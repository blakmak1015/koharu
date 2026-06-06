'use client'

import { create } from 'zustand'

import { clearToken, getMe, getToken, setToken as saveToken } from '@/lib/website'

export type UserRole = 'admin' | 'moderator' | 'translator' | 'supporter' | 'ads_user' | 'user'

export type AuthUser = {
  id: string
  email: string
  name: string
  role: UserRole
  tokenBalance: number
}

type AuthState = {
  /** null = not yet checked, 'logged_out' = checked but no token */
  status: 'loading' | 'logged_in' | 'logged_out'
  token: string | null
  user: AuthUser | null
  /** Convenience: true when role is admin or moderator */
  isStaff: boolean
  /** Open the website dialog from anywhere */
  websiteDialogOpen: boolean
  setWebsiteDialogOpen: (v: boolean) => void
  /** Initialise from secure storage — called once at app start */
  init: () => Promise<void>
  /** After device-flow login succeeds, store token + fetch user */
  login: (token: string) => Promise<void>
  /** Clear token + user */
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  token: null,
  user: null,
  isStaff: false,
  websiteDialogOpen: false,

  setWebsiteDialogOpen: (v) => set({ websiteDialogOpen: v }),

  init: async () => {
    try {
      const t = await getToken()
      if (!t) {
        set({ status: 'logged_out', token: null, user: null, isStaff: false })
        return
      }
      const raw = await fetchUser(t)
      set({
        status: 'logged_in',
        token: t,
        user: raw,
        isStaff: raw.role === 'admin' || raw.role === 'moderator',
      })
    } catch {
      // Token exists but /api/me failed — keep as logged_out so user can re-login
      set({ status: 'logged_out', token: null, user: null, isStaff: false })
    }
  },

  login: async (token: string) => {
    await saveToken(token)
    try {
      const raw = await fetchUser(token)
      set({
        status: 'logged_in',
        token,
        user: raw,
        isStaff: raw.role === 'admin' || raw.role === 'moderator',
      })
    } catch (e) {
      // Token saved but user fetch failed — still treat as logged in with
      // limited info so the user doesn't lose the token
      set({ status: 'logged_in', token, user: null, isStaff: false })
      throw e
    }
  },

  logout: async () => {
    await clearToken()
    set({ status: 'logged_out', token: null, user: null, isStaff: false })
  },
}))

/** Fetch user info from the website API and map to AuthUser */
async function fetchUser(token: string): Promise<AuthUser> {
  const me = await getMe(token)
  return {
    id: me.id,
    email: me.email,
    name: me.name,
    role: (me.role as UserRole) ?? 'user',
    tokenBalance: me.tokenBalance,
  }
}
