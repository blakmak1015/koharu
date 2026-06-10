'use client'

// Website integration dialog (this fork's addition; isolated for easy rebasing).
// Lets a translator claim a chapter (its pages are loaded into a fresh koharu
// project for editing) and submit the finished translation back.
// Now mounted at root level via AuthGate — accessible from both WelcomeScreen
// and MenuBar.
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getConfig, getSceneJson, startPipeline } from '@/lib/api/default/default'
import { createAndOpenProject, uploadPages } from '@/lib/io/scene'
import { useAuthStore } from '@/lib/stores/authStore'
import { useJobsStore } from '@/lib/stores/jobsStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import {
  type Chapter,
  type EditableChapter,
  claimChapter,
  fetchImageBlob,
  fetchRawPage,
  getChapter,
  getEditSource,
  listChapters,
  listEditable,
  listMine,
  pushSeriesGlossary,
  reopenEdit,
  resolveGlossary,
  submitPages,
} from '@/lib/website'
import { useGlossaryStore } from '@/lib/stores/glossaryStore'

const ACTIVE_JOB_KEY = 'website_active_job'
type ActiveJob = {
  chapterId: string
  title: string
  pageIds: string[]
  /** content_id of the series — used to sync the glossary back on submit. */
  contentId?: string
}

function loadActiveJob(): ActiveJob | null {
  try {
    const raw = localStorage.getItem(ACTIVE_JOB_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
function saveActiveJob(job: ActiveJob | null) {
  if (job) localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(job))
  else localStorage.removeItem(ACTIVE_JOB_KEY)
}

// Wait for a koharu pipeline job (tracked by SSE -> jobsStore) to finish.
async function waitForJob(jobId: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const job = useJobsStore.getState().jobs[jobId]
    if (job?.status === 'completed') return
    if (job?.status === 'failed') {
      throw new Error(job.error ?? 'Pipeline failed')
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Render pipeline timed out')
}

// Check whether koharu has a project currently open.
async function hasOpenProject(): Promise<boolean> {
  try {
    const snap = await getSceneJson()
    return !!snap?.scene?.project
  } catch {
    return false
  }
}

// Run the renderer step on all pages so every page has a rendered layer.
async function renderAllPages(pageIds: string[]): Promise<void> {
  if (!(await hasOpenProject())) {
    throw new Error(
      'No project open in koharu. Open the project you were editing first, then submit.',
    )
  }
  const cfg = await getConfig()
  const renderer = cfg.pipeline?.renderer
  if (!renderer) {
    throw new Error('No renderer configured in pipeline settings')
  }
  const defaultFont = usePreferencesStore.getState().defaultFont
  const { operationId } = await startPipeline({
    steps: [renderer],
    pages: pageIds,
    defaultFont,
  })
  await waitForJob(operationId)
}

// Export each page of the current koharu project as a rendered PNG blob.
async function exportRenderedBlobs(pageIds: string[]): Promise<Blob[]> {
  const blobs: Blob[] = []
  for (const id of pageIds) {
    const res = await fetch('/api/v1/projects/current/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'rendered', pages: [id] }),
    })
    if (!res.ok) {
      throw new Error(
        `Could not export rendered page "${id}". Ensure all pages have been processed.`,
      )
    }
    blobs.push(await res.blob())
  }
  return blobs
}

// Pull the central SERIES glossary into koharu's GlossaryDialog (active, editable)
// and load global+type as the read-only context system prompt, so reviewing/
// re-translating in the editor uses the same terminology as the auto-translate.
async function syncGlossaryDown(
  contentId: string,
  token: string,
  displayName: string,
): Promise<void> {
  try {
    const g = await resolveGlossary(contentId, token)
    const gid = `central:${contentId}`
    useGlossaryStore.setState((s) => ({
      glossaries: [
        ...s.glossaries.filter((x) => x.id !== gid),
        { id: gid, name: displayName || contentId, entries: g.seriesEntries, notes: g.seriesNotes },
      ],
      activeGlossaryId: gid,
    }))
    usePreferencesStore.getState().setCustomSystemPrompt(g.contextPrompt ?? undefined)
  } catch (e) {
    console.warn('glossary sync-down failed:', e)
  }
}

// Push the (possibly edited) series glossary back to the central store on submit
// so the next auto-translation of this series uses the corrected terms.
async function syncGlossaryUp(contentId: string, token: string): Promise<void> {
  try {
    const gid = `central:${contentId}`
    const g = useGlossaryStore.getState().glossaries.find((x) => x.id === gid)
    if (g) await pushSeriesGlossary(contentId, g.entries, g.notes ?? '', token)
  } catch (e) {
    console.warn('glossary sync-up failed:', e)
  }
}

export function WebsiteDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const token = useAuthStore((s) => s.token)
  const user = useAuthStore((s) => s.user)
  const [pool, setPool] = useState<Chapter[]>([])
  const [mine, setMine] = useState<(Chapter & { status: string })[]>([])
  const [editable, setEditable] = useState<EditableChapter[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)

  const refresh = useCallback(async (t: string) => {
    const [poolData, mineData, editableData] = await Promise.all([
      listChapters(t),
      listMine(t),
      listEditable(t).catch(() => [] as EditableChapter[]),
    ])
    setPool(poolData)
    setMine(mineData)
    setEditable(editableData)
  }, [])

  // On open, restore any saved active job + refresh chapter lists.
  useEffect(() => {
    if (!open || !token) return
    setActiveJob(loadActiveJob())
    ;(async () => {
      try {
        await refresh(token)
      } catch (e) {
        console.warn('refresh failed:', e)
        setMsg('Could not load chapters. Check your connection and try reopening.')
      }
    })()
  }, [open, refresh, token])

  const onClaim = useCallback(
    async (c: Chapter) => {
      if (!token) return
      setBusy(true)
      setMsg(`Claiming "${c.seriesTitle} Ch.${c.chapterNo}"...`)
      try {
        await claimChapter(c.id, token)
        const detail = await getChapter(c.id, token)
        await createAndOpenProject({ name: `${c.seriesTitle} Ch.${c.chapterNo}` })
        const files: File[] = []
        for (const p of detail.pages) {
          const blob = await fetchRawPage(c.id, p.page_no, token)
          files.push(new File([blob], `${p.page_no}.png`, { type: blob.type || 'image/png' }))
        }
        const pageIds = await uploadPages(files, true)
        const job: ActiveJob = {
          chapterId: c.id,
          title: `${c.seriesTitle} Ch.${c.chapterNo}`,
          pageIds,
        }
        saveActiveJob(job)
        setActiveJob(job)
        onOpenChange(false) // hand off to the editor
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [token, onOpenChange],
  )

  // Reopen an already-published chapter: rebuild an editable koharu project
  // from its stored inpainted pages + translated text blocks, then hand off to
  // the editor. Submit reuses the same flow as a normal translation.
  const onEditPublished = useCallback(
    async (c: EditableChapter) => {
      if (!token) return
      setBusy(true)
      setMsg(`Reopening "${c.seriesTitle} Ch.${c.chapterNo}" for editing...`)
      try {
        const reopened = await reopenEdit(c.chapterId, token)
        if (!reopened.success || !reopened.jobId) {
          throw new Error(
            reopened.reason === 'active_job_exists'
              ? 'This chapter already has an active job in the queue.'
              : reopened.reason || 'Could not reopen chapter for editing.',
          )
        }
        const jobId = reopened.jobId
        const src = await getEditSource(c.chapterId, token)
        if (!src.editable || src.pages.length === 0) {
          throw new Error('This chapter has no inpainted pages to edit.')
        }
        await syncGlossaryDown(c.contentId, token, c.seriesTitle)
        await createAndOpenProject({ name: `[EDIT] ${c.seriesTitle} Ch.${c.chapterNo}` })
        const files: File[] = []
        for (const p of src.pages) {
          const blob = await fetchImageBlob(p.inpaintedImageUrl)
          files.push(
            new File([blob], `${p.pageNumber}.png`, { type: blob.type || 'image/png' }),
          )
        }
        const pageIds = await uploadPages(files, true)
        // Re-create the translated text nodes at their saved positions/colours
        // so the editor sees the existing translation to fix.
        for (let i = 0; i < pageIds.length; i++) {
          const blocks = src.pages[i]?.blocks ?? []
          if (!blocks.length) continue
          const res = await fetch(`/api/v1/pages/${pageIds[i]}/text-nodes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ blocks }),
          })
          if (!res.ok) {
            throw new Error(`Inject text nodes (page ${i + 1}) failed: ${res.status}`)
          }
        }
        // Render so the injected text nodes get sprites and become visible in
        // the editor (see onReviewTranslated note). Renderer-only — no re-translate.
        setMsg('Rendering translated text...')
        await renderAllPages(pageIds)

        const job: ActiveJob = {
          chapterId: jobId,
          title: `[EDIT] ${c.seriesTitle} Ch.${c.chapterNo}`,
          pageIds,
          contentId: c.contentId,
        }
        saveActiveJob(job)
        setActiveJob(job)
        onOpenChange(false) // hand off to the editor
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [token, onOpenChange],
  )

  // Review an AUTO-TRANSLATED job (status 'editing', already claimed for us by
  // the website via /dashboard/translate). Unlike onEditPublished we do NOT call
  // reopenEdit — the translation_job already exists; we just reconstruct its
  // result (inpainted pages + translated text blocks) so the editor can fix it,
  // then Submit uses the SAME jobId. Triggered by the ?review=<jobId>&ch=<chapterId>
  // URL params the gateway forwards on hand-off (see the effect below).
  const onReviewTranslated = useCallback(
    async (jobId: string, chapterId: string) => {
      if (!token) return
      setBusy(true)
      setMsg('Loading translation for review...')
      try {
        // A friendly project name (job is already in my 'editing' list).
        let name = `[REVIEW] ${chapterId.slice(0, 8)}`
        try {
          const mineNow = await listMine(token)
          const m = mineNow.find((x) => x.id === jobId)
          if (m) name = `[REVIEW] ${m.seriesTitle} Ch.${m.chapterNo}`
        } catch {}

        const src = await getEditSource(chapterId, token)
        if (!src.editable || src.pages.length === 0) {
          throw new Error('This job has no inpainted pages to review.')
        }
        await syncGlossaryDown(src.contentId, token, name.replace(/^\[REVIEW\] /, ''))
        await createAndOpenProject({ name })
        const files: File[] = []
        for (const p of src.pages) {
          const blob = await fetchImageBlob(p.inpaintedImageUrl)
          files.push(
            new File([blob], `${p.pageNumber}.png`, { type: blob.type || 'image/png' }),
          )
        }
        const pageIds = await uploadPages(files, true)
        for (let i = 0; i < pageIds.length; i++) {
          const blocks = src.pages[i]?.blocks ?? []
          if (!blocks.length) continue
          const res = await fetch(`/api/v1/pages/${pageIds[i]}/text-nodes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ blocks }),
          })
          if (!res.ok) {
            throw new Error(`Inject text nodes (page ${i + 1}) failed: ${res.status}`)
          }
        }
        // Render so the injected text nodes get sprites and become visible in
        // the editor (add_text_nodes only adds nodes; koharu draws the rendered
        // sprite). steps:[renderer] only typesets — it won't re-translate, so
        // our reconstructed text is preserved.
        setMsg('Rendering translated text...')
        await renderAllPages(pageIds)

        const job: ActiveJob = { chapterId: jobId, title: name, pageIds, contentId: src.contentId }
        saveActiveJob(job)
        setActiveJob(job)
        onOpenChange(false) // hand off to the editor
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [token, onOpenChange],
  )

  // Hand-off entry point: when the website opens us with ?review=<jobId>&ch=<chapterId>
  // (forwarded by the editor gateway), auto-reconstruct that job for review. Run
  // once, as soon as a token is available; strip the params so a refresh won't
  // re-trigger.
  const reviewHandled = useRef(false)
  useEffect(() => {
    if (!token || reviewHandled.current) return
    const params = new URLSearchParams(window.location.search)
    const jobId = params.get('review')
    const chapterId = params.get('ch')
    if (!jobId || !chapterId) return
    reviewHandled.current = true
    params.delete('review')
    params.delete('ch')
    const clean =
      window.location.pathname + (params.toString() ? `?${params}` : '')
    window.history.replaceState({}, '', clean)
    void onReviewTranslated(jobId, chapterId)
  }, [token, onReviewTranslated])

  const onSubmit = useCallback(async () => {
    if (!token || !activeJob) return
    setBusy(true)
    try {
      // Step 1: render all pages so the "rendered" layer is up to date
      setMsg('Rendering all pages...')
      await renderAllPages(activeJob.pageIds)

      // Step 2: export rendered blobs and submit to website
      setMsg('Exporting & submitting...')
      const blobs = await exportRenderedBlobs(activeJob.pageIds)
      const res = await submitPages(activeJob.chapterId, blobs, token)
      // Push any glossary edits back to the central store (live for next translate).
      if (activeJob.contentId) await syncGlossaryUp(activeJob.contentId, token)
      setMsg(`Submitted ${res.pageCount} page(s). Awaiting review.`)
      saveActiveJob(null)
      setActiveJob(null)
      await refresh(token)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [token, activeJob, refresh])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Website — translation jobs</DialogTitle>
          <DialogDescription>
            Claim chapters from the website, translate in koharu, then submit.
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4'>
          <div className='flex items-center justify-between text-sm'>
            <span>
              {user?.email} · <strong>{user?.tokenBalance ?? 0}</strong> tokens
            </span>
          </div>

          {activeJob && (
            <Card className='space-y-2 p-3'>
              <div className='text-sm'>
                Currently translating: <strong>{activeJob.title}</strong>
              </div>
              <Button onClick={onSubmit} disabled={busy}>
                Submit this translation
              </Button>
            </Card>
          )}

          {/* "Available chapters" claiming now happens on the website
              (/dashboard/translate) which reconstructs the auto-translated
              result for review and hands off here via ?review=&ch=. Claiming
              raw from inside koharu is intentionally disabled to keep a single
              entry path. ({pool.length} job(s) waiting on the site.) */}
          <div className='rounded border border-dashed p-3 text-sm text-muted-foreground'>
            งานรอตรวจ ({pool.length}) — เปิดจากหน้าเว็บ{' '}
            <strong>manga-th.net/dashboard/translate</strong> แล้วกด &quot;เริ่มตรวจ&quot;
            ระบบจะดึงงานเข้ามาให้แก้ที่นี่อัตโนมัติ
          </div>

          <div>
            <h3 className='mb-1 text-sm font-medium'>Edit published</h3>
            <ScrollArea className='h-40 rounded border'>
              <div className='space-y-1 p-2'>
                {editable.length === 0 && (
                  <p className='text-sm text-muted-foreground'>None.</p>
                )}
                {editable.map((c) => (
                  <div
                    key={c.chapterId}
                    className='flex items-center justify-between rounded px-2 py-1'
                  >
                    <span className='text-sm'>
                      {c.seriesTitle} — Ch.{c.chapterNo}
                    </span>
                    <Button size='sm' disabled={busy} onClick={() => onEditPublished(c)}>
                      Edit
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>

        {msg && <p className='text-sm text-muted-foreground'>{msg}</p>}
      </DialogContent>
    </Dialog>
  )
}
