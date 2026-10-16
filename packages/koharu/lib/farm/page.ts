'use client'

// Turning one koharu page into what the website publishes: a branded image,
// and the translated text as proportional boxes the reader lays over it.

import { commands } from '@koharu/bridge/protocol'
import type { Layer, Page, PageVariant } from '@koharu/bridge/protocol'

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

function bounds(points: { x: number; y: number }[]): { x: number; y: number; w: number; h: number } {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
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
  let page: Page
  try {
    page = await commands.farmGetPage(pageId)
  } catch (error) {
    // Never silently: an empty result here costs the published chapter its
    // HTML text overlay, and the first time it happened nothing said so.
    log?.(`could not read page ${pageId}: ${String(error)}`)
    return { textBlocks: [], width: 0, height: 0 }
  }
  const width = page.size.width
  const height = page.size.height
  if (!(width > 0 && height > 0)) {
    log?.(`page ${pageId} has no size (${width}x${height})`)
    return { textBlocks: [], width: 0, height: 0 }
  }

  // A pipeline-created text layer carries no geometry of its own: detection
  // makes the layer and relates it to the region it was recognised from, and
  // the position lives on that region. Looking only at the layer found
  // nothing on every page of every chapter.
  const regions = new Map(page.regions.map((region) => [region.id, region]))

  const counts = { layers: 0, text: 0, visible: 0, geometry: 0, translated: 0 }
  const textBlocks: TextBlock[] = []
  for (const layer of page.layers as Layer[]) {
    counts.layers += 1
    if (layer.type !== 'text') continue
    counts.text += 1
    if (!layer.visibility.visible) continue
    counts.visible += 1
    const geometry =
      layer.geometry ??
      regions.get(layer.content.source_region ?? '')?.geometry ??
      regions.get(layer.automatic_region ?? '')?.geometry
    if (!geometry) continue
    counts.geometry += 1
    const text = layer.content.translation?.text?.trim()
    if (!text) continue
    counts.translated += 1
    const box = bounds(geometry.points)
    if (box.w <= 0 || box.h <= 0) continue
    const sourceText = layer.content.source?.text?.trim()
    const size = layer.typography?.size ?? 0
    textBlocks.push({
      x: clamp01(box.x / width),
      y: clamp01(box.y / height),
      w: clamp01(box.w / width),
      h: clamp01(box.h / height),
      rotationDeg: layer.angle_degrees ?? 0,
      text,
      ...(sourceText ? { sourceText } : {}),
      fontSizeRel: size > 0 ? size / width : 0,
      color: toHex(layer.typography?.color),
      strokeColor: contrastingStroke(layer.typography?.color),
      // Vertical Japanese is the common case, so the reader needs to be told
      // when a block is not horizontal.
      direction: layer.typography?.writing_mode === 'Vertical' ? 'vertical' : 'horizontal',
    })
  }
  if (textBlocks.length === 0) {
    log?.(
      `page ${pageId}: no text blocks — layers ${counts.layers}, text ${counts.text}, ` +
        `visible ${counts.visible}, with geometry ${counts.geometry}, translated ${counts.translated}`,
    )
  }
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
