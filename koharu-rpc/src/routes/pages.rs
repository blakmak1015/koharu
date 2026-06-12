//! Page + page-subresource byte-ingress routes.
//!
//! - `POST /pages`                           — multipart: create pages from N image files
//! - `POST /pages/{id}/image-layers`         — multipart: add one Custom image node
//! - `PUT  /pages/{id}/masks/{role}`         — raw PNG body: upsert a mask node
//!   (role ∈ `segment`, `brushInpaint`)
//!
//! All three do the same server-side dance: read bytes → `blobs.put_bytes`
//! → emit an `Op` on the session history.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Multipart, Path, Query, State};
use image::GenericImageView;
use koharu_app::pipeline::{self, EngineCtx, PipelineRunOptions};
use koharu_core::{
    BlobRef, FontPrediction, ImageData, ImageRole, MaskRole, Node, NodeDataPatch, NodeId, NodeKind,
    Op, Page, PageId, ReadingOrder, Region, Scene, TextData, TextDirection, Transform,
};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::AppState;
use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct PutMaskParams {
    /// Optional pipeline engine to run after the mask is updated.
    pub pipeline: Option<String>,
    /// Bounding box for the pipeline run.
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub width: Option<f32>,
    pub height: Option<f32>,
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::default()
        .routes(routes!(create_pages))
        .routes(routes!(create_pages_from_paths))
        .routes(routes!(create_pages_from_urls))
        .routes(routes!(add_image_layer))
        .routes(routes!(put_mask))
        .routes(routes!(reorder_text_nodes))
        .routes(routes!(add_text_nodes))
}

// ---------------------------------------------------------------------------
// POST /pages/{id}/text-nodes — inject translated text blocks into a page.
//
// Used by the website "edit published chapter" flow: the chapter is stored as
// an inpainted (clean) image + proportional textBlocks JSON. To re-edit it in
// koharu we rebuild the project from those parts — add the inpainted image as a
// page (via POST /pages) and then call this to recreate the translated text
// nodes at their saved positions/colours so an editor can fix typos/placement
// and re-render. Coordinates are PROPORTIONAL (0..1) to the page, matching the
// website's TextBlock format; we convert to pixels using the page dimensions.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextNodeInput {
    /// Proportional (0..1) box on the page.
    pub x_rel: f32,
    pub y_rel: f32,
    pub w_rel: f32,
    pub h_rel: f32,
    #[serde(default)]
    pub rotation_deg: f32,
    /// Original (pre-translation) text, optional.
    #[serde(default)]
    pub text: Option<String>,
    /// Translated text actually rendered.
    pub translation: String,
    /// Font size as a fraction of page width (the website's `fontSizeRel`).
    #[serde(default)]
    pub font_size_rel: Option<f32>,
    /// Fill colour, hex "#rrggbb".
    #[serde(default)]
    pub color: Option<String>,
    /// Stroke/outline colour, hex "#rrggbb".
    #[serde(default)]
    pub stroke_color: Option<String>,
    /// "horizontal" | "vertical".
    #[serde(default)]
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddTextNodesRequest {
    pub blocks: Vec<TextNodeInput>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddTextNodesResponse {
    pub nodes: Vec<NodeId>,
}

fn parse_hex_rgb(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some([r, g, b])
}

#[utoipa::path(
    post,
    path = "/pages/{id}/text-nodes",
    params(("id" = PageId, Path, description = "Page id")),
    request_body = AddTextNodesRequest,
    responses((status = 200, body = AddTextNodesResponse))
)]
async fn add_text_nodes(
    State(app): State<AppState>,
    Path(page_id): Path<PageId>,
    Json(req): Json<AddTextNodesRequest>,
) -> ApiResult<Json<AddTextNodesResponse>> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;
    let (page_w, page_h, mut at) = {
        let scene = session.scene.read();
        let page = scene
            .page(page_id)
            .ok_or_else(|| ApiError::not_found(format!("page {page_id}")))?;
        (page.width as f32, page.height as f32, page.nodes.len())
    };

    let mut node_ids = Vec::with_capacity(req.blocks.len());
    for b in req.blocks {
        let x = b.x_rel.clamp(0.0, 1.0) * page_w;
        let y = b.y_rel.clamp(0.0, 1.0) * page_h;
        let w = (b.w_rel.max(0.0) * page_w).max(1.0);
        let h = (b.h_rel.max(0.0) * page_h).max(1.0);
        let direction = match b.direction.as_deref() {
            Some("vertical") => TextDirection::Vertical,
            _ => TextDirection::Horizontal,
        };
        let font_px = b
            .font_size_rel
            .map(|r| (r * page_w).max(1.0))
            .unwrap_or_else(|| w.min(h).max(1.0));
        let text_color = b.color.as_deref().and_then(parse_hex_rgb).unwrap_or([0, 0, 0]);
        let stroke_color = b
            .stroke_color
            .as_deref()
            .and_then(parse_hex_rgb)
            .unwrap_or([255, 255, 255]);

        let text_data = TextData {
            confidence: 1.0,
            source_direction: Some(direction),
            rendered_direction: Some(direction),
            rotation_deg: Some(b.rotation_deg),
            detected_font_size_px: Some(font_px),
            detector: Some("website-editor".to_string()),
            text: b.text.clone(),
            translation: Some(b.translation.clone()),
            font_prediction: Some(FontPrediction {
                direction,
                text_color,
                stroke_color,
                font_size_px: font_px,
                line_height: 1.0,
                ..Default::default()
            }),
            ..Default::default()
        };
        let node = Node {
            id: NodeId::new(),
            transform: Transform {
                x,
                y,
                width: w,
                height: h,
                rotation_deg: b.rotation_deg,
            },
            visible: true,
            kind: NodeKind::Text(text_data),
        };
        let id = node.id;
        app.apply(Op::AddNode {
            page: page_id,
            node,
            at,
        })
        .map_err(ApiError::internal)?;
        at += 1;
        node_ids.push(id);
    }

    Ok(Json(AddTextNodesResponse { nodes: node_ids }))
}

