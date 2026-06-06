// Website integration (our fork's addition, kept isolated for easy rebasing onto
// upstream koharu). Talks to the central manga-website Node API for the translator
// workflow: device-flow login, chapter pool/claim, submit. Heavy ML + editing still
// use koharu's own /api/v1. The website base URL is configurable; defaults to local dev.
const WEBSITE_API =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_WEBSITE_API) || 'https://manga-th.net'

// --- token storage: koharu keyring route when available, else localStorage ---
const TOKEN_KEY = 'website_token'

export async function getToken(): Promise<string | null> {
  try {
    const r = await fetch('/api/v1/ext/token')
    if (r.ok) return (await r.json()).token ?? null
  } catch {}
  return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null
}

export async function setToken(token: string): Promise<void> {
  try {
    const r = await fetch('/api/v1/ext/token', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (r.ok) return
  } catch {}
  if (typeof localStorage !== 'undefined') localStorage.setItem(TOKEN_KEY, token)
}

export async function clearToken(): Promise<void> {
  try {
    await fetch('/api/v1/ext/token', { method: 'DELETE' })
  } catch {}
  if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY)
}

async function web(path: string, init: RequestInit = {}, token?: string | null): Promise<any> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${WEBSITE_API}${path}`, { ...init, headers })
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(body?.error || res.statusText)
  return body
}

// --- device-flow login ---
export type DeviceCode = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  interval: number
}

export const startDeviceLogin = (): Promise<DeviceCode> =>
  web('/api/auth/device/code', { method: 'POST' })

// Returns the access token once approved, or null while still pending.
// The website returns HTTP 400 with { error: "authorization_pending" } while waiting.
export async function pollDeviceToken(deviceCode: string): Promise<string | null> {
  const res = await fetch(`${WEBSITE_API}/api/auth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  })
  const body = await res.json()
  if (!res.ok) {
    if (body.error === 'authorization_pending' || body.error === 'slow_down') return null
    throw new Error(body.error || 'login failed')
  }
  return body.access_token
}

// --- workflow ---
export type Me = { id: string; email: string; name: string; isAdmin: boolean; tokenBalance: number }
export type Chapter = { id: string; seriesTitle: string; chapterNo: string; rewardTokens: number }
export type ChapterDetail = Chapter & {
  status: string
  mine: boolean
  pages: { page_no: number; filename: string }[]
}

// /api/me returns { displayName, credits, role } — map to our Me type
export async function getMe(t: string): Promise<Me> {
  const raw = await web('/api/me', {}, t)
  return {
    id: raw.id,
    email: raw.email,
    name: raw.displayName || raw.email,
    isAdmin: raw.role === 'admin',
    tokenBalance: raw.credits ?? 0,
  }
}
export const listChapters = (t: string): Promise<Chapter[]> =>
  web('/api/translator/chapters', {}, t)
export const listMine = (t: string): Promise<(Chapter & { status: string })[]> =>
  web('/api/translator/chapters/mine', {}, t)
export const claimChapter = (id: string, t: string): Promise<any> =>
  web(`/api/translator/chapters/${id}/claim`, { method: 'POST' }, t)
export const getChapter = (id: string, t: string): Promise<ChapterDetail> =>
  web(`/api/translator/chapters/${id}`, {}, t)

// Fetch one raw (untranslated) source page as a Blob (authorized).
export async function fetchRawPage(id: string, pageNo: number, t: string): Promise<Blob> {
  const res = await fetch(`${WEBSITE_API}/api/translator/chapters/${id}/pages/${pageNo}/raw`, {
    headers: { authorization: `Bearer ${t}` },
  })
  if (!res.ok) throw new Error(`raw page ${pageNo}: ${res.status}`)
  return res.blob()
}

// Submit final translated pages (PNG blobs, in order) back to the website.
export async function submitPages(id: string, pages: Blob[], t: string): Promise<any> {
  const fd = new FormData()
  pages.forEach((b, i) => fd.append('pages', b, `${i + 1}.png`))
  const res = await fetch(`${WEBSITE_API}/api/translator/chapters/${id}/submit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}` },
    body: fd,
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || 'submit failed')
  return body
}

export { WEBSITE_API }
