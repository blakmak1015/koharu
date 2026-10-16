'use client'

// The unattended translation agent: claims a chapter from manga-th.net, runs
// it through the pipeline a page at a time, and uploads each finished page.
//
// Ported from the 0.59.2 fork. Two things shrank it. The pipeline is driven
// over Tauri IPC instead of koharu's old HTTP API, and job state arrives on a
// pushed channel instead of being polled — which removes the stall class the
// fork had to work around by hand.

import { commands } from '@koharu/bridge/protocol'
import type { EntityId, Job, Stage } from '@koharu/bridge/protocol'
import { relaunch } from '@tauri-apps/plugin-process'

import { useKoharuStore } from '../store'

import { pageTextBlocks, renderBrandedPage, type WatermarkCorner } from './page'
import {
  claimJob,
  completeJob,
  delay,
  failJob,
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
  /** Pages in flight on this machine. */
  localConcurrency: number
  /** Pages translating on the shared LLM box at once. */
  llmConcurrency: number
  /**
   * Run detect / translate+inpaint / render as stations so this GPU and the
   * LLM box work on different pages at the same time. Off = one page start to
   * finish, which is the old behaviour.
   */
  assemblyLine: boolean
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
  localConcurrency: 1,
  llmConcurrency: 2,
  assemblyLine: true,
  watermarkCorner: 'top-right',
  recycleAfterChapters: 0,
}

const IDLE_WAIT_MS = 15_000
const ERROR_WAIT_MS = 30_000
const HEARTBEAT_MS = 30_000
const JOB_TIMEOUT_MS = 600_000

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
function awaitJob(jobId: string): Promise<Job> {
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
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('pipeline timed out'))
    }, JOB_TIMEOUT_MS)
    unsubscribe = useKoharuStore.subscribe((state) => {
      const outcome = settle(state.jobs[jobId])
      if (!outcome) return
      clearTimeout(timer)
      unsubscribe()
      if (outcome.ok) resolve(outcome.job)
      else reject(new Error(outcome.error))
    })
  })
}

/**
 * One station of the assembly line, holding its machine's gate only while it
 * runs. A failed stage leaves the page incomplete — untranslated, or with the
 * source text still showing — so it is retried once and then fails loudly
 * rather than publishing a broken page.
 */
async function runStage(
  label: string,
  pageId: EntityId,
  stages: Stage[],
  gate: Semaphore,
  pageNumber: number,
): Promise<void> {
  const release = await gate.acquire()
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      throwIfStopped()
      try {
        const jobId = await commands.process({ scope: 'pages', value: [pageId] }, { operation: 'stages', stages })
        await awaitJob(jobId)
        return
      } catch (error) {
        const why = (error as Error).message
        if (attempt === 2) throw new Error(`page ${pageNumber} [${label}] failed twice: ${why}`)
        log(`page ${pageNumber} [${label}]: ${why} — retrying once`)
      }
    }
  } finally {
    release()
  }
}

/**
 * Bounds how many pages may occupy one station. Permits pass straight from a
 * releaser to the next waiter, so the count cannot drift.
 */
class Semaphore {
  private free: number
  private waiters: (() => void)[] = []

  constructor(limit: number) {
    this.free = Math.max(1, limit)
  }

  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--
    else await new Promise<void>((resolve) => this.waiters.push(resolve))
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.free++
    }
  }
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
    log(`clean image for page ${pageNumber} skipped: ${(error as Error).message}`)
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

async function translatePages(
  job: AgentJob,
  pageIds: EntityId[],
  pages: AgentPage[],
): Promise<CompletePage[]> {
  const localGate = new Semaphore(settings.localConcurrency)
  const llmGate = new Semaphore(settings.llmConcurrency)
  // A page waiting on the remote LLM must not hold a local slot, so more page
  // workers run than either limit: the gates bound each machine, not the pool.
  const workers = settings.assemblyLine
    ? settings.localConcurrency + settings.llmConcurrency
    : settings.localConcurrency
  if (settings.assemblyLine) {
    log(
      `assembly line: ${settings.localConcurrency} local + ${settings.llmConcurrency} translating, ${workers} pages in flight`,
    )
  }

  const uploaded: CompletePage[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      throwIfStopped()
      const index = next++
      if (index >= pageIds.length) return
      const pageId = pageIds[index]
      const pageNumber = pages[index]?.pageNumber ?? index + 1
      log(`translating page ${pageNumber} (${index + 1}/${pageIds.length})...`)

      if (settings.assemblyLine) {
        // Inpainting needs the detection masks, not the translation, so the
        // page is painted on this GPU while it is translated on the other box.
        await runStage('detect', pageId, ['detection', 'ocr'], localGate, pageNumber)
        await sendHeartbeat(job.id)
        await Promise.all([
          runStage('translate', pageId, ['translation'], llmGate, pageNumber),
          runStage('inpaint', pageId, ['inpainting'], localGate, pageNumber),
        ])
      } else {
        await runStage(
          'pipeline',
          pageId,
          ['detection', 'ocr', 'translation', 'inpainting'],
          localGate,
          pageNumber,
        )
      }
      await sendHeartbeat(job.id)

      uploaded.push(await uploadFinishedPage(job, pageId, pageNumber))
      log(`uploaded page ${pageNumber} (${uploaded.length}/${pageIds.length})`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, pageIds.length) }, worker))
  return uploaded
}

// --- loop ---------------------------------------------------------------------

/** One pass. Returns true when a chapter was processed. */
async function processOneJob(): Promise<boolean> {
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
    const reason = (error as Error).message
    log(`job ${claim.job.id} failed: ${reason}`)
    await failJob(claim.job.id, reason, log)
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
      const reason = (error as Error).message
      publish({ status: 'error', lastError: reason })
      log(`agent error: ${reason}`)
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
