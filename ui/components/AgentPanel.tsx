'use client'

// Agent control panel (our fork's addition). Lets the operator configure the
// agent token/ID, start/stop the polling loop, and monitor activity in real
// time. Designed to live in the WebsiteDialog or as a standalone panel.

import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  type AgentState,
  getAgentId,
  getAgentState,
  getAgentToken,
  isAgentRunning,
  setAgentId,
  setAgentToken,
  startAgent,
  stopAgent,
  subscribeAgent,
} from '@/lib/websiteAgent'

const statusLabels: Record<AgentState['status'], string> = {
  stopped: 'Stopped',
  polling: 'Polling for jobs...',
  downloading: 'Downloading pages',
  processing: 'Running pipeline',
  uploading: 'Uploading results',
  submitting: 'Completing job',
  error: 'Error',
  cooldown: 'Waiting for next poll',
}

const statusColors: Record<AgentState['status'], string> = {
  stopped: 'text-zinc-400',
  polling: 'text-sky-400',
  downloading: 'text-amber-400',
  processing: 'text-purple-400',
  uploading: 'text-amber-400',
  submitting: 'text-green-400',
  error: 'text-red-400',
  cooldown: 'text-zinc-400',
}

export function AgentPanel() {
  const [state, setState] = useState<AgentState>(getAgentState)
  const [token, setTok] = useState(getAgentToken)
  const [agentId, setAid] = useState(getAgentId)
  const [showConfig, setShowConfig] = useState(!getAgentToken())

  useEffect(() => subscribeAgent(setState), [])

  const running = isAgentRunning()

  const onSaveConfig = useCallback(() => {
    setAgentToken(token)
    setAgentId(agentId)
    setShowConfig(false)
  }, [token, agentId])

  const onStart = useCallback(() => {
    setAgentToken(token)
    setAgentId(agentId)
    startAgent()
  }, [token, agentId])

  return (
    <div className='space-y-3'>
      {/* Status bar */}
      <Card className='flex items-center justify-between p-3'>
        <div className='flex items-center gap-2'>
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              running
                ? state.status === 'error'
                  ? 'bg-red-400 animate-pulse'
                  : 'bg-emerald-400 animate-pulse'
                : 'bg-zinc-500'
            }`}
          />
          <span className={`text-sm font-medium ${statusColors[state.status]}`}>
            {statusLabels[state.status]}
          </span>
          {state.processedCount > 0 && (
            <span className='text-xs text-muted-foreground'>
              ({state.processedCount} completed)
            </span>
          )}
        </div>
        <div className='flex gap-2'>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => setShowConfig(!showConfig)}
          >
            Config
          </Button>
          {running ? (
            <Button size='sm' variant='destructive' onClick={stopAgent}>
              Stop Agent
            </Button>
          ) : (
            <Button size='sm' onClick={onStart} disabled={!token.trim()}>
              Start Agent
            </Button>
          )}
        </div>
      </Card>

      {/* Config */}
      {showConfig && (
        <Card className='space-y-2 p-3'>
          <div>
            <label className='text-xs font-medium'>Agent Token</label>
            <Input
              type='password'
              value={token}
              onChange={(e) => setTok(e.target.value)}
              placeholder='translation agent token'
              disabled={running}
            />
          </div>
          <div>
            <label className='text-xs font-medium'>Agent ID</label>
            <Input
              value={agentId}
              onChange={(e) => setAid(e.target.value)}
              placeholder='koharu-default'
              disabled={running}
            />
          </div>
          <Button size='sm' variant='secondary' onClick={onSaveConfig} disabled={running}>
            Save
          </Button>
        </Card>
      )}

      {/* Error */}
      {state.lastError && (
        <Card className='border-red-500/30 bg-red-500/5 p-3'>
          <p className='text-xs font-medium text-red-400'>Last error</p>
          <p className='mt-1 text-xs text-red-300'>{state.lastError}</p>
        </Card>
      )}

      {/* Current job */}
      {state.currentJob && (
        <Card className='border-amber-500/30 bg-amber-500/5 p-3'>
          <p className='text-xs font-medium text-amber-300'>Current job</p>
          <p className='mt-1 break-all font-mono text-xs text-amber-200'>
            {state.currentJob.id}
          </p>
          <p className='text-xs text-amber-300/70'>
            {state.currentJob.sourceLanguage} &rarr; {state.currentJob.targetLanguage}
          </p>
        </Card>
      )}

      {/* Log */}
      {state.log.length > 0 && (
        <div>
          <p className='mb-1 text-xs font-medium text-muted-foreground'>Activity log</p>
          <ScrollArea className='h-40 rounded border bg-black/30'>
            <div className='space-y-0.5 p-2'>
              {state.log.map((line, i) => (
                <p
                  key={i}
                  className={`font-mono text-[11px] ${
                    line.includes('Error') ? 'text-red-400' : 'text-zinc-400'
                  }`}
                >
                  {line}
                </p>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
