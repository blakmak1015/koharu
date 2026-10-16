//! Fork-only commands for the unattended translation farm.
//!
//! Upstream's `import` and `export` both open a native file dialog, and
//! `PageImportSource` offers only `Files` and `Folder`, so there is no way to
//! feed pages in or take rendered pages out over IPC. An agent running without
//! a human at the keyboard cannot drive the application at all. These commands
//! are the headless equivalents, and they reuse upstream's own code paths
//! rather than reimplementing them.
//!
//! The `farm_` prefix is deliberate: upstream already owns `run_agent`,
//! `cancel_agent`, `login_agent` and `get_agent_status`, which belong to its
//! Codex integration and have nothing to do with the translation agent here.

use anyhow::Context as _;
use image::{
    ExtendedColorType, ImageEncoder as _,
    codecs::png::{CompressionType, FilterType, PngEncoder},
};
use koharu_desktop::Desktop;
use koharu_rasterizer::RasterOptions;
use koharu_scene::EntityId;
use koharu_secrets::{ExposeSecret as _, SecretString};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::{State, ipc::IpcResponse};

use super::{
    Error, canvas::CanvasChannel, lifecycle::add_pages, processing::Processing,
    project::CurrentProject,
};

/// Distinguishes the credentials of two instances sharing one machine account.
///
/// The farm runs the website agent under its own login while a person may be
/// signed in to the same site in an interactive instance; one token must not
/// overwrite the other.
const INSTANCE_VARIABLE: &str = "KOHARU_INSTANCE_ID";

/// Matches the 0.59.2 agent's own fallback, so an existing website-side
/// registration keeps working after the port.
const DEFAULT_AGENT_ID: &str = "koharu-default";

fn instance() -> Option<String> {
    std::env::var(INSTANCE_VARIABLE)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn namespaced(key: &str) -> String {
    match instance() {
        Some(instance) => format!("{key}.{instance}"),
        None => key.to_owned(),
    }
}

/// What the translation agent presents to the website.
///
/// Two values, not one: the website authenticates the worker with
/// `x-translation-agent-token` and attributes the claim with
/// `x-translation-agent-id`, so a job claimed by one machine is visible as
/// that machine's.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCredentials {
    /// `None` when this instance has never been given a token.
    token: Option<String>,
    agent_id: String,
}

fn read_credentials() -> anyhow::Result<AgentCredentials> {
    let token = koharu_secrets::get(&namespaced("agent-token"))?
        .map(|secret| secret.expose_secret().to_owned());
    // The stored value wins, then the instance name the supervisor already
    // sets, so a second farm machine identifies itself without extra setup.
    let agent_id = koharu_secrets::get(&namespaced("agent-id"))?
        .map(|secret| secret.expose_secret().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(instance)
        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_owned());
    Ok(AgentCredentials { token, agent_id })
}

/// Append pages to the open project from paths the caller already has, and
/// return the new page ids in order.
///
/// The agent downloads raw pages to a scratch directory and passes the paths
/// here. Missing paths are rejected up front: a silently short import would
/// produce a chapter with pages missing, which is worse than a failed job.
#[tracing::instrument(
    target = "koharu_metrics",
    name = "import",
    skip_all,
    fields(origin = "farm", method = "paths"),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_import_pages(
    paths: Vec<PathBuf>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    processing: State<'_, Processing>,
    canvas_channel: State<'_, CanvasChannel>,
) -> std::result::Result<Vec<EntityId>, Error> {
    if paths.is_empty() {
        return Err(anyhow::anyhow!("no pages were given to import").into());
    }
    if let Some(missing) = paths.iter().find(|path| !path.is_file()) {
        return Err(anyhow::anyhow!("{} is not a readable file", missing.display()).into());
    }
    add_pages(paths, &desktop, &project, &processing, &canvas_channel).await
}

/// PNG bytes, returned over the raw IPC body rather than as a JSON number
/// array — the same path `get_thumbnail` uses, and the reason a whole page is
/// cheap to hand to the webview.
#[derive(Type)]
#[specta(transparent)]
pub(crate) struct PageImage(#[specta(type = Vec<u8>)] Vec<u8>);

impl IpcResponse for PageImage {
    fn body(self) -> tauri::Result<tauri::ipc::InvokeResponseBody> {
        Ok(self.0.into())
    }
}

/// Which image of a page the agent wants.
#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PageVariant {
    /// The finished page, translation burned in.
    Translated,
    /// Source plus inpainting and paint, with no text at all.
    ///
    /// The published reader shows this one and lays the translation over it as
    /// real HTML, which is what makes a chapter indexable.
    Clean,
}

