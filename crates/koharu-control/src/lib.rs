//! Loopback control surface for unattended operation.
//!
//! Fork-only. Upstream drives the application entirely through Tauri IPC, which
//! the PowerShell supervisors around the translation farm cannot reach. This
//! exposes only what those supervisors genuinely need: a readiness probe, and
//! the ability to pin the translation model so a restart can never silently
//! fall back to another provider.
//!
//! Hand-rolled rather than built on a web framework: the surface is three
//! loopback routes, and owning the few lines here keeps the fork's delta small
//! across upstream refactors.

use std::{
    net::{Ipv4Addr, SocketAddr},
    str::FromStr as _,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub mod credentials;

use anyhow::{Context as _, Result, bail};
use koharu_pipeline::{PipelineConfig, TranslationConfig};
use koharu_translator::{ModelSelection, Provider};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
};

/// Environment variable that both enables the surface and selects its port.
pub const PORT_VARIABLE: &str = "KOHARU_CONTROL_PORT";

/// Neither 4000 nor 4100 is available: upstream debug builds bind CEF's
/// remote debugging endpoint to 4000, where this fork's HTTP API used to live,
/// and 4100 belongs to the website's editor gateway, which runs on the same
/// machine as the farm.
pub const SUGGESTED_PORT: u16 = 4190;

/// Caps both the header block and the declared body length. Requests here are a
/// few hundred bytes; anything larger is a mistake or an abuse.
const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// Set once the ML runtime and pipeline have finished loading.
///
/// The supervisors poll `/health` and must not pin a model before the pipeline
/// exists, otherwise the write races the pipeline's own initial read.
#[derive(Clone, Debug, Default)]
pub struct Readiness(Arc<AtomicBool>);

impl Readiness {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mark_ready(&self) {
        self.0.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_ready(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// The port the surface should listen on, or `None` when it is disabled.
///
/// Absent or empty disables it, so ordinary desktop use opens no socket.
pub fn configured_port() -> Result<Option<u16>> {
    let Ok(raw) = std::env::var(PORT_VARIABLE) else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let port = u16::from_str(raw)
        .with_context(|| format!("{PORT_VARIABLE} must be a TCP port number, got {raw:?}"))?;
    if port == 0 {
        bail!("{PORT_VARIABLE} must not be 0");
    }
    Ok(Some(port))
}

/// Serve until the process exits. Binds loopback only.
pub async fn serve(port: u16, readiness: Readiness) -> Result<()> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to bind the control surface to {address}"))?;
    tracing::info!(%address, "control surface listening");

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::warn!(%error, "control surface failed to accept a connection");
                continue;
            }
        };
        let readiness = readiness.clone();
        drop(tokio::spawn(async move {
            if let Err(error) = handle(stream, readiness).await {
                tracing::warn!(%peer, %error, "control surface request failed");
            }
        }));
    }
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

/// What a supervisor may pin. Everything else about the translation stage stays
/// under the application's own ownership.
///
/// An omitted field leaves the current value alone; there is deliberately no way
/// to clear one back to unset, because every caller here is pinning rather than
/// resetting.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    provider: Provider,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    quantization: Option<String>,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    reasoning: Option<bool>,
    #[serde(default)]
    instructions: Option<String>,
}

/// What a supervisor may pin for the translation agent. An omitted field is
/// left alone; an empty one is cleared.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentCredentials {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Current {
    provider: Provider,
    model: Option<String>,
    quantization: Option<String>,
    /// `Language` carries no serde implementation; its `Display` form is the
    /// same tag the CLI accepts for `--target-language`.
    target_language: String,
    instructions: Option<String>,
    temperature: Option<f32>,
    /// The requested setting, which only takes effect for a model that declares
    /// the capability.
    reasoning: Option<bool>,
    model_supports_reasoning: bool,
    /// Whether this configuration actually stops the model from thinking.
    ///
    /// Worth reporting separately: a model whose capability flag is false has
    /// its reasoning setting dropped entirely, which leaves a thinking model
    /// free to think — and a thinking model exhausts `max_tokens` on
    /// chain-of-thought and returns truncated JSON, i.e. blank translations.
    thinking_suppressed: bool,
}

/// Mirrors `GenerationConfig::for_model` in `koharu-translator`.
fn effective_reasoning(translation: &TranslationConfig) -> Option<bool> {
    if translation.model.reasoning {
        translation.generation.reasoning
    } else {
        None
    }
}

fn snapshot(translation: &TranslationConfig) -> Current {
    Current {
        provider: translation.model.provider,
        model: translation.model.model.clone(),
        quantization: translation.model.quantization.clone(),
        target_language: translation.target_language.to_string(),
        instructions: translation.instructions.clone(),
        temperature: translation.generation.temperature,
        reasoning: translation.generation.reasoning,
        model_supports_reasoning: translation.model.reasoning,
        thinking_suppressed: effective_reasoning(translation) == Some(false),
    }
}

fn current() -> Result<Current> {
    let config = PipelineConfig::load().context("failed to load the pipeline configuration")?;
    let value = config
        .read()
        .context("failed to read the pipeline configuration")?;
    Ok(snapshot(&value.translation))
}

