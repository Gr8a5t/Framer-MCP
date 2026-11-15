import type { FrameItem, ResolutionPreset } from '../types/media'
import {
  computeScaledDimensions,
  getFileExtension,
  getMimeTypeForImageExt,
} from './format'

export interface ImageDimensions {
  width: number
  height: number
}

export interface InspectedZipFramesSummary {
  width: number
  height: number
  hasMixedSizes: boolean
  hasOddDimensions: boolean
  formatsFound: string[]
  framesWithDimensions: FrameItem[]
}

export interface PreparedFFmpegFrames {
  ext: 'png' | 'jpg'
  buffers: Uint8Array[]
  width: number
  height: number
  normalized: boolean
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  )
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    ((bytes[offset + 3] << 24) >>> 0)
  )
}

function parsePngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  if (!isPng) return null

  const width = readUint32BE(bytes, 16)
  const height = readUint32BE(bytes, 20)
  return width > 0 && height > 0 ? { width, height } : null
}

function parseJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1
    }
    if (offset >= bytes.length) break

    const marker = bytes[offset]
    offset += 1

    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue

    if (offset + 2 > bytes.length) break
    const segmentLength = readUint16BE(bytes, offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)

    if (isSof && offset + 7 <= bytes.length) {
      const height = readUint16BE(bytes, offset + 3)
      const width = readUint16BE(bytes, offset + 5)
      if (width > 0 && height > 0) {
        return { width, height }
      }
      return null
    }

    offset += segmentLength
  }

  return null
}

function parseBmpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null
  const width = Math.abs(readUint32LE(bytes, 18) | 0)
  const height = Math.abs(readUint32LE(bytes, 22) | 0)
  return width > 0 && height > 0 ? { width, height } : null
}

function parseWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null
  const riff =
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  const webp =
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  if (!riff || !webp) return null

  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = readUint32LE(bytes, 21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8X' && bytes.length >= 30) {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    return width > 0 && height > 0 ? { width, height } : null
  }
  return null
}

/**
 * Reads image width and height directly from binary headers without decoding pixels.
 */
export function parseImageDimensionsFromBytes(
  bytes: Uint8Array,
): ImageDimensions | null {
  return (
    parsePngDimensions(bytes) ??
    parseJpegDimensions(bytes) ??
    parseWebpDimensions(bytes) ??
    parseBmpDimensions(bytes)
  )
}

async function decodeImageDimensionsInBrowser(
  bytes: Uint8Array,
  ext: string,
): Promise<ImageDimensions | null> {
  const fromHeader = parseImageDimensionsFromBytes(bytes)
  if (fromHeader) return fromHeader

  if (typeof createImageBitmap !== 'function') return null
  const blob = new Blob([bytes.slice()], { type: getMimeTypeForImageExt(ext) })
  const bitmap = await createImageBitmap(blob)
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

export async function inspectFramesDimensions(
  frames: FrameItem[],
): Promise<InspectedZipFramesSummary> {
  const formatsSet = new Set<string>()
  const framesWithDimensions: FrameItem[] = []

  let firstWidth = 0
  let firstHeight = 0
  let hasMixedSizes = false
  let hasOddDimensions = false

  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]
    const ext = getFileExtension(frame.name)
    formatsSet.add(ext === 'jpeg' ? 'JPG' : ext.toUpperCase())

    const dims =
      frame.width && frame.height
        ? { width: frame.width, height: frame.height }
        : await decodeImageDimensionsInBrowser(frame.data, ext)

    if (dims) {
      if (firstWidth === 0) {
        firstWidth = dims.width
        firstHeight = dims.height
      } else if (dims.width !== firstWidth || dims.height !== firstHeight) {
        hasMixedSizes = true
      }

      if (dims.width % 2 !== 0 || dims.height % 2 !== 0) {
        hasOddDimensions = true
      }
    }

    framesWithDimensions.push({
      ...frame,
      width: dims?.width,
      height: dims?.height,
    })
  }

  return {
    width: firstWidth,
    height: firstHeight,
    hasMixedSizes,
    hasOddDimensions,
    formatsFound: Array.from(formatsSet),
    framesWithDimensions,
  }
}

