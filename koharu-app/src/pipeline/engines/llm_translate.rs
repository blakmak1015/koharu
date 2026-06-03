//! LLM-driven translation. Collects `text` from every text node on the page,
//! sends them through the loaded LLM as tagged blocks, writes the parsed
//! translations back via `UpdateNode { TextDataPatch { translation } }`.

use std::collections::HashSet;

use anyhow::Result;
use async_trait::async_trait;
use koharu_core::{
    NodeDataPatch, NodeId, NodeKind, NodePatch, Op, PageId, ReadingOrder, Scene, TextData,
    TextDataPatch,
};

use crate::pipeline::artifacts::Artifact;
use crate::pipeline::engine::{Engine, EngineCtx, EngineInfo};
use crate::pipeline::engines::support::{sort_manga_reading_order, text_nodes};

/// Max number of prior `(source → translation)` pairs fed back to the model as
/// "translation memory". Keeps the added prompt bounded so the context stays
/// small enough to be fast and fit in VRAM.
const MAX_MEMORY_PAIRS: usize = 40;
/// Skip pathologically long lines so one giant block can't dominate the budget.
const MAX_MEMORY_FIELD_CHARS: usize = 200;

pub struct Model;

#[async_trait]
impl Engine for Model {
    async fn run(&self, ctx: EngineCtx<'_>) -> Result<Vec<Op>> {
        let targets = collect_translation_targets(&ctx);
        if targets.is_empty() {
            return Ok(Vec::new());
        }

        let sources: Vec<String> = targets.iter().map(|(_, s)| s.clone()).collect();

        // Cross-page translation memory: the model is stateless and only sees
        // one translate call at a time, so names / terms / character voice
        // drift across a chapter. Feed back the lines already translated
        // elsewhere in the scene as reference so it stays consistent. This is
        // appended to whatever system prompt the UI sent (custom prompt +
        // glossary); `koharu-llm` in turn appends all of it to the base
        // manga/target-language prompt.
        let exclude: HashSet<NodeId> = targets.iter().map(|(id, _)| *id).collect();
        let memory = collect_translation_memory(ctx.scene, &exclude);
        let system_prompt = combine_system_prompt(
            ctx.options.system_prompt.as_deref(),
            format_memory_block(&memory).as_deref(),
        );

        let translations = ctx
            .llm
            .translate_texts(
                &sources,
                ctx.options.target_language.as_deref(),
                system_prompt.as_deref(),
            )
            .await?;

        let mut ops = Vec::with_capacity(targets.len());
        for ((node_id, _), translation) in targets.into_iter().zip(translations) {
            ops.push(Op::UpdateNode {
                page: ctx.page,
                id: node_id,
                patch: NodePatch {
                    data: Some(NodeDataPatch::Text(TextDataPatch {
                        translation: Some(Some(translation)),
                        ..Default::default()
                    })),
                    transform: None,
                    visible: None,
                },
                prev: NodePatch::default(),
            });
        }
        Ok(ops)
    }
}

fn collect_translation_targets(ctx: &EngineCtx<'_>) -> Vec<(NodeId, String)> {
    collect_translation_targets_from(
        ctx.scene,
        ctx.page,
        ctx.options.text_node_ids.as_deref(),
        ctx.options.reading_order,
    )
}

fn collect_translation_targets_from(
    scene: &Scene,
    page: PageId,
    allowed_ids: Option<&[NodeId]>,
    reading_order: Option<ReadingOrder>,
) -> Vec<(NodeId, String)> {
    let mut blocks: Vec<([f32; 4], (NodeId, String))> = text_nodes(scene, page)
        .into_iter()
        .filter(|(id, _, text_data)| should_translate(*id, text_data, allowed_ids))
        .filter_map(|(id, transform, text_data)| {
            let source = text_data.text.as_ref()?;
            let bbox = [
                transform.x,
                transform.y,
                transform.x + transform.width,
                transform.y + transform.height,
            ];
            Some((bbox, (id, source.clone())))
        })
        .collect();

    // Sort by manga reading order so the LLM sees dialogue in narrative
    // sequence. Default to RTL (standard manga) when not specified.
    sort_manga_reading_order(
        &mut blocks,
        reading_order.unwrap_or(ReadingOrder::Rtl),
    );

    blocks.into_iter().map(|(_, pair)| pair).collect()
}

