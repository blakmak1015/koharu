use std::sync::{Arc, Mutex};

use super::{StageInput, StageProcessor, finish, generation};
use crate::{ModelCell, OcrModel, scope::geometry_extents};
use anyhow::{Context as _, Result, anyhow, bail};
use async_trait::async_trait;
use image::DynamicImage;
use koharu_ml::{
    baberu_ocr::BaberuOcr, hayai_ocr::HayaiOcr, manga_ocr::MangaOcr,
    paddle_ocr_vl::PaddleOCRVLTask, paddle_ocr_vl_quantized::PaddleOCRVLQuantized,
};
use koharu_scene::{
    Authored, EntityId, Geometry, LanguageTag, OcrAnalysis, Origin, RecognizedFrom, Region,
    RegionSpec, SourceText, TextDirection, TextRegion,
};

const PRODUCER: &str = "dev.koharu.pipeline.ocr";

pub(super) struct Processor {
    config: OcrModel,
    device: koharu_ml::Device,
    model: ModelCell<Model>,
}

impl Processor {
    pub(super) fn new(config: OcrModel, device: koharu_ml::Device) -> Self {
        Self {
            config,
            device,
            model: ModelCell::new(),
        }
    }
}

#[async_trait]
impl StageProcessor for Processor {
    fn model(&self) -> &'static str {
        match self.config {
            OcrModel::MangaOcr => "manga-ocr",
            OcrModel::BaberuOcr => "baberu-ocr",
            OcrModel::HayaiOcr => "hayai-ocr",
            OcrModel::PaddleOcrVl1_6 => "paddleocr-vl-1.6",
        }
    }

    fn unload(&self) -> bool {
        self.model.unload()
    }

    async fn load(&self) -> Result<()> {
        self.model
            .ensure(|| Model::load(self.device.clone(), &self.config))
            .await
    }

    async fn process(&self, input: StageInput) -> Result<koharu_scene::Patch> {
        self.model
            .lock()
            .await
            .as_ref()
            .ok_or_else(|| anyhow!("OCR model is not loaded"))?
            .run(input)
            .await
    }
}

enum Model {
    Manga(Arc<Mutex<MangaOcr>>),
    Baberu(Arc<Mutex<BaberuOcr>>),
    Hayai(Arc<Mutex<HayaiOcr>>),
    Paddle(Arc<Mutex<PaddleOCRVLQuantized>>),
}

impl Model {
    async fn load(device: koharu_ml::Device, config: &OcrModel) -> Result<Self> {
        match config {
            OcrModel::MangaOcr => Ok(Self::Manga(Arc::new(Mutex::new(
                MangaOcr::load(device).await?,
            )))),
            OcrModel::BaberuOcr => Ok(Self::Baberu(Arc::new(Mutex::new(
                BaberuOcr::load(device).await?,
            )))),
            OcrModel::HayaiOcr => Ok(Self::Hayai(Arc::new(Mutex::new(
                HayaiOcr::load(device).await?,
            )))),
            OcrModel::PaddleOcrVl1_6 => Ok(Self::Paddle(Arc::new(Mutex::new(
                PaddleOCRVLQuantized::load(device).await?,
            )))),
        }
    }

