'use client'

// Fork-only operator panel for the unattended translation agent.
//
// Deliberately not a settings tab and not translated: it is seen by whoever
// runs the farm, and adding a tab would mean a key in all eight of upstream's
// locale files. It mounts itself, so KoharuApp needs one line.
//
// The effects here matter more than the chrome. The farm instance starts with
// its window hidden, so the panel is what restarts the agent after a reboot —
// collapsed or not, mounted is enough.

import { useCallback, useEffect, useState } from 'react'

import { commands } from '@koharu/bridge/protocol'
import { Button } from '@koharu/ui/components/button'
import { Input } from '@koharu/ui/components/input'
import { Switch } from '@koharu/ui/components/switch'

import {
  getAgentState,
  isAgentRunning,
  startAgent,
  stopAgent,
  subscribeAgent,
  type AgentSettings,
  type AgentState,
} from '@/lib/farm/agent'
import {
  loadAgentEnabled,
  loadAgentSettings,
  saveAgentEnabled,
  saveAgentSettings,
} from '@/lib/farm/settings'

const STATUS_COLOR: Record<AgentState['status'], string> = {
  stopped: 'bg-muted-foreground',
  polling: 'bg-sky-500',
  downloading: 'bg-sky-500',
  processing: 'bg-emerald-500',
  uploading: 'bg-emerald-500',
  cooldown: 'bg-amber-500',
  error: 'bg-rose-500',
}