fn should_translate(id: NodeId, text_data: &TextData, allowed_ids: Option<&[NodeId]>) -> bool {
    if let Some(ids) = allowed_ids
        && !ids.contains(&id)
    {
        return false;
    }
    text_data
        .text
        .as_ref()
        .is_some_and(|source| !source.trim().is_empty())
}

/// Collect distinct `(source, translation)` pairs from text nodes anywhere in
/// the scene that have already been translated, excluding the nodes we are
/// about to (re)translate. Pages and nodes iterate in reading order
/// (`IndexMap`), later occurrences win (most recently established wording), and
/// the result is capped to the most recent [`MAX_MEMORY_PAIRS`] while keeping
/// reading order for presentation.
fn collect_translation_memory(scene: &Scene, exclude: &HashSet<NodeId>) -> Vec<(String, String)> {
    let mut all: Vec<(String, String)> = Vec::new();
    for (_, page) in &scene.pages {
        for (id, node) in &page.nodes {
            if exclude.contains(id) {
                continue;
            }
            let NodeKind::Text(text_data) = &node.kind else {
                continue;
            };
            let (Some(source), Some(translation)) =
                (text_data.text.as_ref(), text_data.translation.as_ref())
            else {
                continue;
            };
            let source = source.trim();
            let translation = translation.trim();
            if source.is_empty() || translation.is_empty() {
                continue;
            }
            if source.chars().count() > MAX_MEMORY_FIELD_CHARS
                || translation.chars().count() > MAX_MEMORY_FIELD_CHARS
            {
                continue;
            }
            all.push((source.to_string(), translation.to_string()));
        }
    }

    // Dedup by source, keeping the last occurrence (most recent wording), then
    // keep only the most recent `MAX_MEMORY_PAIRS`, both preserving order.
    let mut seen = HashSet::new();
    let mut deduped: Vec<(String, String)> = Vec::new();
    for (source, translation) in all.into_iter().rev() {
        if seen.insert(source.clone()) {
            deduped.push((source, translation));
        }
    }
    deduped.reverse();
    let start = deduped.len().saturating_sub(MAX_MEMORY_PAIRS);
    deduped.split_off(start)
}

/// Render collected memory into an instruction block, or `None` when empty.
fn format_memory_block(pairs: &[(String, String)]) -> Option<String> {
    if pairs.is_empty() {
        return None;
    }
    let mut block = String::from(
        "Earlier in this same chapter you already produced the translations below. \
         Keep names, places, special terms, and recurring phrases worded exactly the same, \
         and keep each character's established voice and speech style consistent with these. \
         They are reference only — do not output them again:",
    );
    for (source, translation) in pairs {
        block.push('\n');
        block.push_str(source);
        block.push_str(" => ");
        block.push_str(translation);
    }
    Some(block)
}

/// Join the UI-supplied system prompt (custom prompt + glossary) with the
/// translation-memory block. Either part may be absent.
fn combine_system_prompt(base: Option<&str>, memory: Option<&str>) -> Option<String> {
    match (base, memory) {
        (Some(base), Some(memory)) => Some(format!("{base}\n\n{memory}")),
        (Some(base), None) => Some(base.to_string()),
        (None, Some(memory)) => Some(memory.to_string()),
        (None, None) => None,
    }
}

inventory::submit! {
    EngineInfo {
        id: "llm",
        name: "LLM",
        needs: &[Artifact::OcrText],
        produces: &[Artifact::Translations],
        load: |_runtime, _cpu| Box::pin(async move {
            Ok(Box::new(Model) as Box<dyn Engine>)
        }),
    }
}

#[cfg(test)]
mod tests {
    use koharu_core::{Node, NodeKind, Page, PageId, Scene, TextData, Transform};
    use uuid::Uuid;

    use super::*;

    fn node_id(value: u128) -> NodeId {
        NodeId(Uuid::from_u128(value))
    }

    fn page_id() -> PageId {
        PageId(Uuid::from_u128(1))
    }