// ---------------------------------------------------------------------------
// POST /pages  — create pages from uploaded image files
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatePagesResponse {
    pub pages: Vec<PageId>,
}

#[utoipa::path(
    post,
    path = "/pages",
    request_body(content_type = "multipart/form-data"),
    responses((status = 200, body = CreatePagesResponse))
)]
async fn create_pages(
    State(app): State<AppState>,
    mut multipart: Multipart,
) -> ApiResult<Json<CreatePagesResponse>> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;

    // Collect (filename, bytes) pairs first so we can sort naturally.
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut replace = false;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("multipart: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "replace" {
            let text = field
                .text()
                .await
                .map_err(|e| ApiError::bad_request(format!("{e}")))?;
            replace = text == "true" || text == "1";
            continue;
        }
        let filename = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("page-{}.bin", files.len() + 1));
        let bytes = field
            .bytes()
            .await
            .map_err(|e| ApiError::bad_request(format!("read file: {e}")))?;
        files.push((filename, bytes.to_vec()));
    }

    files.sort_by(|a, b| natord::compare(&a.0, &b.0));

    // Optionally clear the project first. Emitted as a batch so it's one undo step.
    let starting_index = if replace {
        let scene = session.scene.read();
        let remove_ops: Vec<Op> = scene
            .pages
            .keys()
            .copied()
            .map(|id| Op::RemovePage {
                id,
                prev_page: scene.pages[&id].clone(),
                prev_index: scene.pages.get_index_of(&id).unwrap_or(0),
            })
            .collect();
        drop(scene);
        if !remove_ops.is_empty() {
            app.apply(Op::Batch {
                ops: remove_ops,
                label: "Replace pages (clear)".into(),
            })
            .map_err(ApiError::internal)?;
        }
        0
    } else {
        session.scene.read().pages.len()
    };

    // Decode + hash + write each file in parallel. Image decode is the
    // dominant cost per page (~10–50ms for a typical JPEG/PNG), so a
    // 200-page folder benefits almost linearly from multi-core. The output
    // vector preserves the pre-sorted order because rayon's `par_iter`
    // keeps indices through `collect::<Result<Vec<_>>>()`.
    //
    // `BlobStore::put_bytes` is Send + Sync (stateless beyond disk + blake3),
    // so it's safe to call from the rayon pool.
    //
    // Run the rayon section on a blocking thread so we don't stall the
    // tokio runtime while decoding.
    let blobs = session.blobs.clone();
    let decoded: Vec<(String, u32, u32, BlobRef)> = tokio::task::spawn_blocking(move || {
        files
            .into_par_iter()
            .map(
                |(filename, bytes)| -> ApiResult<(String, u32, u32, BlobRef)> {
                    let img = image::load_from_memory(&bytes)
                        .map_err(|e| ApiError::bad_request(format!("decode `{filename}`: {e}")))?;
                    let (w, h) = img.dimensions();
                    let blob = blobs.put_bytes(&bytes).map_err(ApiError::internal)?;
                    Ok((filename, w, h, blob))
                },
            )
            .collect::<ApiResult<Vec<_>>>()
    })
    .await
    .map_err(|e| ApiError::internal(anyhow::anyhow!("import task panicked: {e}")))??;

    // Build one AddPage batch for the whole import.
    let mut ops = Vec::with_capacity(decoded.len());
    let mut created_ids = Vec::with_capacity(decoded.len());
    for (i, (filename, w, h, blob)) in decoded.into_iter().enumerate() {
        let mut page = Page::new(&filename, w, h);
        let page_id = page.id;
        let source_node_id = NodeId::new();
        page.nodes.insert(
            source_node_id,
            Node {
                id: source_node_id,
                transform: Transform::default(),
                visible: true,
                kind: NodeKind::Image(ImageData {
                    role: ImageRole::Source,
                    blob,
                    opacity: 1.0,
                    natural_width: w,
                    natural_height: h,
                    name: Some(filename),
                }),
            },
        );
        created_ids.push(page_id);
        ops.push(Op::AddPage {
            page,
            at: starting_index + i,
        });
    }

    app.apply(Op::Batch {
        ops,
        label: "Import pages".into(),
    })
    .map_err(ApiError::internal)?;

    Ok(Json(CreatePagesResponse { pages: created_ids }))
}

