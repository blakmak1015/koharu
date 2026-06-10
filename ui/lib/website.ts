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
  web('/api/auth/device/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'koharu' }),
  })

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
export type Me = { id: string; email: string; name: string; role: string; isAdmin: boolean; tokenBalance: number }
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
    role: raw.role ?? 'user',
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

// --- edit already-published chapters (fix typos / text placement) ----------
export type EditableChapter = {
  chapterId: string
  contentId: string
  seriesTitle: string
  chapterNo: string
}
export type EditSourceBlock = {
  xRel: number
  yRel: number
  wRel: number
  hRel: number
  rotationDeg: number
  translation: string
  fontSizeRel: number | null
  color: string | null
  strokeColor: string | null
  direction: string
}
export type EditSourcePage = {
  pageNumber: number
  inpaintedImageUrl: string
  imageUrl: string | null
  pageWidth: number | null
  pageHeight: number | null
  blocks: EditSourceBlock[]
}
export type EditSource = {
  chapterId: string
  contentId: string
  editable: boolean
  pages: EditSourcePage[]
}

// Published manga chapters that can be re-opened in the editor.
export const listEditable = (t: string): Promise<EditableChapter[]> =>
  web('/api/translator/chapters/editable', {}, t)

// Reconstruction data (clean pages + translated blocks) for one chapter.
export const getEditSource = (chapterId: string, t: string): Promise<EditSource> =>
  web(`/api/translator/chapters/${chapterId}/edit-source`, {}, t)

// --- central glossary (PostgreSQL) -----------------------------------------
// The series glossary is editable in koharu's GlossaryDialog; global+type come
// down as a read-only context prompt. Edits sync back to the central store on
// Submit so future auto-translation improves.
export type WebGlossaryEntry = { source: string; target: string }

export const resolveGlossary = (
  contentId: string,
  t: string,
): Promise<{
  seriesEntries: WebGlossaryEntry[]
  seriesNotes: string
  contextPrompt: string | null
}> => web(`/api/glossary/resolve?contentId=${encodeURIComponent(contentId)}`, {}, t)

// --- central glossary admin (two-way sync with the web /admin/glossary) ------
export type CentralGlossary = {
  scopeType: 'global' | 'content_type' | 'series'
  scopeValue: string
  entries: WebGlossaryEntry[]
  notes: string
  title?: string
}
export const listGlossaries = (t: string): Promise<{ items: CentralGlossary[] }> =>
  web('/api/admin/glossary', {}, t)
export const saveGlossaryScope = (
  scopeType: string,
  scopeValue: string,
  entries: WebGlossaryEntry[],
  notes: string,
  t: string,
): Promise<unknown> =>
  web(
    '/api/admin/glossary',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopeType, scopeValue, entries, notes }),
    },
    t,
  )

// Save the editor's in-progress text blocks as a draft (resume later / survive
// idle-kill). pages: [{ pageNumber, textBlocks, pageWidth, pageHeight }].
export const saveDraft = (
  jobId: string,
  pages: unknown[],
  t: string,
): Promise<unknown> =>
  web(
    `/api/translator/chapters/${encodeURIComponent(jobId)}/draft`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages }),
    },
    t,
  )

export const pushSeriesGlossary = (
  contentId: string,
  entries: WebGlossaryEntry[],
  notes: string,
  t: string,
): Promise<unknown> =>
  web(
    `/api/glossary/series/${encodeURIComponent(contentId)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries, notes }),
    },
    t,
  )

// Create + claim an edit job for an already-published chapter. Returns the new
// translation_job id used by the normal submit flow. 409 if a job is active.
export async function reopenEdit(
  chapterId: string,
  t: string,
): Promise<{ success: boolean; jobId?: string; reason?: string; status?: string }> {
  const res = await fetch(`${WEBSITE_API}/api/translator/chapters/${chapterId}/reopen-edit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}` },
  })
  return (await res.json().catch(() => ({}))) as {
    success: boolean
    jobId?: string
    reason?: string
    status?: string
  }
}

// Fetch a CDN image URL as a Blob for re-import into koharu.
export async function fetchImageBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch image ${res.status}`)
  return res.blob()
}

export { WEBSITE_API }
