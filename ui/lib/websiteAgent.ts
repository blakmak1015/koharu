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
      /** Page numbers already translated (resume: agent skips these). */
      donePageNumbers?: number[]
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

// The agent lives inside a long-running webview, and fetch() has NO default
// timeout: one stalled TCP connection hangs a call forever. That is exactly how
// the loop used to go silent for hours after a log line with nothing after it
// (including the "report failure" call, which then never let the loop restart).
// Every network call below gets a deadline; idempotent ones also retry.
const DEFAULT_FETCH_TIMEOUT_MS = 60_000

async function fetchDeadline(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  attempts = 1,
): Promise<Response> {
  let lastErr: unknown
  for (let n = 1; n <= attempts; n++) {
    try {
      return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      lastErr = e
      const kind = (e as Error)?.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e as Error)?.message
      appendLog(`fetch ${kind} (try ${n}/${attempts}): ${input.slice(0, 100)}`)
      if (n < attempts) await new Promise((r) => setTimeout(r, 2_000 * n))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function agentFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  attempts = 1,
): Promise<Response> {
  const token = getAgentToken()
  const agentId = getAgentId()
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    'x-translation-agent-token': token,
    'x-translation-agent-id': agentId,
  }
  return fetchDeadline(`${WEBSITE_API}${path}`, { ...init, headers }, timeoutMs, attempts)
}

type JobOutcome = { status: 'completed' | 'completed_with_errors'; warnings: string[] }

/** koharu's own view of one operation, used when the SSE stream misses an event. */
async function pollOperationStatus(jobId: string): Promise<string | undefined> {
  try {
    const res = await fetchDeadline('/api/v1/operations', {}, 15_000)
    if (!res.ok) return undefined
    const body = (await res.json()) as { operations?: { id: string; status: string }[] }
    return body.operations?.find((o) => o.id === jobId)?.status
  } catch {
    return undefined
  }
}

