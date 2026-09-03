//! LLM lifecycle + translation driver.
//!
//! Owns the current LLM state (local llama.cpp model or remote provider).
//! Exposes `translate_texts(sources, target_lang, system_prompt)` which is
//! what the `llm-translate` pipeline engine calls.
//!
//! Construction:
//! ```ignore
//! let backend = app::shared_llama_backend(&runtime)?;
//! let llm = Arc::new(llm::Model::new(runtime, cpu, backend));
//! // then: llm.load_local(...) or llm.load_provider(...)
//! ```

use std::sync::Arc;

use anyhow::Result;
use koharu_core::{
    LlmCatalog, LlmCatalogModel, LlmLoadRequest, LlmProviderCatalog, LlmProviderCatalogStatus,
    LlmState, LlmStateStatus, LlmTarget, LlmTargetKind,
};
use koharu_llm::providers::{
    AnyProvider, ProviderCatalogModels, ProviderConfig, ProviderDescriptor,
    all_provider_descriptors, build_provider, discover_models,
};
use koharu_llm::safe::llama_backend::LlamaBackend;
use koharu_llm::{Language, Llm, ModelId, language::tags as language_tags};
use koharu_runtime::RuntimeManager;
use strum::IntoEnumIterator;
use tokio::sync::{RwLock, broadcast};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[allow(clippy::large_enum_variant)]
pub enum State {
    Empty,
    Loading {
        target: LlmTarget,
    },
    ReadyLocal(Llm),
    ReadyProvider {
        target: LlmTarget,
        provider: Arc<dyn AnyProvider>,
    },
    Failed {
        target: Option<LlmTarget>,
        error: String,
    },
}

/// Which backend one translation call runs against, resolved ONCE per request.
///
/// A remote provider is stateless, so its handle is cloned out of the state
/// lock and the HTTP call runs unlocked - several pages can then be in flight
/// at once and actually use the server's parallel slots. A local llama.cpp
/// model is a single in-process context, so it stays exclusive.
enum Backend {
    Provider {
        provider: Arc<dyn AnyProvider>,
        model_id: String,
    },
    Local,
}

fn local_target(id: ModelId) -> LlmTarget {
    LlmTarget {
        kind: LlmTargetKind::Local,
        model_id: id.to_string(),
        provider_id: None,
    }
}

fn state_target(state: &State) -> Option<LlmTarget> {
    match state {
        State::Empty => None,
        State::Loading { target } => Some(target.clone()),
        State::ReadyLocal(llm) => Some(local_target(llm.id())),
        State::ReadyProvider { target, .. } => Some(target.clone()),
        State::Failed { target, .. } => target.clone(),
    }
}

