use anyhow::Result;
use async_trait::async_trait;
use koharu_scene::{Authored, LanguageTag, Origin, SourceText, Translation};
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
        let mut targets = Vec::new();
        if let Some(group) = input.scene.page(input.page)?.text_group()? {
            for layer in group.text_layers()? {
                if !input.contains_entity(layer.id())? {
                    continue;
                }
                let content = layer.content()?;
                let Some(source) = content.source()? else {
                    continue;
                };
                if !source.text.value.trim().is_empty() {
                    targets.push((content.id(), source.text.value));
                }
            }
        }
        let mut request = TranslationRequest::new(
            targets.iter().map(|(_, source)| source.clone()),
            self.config.target_language,
        );
        if let Some(instructions) = self.config.instructions.as_deref() {
            request = request.with_instructions(instructions);
        }
        if Translator::supports_vision(&self.config.model, &self.config.generation)
            && let Some(image) = input.images.get(&input.scene, input.page, "source").await?
        {
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
