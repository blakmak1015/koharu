'use client'

// Website integration dialog (this fork's addition; isolated for easy rebasing).
// Lets a translator claim a chapter (its pages are loaded into a fresh koharu
// project for editing) and submit the finished translation back.
// Now mounted at root level via AuthGate — accessible from both WelcomeScreen
// and MenuBar.
import { useCallback, useEffect, useState } from 'react'

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
  claimChapter,
  fetchRawPage,
  getChapter,
  listChapters,
  listMine,
  submitPages,
} from '@/lib/website'

const ACTIVE_JOB_KEY = 'website_active_job'
type ActiveJob = { chapterId: string; title: string; pageIds: string[] }

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
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)

  const refresh = useCallback(async (t: string) => {
    const [poolData, mineData] = await Promise.all([listChapters(t), listMine(t)])
    setPool(poolData)
    setMine(mineData)
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

          <div>
            <h3 className='mb-1 text-sm font-medium'>Available chapters</h3>
            <ScrollArea className='h-48 rounded border'>
              <div className='space-y-1 p-2'>
                {pool.length === 0 && <p className='text-sm text-muted-foreground'>None.</p>}
                {pool.map((c) => (
                  <div key={c.id} className='flex items-center justify-between rounded px-2 py-1'>
                    <span className='text-sm'>
                      {c.seriesTitle} — Ch.{c.chapterNo}{' '}
                      <span className='text-muted-foreground'>({c.rewardTokens} tokens)</span>
                    </span>
                    <Button size='sm' disabled={busy} onClick={() => onClaim(c)}>
                      Claim
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