// ---------------------------------------------------------------------------
// POST /pages/from-paths — Tauri fast-path: import by reading files directly
// from disk, skipping multipart upload entirely
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatePagesFromPathsRequest {
    pub paths: Vec<String>,
    #[serde(default)]
    pub replace: bool,
}

/// Create pages by reading image files from absolute paths on the server's
/// filesystem. This is the Tauri desktop import path — the webview picker
/// returns paths, and the backend reads + decodes + hashes them in parallel
/// without a round-trip through JS memory or a multipart upload body.
///
/// Web clients should keep using `POST /pages` with multipart.
#[utoipa::path(
    post,
    path = "/pages/from-paths",
    request_body = CreatePagesFromPathsRequest,
    responses((status = 200, body = CreatePagesResponse))
)]
async fn create_pages_from_paths(
    State(app): State<AppState>,
    Json(req): Json<CreatePagesFromPathsRequest>,
) -> ApiResult<Json<CreatePagesResponse>> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;

    // Natural-order sort by filename component so `page-2.png` < `page-10.png`.
    let mut paths = req.paths;
    paths.sort_by(|a, b| {
        let af = std::path::Path::new(a)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(a);
        let bf = std::path::Path::new(b)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(b);
        natord::compare(af, bf)
    });

    let starting_index = if req.replace {
        let scene = session.scene.read();
        let remove_ops: Vec<Op> = scene
            .pages
            .keys()
            .copied()
            .map(|id| Op::RemovePage {
                id,
                prev_page: scene.pages[&id].clone(),
                prev_index: scene.pages.get_index_of(&id).unwrap_or(0),
            })
            .collect();
        drop(scene);
        if !remove_ops.is_empty() {
            app.apply(Op::Batch {
                ops: remove_ops,
                label: "Replace pages (clear)".into(),
            })
            .map_err(ApiError::internal)?;
        }
        0
    } else {
        session.scene.read().pages.len()
    };

    let blobs = session.blobs.clone();
    let decoded: Vec<(String, u32, u32, BlobRef)> = tokio::task::spawn_blocking(move || {
        paths
            .into_par_iter()
            .map(|path| -> ApiResult<(String, u32, u32, BlobRef)> {
                let filename = std::path::Path::new(&path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "page.bin".to_string());
                let bytes = std::fs::read(&path)
                    .map_err(|e| ApiError::bad_request(format!("read `{filename}`: {e}")))?;
                let img = image::load_from_memory(&bytes)
                    .map_err(|e| ApiError::bad_request(format!("decode `{filename}`: {e}")))?;
                let (w, h) = img.dimensions();
                let blob = blobs.put_bytes(&bytes).map_err(ApiError::internal)?;
                Ok((filename, w, h, blob))
            })
            .collect::<ApiResult<Vec<_>>>()
    })
    .await
    .map_err(|e| ApiError::internal(anyhow::anyhow!("import task panicked: {e}")))??;

    let mut ops = Vec::with_capacity(decoded.len());
    let mut created_ids = Vec::with_capacity(decoded.len());
    for (i, (filename, w, h, blob)) in decoded.into_iter().enumerate() {
        let mut page = Page::new(&filename, w, h);
        let page_id = page.id;
        let source_node_id = NodeId::new();
        page.nodes.insert(
            source_node_id,
            Node {
                id: source_node_id,
                transform: Transform::default(),
                visible: true,
                kind: NodeKind::Image(ImageData {
                    role: ImageRole::Source,
                    blob,
                    opacity: 1.0,
                    natural_width: w,
                    natural_height: h,
                    name: Some(filename),
                }),
            },
        );
        created_ids.push(page_id);
        ops.push(Op::AddPage {
            page,
            at: starting_index + i,
        });
    }

    app.apply(Op::Batch {
        ops,
        label: "Import pages".into(),
    })
    .map_err(ApiError::internal)?;

    Ok(Json(CreatePagesResponse { pages: created_ids }))
}