/// Render one page of the open project and return it as PNG bytes.
///
/// Per page, not per project: the agent uploads each page as it finishes, so
/// an interrupted chapter resumes from the pages that were not done rather
/// than starting again. The bytes come back to the webview because the
/// watermark is baked there before upload.
#[tracing::instrument(
    target = "koharu_metrics",
    name = "export",
    skip_all,
    fields(origin = "farm", format = "png", variant = ?variant),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_render_page(
    page: EntityId,
    variant: PageVariant,
    project: State<'_, CurrentProject>,
    desktop: State<'_, Desktop>,
) -> std::result::Result<PageImage, Error> {
    let snapshot = {
        let project = project.project.lock().await;
        project.as_ref().context("no project is open")?.snapshot()
    };
    snapshot.page(page)?;
    let renderer = desktop.renderer();
    let frame = match variant {
        PageVariant::Translated => renderer.render(&snapshot, page).await?,
        PageVariant::Clean => renderer.render_without_text(&snapshot, page).await?,
    };
    let rasterizer = desktop.rasterizer().await?;
    let bytes = tokio_rayon::spawn(move || -> anyhow::Result<Vec<u8>> {
        let image = rasterizer
            .rasterize(&frame.raster_frame()?, RasterOptions::default())?
            .image;
        let mut bytes = Vec::new();
        PngEncoder::new_with_quality(&mut bytes, CompressionType::Best, FilterType::Adaptive)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                ExtendedColorType::Rgba8,
            )?;
        Ok(bytes)
    })
    .await?;
    tracing::info!(target: "koharu_metrics", metric = "page_exported", format = "png");
    Ok(PageImage(bytes))
}

/// Read this instance's agent credentials.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_get_agent_credentials()
-> std::result::Result<AgentCredentials, Error> {
    Ok(read_credentials()?)
}

/// Store this instance's agent credentials, and return what is now in effect.
///
/// An omitted field is left alone and an empty one is cleared, so the panel can
/// change the token without restating the id.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_set_agent_credentials(
    token: Option<String>,
    agent_id: Option<String>,
) -> std::result::Result<AgentCredentials, Error> {
    for (key, value) in [("agent-token", token), ("agent-id", agent_id)] {
        let Some(value) = value else { continue };
        let value = value.trim();
        if value.is_empty() {
            koharu_secrets::delete(&namespaced(key))?;
        } else {
            koharu_secrets::set(&namespaced(key), &SecretString::from(value))?;
        }
    }
    Ok(read_credentials()?)
}

/// Forget this instance's agent credentials.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_clear_agent_credentials() -> std::result::Result<(), Error> {
    koharu_secrets::delete(&namespaced("agent-token"))?;
    koharu_secrets::delete(&namespaced("agent-id"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two instances on one machine must not share a credential, and a second
    /// farm machine should identify itself from the instance name the
    /// supervisor already sets rather than needing its id typed in.
    ///
    /// One test, not two: the instance name is a process-wide environment
    /// variable, so parallel tests would overwrite each other's setup.
    #[test]
    fn the_instance_name_namespaces_credentials_and_names_the_agent() {
        // SAFETY: the variable is only read elsewhere, never held across this.
        unsafe { std::env::set_var(INSTANCE_VARIABLE, "server") };
        assert_eq!(namespaced("agent-token"), "agent-token.server");
        assert_eq!(namespaced("agent-id"), "agent-id.server");
        assert_eq!(instance().as_deref(), Some("server"));

        unsafe { std::env::set_var(INSTANCE_VARIABLE, "  ") };
        assert_eq!(namespaced("agent-token"), "agent-token");
        assert_eq!(instance(), None);

        unsafe { std::env::remove_var(INSTANCE_VARIABLE) };
        assert_eq!(namespaced("agent-token"), "agent-token");
        assert_eq!(instance(), None);
    }
}