    async fn run(&self, input: StageInput) -> Result<koharu_scene::Patch> {
        let model_name = match self {
            Self::Manga(_) => "manga-ocr",
            Self::Baberu(_) => "baberu-ocr",
            Self::Hayai(_) => "hayai-ocr",
            Self::Paddle(_) => "paddleocr-vl-1.6",
        };
        let page = input.page;
        let mut targets = Vec::new();
        let source = input
            .images
            .get(&input.scene, page, "source")
            .await?
            .ok_or_else(|| anyhow!("page {page} has no source image"))?;
        for entity in input.scene.descendants(page)? {
            let region = entity.id();
            if !input.contains_entity(region)? {
                continue;
            }
            let is_text_region = input
                .scene
                .component::<Region>(region)?
                .is_some_and(|value| value.kind == TextRegion::kind());
            if !is_text_region {
                continue;
            }
            let geometry = input
                .scene
                .component::<Geometry>(region)?
                .ok_or_else(|| anyhow!("text region {region} has no geometry"))?;
            let images = ocr_inputs(&source, &geometry)
                .with_context(|| format!("text region {region} is outside its source image"))?;
            for relation in input.scene.relations_to_as::<RecognizedFrom>(region) {
                let content = relation.value().source;
                let previous = input.scene.component::<SourceText>(content)?;
                if previous
                    .as_ref()
                    .is_some_and(|value| matches!(value.text.origin, Origin::User))
                {
                    continue;
                }
                targets.push(OcrTarget {
                    content,
                    region,
                    geometry: geometry.clone(),
                    previous,
                    images: images.clone(),
                });
            }
        }

        let results = match self {
            Self::Manga(model) => {
                infer_text(model.clone(), targets, |model, image| {
                    model.inference(image)
                })
                .await?
            }
            Self::Baberu(model) => {
                infer_text(model.clone(), targets, |model, image| {
                    model.inference(image)
                })
                .await?
            }
            Self::Hayai(model) => {
                infer_text(model.clone(), targets, |model, image| {
                    model.inference(image)
                })
                .await?
            }
            Self::Paddle(model) => {
                infer_text(model.clone(), targets, |model, image| {
                    Ok(model.inference(image, PaddleOCRVLTask::Ocr)?.text)
                })
                .await?
            }
        };

        let generation = generation(PRODUCER, model_name)?;
        let mut edit = input.scene.edit_as(generation.clone());
        edit.observe_assets(page)?;
        for result in &results {
            edit.observe::<Region>(result.region)?;
            edit.observe::<Geometry>(result.region)?;
            edit.observe::<SourceText>(result.content)?;
        }
        for result in results {
            let language = result
                .previous
                .and_then(|value| value.language)
                .or_else(|| LanguageTag::new("ja-JP").ok());
            let (min_x, min_y, max_x, max_y) = geometry_extents(&result.geometry)
                .ok_or_else(|| anyhow!("text region {} has empty geometry", result.region))?;
            // An empty source is never translated or published; inpainting still
            // erases the printed number from the page.
            let text = if is_page_number(&result.text, (min_y + max_y) / 2.0, source.height()) {
                String::new()
            } else {
                result.text
            };
            edit.set(
                result.content,
                &SourceText {
                    text: Authored::generated(text, generation.clone()),
                    language,
                },
            )?;
            edit.set(
                result.region,
                &OcrAnalysis {
                    origin: Origin::Generated(generation.clone()),
                    direction: if max_y - min_y >= (max_x - min_x) * 1.15 {
                        TextDirection::Vertical
                    } else {
                        TextDirection::Horizontal
                    },
                    confidence: None,
                    line_boundaries: Vec::new(),
                },
            )?;
        }
        finish(edit)
    }
}

struct OcrTarget {
    content: EntityId,
    region: EntityId,
    geometry: Geometry,
    previous: Option<SourceText>,
    /// Read in order and concatenated; one image unless the region is a long strip.
    images: Vec<DynamicImage>,
}

struct OcrResult {
    content: EntityId,
    region: EntityId,
    geometry: Geometry,
    previous: Option<SourceText>,
    text: String,
}

async fn infer_text<M: Send + 'static>(
    model: Arc<Mutex<M>>,
    targets: Vec<OcrTarget>,
    inference: impl Fn(&M, &DynamicImage) -> Result<String> + Send + Sync + 'static,
) -> Result<Vec<OcrResult>> {
    tokio_rayon::spawn(move || {
        let model = model
            .lock()
            .map_err(|_| anyhow!("OCR model lock is poisoned"))?;
        targets
            .into_iter()
            .map(|target| {
                let text = target
                    .images
                    .iter()
                    .map(|image| inference(&model, image))
                    .collect::<Result<String>>()?;
                Ok(OcrResult {
                    content: target.content,
                    region: target.region,
                    geometry: target.geometry,
                    previous: target.previous,
                    text: normalize_ocr_text(text),
                })
            })
            .collect()
    })
    .await
}

// Manga OCR can emit replacement-box glyphs for an isolated Japanese ellipsis.
// Normalize only an all-placeholder sequence so ordinary OCR output is preserved.
fn normalize_ocr_text(text: String) -> String {
    let visible = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<Vec<_>>();
    if visible.len() >= 2
        && visible
            .iter()
            .all(|character| matches!(character, '☐' | '□' | '▢' | '▣' | '�'))
    {
        "…".to_owned()
    } else {
        text
    }
}

