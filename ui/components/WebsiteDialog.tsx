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
import { createAndOpenProject, createPagesFromUrls, invalidateScene, uploadPages } from '@/lib/io/scene'
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
import { brandBlob, fetchSceneBlocks, fetchSceneJson } from '@/lib/websiteAgent'
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
  // import-from-url opened a new project server-side; invalidate the React Query
  // scene cache so the editor UI refetches and actually shows the imported
  // layers (otherwise the canvas stays on the stale/empty scene).
  await invalidateScene()
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

// Export ONE page's clean (inpainted, text-removed) background — the same
// `format: 'inpainted'` export the auto-translate agent uses (websiteAgent.ts).
// The HTML-overlay reader shows THIS image with the text_blocks on top, so a
// reviewer who corrects the inpaint needs the corrected clean image published.
// Best-effort: returns null on any failure so the submit is never blocked and
// no bad URL is sent (the server then keeps the existing inpaint for that page).
async function exportInpaintedBlob(pageId: string): Promise<Blob | null> {
  try {
    const res = await fetch('/api/v1/projects/current/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'inpainted', pages: [pageId] }),
    })
    if (!res.ok) return null
    return await res.blob()
  } catch {
    return null
  }
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
    useGlossaryStore.setState((s) => {
      // Merge the central (PG) series entries with any LOCAL entries already in
      // the store. The local copy may hold additions the user has not Submitted
      // yet (sync-up only runs on Submit), and a plain overwrite here discarded
      // them on every chapter reopen — the "added 20, only ~10 come back" bug.
      // Union by source; local wins on conflict (it's the user's latest edit).
      const existing = s.glossaries.find((x) => x.id === gid)
      const bySource = new Map<string, { source: string; target: string }>()
      for (const e of g.seriesEntries) bySource.set(e.source, e)
      for (const e of existing?.entries ?? []) if (e.source.trim()) bySource.set(e.source, e)
      return {
        glossaries: [
          ...s.glossaries.filter((x) => x.id !== gid),
          {
            id: gid,
            name: displayName || contentId,
            entries: [...bySource.values()],
            notes: existing?.notes || g.seriesNotes,
          },
        ],
        activeGlossaryId: gid,
      }
    })
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
  // Fetch the scene ONCE and reuse it for every page — re-downloading the whole
  // scene per page made draft-save ("กำลังบันทึกข้อความ") slow over the tunnel.
  const scene = await fetchSceneJson()
  for (let i = 0; i < pageIds.length; i++) {
    const { textBlocks, width, height } = await fetchSceneBlocks(pageIds[i], scene)
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
        await syncGlossaryDown(c.contentId, token, c.seriesTitle)
        let pageIds: string[]
        if (src.masterKhrprojKey) {
          // Fast path: import the koharu master (render intact — no reconstruct).
          // Master takes precedence — opens even if public pages_json is sparse.
          setMsg('กำลังโหลดโปรเจกต์ต้นฉบับจาก R2 (ไม่ต้องเรนเดอร์ใหม่)...')
          pageIds = await importMasterProject(c.chapterId, token)
        } else if (src.editable && src.pages.length > 0) {
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
        } else {
          throw new Error(
            'แชปนี้ไม่มีโปรเจกต์ต้นฉบับและไม่มีหน้า inpaint ให้แก้ (น่าจะเป็นแชปเก่าแบบฝังคำในรูป)',
          )
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
        await syncGlossaryDown(src.contentId, token, name.replace(/^\[REVIEW\] /, ''))
        let pageIds: string[]
        if (src.masterKhrprojKey) {
          // Fast path: import the koharu master (render intact — no reconstruct).
          // Master takes precedence: a chapter with a master always opens, even
          // if its public pages_json is sparse (baked / overwritten).
          setMsg('กำลังโหลดโปรเจกต์ต้นฉบับจาก R2 (ไม่ต้องเรนเดอร์ใหม่)...')
          pageIds = await importMasterProject(chapterId, token)
        } else if (src.editable && src.pages.length > 0) {
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
        } else {
          throw new Error(
            'แชปนี้ไม่มีโปรเจกต์ต้นฉบับและไม่มีหน้า inpaint ให้ตรวจ (น่าจะเป็นแชปเก่าแบบฝังคำในรูป)',
          )
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
      // 0. Guard against submitting a STALE/RAW project. After an editor
      //    idle-kill or cold resume the open koharu project can silently revert
      //    to the freshly-imported RAW master; submitting then overwrites the
      //    user's edits with raw text (the ch58 lost-edit case). Verify the open
      //    scene still contains the pages we're reviewing, and abort loudly if not.
      setMsg('กำลังตรวจสอบโปรเจกต์...')
      const sceneNow = await (await fetch('/api/v1/scene.json')).json()
      const scenePageIds = Object.keys(sceneNow?.scene?.pages ?? sceneNow?.pages ?? {})
      const missing = activeJob.pageIds.filter((id) => !scenePageIds.includes(id))
      if (missing.length) {
        throw new Error(
          `⚠️ โปรเจกต์ที่เปิดอยู่ไม่ตรงกับงานนี้ (${missing.length}/${activeJob.pageIds.length} หน้าหาย — น่าจะถูกรีโหลด/idle) — กรุณาเปิดงานนี้ใหม่จากเว็บแล้วแก้อีกครั้งก่อน Submit เพื่อกันงานแก้หาย`,
        )
      }

      // 1. Render so the rendered layer + text sprites are current.
      setMsg('กำลังเรนเดอร์ทุกหน้า...')
      await renderAllPages(activeJob.pageIds)

      // 2. Save text blocks so manga (HTML overlay) reflects the edits, not just
      //    the baked raster (the web keeps the overlay; clearOverlay is off).
      //    Fail LOUD: a swallowed error here previously let submit proceed with
      //    RAW/stale text. If the edited text can't be saved, abort the submit.
      setMsg('กำลังบันทึกข้อความ...')
      const draftPages = await buildDraftPages(activeJob.pageIds)
      await saveDraft(activeJob.chapterId, draftPages, token)

      // 3. Export + upload rendered pages with per-page progress (G). Bake the
      //    "manga-th.net" watermark into each page first (parity with the agent —
      //    manual-review submits were going up un-watermarked).
      //
      //    ALSO export the clean (inpainted) background per page — same as the
      //    agent — so a reviewer who corrected the inpaint publishes that fix to
      //    the HTML-overlay reader (which renders inpainted_image_url + text_blocks).
      //    The clean image is watermarked too (the reader shows IT, not the
      //    rendered raster). Per-page inpaint export is best-effort: a failure
      //    leaves that page's entry undefined so submitPages keeps the old inpaint.
      const blobs: Blob[] = []
      const inpaintedBlobs: (Blob | undefined)[] = []
      for (let i = 0; i < activeJob.pageIds.length; i++) {
        setMsg(`กำลังอัปโหลด หน้า ${i + 1}/${total}...`)
        const corner = usePreferencesStore.getState().watermarkCorner
        const [b] = await exportRenderedBlobs([activeJob.pageIds[i]])
        blobs.push(await brandBlob(b, corner))
        const clean = await exportInpaintedBlob(activeJob.pageIds[i])
        inpaintedBlobs.push(clean ? await brandBlob(clean, corner) : undefined)
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
      const res = await submitPages(
        activeJob.chapterId,
        blobs,
        token,
        masterKhrprojKey,
        inpaintedBlobs,
      )
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

  // Eager-push the series glossary when the dialog CLOSES without submitting.
  // The native SettingsDialog glossary panel only reaches PG via syncGlossaryUp
  // on a successful Submit; a reviewer who adds terms while reviewing and then
  // just closes the dialog (no Submit) would otherwise lose those additions for
  // the next auto-translate. Skip when a submit just succeeded (it already
  // pushed) and when we never had an active series content / token.
  const handleOpenChange = useCallback(
    (v: boolean) => {
      if (!v && !submittedRef.current && token) {
        const contentId = activeJob?.contentId
        if (contentId) {
          const gid = `central:${contentId}`
          const hasGlossary = useGlossaryStore
            .getState()
            .glossaries.some((g) => g.id === gid)
          if (hasGlossary) {
            // Fire-and-forget; never block the close on the network call.
            void syncGlossaryUp(contentId, token)
          }
        }
      }
      onOpenChange(v)
    },
    [activeJob, token, onOpenChange],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