fn snapshot_from_state(state: &State) -> LlmState {
    match state {
        State::Empty => LlmState {
            status: LlmStateStatus::Empty,
            target: None,
            error: None,
        },
        State::Loading { target } => LlmState {
            status: LlmStateStatus::Loading,
            target: Some(target.clone()),
            error: None,
        },
        State::ReadyLocal(llm) => LlmState {
            status: LlmStateStatus::Ready,
            target: Some(local_target(llm.id())),
            error: None,
        },
        State::ReadyProvider { target, .. } => LlmState {
            status: LlmStateStatus::Ready,
            target: Some(target.clone()),
            error: None,
        },
        State::Failed { target, error } => LlmState {
            status: LlmStateStatus::Failed,
            target: target.clone(),
            error: Some(error.clone()),
        },
    }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

pub struct Model {
    state: Arc<RwLock<State>>,
    state_tx: broadcast::Sender<LlmState>,
    runtime: RuntimeManager,
    cpu: bool,
    backend: Arc<LlamaBackend>,
}

impl Model {
    pub fn new(runtime: RuntimeManager, cpu: bool, backend: Arc<LlamaBackend>) -> Self {
        Self {
            state: Arc::new(RwLock::new(State::Empty)),
            state_tx: broadcast::channel(64).0,
            runtime,
            cpu,
            backend,
        }
    }

    pub fn is_cpu(&self) -> bool {
        self.cpu
    }

    pub fn backend(&self) -> Arc<LlamaBackend> {
        self.backend.clone()
    }

    /// Load a provider target (remote API) immediately.
    pub async fn load_provider(
        &self,
        target: LlmTarget,
        provider: Arc<dyn AnyProvider>,
    ) -> Result<()> {
        *self.state.write().await = State::ReadyProvider { target, provider };
        self.emit_state().await;
        Ok(())
    }

    /// Kick off a local llama.cpp load in the background.
    pub async fn load_local(&self, id: ModelId) {
        let target = local_target(id);
        *self.state.write().await = State::Loading {
            target: target.clone(),
        };
        self.emit_state().await;

        let state_cloned = self.state.clone();
        let state_tx = self.state_tx.clone();
        let runtime = self.runtime.clone();
        let cpu = self.cpu;
        let backend = self.backend.clone();
        tokio::spawn(async move {
            let res = Llm::load(&runtime, id, cpu, backend).await;
            let mut guard = state_cloned.write().await;
            match res {
                Ok(llm) => *guard = State::ReadyLocal(llm),
                Err(e) => {
                    *guard = State::Failed {
                        target: Some(target),
                        error: format!("{e:#}"),
                    }
                }
            }
            let snapshot = snapshot_from_state(&guard);
            let _ = state_tx.send(snapshot);
        });
    }

    pub async fn offload(&self) {
        *self.state.write().await = State::Empty;
        self.emit_state().await;
    }

    pub async fn ready(&self) -> bool {
        matches!(
            *self.state.read().await,
            State::ReadyLocal(_) | State::ReadyProvider { .. }
        )
    }

    pub async fn current_target(&self) -> Option<LlmTarget> {
        state_target(&*self.state.read().await)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LlmState> {
        self.state_tx.subscribe()
    }

    pub async fn snapshot(&self) -> LlmState {
        snapshot_from_state(&*self.state.read().await)
    }

    async fn emit_state(&self) {
        let _ = self.state_tx.send(self.snapshot().await);
    }

    /// Snapshot the loaded backend under a short read lock.
    async fn translate_backend(&self) -> Result<Backend> {
        match &*self.state.read().await {
            State::ReadyProvider { target, provider } => Ok(Backend::Provider {
                provider: provider.clone(),
                model_id: target.model_id.clone(),
            }),
            State::ReadyLocal(_) => Ok(Backend::Local),
            State::Loading { .. } => Err(anyhow::anyhow!("LLM is still loading")),
            State::Failed { error, .. } => Err(anyhow::anyhow!("LLM failed to load: {error}")),
            State::Empty => Err(anyhow::anyhow!("no LLM loaded")),
        }
    }

    /// Translate a batch of source strings. Each source becomes a tagged
    /// `[N]...` block; the response is parsed back into per-block
    /// translations. Output length matches input length (possibly with empty
    /// strings for missing blocks).
    pub async fn translate_texts(
        &self,
        sources: &[String],
        target_language: Option<&str>,
        custom_system_prompt: Option<&str>,
    ) -> Result<Vec<String>> {
        if sources.is_empty() {
            return Ok(Vec::new());
        }
        let target_language = resolve_target_language(target_language);
        let body = format_sources(sources);

        let backend = self.translate_backend().await?;
        let translation = self
            .translate_body(&backend, &body, target_language, custom_system_prompt)
            .await?;

        let mut blocks = match parse_tagged_blocks(&translation, sources.len())? {
            Some(parsed) => {
                // Happy path: the model returned exactly the ids we sent, each
                // once. Accept the mapping as-is (preserves prior behavior).
                if parsed.all_valid() {
                    parsed.blocks
                } else {
                    // The returned id set is NOT exactly {0..expected}: some
                    // block was dropped, duplicated, or carried an out-of-range
                    // id. The whole-page mapping can no longer be trusted by
                    // position, so we DO NOT accept the scrambled result for the
                    // offending blocks. Re-translate each bad block on its own
                    // (sent ALONE as a single `[1]` block, which cannot
                    // misalign) and splice the result back by position. Trusted
                    // blocks (valid[i] == true) are kept from the batch result.
                    tracing::warn!(
                        "tagged-block mismatch ({} of {} blocks untrusted); re-translating per-block",
                        parsed.valid.iter().filter(|&&v| !v).count(),
                        sources.len(),
                    );
                    let mut blocks = parsed.blocks;
                    for (i, ok) in parsed.valid.iter().enumerate() {
                        if *ok {
                            continue;
                        }
                        match self
                            .retranslate_single(
                                &backend,
                                &sources[i],
                                target_language,
                                custom_system_prompt,
                            )
                            .await
                        {
                            Some(text) => blocks[i] = text,
                            // Still couldn't get a trustworthy translation —
                            // leave it EMPTY rather than risk a mis-assigned
                            // line from the scrambled batch.
                            None => blocks[i] = String::new(),
                        }
                    }
                    blocks
                }
            }
            // No tags at all: fall back to legacy line-splitting (unchanged).
            None => split_legacy_lines(&translation, sources.len()),
        };

        // Defensive: parse_tagged_blocks / split_legacy_lines already size to
        // sources.len(), but keep the contract explicit.
        blocks.resize(sources.len(), String::new());
        Ok(blocks
            .into_iter()
            .map(|s| strip_wrapping_quotes(s.trim()))
            .collect())
    }

    /// Run one translation request against whichever backend is loaded, then
    /// strip thinking / reasoning preamble. `body` is the already-formatted
    /// tagged payload (`[1]..\n[2]..`). Takes the backend resolved by the
    /// caller, so the remote-provider path never holds the state lock.
    async fn translate_body(
        &self,
        backend: &Backend,
        body: &str,
        target_language: Language,
        custom_system_prompt: Option<&str>,
    ) -> Result<String> {
        let raw = match backend {
            // Local llama.cpp is one in-process context, so generation still
            // runs under the exclusive state lock.
            Backend::Local => {
                let mut guard = self.state.write().await;
                let State::ReadyLocal(llm) = &mut *guard else {
                    return Err(anyhow::anyhow!("local LLM was unloaded mid-translation"));
                };
                let mut opts = llm.id().default_generate_options();
                // Manga translation must be faithful and stay in the target
                // language. Some general chat models (notably the qwen
                // *-uncensored variants) default to temperature 1.0, which makes
                // them drift mid-sentence into the wrong script (e.g. leaking
                // Chinese characters into Thai output). Cap the temperature for
                // the translation use-case so output stays in one language.
                //
                // 0.3 kept output in-language but was too rigid: the model
                // always picked the safest, most literal wording, which read
                // flat and lost nuance/voice. 0.5 gives enough room for natural
                // phrasing and tone while still being low enough to keep the
                // output in a single script.
                const MAX_TRANSLATION_TEMPERATURE: f64 = 0.5;
                if opts.temperature > MAX_TRANSLATION_TEMPERATURE {
                    opts.temperature = MAX_TRANSLATION_TEMPERATURE;
                }
                llm.generate(body, &opts, target_language, custom_system_prompt)
            }
            // Remote provider: stateless HTTP, no lock held, so several pages
            // can be translated concurrently.
            Backend::Provider { provider, model_id } => {
                provider
                    .translate(body, target_language, model_id, custom_system_prompt)
                    .await
            }
        }?;

        let stripped = strip_thinking_block(&raw);
        let stripped = strip_reasoning_preamble(stripped);
        Ok(stripped.to_string())
    }

    /// Re-translate a single source string in isolation. The source is sent as
    /// the ONLY `[1]` block, so its tag cannot collide with or be shifted by any
    /// neighbouring block. Returns the translated text, or `None` if the model
    /// still failed to return a clean single `[1]` block.
    async fn retranslate_single(
        &self,
        backend: &Backend,
        source: &str,
        target_language: Language,
        custom_system_prompt: Option<&str>,
    ) -> Option<String> {
        let body = format_sources(&[source.to_string()]);
        let translation = match self
            .translate_body(backend, &body, target_language, custom_system_prompt)
            .await
        {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!("per-block re-translate failed: {e:#}");
                    return None;
                }
            };
        match parse_tagged_blocks(&translation, 1) {
            Ok(Some(parsed)) if parsed.all_valid() => {
                parsed.blocks.into_iter().next().filter(|s| !s.trim().is_empty())
            }
            // The single-block response was itself malformed. As a last resort
            // accept the whole (tag-stripped) body if it is non-empty plain
            // text — there is only one block, so there is nothing to misalign.
            _ => {
                let trimmed = translation.trim();
                (!trimmed.is_empty() && find_next_tag(trimmed).is_none())
                    .then(|| trimmed.to_string())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Provider configuration + construction
// ---------------------------------------------------------------------------

impl Model {
    /// Resolve + build a provider from the app config, then load it.
    pub async fn load_from_request(
        &self,
        request: LlmLoadRequest,
        provider_config: Option<ProviderConfig>,
    ) -> Result<()> {
        match request.target.kind {
            LlmTargetKind::Local => {
                let id: ModelId =
                    std::str::FromStr::from_str(&request.target.model_id).map_err(|_| {
                        anyhow::anyhow!("unknown local model id: {}", request.target.model_id)
                    })?;
                self.load_local(id).await;
                Ok(())
            }
            LlmTargetKind::Provider => {
                let provider_id = request
                    .target
                    .provider_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("provider target missing provider_id"))?;
                let config = provider_config.ok_or_else(|| {
                    anyhow::anyhow!("no saved provider configuration for {provider_id}")
                })?;
                let provider: Arc<dyn AnyProvider> =
                    Arc::from(build_provider(provider_id, config)?);
                self.load_provider(request.target, provider).await?;
                Ok(())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/// Build the LLM catalog (local models + providers). Dynamic-provider entries
/// perform a live model-discovery call when the provider has valid
/// configuration; Static providers always return the baked-in list.
pub async fn catalog(config: &crate::config::AppConfig, runtime: &RuntimeManager) -> LlmCatalog {
    LlmCatalog {
        local_models: local_catalog_models(),
        providers: provider_catalog(config, runtime).await,
    }
}

fn provider_target(provider_id: &str, model_id: &str) -> LlmTarget {
    LlmTarget {
        kind: LlmTargetKind::Provider,
        model_id: model_id.to_string(),
        provider_id: Some(provider_id.to_string()),
    }
}

fn local_catalog_models() -> Vec<LlmCatalogModel> {
    ModelId::iter()
        .map(|model| LlmCatalogModel {
            target: local_target(model),
            name: model.to_string(),
            languages: language_tags(&model.languages()),
        })
        .collect()
}

async fn provider_catalog(
    config: &crate::config::AppConfig,
    runtime: &RuntimeManager,
) -> Vec<LlmProviderCatalog> {
    let mut providers = Vec::new();
    for descriptor in all_provider_descriptors() {
        let stored = config.providers.iter().find(|p| p.id == descriptor.id);
        let base_url = stored.and_then(|p| p.base_url.clone());
        let api_key = stored
            .and_then(|p| p.api_key.as_ref())
            .map(|secret| secret.expose().to_owned());
        let has_api_key = api_key.as_deref().is_some_and(|v| !v.trim().is_empty());
        let missing = (descriptor.requires_api_key && !has_api_key)
            || (descriptor.requires_base_url
                && base_url.as_deref().is_none_or(|v| v.trim().is_empty()));

        let (status, error, models) = if missing {
            (
                LlmProviderCatalogStatus::MissingConfiguration,
                None,
                static_provider_models(descriptor),
            )
        } else {
            match &descriptor.models {
                ProviderCatalogModels::Static(_) => (
                    LlmProviderCatalogStatus::Ready,
                    None,
                    static_provider_models(descriptor),
                ),
                ProviderCatalogModels::Dynamic(_) => {
                    let cfg = ProviderConfig {
                        http_client: runtime.http_client(),
                        api_key,
                        base_url: base_url.clone(),
                        temperature: None,
                        max_tokens: None,
                    };
                    match discover_models(descriptor.id, cfg) {
                        Ok(future) => match future.await {
                            Ok(discovered) => (
                                LlmProviderCatalogStatus::Ready,
                                None,
                                discovered
                                    .into_iter()
                                    .map(|m| LlmCatalogModel {
                                        target: provider_target(descriptor.id, &m.id),
                                        name: m.name,
                                        languages: descriptor.supported_languages.tags(),
                                    })
                                    .collect(),
                            ),
                            Err(e) => (
                                LlmProviderCatalogStatus::DiscoveryFailed,
                                Some(format!("{e:#}")),
                                Vec::new(),
                            ),
                        },
                        Err(e) => (
                            LlmProviderCatalogStatus::DiscoveryFailed,
                            Some(format!("{e:#}")),
                            Vec::new(),
                        ),
                    }
                }
            }
        };

        providers.push(LlmProviderCatalog {
            id: descriptor.id.to_string(),
            name: descriptor.name.to_string(),
            requires_api_key: descriptor.requires_api_key,
            requires_base_url: descriptor.requires_base_url,
            has_api_key,
            base_url,
            status,
            error,
            models,
        });
    }
    providers
}

fn static_provider_models(descriptor: &ProviderDescriptor) -> Vec<LlmCatalogModel> {
    match &descriptor.models {
        ProviderCatalogModels::Static(models) => models
            .iter()
            .map(|m| LlmCatalogModel {
                target: provider_target(descriptor.id, m.id),
                name: m.name.to_string(),
                languages: descriptor.supported_languages.tags(),
            })
            .collect(),
        ProviderCatalogModels::Dynamic(_) => Vec::new(),
    }
}

/// Build a `ProviderConfig` from stored app config. Used by `load_from_request`
/// when a provider target is requested.
pub fn provider_config_from_settings(
    config: &crate::config::AppConfig,
    runtime: &RuntimeManager,
    provider_id: &str,
) -> ProviderConfig {
    let stored = config.providers.iter().find(|p| p.id == provider_id);
    ProviderConfig {
        http_client: runtime.http_client(),
        api_key: stored
            .and_then(|p| p.api_key.as_ref())
            .map(|s| s.expose().to_owned()),
        base_url: stored.and_then(|p| p.base_url.clone()),
        temperature: None,
        max_tokens: None,
    }
}

// ---------------------------------------------------------------------------
// Tag formatting + response parsing
// ---------------------------------------------------------------------------

fn format_sources(sources: &[String]) -> String {
    sources
        .iter()
        .enumerate()
        .map(|(idx, text)| format!("[{}]{}", idx + 1, text))
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_block_tag(text: &str) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    if bytes.first()? != &b'[' {
        return None;
    }
    let end = text[1..].find(']')?;
    let num_str = &text[1..1 + end];
    let id_1based: usize = num_str.parse().ok()?;
    if id_1based == 0 {
        return None;
    }
    Some((1 + end + 1, id_1based - 1))
}

fn find_next_tag(text: &str) -> Option<(usize, usize, usize)> {
    let mut line_start = 0;
    while line_start <= text.len() {
        let line = &text[line_start..];
        let indent = line
            .as_bytes()
            .iter()
            .take_while(|&&byte| matches!(byte, b' ' | b'\t'))
            .count();
        let offset = line_start + indent;
        if let Some((len, id)) = parse_block_tag(&text[offset..]) {
            return Some((offset, len, id));
        }
        let Some(next_newline) = line.find('\n') else {
            break;
        };
        line_start += next_newline + 1;
    }
    None
}

/// Result of parsing a tagged `[N]...` response.
///
/// `blocks` is always `expected_blocks` long. `valid[i]` is `true` only when
/// position `i` can be trusted: exactly one in-range tag `[i+1]` was seen.
/// A position is INVALID when its tag was missing entirely or when the model
/// emitted the same id more than once (an ambiguous/scrambled mapping). Tags
/// whose id is out of range are discarded; the page-level effect (a shifted or
/// dropped block) shows up as a missing position elsewhere.
struct ParsedBlocks {
    blocks: Vec<String>,
    valid: Vec<bool>,
}

impl ParsedBlocks {
    fn all_valid(&self) -> bool {
        self.valid.iter().all(|&v| v)
    }
}

fn parse_tagged_blocks(translation: &str, expected_blocks: usize) -> Result<Option<ParsedBlocks>> {
    if find_next_tag(translation).is_none() {
        return Ok(None);
    }
    let mut blocks = vec![String::new(); expected_blocks];
    // How many times each in-range id was emitted. 1 == trustworthy; 0 ==
    // missing; >=2 == duplicate (ambiguous, must re-translate that position).
    let mut seen_count = vec![0usize; expected_blocks];
    let mut found_any = false;
    let mut cursor = translation;
    while let Some((offset, len, id)) = find_next_tag(cursor) {
        found_any = true;
        cursor = &cursor[offset + len..];
        let content_end = find_next_tag(cursor)
            .map(|(next_offset, _, _)| next_offset)
            .unwrap_or(cursor.len());
        let content = cursor[..content_end].trim().to_string();
        if id < expected_blocks {
            // First occurrence wins; later duplicates are flagged via the count
            // and do not clobber the first content.
            if seen_count[id] == 0 {
                blocks[id] = content;
            }
            seen_count[id] += 1;
        }
        // Out-of-range ids are intentionally dropped (see struct docs).
        cursor = &cursor[content_end..];
    }
    if !found_any {
        return Ok(None);
    }
    let valid = seen_count.iter().map(|&c| c == 1).collect();
    Ok(Some(ParsedBlocks { blocks, valid }))
}

fn split_legacy_lines(translation: &str, expected_blocks: usize) -> Vec<String> {
    let mut lines: Vec<String> = translation
        .lines()
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect();
    lines.truncate(expected_blocks);
    while lines.len() < expected_blocks {
        lines.push(String::new());
    }
    lines
}

fn strip_thinking_block(text: &str) -> &str {
    if let Some(start) = text.find("<think>")
        && let Some(end) = text[start..].find("</think>")
    {
        return text[start + end + "</think>".len()..].trim_start();
    }
    text
}

/// Strip verbose reasoning / chain-of-thought that some models (especially
/// small "thinking" models like Gemma uncensored variants) emit as plain text
/// before the actual translation. Common patterns:
///
/// - `REASONING\n...\n\n<actual translation>`
/// - `Here's a thinking process...\n...\n\n<actual translation>`
/// - `Let me translate...\n\n<actual translation>`
///
/// The heuristic: if the response starts with English reasoning text but
/// contains tagged blocks `[1]...` somewhere inside, extract from the first
/// tag onward. This is safe because tagged output is the only thing we asked
/// for, so anything before the first tag is unwanted preamble.
fn strip_reasoning_preamble(text: &str) -> &str {
    // Fast path: already starts with a tag → nothing to strip.
    let trimmed = text.trim_start();
    if trimmed.starts_with('[') {
        return trimmed;
    }
    // Find the first `[N]` block tag in the text.
    if let Some(pos) = find_first_block_tag(trimmed) {
        return trimmed[pos..].trim_start();
    }
    trimmed
}

/// Find byte offset of the first `[N]` block tag (where N is a positive integer)
/// at the start of a line.
fn find_first_block_tag(text: &str) -> Option<usize> {
    let mut offset = 0;
    for line in text.lines() {
        let stripped = line.trim_start();
        if stripped.starts_with('[') {
            if let Some(end) = stripped[1..].find(']') {
                let num_str = &stripped[1..1 + end];
                if num_str.parse::<usize>().is_ok() {
                    let indent = line.len() - stripped.len();
                    return Some(offset + indent);
                }
            }
        }
        offset += line.len() + 1; // +1 for newline
    }
    None
}

fn strip_wrapping_quotes(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.chars().next();
        let last = trimmed.chars().last();
        if let (Some(f), Some(l)) = (first, last)
            && (f == '"' && l == '"' || f == '\'' && l == '\'')
        {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// Resolve the request's optional target-language string to a concrete
/// `Language`. Defaults to **Thai** — this is the manga-th.net fork, and the
/// website agent sends `targetLanguage: undefined` whenever a job row has a
/// null `target_language`. The upstream default of English silently produced
/// fully-English pages ("translation keeps drifting to English" reports); Thai
/// is the only safe fallback for this fork. Explicit values are still honored.
fn resolve_target_language(target: Option<&str>) -> Language {
    target.and_then(Language::parse).unwrap_or(Language::Thai)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_language_defaults_to_thai_never_english() {
        // Missing / empty / unparseable must fall back to Thai, never English.
        assert_eq!(resolve_target_language(None), Language::Thai);
        assert_eq!(resolve_target_language(Some("")), Language::Thai);
        assert_eq!(resolve_target_language(Some("   ")), Language::Thai);
        assert_eq!(resolve_target_language(Some("not-a-language")), Language::Thai);
        // Explicit values are still honored.
        assert_eq!(resolve_target_language(Some("th")), Language::Thai);
        assert_eq!(resolve_target_language(Some("English")), Language::English);
    }

    #[test]
    fn parse_happy_path_all_valid() {
        let parsed = parse_tagged_blocks("[1]a\n[2]b\n[3]c", 3)
            .unwrap()
            .expect("tags present");
        assert_eq!(parsed.blocks, vec!["a", "b", "c"]);
        assert!(parsed.all_valid());
        assert_eq!(parsed.valid, vec![true, true, true]);
    }

    #[test]
    fn parse_dropped_tag_marks_missing_position_invalid() {
        // The model returned only [1] and [3]; block 2 is missing.
        let parsed = parse_tagged_blocks("[1]a\n[3]c", 3)
            .unwrap()
            .expect("tags present");
        assert!(!parsed.all_valid());
        // Present blocks keep their content and stay valid...
        assert_eq!(parsed.blocks[0], "a");
        assert_eq!(parsed.blocks[2], "c");
        assert!(parsed.valid[0]);
        assert!(parsed.valid[2]);
        // ...the dropped one is empty and flagged for re-translation.
        assert_eq!(parsed.blocks[1], "");
        assert!(!parsed.valid[1]);
    }

    #[test]
    fn parse_duplicate_tag_marks_duplicated_position_invalid() {
        // The model emitted [2] twice (and dropped [3]).
        let parsed = parse_tagged_blocks("[1]a\n[2]b\n[2]bb", 3)
            .unwrap()
            .expect("tags present");
        assert!(!parsed.all_valid());
        // First occurrence wins for content, but the duplicate makes it
        // ambiguous → invalid so it is re-translated, not trusted.
        assert_eq!(parsed.blocks[1], "b");
        assert!(!parsed.valid[1]);
        // Block 1 is clean; block 3 was never emitted.
        assert!(parsed.valid[0]);
        assert!(!parsed.valid[2]);
        assert_eq!(parsed.blocks[2], "");
    }

    #[test]
    fn parse_out_of_range_tag_is_discarded_and_leaves_gap() {
        // The model emitted [4] for a 3-block page (out of range) and dropped
        // [3]. The out-of-range content must NOT be assigned to any position.
        let parsed = parse_tagged_blocks("[1]a\n[2]b\n[4]x", 3)
            .unwrap()
            .expect("tags present");
        assert!(!parsed.all_valid());
        assert_eq!(parsed.blocks, vec!["a", "b", ""]);
        assert_eq!(parsed.valid, vec![true, true, false]);
        // Out-of-range text never leaks into a real block.
        assert!(!parsed.blocks.iter().any(|b| b == "x"));
    }

    #[test]
    fn parse_no_tags_returns_none_for_legacy_fallback() {
        assert!(parse_tagged_blocks("just some plain text", 2).unwrap().is_none());
    }

    #[test]
    fn parse_single_block_happy_path() {
        // The per-block re-translation path relies on a clean single [1].
        let parsed = parse_tagged_blocks("[1]hello", 1).unwrap().expect("tag");
        assert!(parsed.all_valid());
        assert_eq!(parsed.blocks, vec!["hello"]);
    }
}
