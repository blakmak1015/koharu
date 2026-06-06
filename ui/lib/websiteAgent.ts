// Website agent loop (our fork's addition, kept isolated for easy rebasing).
// Polls the central manga-website for queued translation jobs, auto-processes
// them through the koharu pipeline, and submits the rendered results back.
//
// Designed to run in the browser tab — relies on the koharu Next.js dev server
// (/api/v1/*) for project/pipeline/export ops, and the SSE event stream
// (jobsStore) for tracking pipeline completion.

import { getConfig, startPipeline } from '@/lib/api/default/default'
import { createAndOpenProject, exportProject, uploadPages } from '@/lib/io/scene'
import { useJobsStore } from '@/lib/stores/jobsStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'

const WEBSITE_API =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_WEBSITE_API) || 'https://manga-th.net'

// --- localStorage config (agent token + id) ---------------------------------
const AGENT_TOKEN_KEY = 'website_agent_token'
const AGENT_ID_KEY = 'website_agent_id'

export function getAgentToken(): string {
  return localStorage.getItem(AGENT_TOKEN_KEY) ?? ''
}
export function setAgentToken(token: string): void {
  localStorage.setItem(AGENT_TOKEN_KEY, token.trim())
}
export function getAgentId(): string {
  return localStorage.getItem(AGENT_ID_KEY) || 'koharu-default'
}
export function setAgentId(id: string): void {
  localStorage.setItem(AGENT_ID_KEY, id.trim() || 'koharu-default')
}

// --- types ------------------------------------------------------------------
export type AgentJob = {
  id: string
  contentId: string
  chapterId: string
  sourceLanguage: string
  targetLanguage: string
  priority: number
  leasedUntil: string
}

type AgentPage = {
  id: string
  pageNumber: number
  imageUrl: string
}

type ClaimResponse =
  | { success: true; claimed: false; reason: string; waitMs: number }
  | { success: true; claimed: true; agentId: string; job: AgentJob; pages: AgentPage[] }

export type AgentStatus =
  | 'stopped'
  | 'polling'
  | 'downloading'
  | 'processing'
  | 'uploading'
  | 'submitting'
  | 'error'
  | 'cooldown'

export type AgentState = {
  status: AgentStatus
  currentJob: AgentJob | null
  lastError: string | null
  processedCount: number
  log: string[]
}

type AgentListener = (state: AgentState) => void

// --- singleton agent state --------------------------------------------------
let _state: AgentState = {
  status: 'stopped',
  currentJob: null,
  lastError: null,
  processedCount: 0,
  log: [],
}
const _listeners = new Set<AgentListener>()
let _abortController: AbortController | null = null

function setState(patch: Partial<AgentState>) {
  _state = { ..._state, ...patch }
  for (const fn of _listeners) fn(_state)
}
function appendLog(msg: string) {
  const ts = new Date().toLocaleTimeString()
  const entry = `[${ts}] ${msg}`
  _state = { ..._state, log: [..._state.log.slice(-99), entry] }
  for (const fn of _listeners) fn(_state)
}

export function getAgentState(): AgentState {
  return _state
}
export function subscribeAgent(fn: AgentListener): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

// --- helpers ----------------------------------------------------------------

async function agentFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getAgentToken()
  const agentId = getAgentId()
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    'x-translation-agent-token': token,
    'x-translation-agent-id': agentId,
  }
  return fetch(`${WEBSITE_API}${path}`, { ...init, headers })
}

