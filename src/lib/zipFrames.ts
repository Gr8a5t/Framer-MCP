import { unzipSync, zipSync } from 'fflate'
import type { FrameItem } from '../types/media'
import { getFileExtension, isSupportedImageFile, naturalCompare } from './format'

export interface ZipFrameInput {
  name: string
  data: Uint8Array
}

export interface UnpackedZipFrame {
  id: string
  name: string
  archivePath: string
  ext: string
  data: Uint8Array
  size: number
}

/**
 * Packages extracted frame buffers into an uncompressed (STORE) ZIP archive.
 * PNG and JPEG payloads are already compressed, so STORE avoids redundant CPU work.
 */
export async function createFramesZip(frames: ZipFrameInput[]): Promise<Uint8Array> {
  if (frames.length === 0) {
    throw new Error('No frames available to archive.')
  }

  // Yield a frame so progress UI renders before synchronous ZIP assembly.
  await new Promise((resolve) => setTimeout(resolve, 0))

  const files: Record<string, Uint8Array> = {}
  for (const frame of frames) {
    files[frame.name] = frame.data
  }

  return zipSync(files, { level: 0 })
}

/**
 * Unpacks an uploaded .zip archive, filters for supported image files,
 * ignores OS metadata entries, and returns frames in natural filename order.
 */
export async function extractFramesFromZip(
  zipBytes: Uint8Array,
): Promise<UnpackedZipFrame[]> {
  await new Promise((resolve) => setTimeout(resolve, 0))

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zipBytes)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Invalid archive'
    throw new Error(`Could not read ZIP file: ${detail}`)
  }

  const validPaths = Object.keys(entries)
    .filter((entryPath) => isSupportedImageFile(entryPath) && entries[entryPath].byteLength > 0)
    .sort(naturalCompare)

  if (validPaths.length === 0) {
    throw new Error(
      'No supported image frames (.png, .jpg, .jpeg, .webp, .bmp) were found inside this ZIP file.',
    )
  }

  const seenDisplayNames = new Map<string, number>()

  return validPaths.map((archivePath, index) => {
    const data = entries[archivePath]
    const rawName = archivePath.replace(/\\/g, '/').split('/').pop() ?? archivePath
    const count = (seenDisplayNames.get(rawName) ?? 0) + 1
    seenDisplayNames.set(rawName, count)

    const displayName =
      count === 1 ? rawName : `${archivePath.replace(/[/\\]/g, '_')}`

    return {
      id: `zip-frame-${index + 1}-${archivePath}`,
      name: displayName,
      archivePath,
      ext: getFileExtension(rawName),
      data,
      size: data.byteLength,
    }
  })
}

export function toFrameItems(unpacked: UnpackedZipFrame[]): FrameItem[] {
  return unpacked.map((entry) => ({
    id: entry.id,
    name: entry.name,
    data: entry.data,
    size: entry.size,
  }))
}