/// A scan's printed page number: up to four digits centred in the top or bottom
/// 12% of the page. The 2026-10-30 audit found 16 in 11 chapters, all in the
/// bottom band; digits inside the artwork sit further in and are kept.
fn is_page_number(text: &str, center_y: f64, page_height: u32) -> bool {
    let text = text.trim();
    let band = f64::from(page_height) * 0.12;
    (1..=4).contains(&text.chars().count())
        && text
            .chars()
            .all(|c| c.is_ascii_digit() || ('０'..='９').contains(&c))
        && (center_y < band || center_y > f64::from(page_height) - band)
}

// Crop-level OCR models are trained on bubble-sized crops. On a strip whose long
// side is many times its short side (chapter recap, disclaimer, running header,
// magazine notice) Hayai returned fluent nonsense for ~65% of such regions in a
// 2026-10-30 audit of 11 farm chapters, against ~3% for ordinary bubbles, while
// its glyphs were already 32-48 px after resizing. Strips are therefore read as
// short pieces, or with surrounding context; every other region keeps the tight
// crop it always had.
const STRIP_ASPECT: f64 = 8.0;
const STRIP_MARGIN: u32 = 8;
/// A horizontal line longer than this many line heights is read in pieces.
const LONG_LINE: u32 = 13;
/// Target piece length, in line heights (roughly glyphs).
const PIECE: u32 = 10;
/// Luma below this is ink; a row with ink in more than 1% of its pixels is text.
const INK: u8 = 110;

fn ocr_inputs(source: &DynamicImage, geometry: &Geometry) -> Result<Vec<DynamicImage>> {
    let (min_x, min_y, max_x, max_y) =
        geometry_extents(geometry).ok_or_else(|| anyhow!("geometry is empty"))?;
    let (width, height) = (max_x - min_x, max_y - min_y);
    let tight = crop(source, geometry, 0)?;
    if width.max(height) < width.min(height) * STRIP_ASPECT {
        return Ok(vec![tight]);
    }
    if width > height
        && let Some(pieces) = line_pieces(&tight)
    {
        return Ok(pieces);
    }
    Ok(vec![crop(source, geometry, STRIP_MARGIN)?])
}

/// Split a horizontal strip into its text lines, dropping ruby (furigana) rows,
/// and cut each line into pieces about `PIECE` glyphs long at the emptiest
/// column near each cut. `None` when no line is long enough to need it, or the
/// strip has no dark-on-light lines to find (white text on black).
fn line_pieces(strip: &DynamicImage) -> Option<Vec<DynamicImage>> {
    let gray = strip.to_luma8();
    let (width, height) = gray.dimensions();
    let inked = |y: u32| {
        (0..width)
            .filter(|&x| gray.get_pixel(x, y)[0] < INK)
            .count()
            * 100
            > width as usize
    };
    let mut bands = Vec::new();
    let mut start = None;
    for y in 0..=height {
        match (y < height && inked(y), start) {
            (true, None) => start = Some(y),
            (false, Some(top)) => {
                bands.push((top, y));
                start = None;
            }
            _ => {}
        }
    }
    // Ruby rows are roughly half the height of the text they annotate.
    let tallest = bands.iter().map(|(top, bottom)| bottom - top).max()?;
    let lines: Vec<(u32, u32)> = bands
        .into_iter()
        .filter(|(top, bottom)| (bottom - top) * 10 >= tallest * 6)
        .map(|(top, bottom)| {
            let pad = (bottom - top) * 15 / 100;
            (top.saturating_sub(pad), (bottom + pad).min(height))
        })
        .collect();
    if !lines
        .iter()
        .any(|(top, bottom)| width > (bottom - top) * LONG_LINE)
    {
        return None;
    }
    let mut pieces = Vec::new();
    for (top, bottom) in lines {
        let line = bottom - top;
        let ink = |x: u32| {
            (top..bottom)
                .filter(|&y| gray.get_pixel(x, y)[0] < INK)
                .count()
        };
        let mut left = 0;
        while width - left > line * PIECE * 13 / 10 {
            let target = left + line * PIECE;
            let cut = (target - line..=(target + line).min(width - 1))
                .min_by_key(|&x| (ink(x), x.abs_diff(target)))
                .unwrap_or(target);
            pieces.push(strip.crop_imm(left, top, cut - left, line));
            left = cut;
        }
        pieces.push(strip.crop_imm(left, top, width - left, line));
    }
    Some(pieces)
}

