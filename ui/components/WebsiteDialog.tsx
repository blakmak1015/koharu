'use client'

// Website integration dialog (this fork's addition; isolated for easy rebasing).
// Lets a translator log into the manga website, claim a chapter (its pages are
// loaded into a fresh koharu project for editing), and submit the finished
// translation back. Heavy ML + editing use koharu's normal flow.
import { useCallback, useEffect, useState } from 'react'

import { AgentPanel } from '@/components/AgentPanel'
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
import { openExternalUrl } from '@/lib/backend'
import { getConfig, getSceneJson, startPipeline } from '@/lib/api/default/default'
import { createAndOpenProject, uploadPages } from '@/lib/io/scene'
import { useJobsStore } from '@/lib/stores/jobsStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import {
  type Chapter,
  type Me,
  claimChapter,
  clearToken,
  fetchRawPage,
  getChapter,
  getMe,
  getToken,
  listChapters,
  listMine,
  pollDeviceToken,
  setToken,
  startDeviceLogin,
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

// Wait for a koharu pipeline job (tracked by SSE → jobsStore) to finish.
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
  const [token, setTok] = useState<string | null>(null)
  const [me, setMeState] = useState<Me | null>(null)
  const [pool, setPool] = useState<Chapter[]>([])
  const [mine, setMine] = useState<(Chapter & { status: string })[]>([])
  const [userCode, setUserCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)

  const refresh = useCallback(async (t: string) => {
    const [meData, poolData, mineData] = await Promise.all([getMe(t), listChapters(t), listMine(t)])
    setMeState(meData)
    setPool(poolData)
    setMine(mineData)
  }, [])

  // On open, restore any saved token + active job.
  useEffect(() => {
    if (!open) return
    setActiveJob(loadActiveJob())
    ;(async () => {
      const t = await getToken()
      if (!t) return
      setTok(t)
      try {
        await refresh(t)
      } catch (e) {
        // Don't clear the token on refresh failure — the token might still
        // be valid; the website could just be temporarily unreachable.
        console.warn('refresh failed (token kept):', e)
        setMsg('Could not load chapters. Check your connection and try reopening.')
      }
    })()
  }, [open, refresh])

  const onLogin = useCallback(async () => {
    setMsg(null)
    setBusy(true)
    try {
      const dc = await startDeviceLogin()
      setUserCode(dc.user_code)
      await openExternalUrl(dc.verification_uri_complete)
      // poll
      for (;;) {
        await new Promise((r) => setTimeout(r, (dc.interval || 5) * 1000))
        const t = await pollDeviceToken(dc.device_code)
        if (t) {
          await setToken(t)
          setTok(t)
          setUserCode(null)
          await refresh(t)
          break
        }
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const onLogout = useCallback(async () => {
    await clearToken()
    setTok(null)
    setMeState(null)
  }, [])

  const onClaim = useCallback(
    async (c: Chapter) => {
      if (!token) return
      setBusy(true)
      setMsg(`Claiming "${c.seriesTitle} Ch.${c.chapterNo}"…`)
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
      setMsg('Rendering all pages…')
      await renderAllPages(activeJob.pageIds)

      // Step 2: export rendered blobs and submit to website
      setMsg('Exporting & submitting…')
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

        {!token ? (
          <div className='space-y-3'>
            <Button onClick={onLogin} disabled={busy}>
              Sign in via browser
            </Button>
            {userCode && (
              <p className='text-sm'>
                Your code: <strong>{userCode}</strong> — approve it in the browser.
              </p>
            )}
          </div>
        ) : (
          <div className='space-y-4'>
            <div className='flex items-center justify-between text-sm'>
              <span>
                {me?.email} · <strong>{me?.tokenBalance ?? 0}</strong> tokens
              </span>
              <Button variant='ghost' size='sm' onClick={onLogout}>
                Logout
              </Button>
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
        )}

        {msg && <p className='text-sm text-muted-foreground'>{msg}</p>}

        {/* Agent auto-translate mode (admin only — needs agent token) */}
        <details className='border-t pt-3'>
          <summary className='cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground'>
            Auto-translate agent (server mode)
          </summary>
          <p className='mt-1 mb-2 text-xs text-muted-foreground'>
            สำหรับ admin: ให้ koharu รับงานจากเว็บไซต์อัตโนมัติ — poll คิว, แปล, ส่งกลับ
            โดยไม่ต้องกดเอง ต้องใส่ Agent Token จาก server config
          </p>
          <AgentPanel />
        </details>
      </DialogContent>
    </Dialog>
  )
}
