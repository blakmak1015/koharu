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
  | {
      success: true
      claimed: true
      agentId: string
      job: AgentJob
      pages: AgentPage[]
      /** Resolved central glossary (global+type+series) as a koharu systemPrompt. */
      systemPrompt?: string | null
    }

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

async function waitForJob(jobId: string, timeoutMs = 2_700_000): Promise<void> {
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

// --- watermark + SEO overlay (parity with the standalone Node agent) --------

type TextBlock = {
  x: number
  y: number
  w: number
  h: number
  rotationDeg: number
  text: string
  fontSizeRel: number
  color?: string
  strokeColor?: string
  direction?: 'horizontal' | 'vertical'
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const toHex = (rgb: number[] | undefined): string => {
  const c = rgb && rgb.length >= 3 ? rgb : [0, 0, 0]
  return '#' + c.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')
}
const contrastingStroke = (rgb: number[] | undefined): string => {
  const c = rgb && rgb.length >= 3 ? rgb : [0, 0, 0]
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 128 ? '#000000' : '#ffffff'
}

// Bake a faint "manga-th.net" mark into the top-right of a rendered page (plain
// grey, no outline) using the canvas — runs in the koharu webview. Never blocks
// the upload: returns the original blob on any failure.
async function brandBlob(blob: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob)
    const W = bmp.width
    const H = bmp.height
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (!ctx) return blob
    ctx.drawImage(bmp, 0, 0)
    const fontPx = Math.max(22, Math.round(W * 0.045))
    ctx.font = `${fontPx}px sans-serif`
    ctx.textBaseline = 'top'
    const text = 'manga-th.net'
    const tw = ctx.measureText(text).width
    const margin = Math.round(W * 0.02)
    ctx.fillStyle = 'rgba(110,110,110,0.5)'
    ctx.fillText(text, W - tw - margin, Math.round(H * 0.05))
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? blob), 'image/png'))
  } catch {
    return blob
  }
}

