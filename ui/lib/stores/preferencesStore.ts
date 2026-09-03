'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { getPlatform } from '@/lib/shortcutUtils'

type PreferencesState = {
  brushConfig: {
    size: number
    color: string
  }
  setBrushConfig: (config: Partial<PreferencesState['brushConfig']>) => void
  defaultFont?: string
  setDefaultFont: (font?: string) => void
  /** Corner where the "manga-th.net" watermark is baked into uploaded pages. */
  watermarkCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  setWatermarkCorner: (corner: PreferencesState['watermarkCorner']) => void
  /** How many pages the translation agent processes at once. 1 = sequential.
   *  Higher fills GPU idle gaps (a single page doesn't saturate the GPU). */
  agentPageConcurrency: number
  setAgentPageConcurrency: (n: number) => void
  favoriteFonts: string[]
  toggleFavoriteFont: (font: string) => void
  customSystemPrompt?: string
  setCustomSystemPrompt: (prompt?: string) => void
  codexImagePrompt?: string
  setCodexImagePrompt: (prompt?: string) => void
  codexImageModel?: string
  setCodexImageModel: (model?: string) => void
  shortcuts: {
    select: string
    block: string
    brush: string
    eraser: string
    repairBrush: string
    increaseBrushSize: string
    decreaseBrushSize: string
    undo: string
    redo: string
  }
  setShortcuts: (shortcuts: Partial<PreferencesState['shortcuts']>) => void
  resetShortcuts: () => void
  resetPreferences: () => void
}

const initialPreferences = {
  brushConfig: {
    size: 36,
    color: '#ffffff',
  },
  favoriteFonts: [],
  watermarkCorner: 'top-right' as const,
  agentPageConcurrency: 2,
  shortcuts: {
    select: 'V',
    block: 'M',
    brush: 'B',
    eraser: 'E',
    repairBrush: 'R',
    increaseBrushSize: ']',
    decreaseBrushSize: '[',
    undo: getPlatform() === 'mac' ? 'Cmd+Z' : 'Ctrl+Z',
    redo: getPlatform() === 'mac' ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z',
  },
  codexImagePrompt:
    'Translate all visible text to natural English, remove the original lettering, and redraw the page as a clean manga image while preserving the artwork, panel layout, speech bubbles, tone, and composition.',
  codexImageModel: 'gpt-5.5',
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      ...initialPreferences,
      setBrushConfig: (config) =>
        set((state) => ({
          brushConfig: {
            ...state.brushConfig,
            ...config,
          },
        })),
      setDefaultFont: (font) => set({ defaultFont: font }),
      setWatermarkCorner: (corner) => set({ watermarkCorner: corner }),
      setAgentPageConcurrency: (n) =>
        set({ agentPageConcurrency: Math.max(1, Math.min(6, Math.floor(n) || 1)) }),
      toggleFavoriteFont: (font) =>
        set((state) => ({
          favoriteFonts: state.favoriteFonts.includes(font)
            ? state.favoriteFonts.filter((f) => f !== font)
            : [...state.favoriteFonts, font],
        })),
      setCustomSystemPrompt: (prompt) => set({ customSystemPrompt: prompt }),
      setCodexImagePrompt: (prompt) => set({ codexImagePrompt: prompt }),
      setCodexImageModel: (model) => set({ codexImageModel: model }),
      setShortcuts: (shortcuts) =>
        set((state) => ({
          shortcuts: {
            ...state.shortcuts,
            ...shortcuts,
          },
        })),
      resetShortcuts: () =>
        set(() => ({
          shortcuts: {
            ...initialPreferences.shortcuts,
          },
        })),
      resetPreferences: () => set({ ...initialPreferences }),
    }),
    {
      name: 'koharu-config',
      version: 6,
      migrate: (persisted: any, version: number) => {
        if (version < 2 && persisted) {
          delete persisted.localLlm
          delete persisted.openAiCompatibleConfigVersion
        }
        if (version < 3 && persisted) {
          delete persisted.apiKeys
          delete persisted.providerBaseUrls
          delete persisted.providerModelNames
        }
        if (version < 4 && persisted?.shortcuts) {
          for (const key in persisted.shortcuts) {
            const val = persisted.shortcuts[key]
            if (typeof val === 'string' && val.length === 1) {
              persisted.shortcuts[key] = val.toUpperCase()
            }
          }
        }
        if (version < 5 && persisted?.shortcuts) {
          const isMac = getPlatform() === 'mac'
          if (!persisted.shortcuts.undo) {
            persisted.shortcuts.undo = isMac ? 'Cmd+Z' : 'Ctrl+Z'
          }
          if (!persisted.shortcuts.redo) {
            persisted.shortcuts.redo = isMac ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Z'
          }
        }
        if (version < 6 && persisted) {
          persisted.codexImagePrompt ??= initialPreferences.codexImagePrompt
          persisted.codexImageModel ??= initialPreferences.codexImageModel
        }
        return persisted
      },
      partialize: (state) => ({
        brushConfig: state.brushConfig,
        defaultFont: state.defaultFont,
        watermarkCorner: state.watermarkCorner,
        agentPageConcurrency: state.agentPageConcurrency,
        favoriteFonts: state.favoriteFonts,
        customSystemPrompt: state.customSystemPrompt,
        codexImagePrompt: state.codexImagePrompt,
        codexImageModel: state.codexImageModel,
        shortcuts: state.shortcuts,
      }),
    },
  ),
)