// ---------------------------------------------------------------------------
// POST /pages/from-urls — server-side image ingress by URL.
//
// The website "review / edit" reconstruct used to download every inpainted
// page into the browser and re-upload it as one multipart body. For a 40-50
// page chapter that's ~150MB pulled down, then pushed back up through the
// Cloudflare tunnel — bottlenecked by the client's UPLOAD bandwidth, double-
// transiting the cloud, and tripping Cloudflare's 100MB request-body cap.
//
// This endpoint flips it: the browser sends only the URL list (a few KB) and
// koharu fetches the images directly from the CDN (on the GPU box, full
// bandwidth, in parallel). Order is taken from the request array — urls[i] is
// page i — so we do NOT sort by filename (CDN names don't encode page order).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatePagesFromUrlsRequest {
    pub urls: Vec<String>,
    #[serde(default)]
    pub replace: bool,
}

/// GET a URL into bytes, retrying transient failures (connection reset,
/// partial/decoded body, 5xx). CDN fetches under concurrency occasionally drop
/// a response mid-body; a couple of retries makes the import reliable.
async fn fetch_bytes_retry(
    client: &reqwest::Client,
    url: &str,
    attempts: u32,
) -> ApiResult<Vec<u8>> {
    let mut last = String::from("no attempt made");
    for attempt in 0..attempts.max(1) {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(250 * u64::from(attempt))).await;
        }
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                Ok(b) => return Ok(b.to_vec()),
                Err(e) => last = format!("read body: {e}"),
            },
            Ok(resp) => last = format!("HTTP {}", resp.status()),
            Err(e) => last = format!("send: {e}"),
        }
    }
    Err(ApiError::bad_request(format!(
        "fetch `{url}` failed after {} attempts: {last}",
        attempts.max(1)
    )))
}

