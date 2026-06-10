'use client'

import { BookMarkedIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

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
import {
  type CentralGlossary,
  getToken,
  listGlossaries,
  saveGlossaryScope,
} from '@/lib/website'

/**
 * Central glossary editor — reads from and writes to the website's shared
 * glossary (the same store the auto-translate agent uses and the web
 * /admin/glossary page edits). Two-way sync: edit here or on the web, both match.
 */
const keyOf = (g: CentralGlossary) => `${g.scopeType}:${g.scopeValue}`
function label(g: CentralGlossary): string {
  if (g.scopeType === 'global') return '🌐 ทั่วไป (ทุกเรื่อง)'
  if (g.scopeType === 'content_type') return `📚 ${g.scopeValue}`
  return `📖 ${g.title || g.scopeValue}`
}

export function GlossaryDialog() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<CentralGlossary[]>([])
  const [selKey, setSelKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setMsg(null)
    try {
      const token = await getToken()
      if (!token) {
        setMsg('ยังไม่ได้เข้าสู่ระบบเว็บ')
        return
      }
      const res = await listGlossaries(token)
      const list = (res.items ?? []).map((g) => ({
        ...g,
        entries: g.entries ?? [],
        notes: g.notes ?? '',
      }))
      setItems(list)
      setSelKey((prev) => prev || (list[0] ? keyOf(list[0]) : ''))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'โหลดไม่ได้')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const sel = items.find((g) => keyOf(g) === selKey)
  function patchSel(fn: (g: CentralGlossary) => CentralGlossary) {
    setItems((prev) => prev.map((g) => (keyOf(g) === selKey ? fn(g) : g)))
  }

  const save = useCallback(async () => {
    if (!sel) return
    setBusy(true)
    setMsg(null)
    try {
      const token = await getToken()
      if (!token) throw new Error('ยังไม่ได้เข้าสู่ระบบเว็บ')
      const entries = sel.entries.filter((e) => e.source.trim() && e.target.trim())
      await saveGlossaryScope(sel.scopeType, sel.scopeValue, entries, sel.notes, token)
      setMsg(`บันทึกขึ้นเว็บแล้ว (${entries.length} คำ) — มีผลกับงานแปลถัดไปทันที`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'บันทึกไม่ได้')
    } finally {
      setBusy(false)
    }
  }, [sel])

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
          Glossary
        </Button>
      </DialogTrigger>
      <DialogContent className='max-w-xl' data-testid='glossary-dialog'>
        <DialogHeader>
          <DialogTitle>คลังคำแปล (ซิงก์กับเว็บ)</DialogTitle>
          <DialogDescription>
            คำศัพท์/ชื่อเฉพาะที่ใช้ตอนแปล เก็บที่ส่วนกลาง — แก้ที่นี่หรือที่เว็บก็ตรงกัน.
            ตอนแปลรวม เรื่อง &gt; ประเภท &gt; ทั่วไป
          </DialogDescription>
        </DialogHeader>

        {msg ? <p className='text-xs text-muted-foreground'>{msg}</p> : null}

        <div className='flex items-center gap-1.5'>
          <Select
            value={selKey || '__none__'}
            onValueChange={(v) => setSelKey(v === '__none__' ? '' : v)}
          >
            <SelectTrigger data-testid='glossary-select' className='min-w-0 flex-1'>
              <SelectValue placeholder='เลือกกลุ่ม' />
            </SelectTrigger>
            <SelectContent position='popper'>
              {items.length === 0 ? <SelectItem value='__none__'>(ว่าง)</SelectItem> : null}
              {items.map((g) => (
                <SelectItem key={keyOf(g)} value={keyOf(g)}>
                  {label(g)} ({g.entries.length})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant='outline'
            size='sm'
            className='h-9 shrink-0 gap-1'
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCwIcon className='size-3.5' />
            รีเฟรช
          </Button>
          {sel ? (
            <Button
              size='sm'
              className='h-9 shrink-0 gap-1'
              disabled={busy}
              onClick={() => void save()}
            >
              <SaveIcon className='size-3.5' />
              บันทึก
            </Button>
          ) : null}
        </div>

        {sel ? (
          <div className='flex flex-col gap-3'>
            <div className='flex flex-col gap-1'>
              <div className='flex items-center justify-between'>
                <span className='text-[10px] font-medium text-muted-foreground uppercase'>
                  Terms
                </span>
                <Button
                  data-testid='glossary-add-entry'
                  variant='ghost'
                  size='xs'
                  className='h-6 gap-1 px-1.5 text-[11px]'
                  onClick={() =>
                    patchSel((g) => ({
                      ...g,
                      entries: [...g.entries, { source: '', target: '' }],
                    }))
                  }
                >
                  <PlusIcon className='size-3' />
                  เพิ่มคำ
                </Button>
              </div>
              <ScrollArea className='max-h-56'>
                <div className='flex flex-col gap-1.5 pr-2'>
                  {sel.entries.length === 0 ? (
                    <p className='py-3 text-center text-xs text-muted-foreground'>
                      ยังไม่มีคำ
                    </p>
                  ) : (
                    sel.entries.map((entry, index) => (
                      <div key={index} className='flex items-center gap-1.5'>
                        <Input
                          data-testid={`glossary-source-${index}`}
                          value={entry.source}
                          onChange={(e) =>
                            patchSel((g) => ({
                              ...g,
                              entries: g.entries.map((x, i) =>
                                i === index ? { ...x, source: e.target.value } : x,
                              ),
                            }))
                          }
                          placeholder='ต้นฉบับ (เช่น ダイゴ)'
                          className='h-8 text-sm'
                        />
                        <span className='shrink-0 text-muted-foreground'>→</span>
                        <Input
                          data-testid={`glossary-target-${index}`}
                          value={entry.target}
                          onChange={(e) =>
                            patchSel((g) => ({
                              ...g,
                              entries: g.entries.map((x, i) =>
                                i === index ? { ...x, target: e.target.value } : x,
                              ),
                            }))
                          }
                          placeholder='คำแปล (เช่น ไดโกะ)'
                          className='h-8 text-sm'
                        />
                        <Button
                          variant='ghost'
                          size='xs'
                          className='h-8 shrink-0 px-1.5 text-muted-foreground hover:text-destructive'
                          onClick={() =>
                            patchSel((g) => ({
                              ...g,
                              entries: g.entries.filter((_, i) => i !== index),
                            }))
                          }
                          aria-label='ลบ'
                        >
                          <Trash2Icon className='size-3.5' />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>

            <div className='flex flex-col gap-1'>
              <span className='text-[10px] font-medium text-muted-foreground uppercase'>
                Tone / context notes
              </span>
              <Textarea
                data-testid='glossary-notes'
                value={sel.notes ?? ''}
                onChange={(e) => patchSel((g) => ({ ...g, notes: e.target.value }))}
                placeholder='เช่น ใช้สรรพนามสุภาพ, คงอารมณ์ต้นฉบับ'
                rows={3}
                className='resize-y text-sm'
              />
            </div>
          </div>
        ) : (
          <p className='py-6 text-center text-sm text-muted-foreground'>
            {busy ? 'กำลังโหลด...' : 'เลือกกลุ่มด้านบน'}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
