import type { ResolutionPreset } from '../types/media'

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp'])

export function naturalCompare(a: string, b: string): number {
  return naturalCollator.compare(a, b)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** idx
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const totalMillis = Math.round(seconds * 1000)
  const mins = Math.floor(totalMillis / 60000)
  const secs = Math.floor((totalMillis % 60000) / 1000)
  const tenths = Math.floor((totalMillis % 1000) / 100)
  const mm = String(mins).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  return mins >= 1 ? `${mm}:${ss}.${tenths}` : `${mm}:${ss}.${tenths}`
}

export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.000'
  const totalMs = Math.round(seconds * 1000)
  const mins = Math.floor(totalMs / 60000)
  const secs = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

export function stripExtension(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function sanitizeBaseName(name: string): string {
  const cleaned = stripExtension(name)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'framer_output'
}

export function getFileExtension(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function isSupportedImageFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  if (!normalized || normalized.endsWith('/')) return false

  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return false

  if (parts.some((part) => part === '__MACOSX' || part.startsWith('.'))) {
    return false
  }

  const fileName = parts[parts.length - 1]
  const lower = fileName.toLowerCase()
  if (lower === 'thumbs.db' || lower === 'desktop.ini') {
    return false
  }

  const ext = getFileExtension(fileName)
  return IMAGE_EXTENSIONS.has(ext)
}

export function getMimeTypeForImageExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'png':
    default:
      return 'image/png'
  }
}

export function parseFpsFromFilename(fileName: string): number | null {
  const match = fileName.match(/(?:^|[_\-\s])(\d+(?:\.\d+)?)\s*fps(?:[_\-.\s]|$)/i)
  if (!match) return null
  const parsed = Number.parseFloat(match[1])
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 240) return null
  return parsed
}

export function parseFpsFromFfmpegLog(logText: string): number | null {
  const patterns = [
    /,\s*(\d+(?:\.\d+)?)\s+fps\b/i,
    /,\s*(\d+(?:\.\d+)?)\s+tbr\b/i,
  ]
  for (const pattern of patterns) {
    const match = logText.match(pattern)
    if (match) {
      const value = Number.parseFloat(match[1])
      if (Number.isFinite(value) && value > 0 && value <= 240) {
        return Number(value.toFixed(2))
      }
    }
  }
  return null
}

export function computeEvenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded + 1
}

export function getShortEdgeForPreset(preset: ResolutionPreset): number | null {
  switch (preset) {
    case '480p':
      return 480
    case '720p':
      return 720
    case '1080p':
      return 1080
    case 'original':
    default:
      return null
  }
}

export function computeScaledDimensions(
  width: number,
  height: number,
  preset: ResolutionPreset,
): { width: number; height: number } {
  const targetShortEdge = getShortEdgeForPreset(preset)
  if (width <= 0 || height <= 0) {
    const edge = targetShortEdge ?? 720
    return {
      width: computeEvenDimension((edge * 16) / 9),
      height: computeEvenDimension(edge),
    }
  }
  if (!targetShortEdge) {
    return {
      width: computeEvenDimension(width),
      height: computeEvenDimension(height),
    }
  }
  if (width >= height) {
    return {
      width: computeEvenDimension((width * targetShortEdge) / height),
      height: computeEvenDimension(targetShortEdge),
    }
  }
  return {
    width: computeEvenDimension(targetShortEdge),
    height: computeEvenDimension((height * targetShortEdge) / width),
  }
}

export function clampFps(value: number, fallback = 24): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(120, Math.max(0.5, Number(value.toFixed(2))))
}

export function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    const msg = (error as { message: string }).message.trim()
    if (msg) return msg
  }
  return fallback
}

