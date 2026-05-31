'use client'

import { BookMarkedIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useGlossaryStore } from '@/lib/stores/glossaryStore'

/**
 * Editor for per-series glossaries. The active glossary is appended to the
 * translation system prompt so terminology stays consistent across a series'
 * chapters (the model itself does not remember anything between runs).
 */
export function GlossaryDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const glossaries = useGlossaryStore((s) => s.glossaries)
  const activeGlossaryId = useGlossaryStore((s) => s.activeGlossaryId)
  const createGlossary = useGlossaryStore((s) => s.createGlossary)
  const deleteGlossary = useGlossaryStore((s) => s.deleteGlossary)
  const renameGlossary = useGlossaryStore((s) => s.renameGlossary)
  const setActiveGlossary = useGlossaryStore((s) => s.setActiveGlossary)
  const setNotes = useGlossaryStore((s) => s.setNotes)
  const addEntry = useGlossaryStore((s) => s.addEntry)
  const updateEntry = useGlossaryStore((s) => s.updateEntry)
  const removeEntry = useGlossaryStore((s) => s.removeEntry)

  const active = glossaries.find((g) => g.id === activeGlossaryId)
  const entryCount = active?.entries.filter((e) => e.source.trim() && e.target.trim()).length ?? 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          data-testid='glossary-open'
          variant='outline'
          size='sm'
          className='h-6 w-full justify-start gap-1.5 px-2 text-[11px]'
        >
          <BookMarkedIcon className='size-3' />
          {t('glossary.button', { defaultValue: 'Glossary' })}
          {active ? (
            <span className='ml-auto truncate text-muted-foreground'>
              {active.name}
              {entryCount > 0 ? ` (${entryCount})` : ''}
            </span>
          ) : null}
        </Button>
      </DialogTrigger>
      <DialogContent className='max-w-xl' data-testid='glossary-dialog'>
        <DialogHeader>
          <DialogTitle>{t('glossary.title', { defaultValue: 'Series glossary' })}</DialogTitle>
          <DialogDescription>
            {t('glossary.description', {
              defaultValue:
                'Keep names and special terms consistent across a series. The active glossary is added to every translation.',
            })}
          </DialogDescription>
        </DialogHeader>

        {/* Glossary selector + create/delete */}
        <div className='flex items-center gap-1.5'>
          <Select
            value={activeGlossaryId ?? '__none__'}
            onValueChange={(v) => setActiveGlossary(v === '__none__' ? undefined : v)}
          >
            <SelectTrigger data-testid='glossary-select' className='min-w-0 flex-1'>
              <SelectValue
                placeholder={t('glossary.selectPlaceholder', { defaultValue: 'No glossary' })}
              />
            </SelectTrigger>
            <SelectContent position='popper'>
              <SelectItem value='__none__'>
                {t('glossary.none', { defaultValue: 'No glossary (off)' })}
              </SelectItem>
              {glossaries.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            data-testid='glossary-new'
            variant='outline'
            size='sm'
            className='h-9 shrink-0 gap-1'
            onClick={() =>
              createGlossary(t('glossary.newName', { defaultValue: 'New series' }) as string)
            }
          >
            <PlusIcon className='size-3.5' />
            {t('glossary.new', { defaultValue: 'New' })}
          </Button>
          {active ? (
            <Button
              data-testid='glossary-delete'
              variant='ghost'
              size='sm'
              className='h-9 shrink-0 px-2 text-destructive hover:text-destructive'
              onClick={() => deleteGlossary(active.id)}
              aria-label={t('glossary.delete', { defaultValue: 'Delete glossary' }) as string}
            >
              <Trash2Icon className='size-3.5' />
            </Button>
          ) : null}
        </div>

        {active ? (
          <div className='flex flex-col gap-3'>
            {/* Rename */}
            <Input
              data-testid='glossary-name'
              value={active.name}
              onChange={(e) => renameGlossary(active.id, e.target.value)}
              placeholder={t('glossary.namePlaceholder', { defaultValue: 'Series name' })}
              className='h-8 text-sm'
            />

            {/* Term pairs */}
            <div className='flex flex-col gap-1'>
              <div className='flex items-center justify-between'>
                <span className='text-[10px] font-medium text-muted-foreground uppercase'>
                  {t('glossary.terms', { defaultValue: 'Terms' })}
                </span>
                <Button
                  data-testid='glossary-add-entry'
                  variant='ghost'
                  size='xs'
                  className='h-6 gap-1 px-1.5 text-[11px]'
                  onClick={() => addEntry(active.id)}
                >
                  <PlusIcon className='size-3' />
                  {t('glossary.addTerm', { defaultValue: 'Add term' })}
                </Button>
              </div>
              <ScrollArea className='max-h-56'>
                <div className='flex flex-col gap-1.5 pr-2'>
                  {active.entries.length === 0 ? (
                    <p className='py-3 text-center text-xs text-muted-foreground'>
                      {t('glossary.empty', {
                        defaultValue: 'No terms yet. Add a source → target pair.',
                      })}
                    </p>
                  ) : (
                    active.entries.map((entry, index) => (
                      <div key={index} className='flex items-center gap-1.5'>
                        <Input
                          data-testid={`glossary-source-${index}`}
                          value={entry.source}
                          onChange={(e) =>
                            updateEntry(active.id, index, { source: e.target.value })
                          }
                          placeholder={t('glossary.sourcePlaceholder', {
                            defaultValue: 'Source (e.g. ダイゴ)',
                          })}
                          className='h-8 text-sm'
                        />
                        <span className='shrink-0 text-muted-foreground'>→</span>
                        <Input
                          data-testid={`glossary-target-${index}`}
                          value={entry.target}
                          onChange={(e) =>
                            updateEntry(active.id, index, { target: e.target.value })
                          }
                          placeholder={t('glossary.targetPlaceholder', {
                            defaultValue: 'Target (e.g. ไดโกะ)',
                          })}
                          className='h-8 text-sm'
                        />
                        <Button
                          variant='ghost'
                          size='xs'
                          className='h-8 shrink-0 px-1.5 text-muted-foreground hover:text-destructive'
                          onClick={() => removeEntry(active.id, index)}
                          aria-label={
                            t('glossary.removeTerm', { defaultValue: 'Remove term' }) as string
                          }
                        >
                          <Trash2Icon className='size-3.5' />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Notes */}
            <div className='flex flex-col gap-1'>
              <span className='text-[10px] font-medium text-muted-foreground uppercase'>
                {t('glossary.notesLabel', { defaultValue: 'Tone / context notes' })}
              </span>
              <Textarea
                data-testid='glossary-notes'
                value={active.notes ?? ''}
                onChange={(e) => setNotes(active.id, e.target.value)}
                placeholder={t('glossary.notesPlaceholder', {
                  defaultValue: 'e.g. casual tone; characters speak politely',
                })}
                rows={3}
                className='resize-y text-sm'
              />
            </div>
          </div>
        ) : (
          <p className='py-6 text-center text-sm text-muted-foreground'>
            {t('glossary.createPrompt', {
              defaultValue: 'Create a glossary to keep terminology consistent across a series.',
            })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
