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

use tauri::{State, ipc::IpcResponse};

use super::{
    Error,
    canvas::CanvasChannel,
    lifecycle::add_pages,
    processing::Processing,
    project::{CurrentProject, Page, Project},
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

/// One source page to fetch, in reading order.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourcePage {
    url: String,
    /// Becomes the page label, so the project reads in the right order.
    name: String,
}

/// Download the chapter's source pages and append them to the open project,
/// returning the new page ids in order.
///
/// Rust fetches them rather than the webview handing bytes back over IPC: a
/// typed command would carry them as a JSON array of numbers, which for a
/// forty-page chapter is tens of megabytes of text to encode and parse. The
/// bytes never need to be in the webview at all.
#[tracing::instrument(
    target = "koharu_metrics",
    name = "import",
    skip_all,
    fields(origin = "farm", method = "urls"),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_import_pages(
    pages: Vec<SourcePage>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    processing: State<'_, Processing>,
    canvas_channel: State<'_, CanvasChannel>,
) -> std::result::Result<Vec<EntityId>, Error> {
    if pages.is_empty() {
        return Err(anyhow::anyhow!("no pages were given to import").into());
    }
    let directory = tempfile::tempdir().context("failed to create a scratch directory")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .context("failed to build the download client")?;

    let mut paths = Vec::with_capacity(pages.len());
    for page in &pages {
        let response = client
            .get(&page.url)
            .send()
            .await
            .with_context(|| format!("failed to download {}", page.name))?
            .error_for_status()
            .with_context(|| format!("failed to download {}", page.name))?;
        let bytes = response
            .bytes()
            .await
            .with_context(|| format!("failed to read {}", page.name))?;
        // The name is the website's, so keep it to a file name.
        let name = std::path::Path::new(&page.name)
            .file_name()
            .context("a source page has no file name")?;
        let path = directory.path().join(name);
        tokio::fs::write(&path, &bytes)
            .await
            .with_context(|| format!("failed to write {}", path.display()))?;
        paths.push(path);
    }

    // The scratch files are decoded during the import, so the directory can go
    // as soon as it returns — but not before.
    let imported = add_pages(paths, &desktop, &project, &processing, &canvas_channel).await;
    drop(directory);
    let imported = imported?;
    if imported.len() != pages.len() {
        return Err(anyhow::anyhow!(
            "imported {} page(s) for {} source page(s)",
            imported.len(),
            pages.len()
        )
        .into());
    }
    Ok(imported)
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

/// Read one page by id, without selecting it.
///
/// Upstream's `get_page` returns whichever page is active, which the agent
/// cannot use: it runs several pages at once, and selecting each one to read
/// its text blocks would make them race over a single shared selection — and
/// would move the editor's view around while a person is looking at it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_get_page(
    page: EntityId,
    project: State<'_, CurrentProject>,
) -> std::result::Result<Page, Error> {
    let snapshot = {
        let project = project.project.lock().await;
        project.as_ref().context("no project is open")?.snapshot()
    };
    Ok(Project::page(&snapshot, page)?)
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