async function renderFrameToNormalizedPng(
  bytes: Uint8Array,
  ext: string,
  targetWidth: number,
  targetHeight: number,
): Promise<Uint8Array> {
  const blob = new Blob([bytes.slice()], { type: getMimeTypeForImageExt(ext) })
  const bitmap = await createImageBitmap(blob)

  try {
    const scale = Math.min(
      targetWidth / bitmap.width,
      targetHeight / bitmap.height,
    )
    const drawWidth = Math.round(bitmap.width * scale)
    const drawHeight = Math.round(bitmap.height * scale)
    const offsetX = Math.floor((targetWidth - drawWidth) / 2)
    const offsetY = Math.floor((targetHeight - drawHeight) / 2)

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(targetWidth, targetHeight)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Could not acquire 2D canvas context.')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, targetWidth, targetHeight)
      ctx.drawImage(bitmap, offsetX, offsetY, drawWidth, drawHeight)
      const outBlob = await canvas.convertToBlob({ type: 'image/png' })
      return new Uint8Array(await outBlob.arrayBuffer())
    }

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not acquire 2D canvas context.')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, targetWidth, targetHeight)
    ctx.drawImage(bitmap, offsetX, offsetY, drawWidth, drawHeight)

    const outBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result)
        else reject(new Error('Failed to encode normalized PNG frame.'))
      }, 'image/png')
    })
    return new Uint8Array(await outBlob.arrayBuffer())
  } finally {
    bitmap.close()
  }
}

function canonicalImage2Ext(ext: string): 'png' | 'jpg' | null {
  const lower = ext.toLowerCase()
  if (lower === 'png') return 'png'
  if (lower === 'jpg' || lower === 'jpeg') return 'jpg'
  return null
}

/**
 * Uses zero-copy frames when all images share the same PNG/JPG format and identical
 * even dimensions; otherwise normalizes frames onto an even-dimension PNG canvas.
 */
export async function prepareFramesForFFmpeg(
  frames: FrameItem[],
  targetResolution: ResolutionPreset = 'original',
  onProgress?: (completed: number, total: number) => void,
): Promise<PreparedFFmpegFrames> {
  if (frames.length === 0) {
    throw new Error('No frames provided.')
  }

  const summary = await inspectFramesDimensions(frames)
  const canonicalExts = new Set(
    summary.framesWithDimensions.map((f) =>
      canonicalImage2Ext(getFileExtension(f.name)),
    ),
  )

  const singleExt =
    canonicalExts.size === 1 ? Array.from(canonicalExts)[0] : null

  const allHaveKnownSizes = summary.framesWithDimensions.every(
    (f) => typeof f.width === 'number' && typeof f.height === 'number',
  )

  const targetDims = computeScaledDimensions(
    summary.width,
    summary.height,
    targetResolution,
  )

  if (
    singleExt !== null &&
    allHaveKnownSizes &&
    !summary.hasMixedSizes &&
    !summary.hasOddDimensions &&
    summary.width > 0 &&
    summary.height > 0
  ) {
    return {
      ext: singleExt,
      buffers: summary.framesWithDimensions.map((f) => f.data),
      width: targetDims.width,
      height: targetDims.height,
      normalized: false,
    }
  }

  const buffers: Uint8Array[] = []

  for (let i = 0; i < summary.framesWithDimensions.length; i += 1) {
    const frame = summary.framesWithDimensions[i]
    const ext = getFileExtension(frame.name)
    const pngBytes = await renderFrameToNormalizedPng(
      frame.data,
      ext,
      targetDims.width,
      targetDims.height,
    )
    buffers.push(pngBytes)
    onProgress?.(i + 1, summary.framesWithDimensions.length)
  }

  return {
    ext: 'png',
    buffers,
    width: targetDims.width,
    height: targetDims.height,
    normalized: true,
  }
}

