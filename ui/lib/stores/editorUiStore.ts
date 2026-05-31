'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { LlmTarget } from '@/lib/api/schemas'
import type { RenderEffect, RenderStroke, ToolMode } from '@/lib/types'

/**
 * Editor UI state (canvas scale, tool mode, layer-visibility toggles, local
 * UI errors). Does **not** hold scene data — that lives in `sceneStore`, and
 * the active page id lives in `selectionStore`.
 */

const ERROR_AUTO_DISMISS_MS = 8000

// This fork ships a Thai-only manga workflow with one bundled local model.
// Default the model selection to it (deterministically, not depending on which
// model happens to be loaded first) and the target language to Thai.
export const DEFAULT_LOCAL_MODEL_ID = 'gemma4-e4b-uncensored'
export const DEFAULT_TARGET_LANGUAGE = 'th-TH'

let dismissTimer: ReturnType<typeof setTimeout> | null = null

const clearDismissTimer = () => {
  if (!dismissTimer) return
  clearTimeout(dismissTimer)
  dismissTimer = null
}

// ---------------------------------------------------------------------------
// Store type
// ---------------------------------------------------------------------------

type EditorUiState = {
  // canvas
  scale: number
  autoFitEnabled: boolean
  setScale: (scale: number) => void
  setAutoFitEnabled: (enabled: boolean) => void

  // layer visibility
  showSegmentationMask: boolean
  showInpaintedImage: boolean
  showBrushLayer: boolean
  showRenderedImage: boolean
  showTextBlocksOverlay: boolean
  setShowSegmentationMask: (show: boolean) => void
  setShowInpaintedImage: (show: boolean) => void
  setShowBrushLayer: (show: boolean) => void
  setShowRenderedImage: (show: boolean) => void
  setShowTextBlocksOverlay: (show: boolean) => void

  // tools
  mode: ToolMode
  setMode: (mode: ToolMode) => void

  // render style defaults (per-session)
  renderEffect: RenderEffect
  renderStroke?: RenderStroke
  setRenderEffect: (effect: RenderEffect) => void
  setRenderStroke: (stroke?: RenderStroke) => void

  // llm ui
  selectedTarget?: LlmTarget
  selectedLanguage?: string
  setSelectedTarget: (target?: LlmTarget) => void
  setSelectedLanguage: (lang?: string) => void

  // ui error
  error?: { id: number; message: string }
  showError: (message: string) => void
  clearError: () => void

  // page navigator panel
  showNavigator: boolean
  setShowNavigator: (show: boolean) => void

  // reading order
  readingOrder: 'rtl' | 'ltr' | 'custom'
  setReadingOrder: (order: 'rtl' | 'ltr' | 'custom') => void
}

const initialState = {
  scale: 100,
  autoFitEnabled: true,
  showSegmentationMask: false,
  showInpaintedImage: false,
  showBrushLayer: false,
  showRenderedImage: false,
  showTextBlocksOverlay: false,
  mode: 'select' as ToolMode,
  renderEffect: { italic: false, bold: false } as RenderEffect,
  renderStroke: undefined as RenderStroke | undefined,
  selectedTarget: {
    kind: 'local',
    modelId: DEFAULT_LOCAL_MODEL_ID,
    providerId: null,
  } as LlmTarget | undefined,
  // Default the translation target to Thai (this fork ships a Thai-only
  // workflow). Without a default koharu falls back to the model's first listed
  // language (e.g. zh-CN/en-US), which silently produced wrong-language output.
  selectedLanguage: DEFAULT_TARGET_LANGUAGE as string | undefined,
  error: undefined as { id: number; message: string } | undefined,
  showNavigator: true,
  readingOrder: 'rtl' as const,
}

export const useEditorUiStore = create<EditorUiState>()(
  persist(
    (set) => ({
      ...initialState,

      setScale: (scale) => {
        const clamped = Math.max(10, Math.min(100, Math.round(scale)))
        set({ scale: clamped })
      },
      setAutoFitEnabled: (enabled) => set({ autoFitEnabled: enabled }),

      setShowSegmentationMask: (show) => set({ showSegmentationMask: show }),
      setShowInpaintedImage: (show) => set({ showInpaintedImage: show }),
      setShowBrushLayer: (show) => set({ showBrushLayer: show }),
      setShowRenderedImage: (show) => set({ showRenderedImage: show }),
      setShowTextBlocksOverlay: (show) => set({ showTextBlocksOverlay: show }),

      setMode: (mode) => {
        set({ mode })
        if (mode === 'repairBrush' || mode === 'brush' || mode === 'eraser') {
          set({ showRenderedImage: false, showInpaintedImage: true })
        }
        if (mode === 'repairBrush') {
          set({
            showTextBlocksOverlay: true,
            showSegmentationMask: true,
            showBrushLayer: false,
          })
        } else if (mode !== 'eraser') {
          set({ showSegmentationMask: false })
          if (mode === 'brush') set({ showBrushLayer: true })
          else if (mode === 'block') set({ showTextBlocksOverlay: true })
        }
      },

      setRenderEffect: (effect) => set({ renderEffect: effect }),
      setRenderStroke: (stroke) => set({ renderStroke: stroke }),

      setSelectedTarget: (selectedTarget) => set({ selectedTarget }),
      setSelectedLanguage: (selectedLanguage) => set({ selectedLanguage }),

      showError: (message) => {
        clearDismissTimer()
        set({ error: { id: Date.now(), message } })
        dismissTimer = setTimeout(() => {
          dismissTimer = null
          set({ error: undefined })
        }, ERROR_AUTO_DISMISS_MS)
      },
      clearError: () => {
        clearDismissTimer()
        set({ error: undefined })
      },

      setShowNavigator: (show) => set({ showNavigator: show }),

      setReadingOrder: (readingOrder) => set({ readingOrder }),
    }),
    {
      name: 'koharu-editor-ui',
      // Bump when the bundled-default model changes so already-persisted
      // selections (e.g. the previous qwen default) migrate forward instead of
      // pinning users to a model this fork no longer recommends.
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as
          | {
              selectedTarget?: LlmTarget
              selectedLanguage?: string
              readingOrder?: 'rtl' | 'ltr' | 'custom'
            }
          | undefined
        if (!state) return undefined
        let selectedTarget = state.selectedTarget
        // v0 shipped qwen3.5-9b-uncensored as the default. It overflows 8GB
        // VRAM on the target GPU and produced poor/untranslated output, so
        // forward any leftover qwen default selection to the gemma default.
        if (
          version < 1 &&
          selectedTarget?.kind === 'local' &&
          selectedTarget.modelId === 'qwen3.5-9b-uncensored'
        ) {
          selectedTarget = {
            kind: 'local',
            modelId: DEFAULT_LOCAL_MODEL_ID,
            providerId: null,
          }
        }
        return {
          selectedTarget,
          selectedLanguage: state.selectedLanguage,
          readingOrder: state.readingOrder ?? 'rtl',
        }
      },
      partialize: (state) => ({
        selectedTarget: state.selectedTarget,
        selectedLanguage: state.selectedLanguage,
        readingOrder: state.readingOrder,
      }),
    },
  ),
)