// Wait for one pipeline operation to reach a TERMINAL state. koharu has five
// statuses, not two: running / completed / completed_with_errors / cancelled /
// failed. This used to check only completed and failed, so a page that ended
// in completed_with_errors (a step failed) or cancelled parked the worker here
// for the full timeout with koharu already idle — the "hangs after one
// chapter" report. All four terminal states are handled now.
async function waitForJob(jobId: string, timeoutMs = 600_000): Promise<JobOutcome> {
  const start = Date.now()
  let lastPoll = 0
  for (;;) {
    if (_abortController?.signal.aborted) throw new Error('Agent stopped')
    const job = useJobsStore.getState().jobs[jobId]
    let status: string | undefined = job?.status
    // The store is fed by the webview's SSE stream. If that stream drops or
    // reconnects, the terminal event never lands — so ask koharu directly.
    if ((!status || status === 'running') && Date.now() - lastPoll > 15_000) {
      lastPoll = Date.now()
      status = (await pollOperationStatus(jobId)) ?? status
    }
    if (status === 'completed' || status === 'completed_with_errors') {
      return {
        status,
        warnings: (job?.warnings ?? []).map(
          (w) => `${w.stepId} p${w.pageIndex + 1}: ${w.message}`,
        ),
      }
    }
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(job?.error ?? `Pipeline ${status}`)
    }
    if (Date.now() - start >= timeoutMs) throw new Error('Pipeline timed out')
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function sendHeartbeat(jobId: string): Promise<void> {
  try {
    await agentFetch('/api/admin/translation/agent/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }, 15_000)
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
  /** Original OCR source text (for editor comparison). */
  sourceText?: string
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
export type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export async function brandBlob(blob: Blob, corner: WatermarkCorner = 'top-right'): Promise<Blob> {
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
    const text = 'manga-th.net'
    const tw = ctx.measureText(text).width
    const margin = Math.round(W * 0.02)
    const onLeft = corner === 'top-left' || corner === 'bottom-left'
    const onTop = corner === 'top-left' || corner === 'top-right'
    const x = onLeft ? margin : W - tw - margin
    ctx.textBaseline = onTop ? 'top' : 'bottom'
    const y = onTop ? Math.round(H * 0.03) : Math.round(H * 0.97)
    ctx.fillStyle = 'rgba(110,110,110,0.5)'
    ctx.fillText(text, x, y)
    // Re-encode as webp (q=0.92): manga inpaint/rendered pages are ~2MB as PNG,
    // ~3-4x smaller as high-quality webp, so the reader (and the upload) is much
    // faster. Both the rendered and the clean inpaint pass through here, so this
    // is the single place that controls the published image format. q=0.92 keeps
    // screentones crisp. Browser canvas webp is lossy-only (no lossless mode).
    return await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b ?? blob), 'image/webp', 0.92),
    )
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
  }, 180_000, 3)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Upload page ${pageNumber} failed: ${(err as { error?: string }).error || res.statusText}`)
  }
  const data = (await res.json()) as { uploaded: { url: string } }
  return data.uploaded.url
}

// Extract translated text blocks for one koharu page as PROPORTIONAL (0-1) boxes
// from the live scene, so the web reader can overlay them as HTML text (SEO).
// `prefetchedScene` lets a caller fetch /api/v1/scene.json ONCE and reuse it for
// every page, instead of re-downloading the whole scene per page (which was
// very slow over the remote editor tunnel for a 40+ page chapter).
export async function fetchSceneJson(): Promise<{ scene?: { pages?: Record<string, unknown> } } | null> {
  try {
    const res = await fetchDeadline('/api/v1/scene.json', {}, 60_000, 2)
    if (!res.ok) return null
    return (await res.json()) as { scene?: { pages?: Record<string, unknown> } }
  } catch {
    return null
  }
}

export async function fetchSceneBlocks(
  koharuPageId: string,
  prefetchedScene?: { scene?: { pages?: Record<string, unknown> } } | null,
): Promise<{ textBlocks: TextBlock[]; width: number; height: number }> {
  type BoxT = { x?: number; y?: number; width?: number; height?: number; rotationDeg?: number }
  try {
    const scene = prefetchedScene !== undefined ? prefetchedScene : await fetchSceneJson()
    if (!scene) return { textBlocks: [], width: 0, height: 0 }
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
              text?: string
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
        const sourceText = String(t.text ?? '').trim()
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
          ...(sourceText ? { sourceText } : {}),
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

type LoadedTarget = { kind?: string; providerId?: string | null; modelId?: string }

/** The remote llama.cpp server. A LOCAL model here silently emits English. */
const REQUIRED_PROVIDER_ID = 'openai-compatible'

// Make sure koharu has the PROVIDER LLM loaded before translating. A freshly
// (re)started koharu has no model selected; the `llm` step would then fail and
// nothing renders. Idempotent — returns immediately if the provider is already
// ready. Returns false (never a local fallback) when no provider is reachable.
async function ensureLlmLoaded(): Promise<boolean> {
  try {
    const cur = await fetchDeadline('/api/v1/llm/current', {}, 15_000)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    const curTarget = cur?.target as LoadedTarget | undefined
    if (String(cur?.status ?? '').toLowerCase() === 'ready' && curTarget?.kind === 'provider') return true
    if (curTarget && curTarget.kind !== 'provider') {
      appendLog(`LLM is on a LOCAL model (${curTarget.modelId}) — switching back to the provider`)
    }

    // NOTE the shape: the catalog is { localModels, providers[].models } — an
    // earlier version read a non-existent `models` key, so every lookup fell
    // through to localModels[0] and the agent quietly translated to English.
    const cat = (await fetchDeadline('/api/v1/llm/catalog', {}, 30_000).then((r) => r.json())) as {
      providers?: {
        id: string
        status?: string
        models?: { target: LoadedTarget; name?: string }[]
      }[]
    }
    const providers = cat.providers ?? []
    const ready = providers.filter((p) => p.status === 'ready' && (p.models?.length ?? 0) > 0)
    const usable = ready.find((p) => p.id === REQUIRED_PROVIDER_ID) ?? ready[0]
    const pick = usable?.models?.[0]
    if (!pick) {
      const seen = providers.map((p) => `${p.id}=${p.status ?? '?'}`).join(', ') || 'none'
      appendLog(`No provider LLM reachable (${seen}). NOT falling back to a local model — idling.`)
      return false
    }
    appendLog(`Loading provider LLM ${pick.target.modelId} via ${usable.id}...`)
    await fetchDeadline('/api/v1/llm/current', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: pick.target }),
    })
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const s = await fetchDeadline('/api/v1/llm/current', {}, 15_000).then((r) => r.json()).catch(() => null)
      const st = String(s?.status ?? '').toLowerCase()
      if (st === 'ready' && (s?.target as LoadedTarget | undefined)?.kind === 'provider') {
        appendLog('LLM ready (provider)')
        return true
      }
      if (st === 'error') {
        appendLog(`LLM load error: ${s?.error ?? 'unknown'}`)
        return false
      }
    }
    appendLog('LLM did not become ready within 60s')
    return false
  } catch (e) {
    appendLog(`ensureLlmLoaded failed: ${(e as Error).message}`)
    return false
  }
}

// --- main loop --------------------------------------------------------------

async function processOneJob(): Promise<boolean> {
  // 0. The agent must translate through the provider LLM. Check BEFORE
  //    claiming: if the provider is down we simply idle instead of claiming a
  //    job and then failing it (or, worse, translating it with a local model).
  if (!(await ensureLlmLoaded())) return false

  // 1. Claim
  setState({ status: 'polling' })
  appendLog('Polling for jobs...')
  const claimRes = await agentFetch('/api/admin/translation/agent/claim', {
    method: 'POST',
  }, 45_000)
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
    // 2. Skip pages already translated in a prior (interrupted) run; download
    //    only the remaining source pages so we RESUME instead of redoing all.
    const donePages = new Set(claim.donePageNumbers ?? [])
    const remaining = pages.filter((pg) => !donePages.has(pg.pageNumber))
    if (donePages.size) {
      appendLog(`Resuming: ${donePages.size} page(s) already done, ${remaining.length} remaining`)
    }
    appendLog('Downloading source pages...')
    const files: File[] = []
    for (const page of remaining) {
      if (_abortController?.signal.aborted) throw new Error('Agent stopped')
      const url = page.imageUrl.startsWith('http') ? page.imageUrl : `${WEBSITE_API}${page.imageUrl}`
      const res = await fetchDeadline(url, {}, 90_000, 3)
      if (!res.ok) throw new Error(`Failed to download page ${page.pageNumber}: ${res.status}`)
      const blob = await res.blob()
      files.push(new File([blob], `${page.pageNumber}.png`, { type: blob.type || 'image/png' }))
    }
    appendLog(`Downloaded ${files.length} page(s)`)

    type CompletePage = {
      pageNumber: number
      translatedImageUrl: string
      inpaintedImageUrl?: string
      textBlocks?: TextBlock[]
      pageWidth?: number
      pageHeight?: number
    }
    const uploadedPages: CompletePage[] = []
    // R2 key of the .khrproj master, set only on a clean full run (see below).
    let masterKhrprojKey: string | undefined
    const prefs = usePreferencesStore.getState()

    if (remaining.length > 0) {
      // 3. Create project & upload the remaining source pages
      setState({ status: 'processing' })
      appendLog('Creating koharu project...')
      await createAndOpenProject({ name: `agent-${job.id.slice(0, 8)}` })
      const pageIds = await uploadPages(files, true)

      // 4. Pipeline config (the LLM was already verified before the claim)
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
      if (claim.systemPrompt) {
        appendLog(`Using central glossary (${claim.systemPrompt.length} chars)`)
      }

      // 5. Process pages with a small worker pool. A single page never saturates
      //    the GPU (CPU/I-O/LLM gaps), so running a few concurrently fills those
      //    gaps and is much faster. Each uploaded page is still persisted
      //    server-side independently, so a crash/restart resumes from the pages
      //    that weren't done yet (order no longer matters). Concurrency is
      //    configurable (prefs.agentPageConcurrency; 1 = old sequential behavior).
      setState({ status: 'processing' })
      const pageConcurrency = Math.max(1, prefs.agentPageConcurrency || 1)
      let nextPageIdx = 0
      const processOnePage = async (): Promise<void> => {
        for (;;) {
          if (_abortController?.signal.aborted) throw new Error('Agent stopped')
          const i = nextPageIdx++
          if (i >= pageIds.length) return
          const pageId = pageIds[i]
          const pageNumber = remaining[i]?.pageNumber ?? i + 1
          appendLog(`Translating page ${pageNumber} (${i + 1}/${remaining.length})...`)
          const runPipeline = async (): Promise<JobOutcome> => {
            const { operationId } = await startPipeline({
              steps,
              pages: [pageId],
              targetLanguage: job.targetLanguage || undefined,
              defaultFont: prefs.defaultFont,
              systemPrompt: claim.systemPrompt ?? undefined,
            })
            return waitForJob(operationId)
          }
          let outcome = await runPipeline()
          if (outcome.status === 'completed_with_errors') {
            // A failed step makes koharu SKIP that page's remaining steps, so
            // the page is incomplete (untranslated, or with the source text
            // left showing). These are usually transient, so retry once — then
            // fail loudly rather than publishing a broken page.
            const why = outcome.warnings.join('; ') || 'no detail reported'
            appendLog(`Page ${pageNumber}: pipeline step failed (${why}) — retrying once`)
            outcome = await runPipeline()
            if (outcome.status === 'completed_with_errors') {
              throw new Error(
                `Page ${pageNumber} failed twice: ${outcome.warnings.join('; ') || why}`,
              )
            }
          }
          await sendHeartbeat(job.id)

          // Rendered page -> bake watermark -> upload.
          const { blob: renderedRaw } = await exportProject({
            format: 'rendered',
            pages: [pageId],
            defaultFont: prefs.defaultFont,
          })
          const rendered = await brandBlob(renderedRaw, prefs.watermarkCorner)
          const entry: CompletePage = {
            pageNumber,
            translatedImageUrl: await uploadPage(job.id, pageNumber, rendered),
          }

          // Clean (inpainted) image + text blocks for the SEO/HTML overlay reader.
          // The reader shows THIS image (not the rendered one), so the watermark
          // must be baked here too or it won't appear on the published page.
          try {
            const { blob: clean } = await exportProject({
              format: 'inpainted',
              pages: [pageId],
              defaultFont: prefs.defaultFont,
            })
            entry.inpaintedImageUrl = await uploadPage(
              job.id,
              pageNumber,
              await brandBlob(clean, prefs.watermarkCorner),
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
          appendLog(`Uploaded page ${pageNumber} (${uploadedPages.length}/${remaining.length})`)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(pageConcurrency, pageIds.length) }, processOnePage),
      )

      // 5.5 Export the full koharu project as the .khrproj master to R2 — ONLY
      // on a clean full run (no pages were pre-done in a prior interrupted run),
      // because a resumed run's project holds only the pages processed this time.
      // Server-side stream via a presigned PUT so the ~150MB never hits a browser.
      // Best-effort: if it fails, the job still completes and review falls back to
      // reconstruct.
      if (!claim.donePageNumbers?.length) {
        try {
          appendLog('Exporting .khrproj master to R2...')
          const presignRes = await agentFetch('/api/admin/translation/khrproj/presign', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chapterId: job.chapterId, op: 'put' }),
          }, 30_000)
          if (presignRes.ok) {
            const { url, key } = (await presignRes.json()) as { url: string; key: string }
            const exp = await fetchDeadline('/api/v1/projects/current/export-to-url', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ url }),
            }, 900_000)
            if (exp.ok) {
              masterKhrprojKey = key
              appendLog('Master .khrproj stored on R2.')
            } else {
              appendLog(`Master export PUT failed: ${exp.status}`)
            }
          } else {
            appendLog(`Master presign failed: ${presignRes.status}`)
          }
        } catch (e) {
          appendLog(`Master export skipped: ${(e as Error).message}`)
        }
      }
    } else {
      appendLog('All pages already translated — finalizing.')
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
        ...(masterKhrprojKey ? { masterKhrprojKey } : {}),
      }),
    }, 180_000)
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
          }, 20_000, 2)
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
