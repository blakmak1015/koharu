'use client'

// Full-screen login gate. Shown when no website token is present.
// Uses the same device-flow login as WebsiteDialog.

import { LoaderIcon } from 'lucide-react'
import Image from 'next/image'
import { useCallback, useState } from 'react'

import { Button } from '@/components/ui/button'
import { openExternalUrl } from '@/lib/backend'
import { useAuthStore } from '@/lib/stores/authStore'
import { pollDeviceToken, startDeviceLogin } from '@/lib/website'

export function LoginScreen() {
  const login = useAuthStore((s) => s.login)
  const [busy, setBusy] = useState(false)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onLogin = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const dc = await startDeviceLogin()
      setUserCode(dc.user_code)
      await openExternalUrl(dc.verification_uri_complete)
      // Poll until approved
      for (;;) {
        await new Promise((r) => setTimeout(r, (dc.interval || 5) * 1000))
        const t = await pollDeviceToken(dc.device_code)
        if (t) {
          await login(t)
          break
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setUserCode(null)
    }
  }, [login])

  return (
    <div className='flex h-screen w-screen flex-col items-center justify-center bg-background'>
      <div className='flex flex-col items-center gap-6'>
        <Image src='/icon.png' alt='Koharu' width={64} height={64} priority />
        <div className='text-center'>
          <h1 className='text-2xl font-semibold tracking-tight text-foreground'>Koharu</h1>
          <p className='mt-1 text-sm text-muted-foreground'>Sign in to continue</p>
        </div>

        <Button onClick={onLogin} disabled={busy} size='lg' className='min-w-48'>
          {busy ? (
            <>
              <LoaderIcon className='mr-2 h-4 w-4 animate-spin' />
              Waiting for approval...
            </>
          ) : (
            'Sign in via browser'
          )}
        </Button>

        {userCode && (
          <div className='rounded-lg border border-border bg-card p-4 text-center'>
            <p className='text-xs text-muted-foreground'>Your code</p>
            <p className='mt-1 font-mono text-2xl font-bold tracking-widest'>{userCode}</p>
            <p className='mt-2 text-xs text-muted-foreground'>Approve it in the browser</p>
          </div>
        )}

        {error && (
          <p className='max-w-sm text-center text-sm text-destructive'>{error}</p>
        )}
      </div>
    </div>
  )
}
