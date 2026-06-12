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
import { createAndOpenProject, createPagesFromUrls, uploadPages } from '@/lib/io/scene'
import { useAuthStore } from '@/lib/stores/authStore'
import { useJobsStore } from '@/lib/stores/jobsStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import {
  type Chapter,
  type EditableChapter,
  claimChapter,
  fetchImageBlob,
  presignKhrproj,
  fetchRawPage,
  getChapter,
  getEditSource,
  listChapters,
  listEditable,
  listMine,
  pushSeriesGlossary,
  reopenEdit,
  resolveGlossary,
  saveDraft,
  submitPages,
} from '@/lib/website'
import { fetchSceneBlocks } from '@/lib/websiteAgent'
import { useGlossaryStore } from '@/lib/stores/glossaryStore'

const ACTIVE_JOB_KEY = 'website_active_job'
type ActiveJob = {
  /** NOTE: holds the translation_job id (used as the submit/draft :id). */
  chapterId: string
  title: string
  pageIds: string[]
  /** content_id of the series — used to sync the glossary back on submit. */
  contentId?: string
  /** Real chapter id — used to presign the .khrproj master on submit. */
  srcChapterId?: string
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

// Download inpainted page images with bounded concurrency. A 40-50 page chapter
// is ~150MB+; fetching one-at-a-time made reconstruct look frozen ("Loading
// translation for review..." with no movement). Parallel (6 at a time) cuts that
// several-fold and reports progress so the dialog shows it's actually working.
async function fetchInpaintFiles(
  pages: { pageNumber: number; inpaintedImageUrl: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<File[]> {
  const files: File[] = new Array(pages.length)
  const total = pages.length
  let done = 0
  const queue = pages.map((p, i) => ({ p, i }))
  const CONCURRENCY = 6
  async function worker() {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      const blob = await fetchImageBlob(item.p.inpaintedImageUrl)
      files[item.i] = new File([blob], `${item.p.pageNumber}.png`, {
        type: blob.type || 'image/png',
      })
      done += 1
      onProgress?.(done, total)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker),
  )
  return files
}

// Import the inpainted pages into the currently-open koharu project.
//
// Fast path: hand koharu the URL list so IT fetches the images directly from
// the CDN (on the GPU box: full bandwidth, parallel, no 150MB browser round-
// trip, and the tiny JSON body sidesteps Cloudflare's 100MB request cap).
// Fallback: if the server can't reach the CDN, pull into the browser and
// multipart-upload (works for smaller chapters).
async function importInpaintPages(
  pages: { pageNumber: number; inpaintedImageUrl: string }[],
  setMsg: (m: string) => void,
): Promise<string[]> {
  try {
    setMsg(`กำลังให้ koharu ดึงรูป ${pages.length} หน้าจาก CDN โดยตรง...`)
    return await createPagesFromUrls(
      pages.map((p) => p.inpaintedImageUrl),
      true,
    )
  } catch (e) {
    console.warn('from-urls import failed, falling back to browser upload', e)
    setMsg('ดึงตรงไม่ได้ — ใช้วิธีสำรอง (โหลดผ่านเบราว์เซอร์)...')
    const files = await fetchInpaintFiles(pages, (d, t) =>
      setMsg(`กำลังโหลดรูป ${d}/${t}...`),
    )
    setMsg(`กำลังอัปโหลด ${files.length} รูปเข้า koharu...`)
    return await uploadPages(files, true)
  }
}

// Fast-path open: presign a GET for the chapter's .khrproj master and have
// koharu fetch + import it server-side (render intact — no reconstruct, no
// re-render). Returns the imported page ids in page order.
async function importMasterProject(chapterId: string, token: string): Promise<string[]> {
  const { url } = await presignKhrproj(chapterId, 'get', token)
  const imp = await fetch('/api/v1/projects/import-from-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!imp.ok) {
    throw new Error(`import master ${imp.status}: ${(await imp.text()).slice(0, 200)}`)
  }
  const scene = await (await fetch('/api/v1/scene.json')).json()
  return Object.keys(scene?.scene?.pages ?? scene?.pages ?? {})
}

// Export the current koharu project as the chapter's .khrproj master to R2
// (presigned PUT, server-side stream). Returns the R2 key.
async function exportMasterProject(chapterId: string, token: string): Promise<string> {
  const { url, key } = await presignKhrproj(chapterId, 'put', token)
  const exp = await fetch('/api/v1/projects/current/export-to-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!exp.ok) {
    throw new Error(`export master ${exp.status}: ${(await exp.text()).slice(0, 200)}`)
  }
  return key
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

// Extract the current scene's translated text blocks per page (for draft-save
// and submit). Page order matches upload order, so pageNumber = index + 1.
async function buildDraftPages(pageIds: string[]) {
  const pages: {
    pageNumber: number
    textBlocks: unknown[]
    pageWidth: number
    pageHeight: number
  }[] = []
  for (let i = 0; i < pageIds.length; i++) {
    const { textBlocks, width, height } = await fetchSceneBlocks(pageIds[i])
    pages.push({ pageNumber: i + 1, textBlocks, pageWidth: width, pageHeight: height })
  }
  return pages
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
        let pageIds: string[]
        if (src.masterKhrprojKey) {
          // Fast path: import the koharu master (render intact — no reconstruct).
          setMsg('กำลังโหลดโปรเจกต์ต้นฉบับจาก R2 (ไม่ต้องเรนเดอร์ใหม่)...')
          pageIds = await importMasterProject(c.chapterId, token)
        } else {
          // Fallback: reconstruct from inpaint + saved text blocks, then render.
          await createAndOpenProject({ name: `[EDIT] ${c.seriesTitle} Ch.${c.chapterNo}` })
          pageIds = await importInpaintPages(src.pages, setMsg)
          setMsg('กำลังใส่คำแปลกลับเข้าหน้า...')
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
          setMsg('กำลังเรนเดอร์คำแปลทุกหน้า (อาจใช้เวลาสักครู่)...')
          await renderAllPages(pageIds)
        }

        const job: ActiveJob = {
          chapterId: jobId,
          title: `[EDIT] ${c.seriesTitle} Ch.${c.chapterNo}`,
          pageIds,
          contentId: c.contentId,
          srcChapterId: c.chapterId,
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
      setMsg('กำลังเตรียมงานเพื่อตรวจ...')
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
        let pageIds: string[]
        if (src.masterKhrprojKey) {
          // Fast path: import the koharu master (render intact — no reconstruct).
          setMsg('กำลังโหลดโปรเจกต์ต้นฉบับจาก R2 (ไม่ต้องเรนเดอร์ใหม่)...')
          pageIds = await importMasterProject(chapterId, token)
        } else {
          // Fallback: reconstruct from inpaint + text blocks, then render.
          await createAndOpenProject({ name })
          pageIds = await importInpaintPages(src.pages, setMsg)
          setMsg('กำลังใส่คำแปลกลับเข้าหน้า...')
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
          setMsg('กำลังเรนเดอร์คำแปลทุกหน้า (อาจใช้เวลาสักครู่)...')
          await renderAllPages(pageIds)
        }

        const job: ActiveJob = {
          chapterId: jobId,
          title: name,
          pageIds,
          contentId: src.contentId,
          srcChapterId: chapterId,
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

  // Disarmed once a submit fully succeeds, so the close-guard won't fire then.
  const submittedRef = useRef(false)

  // Auto-save the draft every 5 minutes while a job is active, so an idle-killed
  // or accidentally-closed editor resumes from near-latest text.
  useEffect(() => {
    if (!token || !activeJob) return
    const id = setInterval(() => {
      void (async () => {
        try {
          const pages = await buildDraftPages(activeJob.pageIds)
          await saveDraft(activeJob.chapterId, pages, token)
        } catch {
          /* best-effort auto-save */
        }
      })()
    }, 300_000)
    return () => clearInterval(id)
  }, [token, activeJob])

  // Guard against closing the tab before submit finishes / with unsaved work (F).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (busy || (activeJob && !submittedRef.current)) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [busy, activeJob])

  // Save the current edits as a draft (button + auto-save). Lets the editor
  // close / be idle-killed and resume later from the latest text.
  const onSaveDraft = useCallback(async () => {
    if (!token || !activeJob) return
    setBusy(true)
    setMsg('💾 กำลังเซฟ...')
    try {
      const pages = await buildDraftPages(activeJob.pageIds)
      await saveDraft(activeJob.chapterId, pages, token)
      setMsg('💾 เซฟแล้ว — ปิดแล้วกลับมาทำต่อได้')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [token, activeJob])

  const onSubmit = useCallback(async () => {
    if (!token || !activeJob) return
    const total = activeJob.pageIds.length
    setBusy(true)
    try {
      // 1. Render so the rendered layer + text sprites are current.
      setMsg('กำลังเรนเดอร์ทุกหน้า...')
      await renderAllPages(activeJob.pageIds)

      // 2. Save text blocks so manga (HTML overlay) reflects the edits, not just
      //    the baked raster (the web keeps the overlay; clearOverlay is off).
      setMsg('กำลังบันทึกข้อความ...')
      try {
        const draftPages = await buildDraftPages(activeJob.pageIds)
        await saveDraft(activeJob.chapterId, draftPages, token)
      } catch (e) {
        console.warn('textblock save before submit failed:', e)
      }

      // 3. Export + upload rendered pages with per-page progress (G).
      const blobs: Blob[] = []
      for (let i = 0; i < activeJob.pageIds.length; i++) {
        setMsg(`กำลังอัปโหลด หน้า ${i + 1}/${total}...`)
        const [b] = await exportRenderedBlobs([activeJob.pageIds[i]])
        blobs.push(b)
      }

      // 3.5 Export the edited project as the chapter's .khrproj master so the
      //     next open is instant (render intact). Best-effort — submit still
      //     proceeds (and falls back to reconstruct) if this fails.
      let masterKhrprojKey: string | undefined
      if (activeJob.srcChapterId) {
        try {
          setMsg('กำลังบันทึกโปรเจกต์ต้นฉบับ...')
          masterKhrprojKey = await exportMasterProject(activeJob.srcChapterId, token)
        } catch (e) {
          console.warn('master export on submit failed:', e)
        }
      }

      setMsg('กำลังส่งให้แอดมินตรวจ...')
      const res = await submitPages(activeJob.chapterId, blobs, token, masterKhrprojKey)
      // Push any glossary edits back to the central store (live for next translate).
      if (activeJob.contentId) await syncGlossaryUp(activeJob.contentId, token)

      submittedRef.current = true // disarm the close guard
      saveActiveJob(null)
      setActiveJob(null)
      setMsg(`✅ ส่งให้แอดมินตรวจแล้ว (${res.pageCount} หน้า) — กำลังปิดหน้าต่าง...`)
      // F: auto-close this tab (it was opened via window.open from the website).
      setTimeout(() => {
        try {
          window.close()
        } catch {
          /* if the browser blocks it, the success message stays */
        }
      }, 1200)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [token, activeJob])

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
                Currently editing: <strong>{activeJob.title}</strong>
              </div>
              <div className='flex gap-2'>
                <Button onClick={onSubmit} disabled={busy}>
                  ✅ ส่งให้แอดมินตรวจ
                </Button>
                <Button variant='outline' onClick={onSaveDraft} disabled={busy}>
                  💾 เซฟไว้ทำต่อ
                </Button>
              </div>
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
