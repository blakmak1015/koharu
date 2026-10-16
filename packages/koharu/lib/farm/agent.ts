'use client'

// The unattended translation agent: claims a chapter from manga-th.net, runs
// it through the pipeline a page at a time, and uploads each finished page.
//
// Ported from the 0.59.2 fork. Two things shrank it. The pipeline is driven
// over Tauri IPC instead of koharu's old HTTP API, and job state arrives on a
// pushed channel instead of being polled — which removes the stall class the
// fork had to work around by hand.

import { commands } from '@koharu/bridge/protocol'
import type { EntityId, Job } from '@koharu/bridge/protocol'
import { relaunch } from '@tauri-apps/plugin-process'

import { useKoharuStore } from '../store'

import { pageTextBlocks, renderBrandedPage, type WatermarkCorner } from './page'
import {
  claimJob,
  completeJob,
  delay,
  failJob,
  reason,
  sendHeartbeat,
  sourceUrl,
  uploadPage,
  type AgentJob,
  type AgentPage,
  type ClaimedJob,
  type CompletePage,
} from './website'

export type AgentStatus =
  | 'stopped'
  | 'polling'
  | 'downloading'
  | 'processing'
  | 'uploading'
  | 'error'
  | 'cooldown'

export type AgentState = {
  status: AgentStatus
  currentJob: AgentJob | null
  lastError: string | null
  processedCount: number
  log: string[]
}

export type AgentSettings = {
  watermarkCorner: WatermarkCorner
  /**
   * Restart the process after this many chapters. The pipeline's caching
   * allocator never returns GPU memory, so a long-lived process keeps its
   * worst page's peak reserved for ever; detection alone peaks at 5.7 GB of
   * this box's 8 GB. 0 disables it.
   */
  recycleAfterChapters: number
}

export const defaultAgentSettings: AgentSettings = {
  watermarkCorner: 'top-right',
  recycleAfterChapters: 0,
}

const IDLE_WAIT_MS = 15_000
const ERROR_WAIT_MS = 30_000
const HEARTBEAT_MS = 30_000
// A stage can legitimately take minutes; this bounds silence, not work.
const STALL_TIMEOUT_MS = 600_000
// Two tries, far enough apart that a restarting LLM box has come back.
const PIPELINE_ATTEMPTS = 2
const RETRY_WAIT_MS = 60_000

// --- state ------------------------------------------------------------------

let state: AgentState = {
  status: 'stopped',
  currentJob: null,
  lastError: null,
  processedCount: 0,
  log: [],
}
const listeners = new Set<(state: AgentState) => void>()
let abort: AbortController | null = null
let settings: AgentSettings = defaultAgentSettings

function publish(patch: Partial<AgentState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener(state)
}

function log(message: string) {
  const entry = `[${new Date().toLocaleTimeString()}] ${message}`
  publish({ log: [...state.log.slice(-99), entry] })
  // Also to the application log. The farm instance's window is hidden, so the
  // panel's copy of this is somewhere nobody can read: without the file, an
  // idle agent and a broken one look identical from outside.
  void commands.farmLog(message).catch(() => undefined)
}

export function getAgentState(): AgentState {
  return state
}

export function subscribeAgent(listener: (state: AgentState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function stopped(): boolean {
  return abort?.signal.aborted ?? true
}

function throwIfStopped() {
  if (stopped()) throw new Error('agent stopped')
}

// --- pipeline ----------------------------------------------------------------

/**
 * Wait for one pipeline job to reach a terminal state.
 *
 * The app already receives every job transition on the `subscribe` channel and
 * records it in the store, so this watches the store instead of polling. The
 * 0.59.2 agent polled and recognised only two of koharu's statuses, which
 * parked a worker for the full timeout whenever a page ended any other way —
 * the "hangs after one chapter" report. Here the terminal set is the type:
 * anything that is not `running` settles this promise.
 */
function awaitJob(jobId: string, onProgress?: (done: number, total: number) => void): Promise<Job> {
  const settle = (job: Job | undefined) =>
    job && job.state !== 'running'
      ? job.state === 'finished'
        ? { ok: true as const, job }
        : { ok: false as const, error: job.error ?? `pipeline ${job.state}` }
      : null

  return new Promise<Job>((resolve, reject) => {
    // It may already be terminal: the job can finish before this runs.
    const immediate = settle(useKoharuStore.getState().jobs[jobId])
    if (immediate) {
      if (immediate.ok) resolve(immediate.job)
      else reject(new Error(immediate.error))
      return
    }

    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout>
    // The deadline covers a lack of progress, not the whole job: a chapter of
    // forty pages takes far longer than any one stage, so a fixed timeout
    // would have to be either useless or wrong.
    const extend = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`pipeline made no progress for ${STALL_TIMEOUT_MS / 1000}s`))
      }, STALL_TIMEOUT_MS)
    }
    extend()

    let seen = -1
    unsubscribe = useKoharuStore.subscribe((state) => {
      const job = state.jobs[jobId]
      if (job && job.completed !== seen) {
        seen = job.completed
        extend()
        onProgress?.(job.completed, job.total)
      }
      const outcome = settle(job)
      if (!outcome) return
      clearTimeout(timer)
      unsubscribe()
      if (outcome.ok) resolve(outcome.job)
      else reject(new Error(outcome.error))
    })
  })
}

