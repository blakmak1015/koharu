'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Per-series glossary store.
 *
 * The local LLM is stateless — it only sees what is in the prompt for a single
 * translate call and never remembers terminology across pages or chapters. To
 * keep names / special terms / tone consistent across a whole series we let the
 * user maintain named glossaries and inject the active one into the translation
 * system prompt on every run.
 *
 * Storage is purely client-side (localStorage); this is intentionally an
 * additive, fork-only feature that touches no backend protocol. The active
 * glossary text is composed and appended to `customSystemPrompt`, which the
 * Rust side appends to the base manga/target-language prompt (see
 * `koharu-llm/src/prompt.rs`).
 */

export type GlossaryEntry = {
  /** Source term as it appears in the original (e.g. ダイゴ, 巨塔の魔女). */
  source: string
  /** Preferred translation to use consistently (e.g. ไดโกะ). */
  target: string
}

export type Glossary = {
  id: string
  /** Display name — typically the series title. */
  name: string
  entries: GlossaryEntry[]
  /** Freeform tone / context notes appended after the term list. */
  notes?: string
}

type GlossaryState = {
  glossaries: Glossary[]
  activeGlossaryId?: string

  createGlossary: (name: string) => string
  deleteGlossary: (id: string) => void
  renameGlossary: (id: string, name: string) => void
  setActiveGlossary: (id?: string) => void
  setNotes: (id: string, notes: string) => void

  addEntry: (id: string) => void
  updateEntry: (id: string, index: number, patch: Partial<GlossaryEntry>) => void
  removeEntry: (id: string, index: number) => void
}

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `g_${Date.now()}_${Math.random().toString(36).slice(2)}`

const mapGlossary = (list: Glossary[], id: string, fn: (g: Glossary) => Glossary): Glossary[] =>
  list.map((g) => (g.id === id ? fn(g) : g))

export const useGlossaryStore = create<GlossaryState>()(
  persist(
    (set) => ({
      glossaries: [],
      activeGlossaryId: undefined,

      createGlossary: (name) => {
        const id = newId()
        const trimmed = name.trim() || 'Untitled series'
        set((state) => ({
          glossaries: [...state.glossaries, { id, name: trimmed, entries: [] }],
          activeGlossaryId: id,
        }))
        return id
      },

      deleteGlossary: (id) =>
        set((state) => ({
          glossaries: state.glossaries.filter((g) => g.id !== id),
          activeGlossaryId: state.activeGlossaryId === id ? undefined : state.activeGlossaryId,
        })),

      renameGlossary: (id, name) =>
        set((state) => ({
          glossaries: mapGlossary(state.glossaries, id, (g) => ({ ...g, name })),
        })),

      setActiveGlossary: (id) => set({ activeGlossaryId: id }),

      setNotes: (id, notes) =>
        set((state) => ({
          glossaries: mapGlossary(state.glossaries, id, (g) => ({ ...g, notes })),
        })),

      addEntry: (id) =>
        set((state) => ({
          glossaries: mapGlossary(state.glossaries, id, (g) => ({
            ...g,
            entries: [...g.entries, { source: '', target: '' }],
          })),
        })),

      updateEntry: (id, index, patch) =>
        set((state) => ({
          glossaries: mapGlossary(state.glossaries, id, (g) => ({
            ...g,
            entries: g.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)),
          })),
        })),

      removeEntry: (id, index) =>
        set((state) => ({
          glossaries: mapGlossary(state.glossaries, id, (g) => ({
            ...g,
            entries: g.entries.filter((_, i) => i !== index),
          })),
        })),
    }),
    {
      name: 'koharu-glossary',
      partialize: (state) => ({
        glossaries: state.glossaries,
        activeGlossaryId: state.activeGlossaryId,
      }),
    },
  ),
)

/**
 * Render a glossary into the instruction block appended to the system prompt.
 * Returns `undefined` when the glossary has no usable content so we never send
 * an empty section.
 */
export function composeGlossaryPrompt(glossary?: Glossary): string | undefined {
  if (!glossary) return undefined
  const pairs = glossary.entries
    .map((e) => ({ source: e.source.trim(), target: e.target.trim() }))
    .filter((e) => e.source && e.target)
  const notes = glossary.notes?.trim()
  if (pairs.length === 0 && !notes) return undefined

  const lines: string[] = []
  lines.push(
    `Series glossary for "${glossary.name}". Use these translations consistently every time the source term appears; keep names and special terms identical across the whole series:`,
  )
  for (const { source, target } of pairs) {
    lines.push(`- ${source} → ${target}`)
  }
  if (notes) {
    lines.push(`Context notes: ${notes}`)
  }
  return lines.join('\n')
}

/**
 * Compose the final `systemPrompt` to send with a translate pipeline run:
 * the user's freeform custom prompt followed by the active glossary block.
 * Either part may be empty; returns `undefined` when both are.
 */
export function buildSystemPrompt(customSystemPrompt?: string): string | undefined {
  const { glossaries, activeGlossaryId } = useGlossaryStore.getState()
  const active = glossaries.find((g) => g.id === activeGlossaryId)
  const parts = [customSystemPrompt?.trim(), composeGlossaryPrompt(active)].filter(
    (p): p is string => !!p,
  )
  if (parts.length === 0) return undefined
  return parts.join('\n\n')
}