fn crop(source: &DynamicImage, geometry: &Geometry, margin: u32) -> Result<DynamicImage> {
    let (min_x, min_y, max_x, max_y) =
        geometry_extents(geometry).ok_or_else(|| anyhow!("geometry is empty"))?;
    let margin = f64::from(margin);
    let x = (min_x - margin).floor().max(0.0) as u32;
    let y = (min_y - margin).floor().max(0.0) as u32;
    let right = (max_x + margin)
        .ceil()
        .max(0.0)
        .min(f64::from(source.width())) as u32;
    let bottom = (max_y + margin)
        .ceil()
        .max(0.0)
        .min(f64::from(source.height())) as u32;
    if right <= x || bottom <= y {
        bail!("geometry does not overlap the image");
    }
    Ok(source.crop_imm(x, y, right - x, bottom - y))
}

#[cfg(test)]
mod tests {
    use super::{is_page_number, line_pieces, normalize_ocr_text, ocr_inputs};

    #[test]
    fn page_numbers_are_digits_at_the_top_or_bottom() {
        assert!(is_page_number("284", 1500.0, 1600));
        assert!(is_page_number("２６２", 60.0, 1600));
        assert!(!is_page_number("10", 590.0, 1600));
        assert!(!is_page_number("第3話", 1500.0, 1600));
        assert!(!is_page_number("12345", 1500.0, 1600));
    }
    use image::{DynamicImage, GrayImage, Luma};
    use koharu_scene::Geometry;

    /// White page with black square "glyphs" `size` px tall in each `(top, size, count)` line.
    fn page(width: u32, height: u32, lines: &[(u32, u32, u32)]) -> DynamicImage {
        let mut image = GrayImage::from_pixel(width, height, Luma([255]));
        for &(top, size, count) in lines {
            for glyph in 0..count {
                let left = 4 + glyph * (size + size / 4);
                for y in top..top + size {
                    for x in left..left + size {
                        image.put_pixel(x, y, Luma([0]));
                    }
                }
            }
        }
        DynamicImage::ImageLuma8(image)
    }

    #[test]
    fn bubbles_keep_one_tight_crop() {
        let source = page(400, 400, &[(10, 20, 3)]);
        let inputs = ocr_inputs(&source, &Geometry::rectangle(10.0, 10.0, 100.0, 150.0)).unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!((inputs[0].width(), inputs[0].height()), (100, 150));
    }

    #[test]
    fn long_line_is_read_in_pieces_without_ruby() {
        // A 40-glyph line of 20 px glyphs under a ruby row of 8 px glyphs.
        let strip = page(1010, 40, &[(2, 8, 20), (14, 20, 40)]);
        let pieces = line_pieces(&strip).unwrap();
        assert_eq!(pieces.len(), 4);
        assert!(pieces.iter().all(|piece| piece.height() < 30));
        assert_eq!(pieces.iter().map(DynamicImage::width).sum::<u32>(), 1010);
    }

    #[test]
    fn short_strip_lines_are_read_whole_with_context() {
        let source = page(400, 100, &[(40, 20, 8)]);
        assert!(line_pieces(&source.crop_imm(0, 38, 210, 24)).is_none());
        let inputs = ocr_inputs(&source, &Geometry::rectangle(0.0, 38.0, 210.0, 24.0)).unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!((inputs[0].width(), inputs[0].height()), (218, 40));
    }

    #[test]
    fn repeated_placeholder_glyphs_are_an_ellipsis() {
        assert_eq!(normalize_ocr_text("☐ ☐ ☐".to_owned()), "…");
        assert_eq!(normalize_ocr_text("□\n□".to_owned()), "…");
    }

    #[test]
    fn ordinary_text_and_single_boxes_are_unchanged() {
        assert_eq!(normalize_ocr_text("待って…".to_owned()), "待って…");
        assert_eq!(normalize_ocr_text("☐".to_owned()), "☐");
    }
}
