'use client'

// The unattended agent's half of the manga-th.net API. This is NOT the human
// translator's device-login flow: the agent authenticates as a worker with its
// own two headers and talks only to /api/admin/translation/agent/*.

import { commands } from '@koharu/bridge/protocol'

export const WEBSITE_API = process.env.NEXT_PUBLIC_WEBSITE_API || 'https://manga-th.net'

export type AgentJob = {
  id: string
  contentId: string
  chapterId: string
  sourceLanguage: string
  targetLanguage: string
  priority: number
  leasedUntil: string
}

export type AgentPage = {
  id: string
  pageNumber: number
  imageUrl: string
}

export type ClaimResponse =
  | { success: true; claimed: false; reason: string; waitMs: number }
  | {
      success: true
      claimed: true
      agentId: string
      job: AgentJob
      pages: AgentPage[]
      /** Resolved central glossary (global + type + series) as a system prompt. */
      systemPrompt?: string | null
      /** Page numbers already translated; a resumed run skips them. */
      donePageNumbers?: number[]
    }

export type ClaimedJob = Extract<ClaimResponse, { claimed: true }>

export type TextBlock = {
  x: number
  y: number
  w: number
  h: number
  rotationDeg: number
  text: string
  /** Original OCR text, so a reviewer can compare. */
  sourceText?: string
  fontSizeRel: number
  color?: string
  strokeColor?: string
  direction?: 'horizontal' | 'vertical'
}

export type CompletePage = {
  pageNumber: number
  translatedImageUrl: string
  inpaintedImageUrl?: string
  textBlocks?: TextBlock[]
  pageWidth?: number
  pageHeight?: number
}

/**
 * fetch() has no default timeout, and the agent lives in a webview that runs
 * for weeks. One stalled connection used to hang the loop for hours with
 * nothing after the last log line — including the call that reports failure,
 * which then never let the loop restart. Every request here has a deadline.
 */
const DEFAULT_TIMEOUT_MS = 60_000

export type Logger = (message: string) => void

export async function fetchDeadline(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = 1,
  log?: Logger,
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      lastError = error
      const reason =
        (error as Error)?.name === 'TimeoutError'
          ? `timed out after ${Math.round(timeoutMs / 1000)}s`
          : (error as Error)?.message
      log?.(`fetch ${reason} (try ${attempt}/${attempts}): ${input.slice(0, 100)}`)
      if (attempt < attempts) await delay(2_000 * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Describe whatever was thrown.
 *
 * Tauri commands reject with the serialized error, which for this app is a
 * plain string — reading `.message` off it yields `undefined`, and the first
 * live run spent its pipeline failures reporting exactly that instead of the
 * reason. Anything can be thrown in JavaScript; this handles that.
 */
export function reason(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** Credentials are read per call so a change in the panel takes effect at once. */
async function agentFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = 1,
  log?: Logger,
): Promise<Response> {
  const { token, agentId } = await commands.farmGetAgentCredentials()
  if (!token) throw new Error('no agent token is configured for this instance')
  return fetchDeadline(
    `${WEBSITE_API}${path}`,
    {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        'x-translation-agent-token': token,
        'x-translation-agent-id': agentId,
      },
    },
    timeoutMs,
    attempts,
    log,
  )
}

export async function claimJob(log?: Logger): Promise<ClaimResponse> {
  const response = await agentFetch('/api/admin/translation/agent/claim', { method: 'POST' }, 45_000, 1, log)
  if (!response.ok) {
    throw new Error(`claim failed: ${response.status} ${response.statusText}`)
  }
  // Read the body as text first: a malformed or empty response then produces a
  // log line showing what actually came back, not "Unexpected end of JSON".
  const raw = await response.text()
  try {
    return JSON.parse(raw) as ClaimResponse
  } catch (error) {
    log?.(`claim response was not JSON (${raw.length} bytes): ${raw.slice(0, 300)}`)
    throw new Error(`claim response not JSON: ${reason(error)}`)
  }
}

/** Heartbeats extend the lease. Losing one is not worth failing a job over. */
export async function sendHeartbeat(jobId: string): Promise<void> {
  try {
    await agentFetch(
      '/api/admin/translation/agent/heartbeat',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId }) },
      15_000,
    )
  } catch {
    // non-fatal
  }
}

export async function uploadPage(
  jobId: string,
  pageNumber: number,
  blob: Blob,
  fileName?: string,
  log?: Logger,
): Promise<string> {
  const query = new URLSearchParams({ jobId, pageNumber: String(pageNumber) })
  if (fileName) query.set('fileName', fileName)
  const response = await agentFetch(
    `/api/admin/translation/agent/upload?${query.toString()}`,
    {
      method: 'POST',
      headers: { 'content-type': blob.type || 'image/png' },
      body: await blob.arrayBuffer(),
    },
    180_000,
    3,
    log,
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(`upload page ${pageNumber} failed: ${body.error || response.statusText}`)
  }
  const body = (await response.json()) as { uploaded: { url: string } }
  return body.uploaded.url
}

export async function completeJob(jobId: string, pages: CompletePage[], log?: Logger): Promise<void> {
  const response = await agentFetch(
    '/api/admin/translation/agent/complete',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, pages }),
    },
    180_000,
    1,
    log,
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(`complete failed: ${body.error || response.statusText}`)
  }
}

export async function failJob(jobId: string, message: string, log?: Logger): Promise<void> {
  try {
    await agentFetch(
      '/api/admin/translation/agent/fail',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, error: message.slice(0, 1000) }),
      },
      30_000,
      2,
      log,
    )
  } catch (error) {
    log?.(`failed to report job failure to the website: ${reason(error)}`)
  }
}

/**
 * Absolute URL of one source page.
 *
 * The bytes are fetched in Rust, not here — see `farm_import_pages`. The
 * website sometimes gives a site-relative path, so resolve it first.
 */
export function sourceUrl(page: AgentPage): string {
  return page.imageUrl.startsWith('http') ? page.imageUrl : `${WEBSITE_API}${page.imageUrl}`
}