/// Pin the provider and model, preserving the capability flags the application
/// derives for itself.
///
/// `koharu_config::load` hands back the live, process-wide section, so the
/// running pipeline observes this through its own subscription; persisting it
/// additionally survives the next restart.
fn select(selection: Selection) -> Result<Current> {
    let config = PipelineConfig::load().context("failed to load the pipeline configuration")?;
    let mut write = config
        .write()
        .context("failed to lock the pipeline configuration for writing")?;

    let existing = write.translation.model.clone();
    write.translation.model = ModelSelection {
        provider: selection.provider,
        model: selection.model,
        quantization: selection.quantization,
        vision: existing.vision,
        reasoning: existing.reasoning,
    };
    if let Some(temperature) = selection.temperature {
        write.translation.generation.temperature = Some(temperature);
    }
    if let Some(reasoning) = selection.reasoning {
        write.translation.generation.reasoning = Some(reasoning);
    }
    if let Some(instructions) = selection.instructions {
        write.translation.instructions = Some(instructions);
    }
    let current = snapshot(&write.translation);
    write
        .save()
        .context("failed to persist the pipeline configuration")?;

    tracing::info!(
        provider = %current.provider,
        model = current.model.as_deref().unwrap_or("<default>"),
        temperature = ?current.temperature,
        thinking_suppressed = current.thinking_suppressed,
        "translation settings pinned through the control surface"
    );
    Ok(current)
}

async fn handle(mut stream: TcpStream, readiness: Readiness) -> Result<()> {
    let request = match read_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            let body = serde_json::json!({ "error": format!("{error:#}") });
            return respond(&mut stream, 400, &body).await;
        }
    };

    let (status, body) = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => (
            200,
            serde_json::json!({ "ok": true, "ready": readiness.is_ready() }),
        ),
        ("GET", "/llm/current") => match current() {
            Ok(current) => (200, serde_json::to_value(current)?),
            Err(error) => (500, serde_json::json!({ "error": format!("{error:#}") })),
        },
        ("GET", "/agent/credentials") => match credentials::read() {
            Ok(current) => (
                200,
                serde_json::json!({
                    "agentId": current.agent_id,
                    "hasToken": current.token.is_some(),
                }),
            ),
            Err(error) => (500, serde_json::json!({ "error": format!("{error:#}") })),
        },
        // The token is write-only over HTTP. The supervisor already has it —
        // handing it back would only widen where it can leak from.
        ("PUT", "/agent/credentials") => {
            match serde_json::from_slice::<AgentCredentials>(&request.body) {
                Err(error) => (
                    400,
                    serde_json::json!({ "error": format!("invalid request body: {error}") }),
                ),
                Ok(body) => match credentials::write(body.token.as_deref(), body.agent_id.as_deref())
                {
                    Ok(current) => (
                        200,
                        serde_json::json!({
                            "agentId": current.agent_id,
                            "hasToken": current.token.is_some(),
                        }),
                    ),
                    Err(error) => (500, serde_json::json!({ "error": format!("{error:#}") })),
                },
            }
        }
        ("PUT", "/llm/current") => match serde_json::from_slice::<Selection>(&request.body) {
            Err(error) => (
                400,
                serde_json::json!({ "error": format!("invalid request body: {error}") }),
            ),
            Ok(selection) => match select(selection) {
                Ok(current) => (200, serde_json::to_value(current)?),
                Err(error) => (500, serde_json::json!({ "error": format!("{error:#}") })),
            },
        },
        _ => (
            404,
            serde_json::json!({ "error": "unknown route", "routes": [
                "GET /health", "GET /llm/current", "PUT /llm/current",
                "GET /agent/credentials", "PUT /agent/credentials",
            ]}),
        ),
    };

    respond(&mut stream, status, &body).await
}

async fn read_request(stream: &mut TcpStream) -> Result<Request> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];

    let head_end = loop {
        if let Some(index) = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        {
            break index;
        }
        if buffer.len() > MAX_REQUEST_BYTES {
            bail!("request headers exceed {MAX_REQUEST_BYTES} bytes");
        }
        let read = stream
            .read(&mut chunk)
            .await
            .context("failed to read the request")?;
        if read == 0 {
            bail!("the peer closed the connection before sending a complete request");
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = std::str::from_utf8(&buffer[..head_end])
        .context("the request head is not valid UTF-8")?
        .to_owned();
    let mut lines = head.split("\r\n");
    let start = lines
        .next()
        .context("the request is missing its start line")?;
    let mut parts = start.split_whitespace();
    let method = parts
        .next()
        .context("the request is missing a method")?
        .to_owned();
    let target = parts.next().context("the request is missing a target")?;
    let path = target
        .split(['?', '#'])
        .next()
        .unwrap_or(target)
        .to_owned();

    let mut length = 0_usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            length = value
                .trim()
                .parse()
                .context("the request has an invalid Content-Length")?;
        }
    }
    if length > MAX_REQUEST_BYTES {
        bail!("request body exceeds {MAX_REQUEST_BYTES} bytes");
    }

    let mut body = buffer.split_off(head_end + 4);
    while body.len() < length {
        let read = stream
            .read(&mut chunk)
            .await
            .context("failed to read the request body")?;
        if read == 0 {
            bail!("the peer closed the connection before sending a complete body");
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);

    Ok(Request { method, path, body })
}

async fn respond(stream: &mut TcpStream, status: u16, body: &serde_json::Value) -> Result<()> {
    let body = serde_json::to_vec(body).context("failed to serialize the response")?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {length}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        length = body.len(),
    );

    stream
        .write_all(head.as_bytes())
        .await
        .context("failed to write the response head")?;
    stream
        .write_all(&body)
        .await
        .context("failed to write the response body")?;
    stream.flush().await.context("failed to flush the response")
}
