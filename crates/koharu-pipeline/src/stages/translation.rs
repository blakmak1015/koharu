use anyhow::Result;
use async_trait::async_trait;
use koharu_scene::{
    Authored, EntityId, LanguageTag, Origin, RegionSpec, SourceText, Translation,
};
use koharu_translator::{TranslationRequest, Translator};

use crate::TranslationConfig;

use super::{StageInput, StageProcessor, finish, generation};

const PRODUCER: &str = "dev.koharu.pipeline.translation";

pub(super) struct Processor {
    config: TranslationConfig,
    translator: Translator,
}

impl Processor {
    pub(super) fn new(config: TranslationConfig, translator: Translator) -> Self {
        Self { config, translator }
    }
}

/// Keep what the model read off the page, one entry per bubble it could name.
///
/// Reads the existing typography and changes one key. Writing a fresh one would
/// set `auto_fit` to false and silently stop every one of these bubbles being
/// fitted to its balloon - the field defaults the wrong way for this purpose.
fn record_speakers(
    input: &StageInput,
    edit: &mut koharu_scene::Edit,
    layers: &[EntityId],
    speakers: &[String],
) -> Result<()> {
    for (layer, speaker) in layers.iter().zip(speakers) {
        let speaker = speaker.trim();
        if speaker.is_empty() || speaker.to_ascii_lowercase().starts_with("unknown") {
            continue;
        }
        edit.observe::<koharu_scene::Typography>(*layer)?;
        let mut typography = input
            .scene
            .component::<koharu_scene::Typography>(*layer)?
            .unwrap_or(koharu_scene::Typography {
                origin: Origin::Generated(generation(PRODUCER, "speaker")?),
                preferred_font: None,
                font_weight: None,
                font_style: None,
                size: None,
                auto_fit: true,
                color: None,
                stroke_color: None,
                stroke_width: None,
                alignment: None,
                writing_mode: None,
                extensions: Default::default(),
            });
        typography
            .extensions
            .insert(crate::SPEAKER_KEY.to_owned(), speaker.to_owned());
        edit.set(*layer, &typography)?;
    }
    Ok(())
}

/// Every panel on the page, as bounding boxes in reading order.
///
/// Returned empty when the detector found none, which is the signal to fall
/// back to ordering the bubbles on their own.
fn page_panels(input: &StageInput) -> Result<Vec<Bounds>> {
    let mut panels = Vec::new();
    for entity in input.scene.descendants(input.page)? {
        let Some(region) = entity.component::<koharu_scene::Region>()? else {
            continue;
        };
        if region.kind.as_str() != koharu_scene::PanelRegion::KIND {
            continue;
        }
        let Some(geometry) = entity.component::<koharu_scene::Geometry>()? else {
            continue;
        };
        if let Some(bounds) = bounds_of(&geometry) {
            panels.push(bounds);
        }
    }
    // Panels are read the same way bubbles are: down the page, right first.
    panels.sort_by(|left, right| {
        if (left.top - right.top).abs() <= (left.bottom - left.top) * 0.5 {
            right.right.total_cmp(&left.right)
        } else {
            left.top.total_cmp(&right.top)
        }
    });
    Ok(panels)
}

#[derive(Clone, Copy)]
struct Bounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Bounds {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.left && x <= self.right && y >= self.top && y <= self.bottom
    }
}

fn bounds_of(geometry: &koharu_scene::Geometry) -> Option<Bounds> {
    let xs = geometry.points.iter().map(|point| point.x);
    let ys = geometry.points.iter().map(|point| point.y);
    let left = xs.clone().fold(f64::INFINITY, f64::min);
    let right = xs.fold(f64::NEG_INFINITY, f64::max);
    let top = ys.clone().fold(f64::INFINITY, f64::min);
    let bottom = ys.fold(f64::NEG_INFINITY, f64::max);
    (left.is_finite() && top.is_finite()).then_some(Bounds { left, top, right, bottom })
}