#[utoipa::path(
    post,
    path = "/pages/from-urls",
    request_body = CreatePagesFromUrlsRequest,
    responses((status = 200, body = CreatePagesResponse))
)]
async fn create_pages_from_urls(
    State(app): State<AppState>,
    Json(req): Json<CreatePagesFromUrlsRequest>,
) -> ApiResult<Json<CreatePagesResponse>> {
    use futures::StreamExt;

    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;

    if req.urls.is_empty() {
        return Err(ApiError::bad_request("no urls provided"));
    }

    // Fetch all images server-side, concurrently (bounded), keeping each blob
    // at its request index so we preserve page order. Done BEFORE any clear so
    // a fetch failure leaves the existing project untouched.
    //
    // Force HTTP/1.1 (one connection per request) so a single CDN HTTP/2 stream
    // reset under concurrency can't corrupt the body ("error decoding response
    // body"), and retry each URL a few times to ride out transient hiccups.
    let client = reqwest::Client::builder()
        .http1_only()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| ApiError::internal(anyhow::anyhow!("http client: {e}")))?;
    let total = req.urls.len();
    let fetched_stream = futures::stream::iter(req.urls.into_iter().enumerate().map(
        |(i, url)| {
            let client = client.clone();
            async move {
                let bytes = fetch_bytes_retry(&client, &url, 4).await?;
                Ok::<(usize, Vec<u8>), ApiError>((i, bytes))
            }
        },
    ))
    .buffer_unordered(6);
    futures::pin_mut!(fetched_stream);

    let mut images: Vec<Option<Vec<u8>>> = vec![None; total];
    while let Some(res) = fetched_stream.next().await {
        let (i, bytes) = res?;
        images[i] = Some(bytes);
    }

    // Optionally clear the project first (one undo step), matching create_pages.
    let starting_index = if req.replace {
        let scene = session.scene.read();
        let remove_ops: Vec<Op> = scene
            .pages
            .keys()
            .copied()
            .map(|id| Op::RemovePage {
                id,
                prev_page: scene.pages[&id].clone(),
                prev_index: scene.pages.get_index_of(&id).unwrap_or(0),
            })
            .collect();
        drop(scene);
        if !remove_ops.is_empty() {
            app.apply(Op::Batch {
                ops: remove_ops,
                label: "Replace pages (clear)".into(),
            })
            .map_err(ApiError::internal)?;
        }
        0
    } else {
        session.scene.read().pages.len()
    };

    // Decode + hash + store in parallel, preserving the request order.
    let blobs = session.blobs.clone();
    let indexed: Vec<(usize, Vec<u8>)> = images
        .into_iter()
        .enumerate()
        .map(|(i, b)| (i, b.unwrap_or_default()))
        .collect();
    let mut decoded: Vec<(usize, String, u32, u32, BlobRef)> =
        tokio::task::spawn_blocking(move || {
            indexed
                .into_par_iter()
                .map(|(i, bytes)| -> ApiResult<(usize, String, u32, u32, BlobRef)> {
                    let filename = format!("page-{:04}.png", i + 1);
                    let img = image::load_from_memory(&bytes).map_err(|e| {
                        ApiError::bad_request(format!("decode `{filename}`: {e}"))
                    })?;
                    let (w, h) = img.dimensions();
                    let blob = blobs.put_bytes(&bytes).map_err(ApiError::internal)?;
                    Ok((i, filename, w, h, blob))
                })
                .collect::<ApiResult<Vec<_>>>()
        })
        .await
        .map_err(|e| ApiError::internal(anyhow::anyhow!("import task panicked: {e}")))??;

    decoded.sort_by_key(|(i, ..)| *i);

    let mut ops = Vec::with_capacity(decoded.len());
    let mut created_ids = Vec::with_capacity(decoded.len());
    for (i, (_idx, filename, w, h, blob)) in decoded.into_iter().enumerate() {
        let mut page = Page::new(&filename, w, h);
        let page_id = page.id;
        let source_node_id = NodeId::new();
        page.nodes.insert(
            source_node_id,
            Node {
                id: source_node_id,
                transform: Transform::default(),
                visible: true,
                kind: NodeKind::Image(ImageData {
                    role: ImageRole::Source,
                    blob,
                    opacity: 1.0,
                    natural_width: w,
                    natural_height: h,
                    name: Some(filename),
                }),
            },
        );
        created_ids.push(page_id);
        ops.push(Op::AddPage {
            page,
            at: starting_index + i,
        });
    }

    app.apply(Op::Batch {
        ops,
        label: "Import pages".into(),
    })
    .map_err(ApiError::internal)?;

    Ok(Json(CreatePagesResponse { pages: created_ids }))
}