export function FarmPanel() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<AgentState>(getAgentState)
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [token, setToken] = useState('')
  const [agentId, setAgentId] = useState('')
  const [hasToken, setHasToken] = useState(false)

  useEffect(() => subscribeAgent(setState), [])

  useEffect(() => {
    const stored = loadAgentSettings()
    setSettings(stored)
    void commands
      .farmGetAgentCredentials()
      .then((credentials) => {
        setAgentId(credentials.agentId)
        setHasToken(Boolean(credentials.token))
        // The unattended instance starts on its own. It has no visible window,
        // so the stored flag can never be set there — a token and no window is
        // what being the farm means. A token is required either way: without
        // one every claim fails and the log fills with the same error for as
        // long as the machine is up.
        const shouldRun = credentials.unattended || loadAgentEnabled()
        if (credentials.token && shouldRun && !isAgentRunning()) startAgent(stored)
      })
      .catch(() => undefined)
  }, [])

  const update = useCallback((changes: Partial<AgentSettings>) => {
    setSettings((current) => {
      if (!current) return current
      const next = { ...current, ...changes }
      saveAgentSettings(next)
      return next
    })
  }, [])

  const toggle = useCallback(() => {
    if (!settings) return
    if (isAgentRunning()) {
      saveAgentEnabled(false)
      stopAgent()
      return
    }
    saveAgentEnabled(true)
    startAgent(settings)
  }, [settings])

  const saveCredentials = useCallback(async () => {
    const credentials = await commands.farmSetAgentCredentials(
      token.trim() === '' ? null : token.trim(),
      agentId.trim() === '' ? null : agentId.trim(),
    )
    setAgentId(credentials.agentId)
    setHasToken(Boolean(credentials.token))
    setToken('')
  }, [agentId, token])

  const running = state.status !== 'stopped'

  if (!open) {
    return (
      <button
        type='button'
        onClick={() => setOpen(true)}
        className='fixed bottom-3 right-3 z-50 flex items-center gap-2 rounded-full border border-border/80 bg-[var(--surface-panel)] px-3 py-1.5 text-[11px] shadow-sm'
      >
        <span className={`size-2 rounded-full ${STATUS_COLOR[state.status]}`} />
        Farm
        {state.processedCount > 0 && (
          <span className='text-muted-foreground'>{state.processedCount}</span>
        )}
      </button>
    )
  }

  return (
    <aside className='fixed bottom-3 right-3 z-50 flex max-h-[80vh] w-[360px] flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--surface-panel)] text-[12px] shadow-lg'>
      <header className='flex items-center justify-between border-b border-border/80 px-4 py-2.5'>
        <div className='flex items-center gap-2'>
          <span className={`size-2 rounded-full ${STATUS_COLOR[state.status]}`} />
          <span className='font-semibold'>Translation farm</span>
          <span className='text-muted-foreground'>{state.status}</span>
        </div>
        <button type='button' onClick={() => setOpen(false)} className='text-muted-foreground'>
          ✕
        </button>
      </header>

      <div className='flex-1 overflow-y-auto px-4 py-3'>
        <div className='grid gap-2'>
          <label className='grid gap-1 text-[10px] text-muted-foreground'>
            Agent token {hasToken && <span className='text-emerald-500'>stored</span>}
            <Input
              type='password'
              value={token}
              placeholder={hasToken ? '••••••••  (leave blank to keep)' : 'paste the agent token'}
              className='h-8 text-[12px] text-foreground'
              onChange={(event) => setToken(event.currentTarget.value)}
            />
          </label>
          <label className='grid gap-1 text-[10px] text-muted-foreground'>
            Agent id
            <Input
              value={agentId}
              className='h-8 text-[12px] text-foreground'
              onChange={(event) => setAgentId(event.currentTarget.value)}
            />
          </label>
          <Button size='sm' variant='secondary' onClick={() => void saveCredentials()}>
            Save credentials
          </Button>
        </div>

        {settings && (
          <div className='mt-4 grid gap-2.5'>
            <Row label='Assembly line' hint='Translate and inpaint different pages at once'>
              <Switch
                checked={settings.assemblyLine}
                onCheckedChange={(assemblyLine) => update({ assemblyLine })}
              />
            </Row>
            <Row label='Local pages' hint='Pages on this GPU at once'>
              <Counter
                value={settings.localConcurrency}
                min={1}
                onChange={(localConcurrency) => update({ localConcurrency })}
              />
            </Row>
            <Row label='Translating' hint='Pages on the LLM box at once'>
              <Counter
                value={settings.llmConcurrency}
                min={1}
                onChange={(llmConcurrency) => update({ llmConcurrency })}
              />
            </Row>
            <Row
              label='Recycle after'
              hint='Chapters before restarting; the GPU allocator never gives its peak back. 0 = never'
            >
              <Counter
                value={settings.recycleAfterChapters}
                min={0}
                onChange={(recycleAfterChapters) => update({ recycleAfterChapters })}
              />
            </Row>
          </div>
        )}

        <div className='mt-3 flex items-center gap-2'>
          <Button size='sm' onClick={toggle} disabled={!settings}>
            {running ? 'Stop' : 'Start'}
          </Button>
          <span className='text-[10px] text-muted-foreground'>
            {state.processedCount} chapter(s) this run
          </span>
        </div>

        {state.lastError && (
          <p className='mt-2 text-[10px] leading-4 text-rose-500'>{state.lastError}</p>
        )}

        <pre className='mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-canvas)] p-2 text-[10px] leading-4 text-muted-foreground'>
          {state.log.slice(-40).join('\n') || 'no activity yet'}
        </pre>
      </div>
    </aside>
  )
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className='grid grid-cols-[1fr_auto] items-center gap-3'>
      <div>
        <p className='text-[11px] font-medium'>{label}</p>
        <p className='text-[10px] leading-4 text-muted-foreground'>{hint}</p>
      </div>
      {children}
    </div>
  )
}

function Counter({
  value,
  min,
  onChange,
}: {
  value: number
  min: number
  onChange: (value: number) => void
}) {
  return (
    <Input
      type='number'
      min={min}
      value={value}
      className='h-8 w-20 text-[12px]'
      // The browser never enforces `min` on typed text, so clamp here.
      onChange={(event) => {
        const parsed = Number(event.currentTarget.value)
        onChange(Number.isFinite(parsed) ? Math.max(min, Math.round(parsed)) : min)
      }}
    />
  )
}