/// Put a page's bubbles in the order a reader meets them.
///
/// They arrive in the order the detector found them, which lands on manga
/// reading order about three times in four - measured at 75-79% of consecutive
/// pairs on published chapters, against the 50% pure chance would give.
///
/// That matters more than it sounds. 65% of the Japanese lines on those
/// chapters do not end a sentence: they run on into the next bubble. The model
/// is handed every line of a page at once and can only join them if they arrive
/// in the order they are read, and a pair arriving backwards joins the wrong
/// halves - which is what "the sentences do not flow" looks like from outside.
///
/// Manga is read panel by panel, not row by row across the whole page, and
/// banding by height alone got to 86%: a tall panel on the right and a short
/// one on the left fall into different bands and swap. So bubbles are grouped
/// into the panel that holds them first, and only ordered by position within
/// it. Bubbles outside every panel, and pages where no panel was detected, fall
/// back to the banding on its own.
fn sort_into_reading_order(
    placed: &mut [(EntityId, EntityId, String, Option<(f64, f64)>)],
    panels: &[Bounds],
    page_height: f64,
) {
    let band = (page_height * 0.04).max(1.0);
    let panel_of = |corner: Option<(f64, f64)>| {
        corner.and_then(|(x, y)| panels.iter().position(|panel| panel.contains(x, y)))
    };
    placed.sort_by(|left, right| {
        let (left_panel, right_panel) = (panel_of(left.3), panel_of(right.3));
        match (left_panel, right_panel) {
            (Some(a), Some(b)) if a != b => return a.cmp(&b),
            _ => {}
        }
        match (left.3, right.3) {
            (Some((left_x, left_y)), Some((right_x, right_y))) => {
                if (left_y - right_y).abs() <= band {
                    // same row: the rightmost bubble is read first
                    right_x.total_cmp(&left_x)
                } else {
                    left_y.total_cmp(&right_y)
                }
            }
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
    });
}

/// Turns speaker attribution on for one series.
///
/// The pipeline knows about pages and projects, never about which manga it is
/// working on, so the series-level decision has to arrive from the agent, which
/// does know. It travels in the instructions because that is already the
/// channel the agent writes per chapter, alongside the glossary. The marker is
/// stripped before the model ever sees it.
const SPEAKER_FLAG: &str = "[speaker-attribution: on]";

/// What the model is asked when it is shown the page and the lines on it.
///
/// Kept in romaji and plain English on purpose: a prompt that spells out
/// Japanese words teaches the model to echo them, which is how Japanese began
/// leaking into Thai output once before.
const SPEAKER_PROMPT: &str = "You are looking at one page of a Japanese manga, which reads right to left. Each numbered line below is the text of one speech bubble or caption on that page.

For each line answer with who says it, in one of these forms:
  male - two or three words describing them, or their name if the page gives one
  female - the same
  unknown

Answer unknown whenever the page does not show it: narration, a sign, a bubble with nobody beside it, or a face you cannot read. Do not infer it from the wording, the topic or the tone - a wrong answer here is worse than no answer. Give exactly one answer per numbered line, in the same order, and nothing else.";

impl Processor {
    /// Ask the model who speaks each line, from the page itself.
    ///
    /// Same picture and same lines as the translation call, so the reply comes
    /// back one answer per line without touching the response schema.
    async fn attribute_speakers(
        &self,
        targets: &[(EntityId, String)],
        image: std::sync::Arc<image::DynamicImage>,
    ) -> Result<Vec<String>> {
        let request = TranslationRequest::new(
            targets.iter().map(|(_, source)| source.clone()),
            self.config.target_language,
        )
        .with_instructions(SPEAKER_PROMPT)
        .with_image(image);
        let (_, answers) = self
            .translator
            .translate(&self.config.model, self.config.generation, request)
            .await?;
        Ok(answers)
    }
}

/// Put the page's speakers under the standing instructions, if any were read.
///
/// Ranked below the speaker's own words deliberately: Japanese that says ore or
/// atashi is evidence from the person talking, while a face beside a bubble is
/// an interpretation, and the two disagree often enough to matter.
fn compose_instructions(base: Option<&str>, speakers: &[String]) -> Option<String> {
    let known = |answer: &String| {
        let answer = answer.trim().to_ascii_lowercase();
        !answer.is_empty() && !answer.starts_with("unknown")
    };
    if !speakers.iter().any(known) {
        return base.map(|value| value.replace(SPEAKER_FLAG, "").trim().to_owned());
    }
    let mut out = String::new();
    if let Some(base) = base {
        out.push_str(base.replace(SPEAKER_FLAG, "").trim());
        out.push_str("

");
    }
    out.push_str("Who speaks each line on this page, read from the picture, in the same order as the lines you are given. A line naming a gender here is evidence of that speaker's gender - weaker than the speaker's own Japanese words, stronger than anything else. A line marked unknown is no evidence at all.
");
    for (index, speaker) in speakers.iter().enumerate() {
        out.push_str(&format!("{}. {}
", index + 1, speaker.trim()));
    }
    Some(out)
}

#[async_trait]
impl StageProcessor for Processor {
    fn model(&self) -> &'static str {
        Translator::model(&self.config.model)
    }

    fn unload(&self) -> bool {
        self.translator.unload()
    }

    async fn load(&self) -> Result<()> {
        self.translator.load_model(&self.config.model).await
    }

    async fn process(&self, input: StageInput) -> Result<koharu_scene::Patch> {
        let page_size = input.scene.page(input.page)?.page()?;
        let mut placed = Vec::new();
        if let Some(group) = input.scene.page(input.page)?.text_group()? {
            for layer in group.text_layers()? {
                if !input.contains_entity(layer.id())? {
                    continue;
                }
                let content = layer.content()?;
                let Some(source) = content.source()? else {
                    continue;
                };
                if source.text.value.trim().is_empty() {
                    continue;
                }
                let corner = layer.frame()?.map(|geometry| {
                    let xs = geometry.points.iter().map(|point| point.x);
                    let ys = geometry.points.iter().map(|point| point.y);
                    (
                        xs.fold(f64::NEG_INFINITY, f64::max),
                        ys.fold(f64::INFINITY, f64::min),
                    )
                });
                placed.push((content.id(), layer.id(), source.text.value, corner));
            }
        }
        let panels = page_panels(&input)?;
        sort_into_reading_order(&mut placed, &panels, page_size.height);
        let layers: Vec<EntityId> = placed.iter().map(|(_, layer, _, _)| *layer).collect();
        let targets: Vec<(EntityId, String)> = placed
            .into_iter()
            .map(|(entity, _, source, _)| (entity, source))
            .collect();
        let page_image = if Translator::supports_vision(&self.config.model, &self.config.generation)
        {
            input.images.get(&input.scene, input.page, "source").await?
        } else {
            None
        };

        // Who says each line, read off the page before anything is translated.
        //
        // The model is handed the same picture and the same lines, and answers
        // once per line, which is the shape this request already returns. It is
        // a separate call on purpose: folding the question into the translation
        // would mean changing the reply's schema, and the last time that prompt
        // was altered the model started echoing Japanese into the output.
        //
        // Nothing here can fail a page. Attribution missing means the particle
        // rule falls back to its default of writing none, which is the correct
        // answer when nobody knows who is speaking.
        let enabled = self
            .config
            .instructions
            .as_deref()
            .is_some_and(|value| value.contains(SPEAKER_FLAG));
        let speakers = match (&page_image, enabled) {
            (Some(image), true) => {
                self.attribute_speakers(&targets, image.clone())
                    .await
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        };

        let instructions = compose_instructions(self.config.instructions.as_deref(), &speakers);
        let mut request = TranslationRequest::new(
            targets.iter().map(|(_, source)| source.clone()),
            self.config.target_language,
        );
        if let Some(instructions) = instructions.as_deref() {
            request = request.with_instructions(instructions);
        }
        if let Some(image) = page_image {
            request = request.with_image(image);
        }
        let (provider, translated) = self
            .translator
            .translate(&self.config.model, self.config.generation, request)
            .await?;
        let language = LanguageTag::new(self.config.target_language.tag())?;
        let generated = generation(PRODUCER, provider)?;
        let mut edit = input.scene.edit_as(generated.clone());
        for (entity, _) in &targets {
            edit.observe::<SourceText>(*entity)?;
            edit.observe::<Translation>(*entity)?;
        }
        record_speakers(&input, &mut edit, &layers, &speakers)?;
        for ((entity, source), text) in targets.into_iter().zip(translated) {
            if input
                .scene
                .component::<Translation>(entity)?
                .is_some_and(|value| matches!(value.text.origin, Origin::User))
            {
                continue;
            }
            let text = if source.trim() == "\u{2026}" {
                "\u{2026}".to_owned()
            } else {
                collapse_ellipsis(&text)
            };
            edit.set(
                entity,
                &Translation {
                    text: Authored::generated(text, generated.clone()),
                    language: Some(language.clone()),
                },
            )?;
        }
        finish(edit)
    }
}

/// Collapse a run of ellipsis dots to three.
///
/// Japanese sets several ellipsis characters in a row for pacing and the model
/// carries the run into Thai, where it reads as a stutter rather than a pause.
/// Asking for this in the prompt worked only sometimes - the first chapter
/// translated after the rule went live still had five blocks carrying six and
/// nine dots - and a transform this mechanical has no sometimes.
///
/// Dots only. "!!" and "!?" are emphasis the source means and are left exactly
/// as they came. A run already worth three dots or fewer is untouched, so a
/// lone ellipsis character stays itself.
fn collapse_ellipsis(text: &str) -> String {
    let weight = |c: char| match c {
        '.' => 1,
        '\u{2026}' => 3,
        _ => 0,
    };
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let mut dots = 0;
    for character in text.chars() {
        let value = weight(character);
        if value > 0 {
            run.push(character);
            dots += value;
            continue;
        }
        if dots > 3 {
            out.push_str("...");
        } else {
            out.push_str(&run);
        }
        run.clear();
        dots = 0;
        out.push(character);
    }
    if dots > 3 {
        out.push_str("...");
    } else {
        out.push_str(&run);
    }
    out
}