// ---------------------------------------------------------------------------
// POST /pages/{id}/image-layers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddImageLayerResponse {
    pub node: NodeId,
}

#[utoipa::path(
    post,
    path = "/pages/{id}/image-layers",
    params(("id" = PageId, Path, description = "Page id")),
    request_body(content_type = "multipart/form-data"),
    responses((status = 200, body = AddImageLayerResponse))
)]
async fn add_image_layer(
    State(app): State<AppState>,
    Path(page_id): Path<PageId>,
    mut multipart: Multipart,
) -> ApiResult<Json<AddImageLayerResponse>> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;
    let page_node_count = {
        let scene = session.scene.read();
        scene
            .page(page_id)
            .ok_or_else(|| ApiError::not_found(format!("page {page_id}")))?
            .nodes
            .len()
    };

    // The handler only accepts a single image layer per request, so we
    // pull the first multipart field and ignore the rest.
    let field = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("multipart: {e}")))?
        .ok_or_else(|| ApiError::bad_request("no file uploaded"))?;
    let filename = field
        .file_name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| String::from("layer.png"));
    let bytes = field
        .bytes()
        .await
        .map_err(|e| ApiError::bad_request(format!("read file: {e}")))?
        .to_vec();

    let decoded = image::load_from_memory(&bytes)
        .map_err(|e| ApiError::bad_request(format!("decode: {e}")))?;
    let (w, h) = decoded.dimensions();
    let blob = session
        .blobs
        .put_bytes(&bytes)
        .map_err(ApiError::internal)?;

    // Center-place on the page.
    let (center_x, center_y) = center_on_page(session.scene.read().page(page_id), w, h);
    let node_id = NodeId::new();
    let node = Node {
        id: node_id,
        transform: Transform {
            x: center_x,
            y: center_y,
            width: w as f32,
            height: h as f32,
            rotation_deg: 0.0,
        },
        visible: true,
        kind: NodeKind::Image(ImageData {
            role: ImageRole::Custom,
            blob,
            opacity: 1.0,
            natural_width: w,
            natural_height: h,
            name: Some(filename),
        }),
    };
    app.apply(Op::AddNode {
        page: page_id,
        node,
        at: page_node_count,
    })
    .map_err(ApiError::internal)?;

    Ok(Json(AddImageLayerResponse { node: node_id }))
}

fn center_on_page(page: Option<&koharu_core::Page>, iw: u32, ih: u32) -> (f32, f32) {
    let Some(p) = page else { return (0.0, 0.0) };
    let x = ((p.width as f32) - iw as f32) / 2.0;
    let y = ((p.height as f32) - ih as f32) / 2.0;
    (x.max(0.0), y.max(0.0))
}

#[allow(dead_code)]
fn scene_contains_page(scene: &Scene, id: PageId) -> bool {
    scene.pages.contains_key(&id)
}

// ---------------------------------------------------------------------------
// PUT /pages/{id}/masks/{role}
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PutMaskResponse {
    pub node: NodeId,
    pub blob: BlobRef,
}