async function waitForJob(jobId: string, timeoutMs = 600_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (_abortController?.signal.aborted) throw new Error('Agent stopped')
    const job = useJobsStore.getState().jobs[jobId]
    if (job?.status === 'completed') return
    if (job?.status === 'failed') {
      throw new Error(job.error ?? 'Pipeline failed')
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Pipeline timed out')
}

async function sendHeartbeat(jobId: string): Promise<void> {
  try {
    await agentFetch('/api/admin/translation/agent/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    })
  } catch {
    // heartbeat failures are non-fatal
  }
}

// --- main loop --------------------------------------------------------------

async function processOneJob(): Promise<boolean> {
  // 1. Claim
  setState({ status: 'polling' })
  appendLog('Polling for jobs...')
  const claimRes = await agentFetch('/api/admin/translation/agent/claim', {
    method: 'POST',
  })
  if (!claimRes.ok) {
    throw new Error(`Claim failed: ${claimRes.status} ${claimRes.statusText}`)
  }
  const claim: ClaimResponse = await claimRes.json()
  if (!claim.claimed) {
    appendLog(`No jobs available (${claim.reason}), waiting...`)
    return false
  }

  const { job, pages } = claim
  setState({ currentJob: job, status: 'downloading' })
  appendLog(`Claimed job ${job.id} (${pages.length} pages, ${job.sourceLanguage} -> ${job.targetLanguage})`)

  // Start heartbeat interval
  const heartbeatTimer = setInterval(() => void sendHeartbeat(job.id), 30_000)

  try {
    // 2. Download source pages
    appendLog('Downloading source pages...')
    const files: File[] = []
    for (const page of pages) {
      if (_abortController?.signal.aborted) throw new Error('Agent stopped')
      const url = page.imageUrl.startsWith('http') ? page.imageUrl : `${WEBSITE_API}${page.imageUrl}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to download page ${page.pageNumber}: ${res.status}`)
      const blob = await res.blob()
      files.push(new File([blob], `${page.pageNumber}.png`, { type: blob.type || 'image/png' }))
    }
    appendLog(`Downloaded ${files.length} pages`)

    // 3. Create project & upload pages
    setState({ status: 'processing' })
    appendLog('Creating koharu project...')
    await createAndOpenProject({ name: `agent-${job.id.slice(0, 8)}` })
    const pageIds = await uploadPages(files, true)
    appendLog(`Uploaded ${pageIds.length} pages to koharu project`)

    // 4. Run full pipeline
    appendLog('Running full pipeline...')
    await sendHeartbeat(job.id)
    const cfg = await getConfig()
    if (!cfg.pipeline) throw new Error('No pipeline configuration found')

    const p = cfg.pipeline
    const steps = [
      p.detector,
      p.segmenter,
      p.bubble_segmenter,
      p.font_detector,
      p.ocr,
      p.translator,
      p.inpainter,
      p.renderer,
    ].filter((s): s is string => !!s)

    if (steps.length === 0) throw new Error('No pipeline steps configured')

    const prefs = usePreferencesStore.getState()
    const { operationId } = await startPipeline({
      steps,
      pages: pageIds,
      targetLanguage: job.targetLanguage || undefined,
      defaultFont: prefs.defaultFont,
    })
    appendLog(`Pipeline started (operation: ${operationId}), waiting for completion...`)

    // Periodically heartbeat while pipeline runs
    const pipelineHeartbeat = setInterval(() => void sendHeartbeat(job.id), 30_000)
    try {
      await waitForJob(operationId)
    } finally {
      clearInterval(pipelineHeartbeat)
    }
    appendLog('Pipeline completed successfully')

    // 5. Export rendered pages
    setState({ status: 'uploading' })
    appendLog('Exporting rendered pages...')
    await sendHeartbeat(job.id)

    const uploadedPages: { pageNumber: number; translatedImageUrl: string }[] = []
    for (let i = 0; i < pageIds.length; i++) {
      if (_abortController?.signal.aborted) throw new Error('Agent stopped')
      const pageId = pageIds[i]
      const pageNumber = pages[i]?.pageNumber ?? i + 1

      // Export single rendered page
      const { blob } = await exportProject({
        format: 'rendered',
        pages: [pageId],
        defaultFont: prefs.defaultFont,
      })

      // Upload to website
      const uploadRes = await agentFetch(
        `/api/admin/translation/agent/upload?jobId=${encodeURIComponent(job.id)}&pageNumber=${pageNumber}`,
        {
          method: 'POST',
          headers: { 'content-type': blob.type || 'image/png' },
          body: await blob.arrayBuffer(),
        },
      )
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({}))
        throw new Error(`Upload page ${pageNumber} failed: ${(err as { error?: string }).error || uploadRes.statusText}`)
      }
      const uploadData = (await uploadRes.json()) as { uploaded: { url: string } }
      uploadedPages.push({ pageNumber, translatedImageUrl: uploadData.uploaded.url })
      appendLog(`Uploaded page ${pageNumber}/${pageIds.length}`)
    }

    // 6. Complete
    setState({ status: 'submitting' })
    appendLog('Completing job...')
    const completeRes = await agentFetch('/api/admin/translation/agent/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id,
        pages: uploadedPages,
      }),
    })
    if (!completeRes.ok) {
      const err = await completeRes.json().catch(() => ({}))
      throw new Error(`Complete failed: ${(err as { error?: string }).error || completeRes.statusText}`)
    }

    appendLog(`Job ${job.id} completed successfully!`)
    setState({
      currentJob: null,
      processedCount: _state.processedCount + 1,
    })
    return true
  } finally {
    clearInterval(heartbeatTimer)
  }
}

async function agentLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const didWork = await processOneJob()
      if (!didWork) {
        // No job available — wait before polling again
        setState({ status: 'cooldown' })
        await new Promise((r) => {
          const timer = setTimeout(r, 10_000)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            r(undefined)
          }, { once: true })
        })
      }
      // If we just processed a job, immediately poll for next one
    } catch (err) {
      if (signal.aborted) break
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`Error: ${msg}`)
      setState({ status: 'error', lastError: msg, currentJob: null })

      // If it's a job-specific error, fail the job on the website
      if (_state.currentJob) {
        try {
          await agentFetch('/api/admin/translation/agent/fail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jobId: _state.currentJob.id,
              error: msg,
            }),
          })
          appendLog(`Reported failure for job ${_state.currentJob.id}`)
        } catch {
          appendLog('Failed to report job failure to website')
        }
        setState({ currentJob: null })
      }

      // Back off after error
      await new Promise((r) => {
        const timer = setTimeout(r, 15_000)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          r(undefined)
        }, { once: true })
      })
    }
  }
}

// --- public API -------------------------------------------------------------

export function startAgent(): void {
  if (_abortController) return // already running
  const token = getAgentToken()
  if (!token) {
    setState({ status: 'error', lastError: 'No agent token configured' })
    return
  }
  _abortController = new AbortController()
  setState({ status: 'polling', lastError: null, log: [] })
  appendLog(`Agent started (id: ${getAgentId()})`)
  agentLoop(_abortController.signal).finally(() => {
    _abortController = null
    setState({ status: 'stopped', currentJob: null })
    appendLog('Agent stopped')
  })
}

export function stopAgent(): void {
  if (_abortController) {
    _abortController.abort()
    appendLog('Stopping agent...')
  }
}

export function isAgentRunning(): boolean {
  return _abortController !== null
}
