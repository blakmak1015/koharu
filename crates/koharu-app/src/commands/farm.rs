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
use koharu_scene::{EntityId, TextLayout as SceneTextLayout, Visibility};
use serde::{Deserialize, Serialize};
use specta::Type;

use tauri::{State, ipc::IpcResponse};

use super::{
    Error,
    canvas::CanvasChannel,
    lifecycle::add_pages,
    processing::Processing,
    project::CurrentProject,
};

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

/// Write one agent log line to the application log.
///
/// The agent runs in the webview, and the farm instance's window is hidden, so
/// its own log is somewhere nobody can read. Without this an idle agent and a
/// broken one look exactly alike from outside — which is how the first live
/// run was spent guessing.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_log(message: String) -> std::result::Result<(), Error> {
    tracing::info!(target: "koharu_farm", "{message}");
    Ok(())
}

/// One translated speech bubble, as the published reader needs it.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FarmBlock {
    text: String,
    /// The recognised original, so a reviewer can compare.
    source_text: Option<String>,
    /// Page pixels. The caller turns these into fractions of the page.
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    angle_degrees: f32,
    font_size: Option<f32>,
    color: Option<[u8; 4]>,
    vertical: bool,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FarmPage {
    width: f64,
    height: f64,
    blocks: Vec<FarmBlock>,
}

/// Read one page's translated blocks by id, without selecting it.
///
/// Not upstream's `get_page`, for two reasons. It returns whichever page is
/// active, and the agent runs several at once, so selecting each one to read
/// it would make them race over a single shared selection and move the
/// editor's view while someone is looking at it.
///
/// And its `Layer::Text` view reports only a Geometry component sitting on the
/// layer itself, which nothing the pipeline builds ever has: detection creates
/// the layer and relates it to the region it was recognised from, and the
/// position lives there. Resolving that is what `TextLayerRef::frame` is for,
/// so this asks the scene instead of reassembling the answer in TypeScript.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_page_blocks(
    page: EntityId,
    project: State<'_, CurrentProject>,
) -> std::result::Result<FarmPage, Error> {
    let snapshot = {
        let project = project.project.lock().await;
        project.as_ref().context("no project is open")?.snapshot()
    };
    let value = snapshot.page(page)?.page()?;
    let mut blocks = Vec::new();

    for entity in snapshot.descendants(page)? {
        let id = entity.id();
        if snapshot.component::<SceneTextLayout>(id)?.is_none() {
            continue;
        }
        if snapshot
            .component::<Visibility>(id)?
            .is_some_and(|visibility| !visibility.visible)
        {
            continue;
        }
        let layer = snapshot.text_layer(id)?;
        let content = layer.content()?;
        let Some(translation) = content.translation()? else {
            continue;
        };
        let text = translation.text.value.trim().to_owned();
        if text.is_empty() {
            continue;
        }
        // The authored frame, else the balloon or fitted region behind it,
        // else the region the text was recognised from.
        let geometry = match layer.frame()? {
            Some(geometry) => Some(geometry),
            None => content
                .source_region()?
                .map(koharu_scene::AnalysisRegionRef::geometry)
                .transpose()?,
        };
        let Some(geometry) = geometry else { continue };
        let (x, y, width, height) = bounds(&geometry);
        if width <= 0.0 || height <= 0.0 {
            continue;
        }
        let typography = layer.typography()?;
        blocks.push(FarmBlock {
            text,
            source_text: content
                .source()?
                .map(|source| source.text.value.trim().to_owned())
                .filter(|source| !source.is_empty()),
            x,
            y,
            width,
            height,
            angle_degrees: snapshot
                .component::<SceneTextLayout>(id)?
                .and_then(|layout| layout.angle_degrees)
                .unwrap_or(0.0_f32),
            font_size: typography.as_ref().and_then(|value| value.size),
            color: typography.as_ref().and_then(|value| value.color),
            vertical: typography
                .as_ref()
                .and_then(|value| value.writing_mode)
                .is_some_and(|mode| matches!(mode, koharu_scene::WritingMode::Vertical)),
        });
    }

    Ok(FarmPage {
        width: value.width,
        height: value.height,
        blocks,
    })
}

fn bounds(geometry: &koharu_scene::Geometry) -> (f64, f64, f64, f64) {
    let xs = geometry.points.iter().map(|point| point.x);
    let ys = geometry.points.iter().map(|point| point.y);
    let left = xs.clone().fold(f64::INFINITY, f64::min);
    let top = ys.clone().fold(f64::INFINITY, f64::min);
    let right = xs.fold(f64::NEG_INFINITY, f64::max);
    let bottom = ys.fold(f64::NEG_INFINITY, f64::max);
    if !left.is_finite() || !top.is_finite() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    (left, top, right - left, bottom - top)
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

/// What the agent presents to the website.
///
/// Stored by `koharu-control`, which also lets the supervisor pin it over the
/// loopback surface — the farm instance starts with its window hidden, so
/// there is nowhere for anyone to type a token in.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCredentials {
    /// `None` when this instance has never been given a token.
    token: Option<String>,
    agent_id: String,
    /// Whether this instance is the unattended one.
    ///
    /// It decides whether the agent starts on its own. A stored "enabled"
    /// flag cannot: the farm instance has no visible window, so nobody can
    /// ever set it there in the first place. Having a token and no window is
    /// what being the farm means.
    unattended: bool,
}

impl From<koharu_control::credentials::Credentials> for AgentCredentials {
    fn from(value: koharu_control::credentials::Credentials) -> Self {
        Self {
            token: value.token,
            agent_id: value.agent_id,
            unattended: crate::app::background_mode(),
        }
    }
}

/// Read this instance's agent credentials.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_get_agent_credentials() -> std::result::Result<AgentCredentials, Error> {
    Ok(koharu_control::credentials::read()?.into())
}

/// Store this instance's agent credentials, and return what is now in effect.
///
/// An omitted field is left alone and an empty one is cleared, so the panel can
/// change the id without restating the token.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_set_agent_credentials(
    token: Option<String>,
    agent_id: Option<String>,
) -> std::result::Result<AgentCredentials, Error> {
    Ok(koharu_control::credentials::write(token.as_deref(), agent_id.as_deref())?.into())
}

/// Forget this instance's agent credentials.
#[tauri::command]
#[specta::specta]
pub(crate) async fn farm_clear_agent_credentials() -> std::result::Result<(), Error> {
    Ok(koharu_control::credentials::clear()?)
}