/// Upsert the `Mask { role }` node on a page with the raw image bytes in
/// the body. Emits `Op::UpdateNode` if a mask of that role exists, else
/// `Op::AddNode`. Used by the repair-brush / segment-edit flow; the
/// follow-up localized inpaint is a separate `POST /pipelines` call.
#[utoipa::path(
    put,
    path = "/pages/{id}/masks/{role}",
    params(
        ("id"   = PageId,   Path, description = "Page id"),
        ("role" = MaskRole, Path, description = "Mask role (segment|brushInpaint)"),
        PutMaskParams,
    ),
    request_body(content_type = "image/png"),
    responses((status = 200, body = PutMaskResponse))
)]
async fn put_mask(
    State(app): State<AppState>,
    Path((page_id, role)): Path<(PageId, MaskRole)>,
    Query(params): Query<PutMaskParams>,
    body: Bytes,
) -> ApiResult<Json<PutMaskResponse>> {
    let session = app
        .current_session()
        .ok_or_else(|| ApiError::bad_request("no project open"))?;
    if body.is_empty() {
        return Err(ApiError::bad_request("empty body"));
    }
    // Validate it actually decodes so we don't persist garbage.
    image::load_from_memory(&body)
        .map_err(|e| ApiError::bad_request(format!("decode mask: {e}")))?;

    let blob = session.blobs.put_bytes(&body).map_err(ApiError::internal)?;

    // Find existing mask node of this role, or plan an AddNode.
    let (mut mask_op, node_id) = {
        let scene = session.scene.read();
        let existing = scene
            .page(page_id)
            .ok_or_else(|| ApiError::not_found(format!("page {page_id}")))?
            .nodes
            .iter()
            .find_map(|(id, node)| match &node.kind {
                NodeKind::Mask(m) if m.role == role => Some(*id),
                _ => None,
            });
        match existing {
            Some(id) => {
                let op = Op::UpdateNode {
                    page: page_id,
                    id,
                    patch: koharu_core::NodePatch {
                        data: Some(NodeDataPatch::Mask(koharu_core::MaskDataPatch {
                            blob: Some(blob.clone()),
                        })),
                        transform: None,
                        visible: None,
                    },
                    prev: koharu_core::NodePatch::default(),
                };
                (op, id)
            }
            None => {
                let node_id = NodeId::new();
                let at = scene.page(page_id).map(|p| p.nodes.len()).unwrap_or(0);
                let node = Node {
                    id: node_id,
                    transform: Transform::default(),
                    visible: matches!(role, MaskRole::BrushInpaint),
                    kind: NodeKind::Mask(koharu_core::MaskData {
                        role,
                        blob: blob.clone(),
                    }),
                };
                (
                    Op::AddNode {
                        page: page_id,
                        node,
                        at,
                    },
                    node_id,
                )
            }
        }
    };

    if let Some(engine_id) = params.pipeline.as_ref() {
        // Atomic Batch: Mask Update + Pipeline Run
        let mut ops = vec![mask_op.clone()];

        // 1. Simulate the mask update in a cloned scene so the engine sees it.
        let mut scene = session.scene_snapshot();
        mask_op
            .apply(&mut scene)
            .map_err(|e| ApiError::internal(e.into()))?;

        // 2. Prepare EngineCtx
        let region = Region {
            x: params.x.unwrap_or(0.0) as u32,
            y: params.y.unwrap_or(0.0) as u32,
            width: params.width.unwrap_or(0.0) as u32,
            height: params.height.unwrap_or(0.0) as u32,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let options = PipelineRunOptions {
            region: Some(region),
            ..Default::default()
        };
        let ctx = EngineCtx {
            scene: &scene,
            page: page_id,
            blobs: &session.blobs,
            runtime: &app.runtime,
            cancel: &cancel,
            options: &options,
            llm: &app.llm,
            renderer: &app.renderer,
        };

        // 3. Run Engine (Synchronously for this request)
        let engine_info = pipeline::Registry::find(engine_id)
            .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
        let engine = app
            .registry
            .get(engine_info.id, &app.runtime, app.cpu_only())
            .await
            .map_err(|e| ApiError::internal(anyhow::anyhow!("load engine: {e:#}")))?;

        let engine_ops = engine
            .run(ctx)
            .await
            .map_err(|e| ApiError::internal(anyhow::anyhow!("run engine: {e:#}")))?;

        ops.extend(engine_ops);

        let batch = Op::Batch {
            ops,
            label: format!("Repair Brush ({})", engine_id),
        };
        app.apply(batch).map_err(ApiError::internal)?;
    } else {
        app.apply(mask_op).map_err(ApiError::internal)?;
    }

    Ok(Json(PutMaskResponse {
        node: node_id,
        blob,
    }))
}

// ---------------------------------------------------------------------------
// POST /pages/{page_id}/reorder-text-nodes  — re-sort existing text blocks
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/pages/{page_id}/reorder-text-nodes",
    params(("page_id" = PageId, Path, description = "Page id")),
    request_body = ReadingOrder,
    responses((status = 200))
)]
async fn reorder_text_nodes(
    State(app): State<AppState>,
    Path(page_id): Path<PageId>,
    Json(order): Json<ReadingOrder>,
) -> ApiResult<axum::http::StatusCode> {
    if order == ReadingOrder::Custom {
        return Ok(axum::http::StatusCode::OK);
    }

    tracing::debug!(
        "Reordering text nodes for page {} with order {:?}",
        page_id,
        order
    );
    let new_order_opt = {
        let session = app
            .current_session()
            .ok_or_else(|| ApiError::bad_request("no project open"))?;
        let scene = session.scene_snapshot();
        let page = scene
            .page(page_id)
            .ok_or_else(|| ApiError::not_found("page not found"))?;

        // 1. Collect all text nodes and their bboxes
        let mut text_nodes: Vec<([f32; 4], NodeId)> = page
            .nodes
            .iter()
            .filter_map(|(id, node)| {
                if let NodeKind::Text(_) = &node.kind {
                    let b = &node.transform;
                    Some(([b.x, b.y, b.x + b.width, b.y + b.height], *id))
                } else {
                    None
                }
            })
            .collect();

        tracing::debug!(
            "Found {} text nodes. Current order: {:?}",
            text_nodes.len(),
            text_nodes.iter().map(|(_, id)| id).collect::<Vec<_>>()
        );

        if text_nodes.len() <= 1 {
            return Ok(axum::http::StatusCode::OK);
        }

        // 2. Sort them
        koharu_app::pipeline::support::sort_manga_reading_order(&mut text_nodes, order);

        // 3. Construct the full node order
        let mut new_order = Vec::with_capacity(page.nodes.len());
        let mut sorted_text_iter = text_nodes.into_iter().map(|(_, id)| id);

        for (id, node) in page.nodes.iter() {
            if let NodeKind::Text(_) = &node.kind {
                let sorted_id = sorted_text_iter.next().ok_or_else(|| {
                    ApiError::internal(anyhow::anyhow!("text node count mismatch during reorder"))
                })?;
                new_order.push(sorted_id);
            } else {
                new_order.push(*id);
            }
        }

        // Only return new order if it actually changed
        let changed = page
            .nodes
            .keys()
            .zip(new_order.iter())
            .any(|(old, new)| old != new);

        Ok::<_, ApiError>(if changed { Some(new_order) } else { None })
    }?;

    if let Some(new_order) = new_order_opt {
        tracing::debug!("Applying new order: {:?}", new_order);
        let op = Op::ReorderNodes {
            page: page_id,
            order: new_order,
            prev_order: Vec::new(),
        };
        app.apply(op).map_err(ApiError::internal)?;
    } else {
        tracing::debug!("Order unchanged, skipping Op::ReorderNodes");
    }

    Ok(axum::http::StatusCode::OK)
}
