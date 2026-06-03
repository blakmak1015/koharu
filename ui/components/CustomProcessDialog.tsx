'use client'

import { PlayIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useScene } from '@/hooks/useScene'
import { getConfig, startPipeline } from '@/lib/api/default/default'
import { buildSystemPrompt } from '@/lib/stores/glossaryStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'

type StepDef = {
  key: string
  label: string
  configKey: string
}

const STEP_DEFS: StepDef[] = [
  { key: 'detector', label: 'Detect text blocks', configKey: 'detector' },
  { key: 'segmenter', label: 'Segment mask', configKey: 'segmenter' },
  { key: 'bubble_segmenter', label: 'Bubble segmenter', configKey: 'bubble_segmenter' },
  { key: 'font_detector', label: 'Font detection', configKey: 'font_detector' },
  { key: 'ocr', label: 'OCR', configKey: 'ocr' },
  { key: 'translator', label: 'Translate (LLM)', configKey: 'translator' },
  { key: 'inpainter', label: 'Inpaint', configKey: 'inpainter' },
  { key: 'renderer', label: 'Render', configKey: 'renderer' },
]

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CustomProcessDialog({ open, onOpenChange }: Props) {
  const { scene } = useScene()
  const pageIds = useMemo(() => (scene ? Object.keys(scene.pages) : []), [scene])
  const pageCount = pageIds.length

  // Pipeline engine IDs from config
  const [engineIds, setEngineIds] = useState<Record<string, string>>({})

  // Step selection (all enabled by default)
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(STEP_DEFS.map((s) => [s.key, true])),
  )

  // Page range (1-indexed for display)
  const [fromPage, setFromPage] = useState(1)
  const [toPage, setToPage] = useState(1)

  // Load config when dialog opens
  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const cfg = await getConfig()
        const p = cfg.pipeline ?? {}
        const ids: Record<string, string> = {}
        for (const step of STEP_DEFS) {
          const val = (p as Record<string, unknown>)[step.configKey]
          if (typeof val === 'string') ids[step.key] = val
        }
        setEngineIds(ids)
      } catch {}
    })()
  }, [open])

  // Reset page range when dialog opens or pages change
  useEffect(() => {
    if (!open) return
    setFromPage(1)
    setToPage(Math.max(pageCount, 1))
  }, [open, pageCount])

  const toggleStep = useCallback((key: string) => {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const selectAll = useCallback(() => {
    setChecked(Object.fromEntries(STEP_DEFS.map((s) => [s.key, true])))
  }, [])

  const selectNone = useCallback(() => {
    setChecked(Object.fromEntries(STEP_DEFS.map((s) => [s.key, false])))
  }, [])

  const handleRun = useCallback(async () => {
    // Collect selected engine IDs in pipeline order
    const steps = STEP_DEFS.filter((s) => checked[s.key] && engineIds[s.key]).map(
      (s) => engineIds[s.key],
    )
    if (steps.length === 0) return

    // Convert 1-indexed range to page IDs
    const from0 = Math.max(0, fromPage - 1)
    const to0 = Math.min(pageIds.length, toPage)
    const selectedPages = pageIds.slice(from0, to0)
    if (selectedPages.length === 0) return

    const editor = useEditorUiStore.getState()
    const prefs = usePreferencesStore.getState()

    const hasTranslator = STEP_DEFS.some(
      (s) => s.key === 'translator' && checked[s.key],
    )

    await startPipeline({
      steps,
      pages: selectedPages,
      targetLanguage: editor.selectedLanguage,
      ...(hasTranslator
        ? {
            systemPrompt: buildSystemPrompt(prefs.customSystemPrompt),
            readingOrder: editor.readingOrder === 'custom' ? undefined : editor.readingOrder,
          }
        : {}),
      defaultFont: prefs.defaultFont,
    })

    onOpenChange(false)
  }, [checked, engineIds, fromPage, toPage, pageIds, onOpenChange])

  const selectedCount = STEP_DEFS.filter((s) => checked[s.key]).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-md'>
        <DialogHeader>
          <DialogTitle>Custom process</DialogTitle>
          <DialogDescription>
            Select which pipeline steps to run and the page range.
          </DialogDescription>
        </DialogHeader>

        {/* Steps */}
        <div className='space-y-2'>
          <div className='flex items-center justify-between'>
            <Label className='text-xs font-medium uppercase text-muted-foreground'>
              Steps ({selectedCount}/{STEP_DEFS.length})
            </Label>
            <div className='flex gap-2'>
              <button
                type='button'
                className='text-[11px] text-primary hover:underline'
                onClick={selectAll}
              >
                All
              </button>
              <button
                type='button'
                className='text-[11px] text-primary hover:underline'
                onClick={selectNone}
              >
                None
              </button>
            </div>
          </div>
          <div className='grid grid-cols-2 gap-x-4 gap-y-1.5'>
            {STEP_DEFS.map((step) => {
              const available = !!engineIds[step.key]
              return (
                <label
                  key={step.key}
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition hover:bg-accent ${
                    !available ? 'cursor-not-allowed opacity-40' : ''
                  }`}
                >
                  <input
                    type='checkbox'
                    checked={checked[step.key] && available}
                    onChange={() => available && toggleStep(step.key)}
                    disabled={!available}
                    className='size-3.5 rounded accent-primary'
                  />
                  <span>{step.label}</span>
                </label>
              )
            })}
          </div>
        </div>

        {/* Page range */}
        <div className='space-y-2'>
          <Label className='text-xs font-medium uppercase text-muted-foreground'>
            Page range ({pageCount} {pageCount === 1 ? 'page' : 'pages'})
          </Label>
          <div className='flex items-center gap-2'>
            <span className='text-sm text-muted-foreground'>From</span>
            <Input
              type='number'
              min={1}
              max={pageCount}
              value={fromPage}
              onChange={(e) => setFromPage(Math.max(1, Math.min(pageCount, Number(e.target.value) || 1)))}
              className='h-8 w-20 text-center text-sm'
            />
            <span className='text-sm text-muted-foreground'>to</span>
            <Input
              type='number'
              min={1}
              max={pageCount}
              value={toPage}
              onChange={(e) => setToPage(Math.max(1, Math.min(pageCount, Number(e.target.value) || 1)))}
              className='h-8 w-20 text-center text-sm'
            />
            <span className='text-xs text-muted-foreground'>
              ({Math.max(0, Math.min(toPage, pageCount) - Math.max(fromPage - 1, 0))} selected)
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleRun()}
            disabled={selectedCount === 0 || pageCount === 0}
            className='gap-1.5'
          >
            <PlayIcon className='size-3.5' />
            Run ({selectedCount} steps)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
