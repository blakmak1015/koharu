'use client'

// Root-level auth gate. Blocks entire app until user is logged in.
// Also mounts WebsiteDialog at root level so it's accessible from both
// WelcomeScreen and MenuBar.

import { LoaderIcon } from 'lucide-react'
import { useEffect } from 'react'

import { LoginScreen } from '@/components/LoginScreen'
import { WebsiteDialog } from '@/components/WebsiteDialog'
import { useAuthStore } from '@/lib/stores/authStore'
import { getAgentToken, isAgentRunning, startAgent } from '@/lib/websiteAgent'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((s) => s.status)
  const init = useAuthStore((s) => s.init)
  const websiteDialogOpen = useAuthStore((s) => s.websiteDialogOpen)
  const setWebsiteDialogOpen = useAuthStore((s) => s.setWebsiteDialogOpen)

  useEffect(() => {
    void init()
  }, [init])

  // Auto-start the translation agent when launched as the GUI "server" instance
  // (its window URL carries ?agent=1 — set in app.rs). Headless editor instances
  // never get that param, so they never run the agent. Requires the agent token
  // to have been configured once (persists in this instance's local storage).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('agent') !== '1') return
    if (isAgentRunning() || !getAgentToken()) return
    startAgent()
  }, [])

  // Presence ping for the editor gateway: signals a human is actively using this
  // instance so it isn't idle-killed. Throttled; harmless (404) when not behind
  // the gateway (e.g. the direct :4000 GUI).
  useEffect(() => {
    let last = 0
    const ping = () => {
      const now = Date.now()
      if (now - last < 30_000) return
      last = now
      fetch('/_gw/ping').catch(() => {})
    }
    ping()
    window.addEventListener('mousemove', ping, { passive: true })
    window.addEventListener('keydown', ping)
    window.addEventListener('click', ping)
    return () => {
      window.removeEventListener('mousemove', ping)
      window.removeEventListener('keydown', ping)
      window.removeEventListener('click', ping)
    }
  }, [])

  if (status === 'loading') {
    return (
      <div className='flex h-screen w-screen items-center justify-center bg-background'>
        <LoaderIcon className='h-6 w-6 animate-spin text-muted-foreground' />
      </div>
    )
  }

  if (status === 'logged_out') {
    return <LoginScreen />
  }

  return (
    <>
      {children}
      <WebsiteDialog open={websiteDialogOpen} onOpenChange={setWebsiteDialogOpen} />
    </>
  )
}