// Upload one page image; returns its public URL. Optional fileName lets us store
// the clean (inpainted) image alongside the rendered one without overwriting.
async function uploadPage(jobId: string, pageNumber: number, blob: Blob, fileName?: string): Promise<string> {
  const qs = new URLSearchParams({ jobId, pageNumber: String(pageNumber) })
  if (fileName) qs.set('fileName', fileName)
  const res = await agentFetch(`/api/admin/translation/agent/upload?${qs.toString()}`, {
    method: 'POST',
    headers: { 'content-type': blob.type || 'image/png' },
    body: await blob.arrayBuffer(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Upload page ${pageNumber} failed: ${(err as { error?: string }).error || res.statusText}`)
  }
  const data = (await res.json()) as { uploaded: { url: string } }
  return data.uploaded.url
}

// Extract translated text blocks for one koharu page as PROPORTIONAL (0-1) boxes
// from the live scene, so the web reader can overlay them as HTML text (SEO).
async function fetchSceneBlocks(koharuPageId: string): Promise<{ textBlocks: TextBlock[]; width: number; height: number }> {
  type BoxT = { x?: number; y?: number; width?: number; height?: number; rotationDeg?: number }
  try {
    const res = await fetch('/api/v1/scene.json')
    if (!res.ok) return { textBlocks: [], width: 0, height: 0 }
    const scene = (await res.json()) as { scene?: { pages?: Record<string, unknown> } }
    const page = scene?.scene?.pages?.[koharuPageId] as
      | { width?: number; height?: number; nodes?: Record<string, unknown> }
      | undefined
    if (!page) return { textBlocks: [], width: 0, height: 0 }
    const width = Number(page.width) || 0
    const height = Number(page.height) || 0
    const blocks: TextBlock[] = []
    if (width > 0 && height > 0 && page.nodes) {
      for (const raw of Object.values(page.nodes)) {
        const node = raw as {
          visible?: boolean
          transform?: BoxT
          kind?: {
            text?: {
              translation?: string
              detectedFontSizePx?: number
              rotationDeg?: number
              renderedDirection?: string
              spriteTransform?: BoxT
              fontPrediction?: { textColor?: number[] }
            }
          }
        }
        const t = node?.kind?.text
        if (!t || node.visible === false) continue
        const text = String(t.translation ?? '').trim()
        if (!text) continue
        const box: BoxT = t.spriteTransform && Number(t.spriteTransform.width) > 0 ? t.spriteTransform : (node.transform ?? {})
        const w = Number(box.width) || 0
        const h = Number(box.height) || 0
        if (w <= 0 || h <= 0) continue
        const fontPx = Number(t.detectedFontSizePx) || 0
        const textColor = t.fontPrediction?.textColor
        blocks.push({
          x: clamp01((Number(box.x) || 0) / width),
          y: clamp01((Number(box.y) || 0) / height),
          w: clamp01(w / width),
          h: clamp01(h / height),
          rotationDeg: Number(box.rotationDeg ?? t.rotationDeg ?? 0) || 0,
          text,
          fontSizeRel: fontPx > 0 ? fontPx / width : 0,
          color: toHex(textColor),
          strokeColor: contrastingStroke(textColor),
          direction: t.renderedDirection === 'vertical' ? 'vertical' : 'horizontal',
        })
      }
    }
    return { textBlocks: blocks, width, height }
  } catch {
    return { textBlocks: [], width: 0, height: 0 }
  }
}

// Make sure koharu has an LLM model loaded before translating. A freshly
// (re)started koharu has no model selected; the `llm` step would then fail and
// nothing renders. Idempotent — returns immediately if one is already ready.
async function ensureLlmLoaded(): Promise<void> {
  try {
    const cur = await fetch('/api/v1/llm/current').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (cur && String(cur.status).toLowerCase() === 'ready' && cur.target) return
    const cat = (await fetch('/api/v1/llm/catalog').then((r) => r.json())) as {
      models?: { target: { providerId?: string } }[]
      localModels?: { target: unknown }[]
    }
    const providerModels = cat.models ?? []
    const pick = providerModels.find((m) => m.target.providerId === 'openai-compatible') ?? providerModels[0] ?? (cat.localModels ?? [])[0]
    if (!pick) {
      appendLog('No LLM model available to load')
      return
    }
    appendLog('Loading LLM model...')
    await fetch('/api/v1/llm/current', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: (pick as { target: unknown }).target }),
    })
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const s = await fetch('/api/v1/llm/current').then((r) => r.json()).catch(() => null)
      const st = String(s?.status ?? '').toLowerCase()
      if (st === 'ready') {
        appendLog('LLM ready')
        return
      }
      if (st === 'error') {
        appendLog(`LLM load error: ${s?.error ?? 'unknown'}`)
        return
      }
    }
  } catch (e) {
    appendLog(`ensureLlmLoaded failed: ${(e as Error).message}`)
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
  // Read as text first so a malformed/empty body produces a useful log instead
  // of a bare "Unexpected end of JSON" — and so we can see WHAT came back.
  const rawClaim = await claimRes.text()
  let claim: ClaimResponse
  try {
    claim = JSON.parse(rawClaim)
  } catch (e) {
    appendLog(
      `Claim response was not valid JSON (${rawClaim.length} bytes): ${rawClaim.slice(0, 300)}`,
    )
    throw new Error(`claim response not JSON: ${(e as Error).message}`)
  }
  if (!claim.claimed) {
    appendLog(`No jobs available (${claim.reason}), waiting...`)
    return false
  }

  const { job, pages } = claim
  setState({ currentJob: job, status: 'downloading' })
  appendLog(`Claimed job ${job.id} (${pages.length} pages, ${job.sourceLanguage} -> ${job.targetLanguage})`)

  // Heartbeat immediately (don't wait the full 30s interval): extends the lease
  // right away and proves liveness, so a crash early in processing doesn't leave
  // the job orphaned for the whole lease window.
  await sendHeartbeat(job.id)

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
    await ensureLlmLoaded()
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
    // Central glossary resolved by the website for this content (global+type+
    // series) and shipped with the claim. Sent as the per-request systemPrompt
    // so the local LLM keeps names/terms consistent across the series.
    if (claim.systemPrompt) {
      appendLog(`Using central glossary (${claim.systemPrompt.length} chars)`)
    }
    const { operationId } = await startPipeline({
      steps,
      pages: pageIds,
      targetLanguage: job.targetLanguage || undefined,
      defaultFont: prefs.defaultFont,
      systemPrompt: claim.systemPrompt ?? undefined,
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

    type CompletePage = {
      pageNumber: number
      translatedImageUrl: string
      inpaintedImageUrl?: string
      textBlocks?: TextBlock[]
      pageWidth?: number
      pageHeight?: number
    }
    const uploadedPages: CompletePage[] = []
    for (let i = 0; i < pageIds.length; i++) {
      if (_abortController?.signal.aborted) throw new Error('Agent stopped')
      const pageId = pageIds[i]
      const pageNumber = pages[i]?.pageNumber ?? i + 1

      // Rendered page -> bake watermark -> upload.
      const { blob: renderedRaw } = await exportProject({
        format: 'rendered',
        pages: [pageId],
        defaultFont: prefs.defaultFont,
      })
      const rendered = await brandBlob(renderedRaw)
      const entry: CompletePage = {
        pageNumber,
        translatedImageUrl: await uploadPage(job.id, pageNumber, rendered),
      }

      // Clean (inpainted) image + translated text blocks for the SEO/HTML
      // overlay reader. Best-effort: the rendered raster above is unaffected.
      try {
        const { blob: clean } = await exportProject({
          format: 'inpainted',
          pages: [pageId],
          defaultFont: prefs.defaultFont,
        })
        entry.inpaintedImageUrl = await uploadPage(
          job.id,
          pageNumber,
          clean,
          `${String(pageNumber).padStart(3, '0')}-clean.png`,
        )
      } catch (e) {
        appendLog(`inpaint export page ${pageNumber} skipped: ${(e as Error).message}`)
      }
      const { textBlocks, width, height } = await fetchSceneBlocks(pageId)
      if (textBlocks.length) {
        entry.textBlocks = textBlocks
        entry.pageWidth = width
        entry.pageHeight = height
      }

      uploadedPages.push(entry)
      appendLog(`Uploaded page ${pageNumber}/${pageIds.length}${entry.textBlocks ? ` (+${entry.textBlocks.length} blocks +clean)` : ''}`)
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