    fn text_node(id: NodeId, text: Option<&str>) -> Node {
        Node {
            id,
            transform: Transform::default(),
            visible: true,
            kind: NodeKind::Text(TextData {
                text: text.map(str::to_string),
                ..Default::default()
            }),
        }
    }

    fn translated_node(id: NodeId, text: &str, translation: &str) -> Node {
        Node {
            id,
            transform: Transform::default(),
            visible: true,
            kind: NodeKind::Text(TextData {
                text: Some(text.to_string()),
                translation: Some(translation.to_string()),
                ..Default::default()
            }),
        }
    }

    fn scene_with_texts(nodes: Vec<Node>) -> Scene {
        let page_id = page_id();
        let mut page = Page::new("page", 100, 100);
        page.id = page_id;
        page.nodes = nodes.into_iter().map(|node| (node.id, node)).collect();
        let mut scene = Scene::default();
        scene.pages.insert(page_id, page);
        scene
    }

    #[test]
    fn should_translate_only_requested_nodes() {
        let first = node_id(11);
        let second = node_id(22);
        let scene = scene_with_texts(vec![
            text_node(first, Some("first")),
            text_node(second, Some("second")),
        ]);
        let options = crate::PipelineRunOptions {
            text_node_ids: Some(vec![second]),
            ..Default::default()
        };

        let targets =
            collect_translation_targets_from(&scene, page_id(), options.text_node_ids.as_deref(), None);

        assert_eq!(targets, vec![(second, "second".to_string())]);
    }

    #[test]
    fn should_ignore_requested_nodes_without_ocr_text() {
        let blank = node_id(33);
        let scene = scene_with_texts(vec![
            text_node(blank, Some("   ")),
            text_node(node_id(44), Some("translated")),
        ]);
        let options = crate::PipelineRunOptions {
            text_node_ids: Some(vec![blank]),
            ..Default::default()
        };

        let targets =
            collect_translation_targets_from(&scene, page_id(), options.text_node_ids.as_deref(), None);

        assert!(targets.is_empty());
    }

    #[test]
    fn memory_collects_translated_nodes_excluding_targets() {
        let target = node_id(1);
        let scene = scene_with_texts(vec![
            translated_node(node_id(2), "ダイゴ", "ไดโกะ"),
            translated_node(node_id(3), "巨塔の魔女", "แม่มดหอคอยยักษ์"),
            // Not yet translated -> not memory.
            text_node(node_id(4), Some("まだ")),
            // The block we are about to translate -> excluded even if it has a
            // stale translation.
            translated_node(target, "お前は誰だ", "แกเป็นใคร"),
        ]);

        let exclude = HashSet::from([target]);
        let memory = collect_translation_memory(&scene, &exclude);

        assert_eq!(
            memory,
            vec![
                ("ダイゴ".to_string(), "ไดโกะ".to_string()),
                ("巨塔の魔女".to_string(), "แม่มดหอคอยยักษ์".to_string()),
            ]
        );
    }

    #[test]
    fn memory_dedupes_by_source_keeping_most_recent() {
        let scene = scene_with_texts(vec![
            translated_node(node_id(1), "ダイゴ", "ไดโกะ"),
            translated_node(node_id(2), "ダイゴ", "ไดโก้"),
        ]);

        let memory = collect_translation_memory(&scene, &HashSet::new());

        assert_eq!(memory, vec![("ダイゴ".to_string(), "ไดโก้".to_string())]);
    }

    #[test]
    fn memory_block_is_none_when_empty_and_present_otherwise() {
        assert!(format_memory_block(&[]).is_none());

        let block = format_memory_block(&[("ダイゴ".to_string(), "ไดโกะ".to_string())]).unwrap();
        assert!(block.contains("ダイゴ => ไดโกะ"));
        assert!(block.contains("consistent"));
    }

    #[test]
    fn combine_prompt_merges_base_and_memory() {
        assert_eq!(combine_system_prompt(None, None), None);
        assert_eq!(
            combine_system_prompt(Some("glossary"), None).as_deref(),
            Some("glossary")
        );
        assert_eq!(
            combine_system_prompt(None, Some("mem")).as_deref(),
            Some("mem")
        );
        assert_eq!(
            combine_system_prompt(Some("glossary"), Some("mem")).as_deref(),
            Some("glossary\n\nmem")
        );
    }
}
