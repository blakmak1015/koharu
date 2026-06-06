'use client'

// Root-level auth gate. Blocks entire app until user is logged in.
// Also mounts WebsiteDialog at root level so it's accessible from both
// WelcomeScreen and MenuBar.

import { LoaderIcon } from 'lucide-react'
import { useEffect } from 'react'

import { LoginScreen } from '@/components/LoginScreen'
import { WebsiteDialog } from '@/components/WebsiteDialog'
import { useAuthStore } from '@/lib/stores/authStore'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((s) => s.status)
  const init = useAuthStore((s) => s.init)
  const websiteDialogOpen = useAuthStore((s) => s.websiteDialogOpen)
  const setWebsiteDialogOpen = useAuthStore((s) => s.setWebsiteDialogOpen)

  useEffect(() => {
    void init()
  }, [init])

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
