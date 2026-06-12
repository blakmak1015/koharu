'use client'

import { useEffect, useRef } from 'react'

import { useScene } from '@/hooks/useScene'

// Fetch every hash to completion at bounded concurrency so each response fully
// lands in the browser HTTP cache (blobs carry `Cache-Control: immutable`).
async function warmBlobCache(hashes: string[], concurrency = 3): Promise<void> {
  let i = 0
  const worker = async () => {
    while (i < hashes.length) {
      const h = hashes[i++]
      try {
        const r = await fetch(`/api/v1/blobs/${h}`)
        await r.blob()
      } catch {
        /* best-effort warm-up */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hashes.length) }, worker))
}

/**
 * After a project's scene loads, warm the browser cache with every visible page
 * image in page order. Blobs are immutable + long-cached, so once fetched they
 * stay cached and switching pages in a REMOTE editor (over the cloudflared
 * tunnel) is instant instead of re-downloading ~3MB per page on first view.
 *
 * - No-op on localhost (the agent / desktop GUI) where blobs are already local.
 * - Skips `source` images (not shown during review) to halve warm-up traffic.
 * - Fire-and-forget per distinct page set, so an edit (which mutates the scene)
 *   doesn't cancel an in-flight warm-up.
 */
export function usePrefetchPageBlobs(): void {
  const { scene } = useScene()
  const startedSig = useRef('')

  useEffect(() => {
    if (!scene || typeof window === 'undefined') return
    if (/^(127\.0\.0\.1|localhost)(:|$)/.test(window.location.host)) return

    const pageMap = (scene.pages ?? {}) as Record<
      string,
      { nodes?: Record<string, { visible?: boolean; kind?: { image?: { blob?: string; role?: string } } }> }
    >
    const sig = Object.keys(pageMap).join(',')
    if (!sig || startedSig.current === sig) return

    const seen = new Set<string>()
    const hashes: string[] = []
    for (const p of Object.values(pageMap)) {
      for (const n of Object.values(p.nodes ?? {})) {
        if (n?.visible === false) continue
        const img = n?.kind?.image
        if (!img || img.role === 'source') continue
        const h = img.blob
        if (typeof h === 'string' && h && !seen.has(h)) {
          seen.add(h)
          hashes.push(h)
        }
      }
    }
    if (!hashes.length) return

    startedSig.current = sig
    void warmBlobCache(hashes)
  }, [scene])
}
