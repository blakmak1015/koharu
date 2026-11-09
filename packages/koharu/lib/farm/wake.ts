'use client'

// The farm's idle wait. An empty queue used to cost a claim every 15 s, all
// of it billed Worker requests; now the website POSTs the local editor gateway
// when it queues translation work, and the farm long-polls that gateway on
// localhost instead. Mirrors workers/agent-wake.ts in the website repo, the
// import agent's copy of the same client.

import { commands } from '@koharu/bridge/protocol'

import { delay, reason, type Logger } from './website'

const WAKE_URL = 'http://127.0.0.1:4100/__agent-wake/wait'
/** Longest idle wait: a missed wake only delays work by this much. */
export const WAKE_SAFETY_MS = 30 * 60_000
// Gateway down or too old to know the route: ask again this often.
const GATEWAY_RETRY_MS = 60_000

/**
 * Wait until the website wakes the farm, `ms` passes, or the agent stops.
 *
 * `since` is Date.now() taken before the claim that came back empty, so a
 * wake landing between that claim and this call is not lost. Logs a line per
 * gateway answer - at least every five minutes - which is what tells
 * ops/keepalive.ps1 that an idle farm is alive.
 *
 * shortcut: a poll already in flight cannot be cancelled, so the deadline and
 * a stop can overshoot by up to one gateway poll (~4 min); fine for an idle
 * wait, upgrade only if stopping an idle farm has to be instant.
 */
export async function waitForWake(
  ms: number,
  since: number,
  isStopped: () => boolean,
  log: Logger,
): Promise<'wake' | 'timeout' | 'stopped'> {
  const deadline = Date.now() + ms
  while (!isStopped() && Date.now() < deadline) {
    let retryAfter = GATEWAY_RETRY_MS
    try {
      const status = await commands.farmWaitWake(`${WAKE_URL}?kind=translation&since=${since}`)
      if (status === 200) return 'wake'
      if (status === 204) {
        retryAfter = 0
        log('idle, waiting for the website to wake the farm')
      } else {
        log(`wake gateway answered ${status}`)
      }
    } catch (error) {
      log(`wake gateway unreachable: ${reason(error)}`)
    }
    await delay(Math.max(0, Math.min(retryAfter, deadline - Date.now())))
  }
  return isStopped() ? 'stopped' : 'timeout'
}
