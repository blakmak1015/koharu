import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { waitForWake } from '@/lib/farm/wake'
import { commands } from '@koharu/bridge/protocol'

vi.mock('@koharu/bridge/protocol', () => ({ commands: { farmWaitWake: vi.fn() } }))

const wait = vi.mocked(commands.farmWaitWake)

describe('waitForWake', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('re-polls on the gateway timeout and returns on a wake', async () => {
    wait.mockResolvedValueOnce(204).mockResolvedValueOnce(204).mockResolvedValueOnce(200)
    const log = vi.fn()
    const result = waitForWake(60_000, 123, () => false, log)
    await vi.runAllTimersAsync()
    expect(await result).toBe('wake')
    expect(wait).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenLastCalledWith(
      'http://127.0.0.1:4100/__agent-wake/wait?kind=translation&since=123',
    )
    // one liveness line per gateway answer, for ops/keepalive.ps1
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('backs off a dead gateway and times out at the deadline', async () => {
    wait.mockRejectedValue('connection refused')
    const log = vi.fn()
    const result = waitForWake(150_000, 0, () => false, log)
    await vi.runAllTimersAsync()
    expect(await result).toBe('timeout')
    // t=0, 60 s, 120 s; the third back-off is cut to the 150 s deadline
    expect(wait).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledWith('wake gateway unreachable: connection refused')
  })

  it('does not poll once the agent is stopped', async () => {
    expect(await waitForWake(60_000, 0, () => true, vi.fn())).toBe('stopped')
    expect(wait).not.toHaveBeenCalled()
  })
})
