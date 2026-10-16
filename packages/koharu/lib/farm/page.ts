'use client'

// Turning one koharu page into what the website publishes: a branded image,
// and the translated text as proportional boxes the reader lays over it.

import { commands } from '@koharu/bridge/protocol'
import type { FarmPage, PageVariant } from '@koharu/bridge/protocol'

import type { TextBlock } from './website'

export type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Typography colours are 0-255 RGBA quadruples. */
const toHex = (color: readonly number[] | null | undefined): string => {
  const rgb = color && color.length >= 3 ? color : [0, 0, 0]
  return `#${rgb
    .slice(0, 3)
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
    .join('')}`
}

/** Readable against the text itself, whichever way the text goes. */
const contrastingStroke = (color: readonly number[] | null | undefined): string => {
  const rgb = color && color.length >= 3 ? color : [0, 0, 0]
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 128 ? '#000000' : '#ffffff'
}

/**
 * Read one page's translated text as proportional boxes.
 *
 * Proportional, not pixels: the reader serves a resized image and positions
 * the same boxes over whatever size it ends up showing.
 */
export async function pageTextBlocks(
  pageId: string,
  log?: (message: string) => void,
): Promise<{ textBlocks: TextBlock[]; width: number; height: number }> {
  let page: FarmPage
  try {
    page = await commands.farmPageBlocks(pageId)
  } catch (error) {
    // Never silently: an empty result here costs the published chapter its
    // HTML text overlay, and the first time it happened nothing said so.
    log?.(`could not read page ${pageId}: ${String(error)}`)
    return { textBlocks: [], width: 0, height: 0 }
  }
  const { width, height } = page
  if (!(width > 0 && height > 0)) {
    log?.(`page ${pageId} has no size (${width}x${height})`)
    return { textBlocks: [], width: 0, height: 0 }
  }

  // Proportional, not pixels: the reader serves a resized image and lays the
  // same boxes over whatever size it ends up showing.
  const textBlocks: TextBlock[] = page.blocks.map((block) => ({
    x: clamp01(block.x / width),
    y: clamp01(block.y / height),
    w: clamp01(block.width / width),
    h: clamp01(block.height / height),
    rotationDeg: block.angleDegrees,
    text: block.text,
    ...(block.sourceText ? { sourceText: block.sourceText } : {}),
    fontSizeRel: block.fontSize && block.fontSize > 0 ? block.fontSize / width : 0,
    color: toHex(block.color),
    strokeColor: contrastingStroke(block.color),
    direction: block.vertical ? ('vertical' as const) : ('horizontal' as const),
  }))
  if (textBlocks.length === 0) log?.(`page ${pageId}: the scene has no translated blocks`)
  return { textBlocks, width, height }
}

/** Render one page and bake the site mark into it, ready to upload. */
export async function renderBrandedPage(
  pageId: string,
  variant: PageVariant,
  corner: WatermarkCorner,
): Promise<Blob> {
  const bytes = new Uint8Array(await commands.farmRenderPage(pageId, variant))
  return brandBlob(new Blob([bytes], { type: 'image/png' }), corner)
}

/**
 * Bake a faint "manga-th.net" mark into a rendered page and re-encode it.
 *
 * Never blocks an upload: any failure returns the original image, because a
 * page without a watermark beats a chapter that does not publish.
 */
export async function brandBlob(blob: Blob, corner: WatermarkCorner = 'top-right'): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) return blob
    context.drawImage(bitmap, 0, 0)

    const text = 'manga-th.net'
    context.font = `${Math.max(22, Math.round(bitmap.width * 0.045))}px sans-serif`
    const margin = Math.round(bitmap.width * 0.02)
    const onLeft = corner === 'top-left' || corner === 'bottom-left'
    const onTop = corner === 'top-left' || corner === 'top-right'
    context.textBaseline = onTop ? 'top' : 'bottom'
    context.fillStyle = 'rgba(110,110,110,0.5)'
    context.fillText(
      text,
      onLeft ? margin : bitmap.width - context.measureText(text).width - margin,
      Math.round(bitmap.height * (onTop ? 0.03 : 0.97)),
    )

    // Re-encode as webp. A manga page is ~2 MB as PNG and 3-4x smaller at
    // q=0.92, which keeps screentones crisp — and both the translated and the
    // clean image pass through here, so this is the one place that decides the
    // published format. Canvas webp is lossy only.
    return await new Promise<Blob>((resolve) =>
      canvas.toBlob((encoded) => resolve(encoded ?? blob), 'image/webp', 0.92),
    )
  } catch {
    return blob
  }
}