// --- one chapter --------------------------------------------------------------

async function uploadFinishedPage(
  job: AgentJob,
  pageId: EntityId,
  pageNumber: number,
): Promise<CompletePage> {
  const translated = await renderBrandedPage(pageId, 'translated', settings.watermarkCorner)
  const entry: CompletePage = {
    pageNumber,
    translatedImageUrl: await uploadPage(job.id, pageNumber, translated, undefined, log),
  }

  // The clean image is what the reader actually shows, with the translation
  // laid over it as HTML — so the watermark has to be baked into this one too,
  // or it never appears on the published page.
  try {
    const clean = await renderBrandedPage(pageId, 'clean', settings.watermarkCorner)
    entry.inpaintedImageUrl = await uploadPage(
      job.id,
      pageNumber,
      clean,
      `${String(pageNumber).padStart(3, '0')}-clean.png`,
      log,
    )
  } catch (error) {
    log(`clean image for page ${pageNumber} skipped: ${reason(error)}`)
  }

  const { textBlocks, width, height } = await pageTextBlocks(pageId)
  if (textBlocks.length) {
    entry.textBlocks = textBlocks
    entry.pageWidth = width
    entry.pageHeight = height
  }
  return entry
}

async function processClaim(claim: ClaimedJob): Promise<void> {
  const { job } = claim
  publish({ currentJob: job, status: 'downloading' })
  log(`claimed job ${job.id} (${claim.pages.length} pages, ${job.sourceLanguage} -> ${job.targetLanguage})`)

  // Heartbeat before anything slow: this extends the lease immediately, so a
  // crash early on does not leave the job orphaned for the whole lease window.
  await sendHeartbeat(job.id)
  const heartbeat = setInterval(() => void sendHeartbeat(job.id), HEARTBEAT_MS)

  try {
    const done = new Set(claim.donePageNumbers ?? [])
    const remaining = claim.pages.filter((page) => !done.has(page.pageNumber))
    if (done.size) log(`resuming: ${done.size} page(s) already done, ${remaining.length} remaining`)
    if (remaining.length === 0) {
      await completeJob(job.id, [], log)
      return
    }

    publish({ status: 'processing' })
    log('creating project...')
    await commands.createProject(`agent-${job.id.slice(0, 8)}`)
    log(`downloading ${remaining.length} source page(s)...`)
    const pageIds = await commands.farmImportPages(
      remaining.map((page) => ({ url: sourceUrl(page), name: `${page.pageNumber}.png` })),
    )

    await sendHeartbeat(job.id)
    if (claim.systemPrompt) log(`using central glossary (${claim.systemPrompt.length} chars)`)

    const uploaded = await translatePages(job, pageIds, remaining)
    uploaded.sort((left, right) => left.pageNumber - right.pageNumber)

    publish({ status: 'uploading' })
    log('completing job...')
    await completeJob(job.id, uploaded, log)
    log(`job ${job.id} completed`)
    publish({ currentJob: null, processedCount: state.processedCount + 1 })
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * Run the whole chapter through the pipeline, then upload each page.
 *
 * One job for every page, not one per page. `process` refuses a second job
 * while one is running ("another process is already running"), and it refuses
 * it for good reason: `koharu-pipeline` has its own scheduler that already
 * runs detection on one page while another is being translated and a third is
 * inpainted, with backpressure so a fast stage cannot run away from a slow
 * one. The 0.59.2 agent had to build that overlap by hand because the old
 * API had no scheduler; here, hand-rolling it is both redundant and refused.
 */
async function translatePages(
  job: AgentJob,
  pageIds: EntityId[],
  pages: AgentPage[],
): Promise<CompletePage[]> {
  // Retried as a whole, which is cheap: every stage implements `skip`, so a
  // second run leaves the pages it already detected, OCR'd and inpainted
  // alone - and detection is the expensive one. Without this a single
  // transient 502 from the shared LLM box throws away a whole chapter's GPU
  // work, which is exactly what the first live run did.
  for (let attempt = 1; ; attempt++) {
    log(`running the pipeline over ${pageIds.length} page(s)...`)
    try {
      const jobId = await commands.process(
        { scope: 'pages', value: pageIds },
        { operation: 'full' },
      )
      let lastBeat = 0
      await awaitJob(jobId, (done, total) => {
        log(`pipeline ${done}/${total}`)
        // The lease has to outlive the whole chapter, and the pipeline can
        // spend minutes on one page.
        if (Date.now() - lastBeat > HEARTBEAT_MS) {
          lastBeat = Date.now()
          void sendHeartbeat(job.id)
        }
      })
      break
    } catch (error) {
      throwIfStopped()
      if (attempt >= PIPELINE_ATTEMPTS) throw error
      log(`pipeline failed: ${reason(error)} — retrying (${attempt}/${PIPELINE_ATTEMPTS})`)
      await sendHeartbeat(job.id)
      await delay(RETRY_WAIT_MS)
    }
  }

  publish({ status: 'uploading' })
  const uploaded: CompletePage[] = []
  for (const [index, pageId] of pageIds.entries()) {
    throwIfStopped()
    const pageNumber = pages[index]?.pageNumber ?? index + 1
    uploaded.push(await uploadFinishedPage(job, pageId, pageNumber))
    log(`uploaded page ${pageNumber} (${uploaded.length}/${pageIds.length})`)
    await sendHeartbeat(job.id)
  }
  return uploaded
}

// --- loop ---------------------------------------------------------------------

/**
 * Is the translation provider answering?
 *
 * Checked before claiming, never after. The LLM box is shared and goes down
 * on its own; an agent that claims a chapter it cannot translate marks it
 * failed and immediately claims the next one, so a single outage churns the
 * whole queue into failures. Idling costs nothing.
 *
 * The 0.59.2 agent had this as `ensureLlmLoaded`, which also chose a model.
 * Choosing is the supervisor's job now - this only asks whether the pinned
 * one can be reached.
 */
async function providerReachable(): Promise<boolean> {
  const { pipeline } = await commands.getPreferences()
  const provider = pipeline.translation.model.provider
  try {
    // Asked through koharu, not with fetch. The provider is a different
    // origin and sends no CORS headers - a Cloudflare 502 certainly does not
    // - so from the webview a dead server and a healthy one both come back as
    // "Failed to fetch", and the agent would idle for ever. Listing models is
    // the same call koharu already makes to populate its model picker.
    const models = await commands.getTranslationModels()
    if (models.some((model) => model.provider === provider)) return true
    log(`translation provider ${provider} is not answering`)
    return false
  } catch (error) {
    log(`could not reach the translation provider: ${reason(error)}`)
    return false
  }
}

/** One pass. Returns true when a chapter was processed. */
async function processOneJob(): Promise<boolean> {
  if (!(await providerReachable())) return false
  publish({ status: 'polling' })
  const claim = await claimJob(log)
  if (!claim.claimed) {
    log(`no jobs available (${claim.reason})`)
    return false
  }
  try {
    await processClaim(claim)
    return true
  } catch (error) {
    const why = reason(error)
    log(`job ${claim.job.id} failed: ${why}`)
    await failJob(claim.job.id, why, log)
    publish({ currentJob: null })
    throw error
  }
}

async function loop(): Promise<void> {
  let sinceRecycle = 0
  while (!stopped()) {
    try {
      const processed = await processOneJob()
      if (!processed) {
        publish({ status: 'cooldown' })
        await delay(IDLE_WAIT_MS)
        continue
      }
      sinceRecycle += 1
      if (settings.recycleAfterChapters > 0 && sinceRecycle >= settings.recycleAfterChapters) {
        log(`recycling the process after ${sinceRecycle} chapter(s) to release GPU memory`)
        stopAgent()
        await relaunch()
        return
      }
    } catch (error) {
      if (stopped()) return
      const why = reason(error)
      publish({ status: 'error', lastError: why })
      log(`agent error: ${why}`)
      await delay(ERROR_WAIT_MS)
    }
  }
}

export function startAgent(next: AgentSettings = defaultAgentSettings): void {
  if (abort && !abort.signal.aborted) return
  settings = next
  abort = new AbortController()
  publish({ status: 'polling', lastError: null })
  log('agent started')
  void loop().finally(() => publish({ status: 'stopped', currentJob: null }))
}

export function stopAgent(): void {
  abort?.abort()
  abort = null
  publish({ status: 'stopped', currentJob: null })
  log('agent stopped')
}

export function isAgentRunning(): boolean {
  return !stopped()
}
