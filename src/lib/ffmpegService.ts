import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import type {
  EngineProgress,
  FpsMode,
  FrameImageFormat,
  FrameItem,
  JpegQualityPreset,
  OutputVideoFormat,
  ResolutionPreset,
  VideoQualityPreset,
} from '../types/media'
import { buildEncodeVideoArgs, buildExtractFramesArgs } from './ffmpegArgs'
import {
  formatErrorMessage,
  getFileExtension,
  naturalCompare,
  parseFpsFromFfmpegLog,
} from './format'
import {
  parseImageDimensionsFromBytes,
  prepareFramesForFFmpeg,
} from './imageNormalize'

export class JobCancelledError extends Error {
  constructor() {
    super('Operation cancelled.')
    this.name = 'JobCancelledError'
  }
}

export interface ExtractFramesJobInput {
  file: File
  fpsMode: FpsMode
  customFps: number
  format: FrameImageFormat
  jpegQuality: JpegQualityPreset
  resolution?: ResolutionPreset
  fallbackWidth?: number
  fallbackHeight?: number
  onProgress?: (progress: EngineProgress) => void
  onEngineStatusChange?: (ready: boolean) => void
}

export interface ExtractFramesJobOutput {
  frames: FrameItem[]
  detectedSourceFps: number | null
  effectiveFps: number | null
  width: number
  height: number
}

export interface EncodeVideoJobInput {
  frames: FrameItem[]
  fps: number
  format: OutputVideoFormat
  quality: VideoQualityPreset
  resolution?: ResolutionPreset
  onProgress?: (progress: EngineProgress) => void
  onEngineStatusChange?: (ready: boolean) => void
}

export interface EncodeVideoJobOutput {
  data: Uint8Array
  mimeType: string
  extension: OutputVideoFormat
  width: number
  height: number
  durationSec: number
}

let ffmpegInstance: FFmpeg | null = null
let loadPromise: Promise<FFmpeg> | null = null
let coreAssetUrls: { coreURL: string; wasmURL: string } | null = null
let activeJobId = 0
let cancelledJobId = 0
let jobCounter = 0

function assertNotCancelled(jobId: number) {
  if (cancelledJobId >= jobId) {
    throw new JobCancelledError()
  }
}

async function getCoreAssetUrls(): Promise<{ coreURL: string; wasmURL: string }> {
  if (coreAssetUrls) return coreAssetUrls

  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`

  const [coreURL, wasmURL] = await Promise.all([
    toBlobURL(`${base}ffmpeg/ffmpeg-core.js`, 'text/javascript'),
    toBlobURL(`${base}ffmpeg/ffmpeg-core.wasm`, 'application/wasm'),
  ])

  coreAssetUrls = { coreURL, wasmURL }
  return coreAssetUrls
}

export async function ensureFFmpegLoaded(
  onProgress?: (progress: EngineProgress) => void,
  onEngineStatusChange?: (ready: boolean) => void,
  jobId?: number,
): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    onEngineStatusChange?.(true)
    return ffmpegInstance
  }

  if (!loadPromise) {
    loadPromise = (async () => {
      onProgress?.({
        phase: 'loading-engine',
        ratio: 0.1,
        message: 'Loading local FFmpeg WebAssembly engine…',
      })

      const instance = new FFmpeg()
      const { coreURL, wasmURL } = await getCoreAssetUrls()

      if (jobId !== undefined) {
        assertNotCancelled(jobId)
      }

      onProgress?.({
        phase: 'loading-engine',
        ratio: 0.5,
        message: 'Initializing FFmpeg worker…',
      })

      await instance.load({ coreURL, wasmURL })
      ffmpegInstance = instance
      onEngineStatusChange?.(true)
      return instance
    })().catch((error) => {
      loadPromise = null
      ffmpegInstance = null
      onEngineStatusChange?.(false)
      throw error
    })
  }

  return loadPromise
}

function resetFFmpegWorker(
  onEngineStatusChange?: (ready: boolean) => void,
): void {
  if (ffmpegInstance) {
    ffmpegInstance.terminate()
    ffmpegInstance = null
  }
  loadPromise = null
  onEngineStatusChange?.(false)
}

export function cancelCurrentFFmpegJob(
  onEngineStatusChange?: (ready: boolean) => void,
): void {
  if (activeJobId > 0) {
    cancelledJobId = activeJobId
  }

  resetFFmpegWorker(onEngineStatusChange)
}

class FFmpegExecExitError extends Error {}

function wrapUnexpectedFFmpegError(
  error: unknown,
  fallback: string,
  logMessages: string[],
  onEngineStatusChange?: (ready: boolean) => void,
): Error {
  if (error instanceof FFmpegExecExitError) {
    return error
  }
  // A thrown worker/WASM error can leave the Emscripten heap corrupted; terminate
  // the worker so the next conversion gets a fresh FFmpeg instance.
  resetFFmpegWorker(onEngineStatusChange)
  const baseMessage = formatErrorMessage(error, fallback)
  const tailLog = logMessages.filter(Boolean).slice(-8).join(' | ')
  return new Error(tailLog ? `${baseMessage} (${tailLog})` : baseMessage)
}

async function safeCleanupPaths(ffmpeg: FFmpeg, files: string[], dirs: string[]) {
  for (const filePath of files) {
    try {
      await ffmpeg.deleteFile(filePath)
    } catch {
      // Best-effort cleanup in MEMFS
    }
  }
  for (const dirPath of dirs) {
    try {
      const entries = await ffmpeg.listDir(dirPath)
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue
        const full = `${dirPath}/${entry.name}`
        if (entry.isDir) {
          await safeCleanupPaths(ffmpeg, [], [full])
        } else {
          await ffmpeg.deleteFile(full)
        }
      }
      await ffmpeg.deleteDir(dirPath)
    } catch {
      // Best-effort cleanup in MEMFS
    }
  }
}

export async function extractFramesFromVideo(
  input: ExtractFramesJobInput,
): Promise<ExtractFramesJobOutput> {
  const jobId = ++jobCounter
  activeJobId = jobId

  const ffmpeg = await ensureFFmpegLoaded(
    input.onProgress,
    input.onEngineStatusChange,
    jobId,
  )
  assertNotCancelled(jobId)

  const jobDir = `/job_extract_${jobId}`
  const outDir = `${jobDir}/out`
  const inputExt = getFileExtension(input.file.name) || 'mp4'
  const inputPath = `${jobDir}/input.${inputExt}`
  const outputPattern = `${outDir}/frame_%05d.${input.format}`

  const logMessages: string[] = []
  const onLog = ({ message }: { message: string }) => {
    logMessages.push(message)
  }
  const onExecProgress = ({ progress }: { progress: number }) => {
    const ratio = Number.isFinite(progress)
      ? Math.min(0.88, Math.max(0.08, progress * 0.85))
      : 0.25
    input.onProgress?.({
      phase: 'processing',
      ratio,
      message: 'Decoding video into frame images…',
    })
  }

  ffmpeg.on('log', onLog)
  ffmpeg.on('progress', onExecProgress)

  try {
    input.onProgress?.({
      phase: 'preparing',
      ratio: 0.05,
      message: 'Reading video into workspace memory…',
    })

    await ffmpeg.createDir(jobDir)
    await ffmpeg.createDir(outDir)

    const rawBytes = new Uint8Array(await input.file.arrayBuffer())
    assertNotCancelled(jobId)
    await ffmpeg.writeFile(inputPath, rawBytes)

    const args = buildExtractFramesArgs({
      inputPath,
      outputPattern,
      fpsMode: input.fpsMode,
      customFps: input.customFps,
      format: input.format,
      jpegQuality: input.jpegQuality,
      resolution: input.resolution ?? 'original',
    })

    input.onProgress?.({
      phase: 'processing',
      ratio: 0.1,
      message: 'Extracting frames with FFmpeg…',
    })

    const exitCode = await ffmpeg.exec(args)
    assertNotCancelled(jobId)

    if (exitCode !== 0) {
      const tailLog = logMessages.filter(Boolean).slice(-12).join(' | ')
      throw new FFmpegExecExitError(
        `FFmpeg failed to extract frames (exit code ${exitCode}). ${tailLog}`,
      )
    }

    const dirEntries = await ffmpeg.listDir(outDir)
    const frameFileNames = dirEntries
      .filter((entry) => !entry.isDir && entry.name.startsWith('frame_'))
      .map((entry) => entry.name)
      .sort(naturalCompare)

    if (frameFileNames.length === 0) {
      throw new FFmpegExecExitError(
        'FFmpeg produced 0 frames for this video. Try a different FPS or video file.',
      )
    }

    const detectedSourceFps = parseFpsFromFfmpegLog(logMessages.join('\n'))
    const effectiveFps =
      input.fpsMode === 'custom' ? input.customFps : detectedSourceFps

    const frames: FrameItem[] = []
    let width = 0
    let height = 0

    for (let i = 0; i < frameFileNames.length; i += 1) {
      assertNotCancelled(jobId)
      const fileName = frameFileNames[i]
      const data = await ffmpeg.readFile(`${outDir}/${fileName}`)
      if (!(data instanceof Uint8Array)) {
        throw new Error(`Unexpected text output reading ${fileName}.`)
      }

      if (i === 0) {
        const dims = parseImageDimensionsFromBytes(data)
        if (dims) {
          width = dims.width
          height = dims.height
        } else {
          width = input.fallbackWidth ?? 0
          height = input.fallbackHeight ?? 0
        }
      }

      frames.push({
        id: `extracted-${jobId}-${i + 1}`,
        name: fileName,
        data,
        size: data.byteLength,
        width: width || undefined,
        height: height || undefined,
        timestampSec: effectiveFps ? i / effectiveFps : undefined,
      })

      if (i % 20 === 0 || i === frameFileNames.length - 1) {
        input.onProgress?.({
          phase: 'packaging',
          ratio: 0.88 + ((i + 1) / frameFileNames.length) * 0.1,
          message: `Reading extracted frame ${i + 1} of ${frameFileNames.length}…`,
        })
      }
    }

    return {
      frames,
      detectedSourceFps,
      effectiveFps,
      width,
      height,
    }
  } catch (error) {
    if (cancelledJobId >= jobId) {
      throw new JobCancelledError()
    }
    throw wrapUnexpectedFFmpegError(
      error,
      'FFmpeg failed while extracting frames.',
      logMessages,
      input.onEngineStatusChange,
    )
  } finally {
    ffmpeg.off('log', onLog)
    ffmpeg.off('progress', onExecProgress)
    if (ffmpegInstance === ffmpeg && ffmpeg.loaded) {
      await safeCleanupPaths(ffmpeg, [], [jobDir])
    }
    if (activeJobId === jobId) {
      activeJobId = 0
    }
  }
}

export async function encodeFramesToVideo(
  input: EncodeVideoJobInput,
): Promise<EncodeVideoJobOutput> {
  const jobId = ++jobCounter
  activeJobId = jobId

  input.onProgress?.({
    phase: 'preparing',
    ratio: 0.04,
    message: 'Inspecting frame dimensions and formats…',
  })

  const resolution = input.resolution ?? 'original'

  const prepared = await prepareFramesForFFmpeg(
    input.frames,
    resolution,
    (done, total) => {
      input.onProgress?.({
        phase: 'preparing',
        ratio: 0.04 + (done / total) * 0.18,
        message: `Normalizing frame ${done} of ${total} for encoding…`,
      })
    },
  )
  assertNotCancelled(jobId)

  const ffmpeg = await ensureFFmpegLoaded(
    input.onProgress,
    input.onEngineStatusChange,
    jobId,
  )
  assertNotCancelled(jobId)

  const jobDir = `/job_encode_${jobId}`
  const inDir = `${jobDir}/in`
  const outputPath = `${jobDir}/output.${input.format}`
  const inputPattern = `${inDir}/frame_%05d.${prepared.ext}`

  const logMessages: string[] = []
  const onLog = ({ message }: { message: string }) => {
    logMessages.push(message)
  }
  const onExecProgress = ({ progress }: { progress: number }) => {
    const ratio = Number.isFinite(progress)
      ? Math.min(0.95, Math.max(0.32, 0.32 + progress * 0.63))
      : 0.5
    input.onProgress?.({
      phase: 'processing',
      ratio,
      message: `Encoding ${input.format.toUpperCase()} video…`,
    })
  }

  ffmpeg.on('log', onLog)
  ffmpeg.on('progress', onExecProgress)

  try {
    await ffmpeg.createDir(jobDir)
    await ffmpeg.createDir(inDir)

    for (let i = 0; i < prepared.buffers.length; i += 1) {
      assertNotCancelled(jobId)
      const padded = String(i + 1).padStart(5, '0')
      // Clone buffer because ffmpeg.writeFile transfers Uint8Array.buffer to the worker.
      await ffmpeg.writeFile(
        `${inDir}/frame_${padded}.${prepared.ext}`,
        prepared.buffers[i].slice(),
      )

      if (i % 25 === 0 || i === prepared.buffers.length - 1) {
        input.onProgress?.({
          phase: 'preparing',
          ratio: 0.22 + ((i + 1) / prepared.buffers.length) * 0.1,
          message: `Staging frame ${i + 1} of ${prepared.buffers.length}…`,
        })
      }
    }

    const args = buildEncodeVideoArgs({
      inputPattern,
      outputPath,
      fps: input.fps,
      format: input.format,
      quality: input.quality,
      resolution,
      targetWidth: prepared.width,
      targetHeight: prepared.height,
    })

    input.onProgress?.({
      phase: 'processing',
      ratio: 0.34,
      message: `Encoding ${prepared.buffers.length} frames at ${input.fps} fps…`,
    })

    const exitCode = await ffmpeg.exec(args)
    assertNotCancelled(jobId)

    if (exitCode !== 0) {
      const tailLog = logMessages.filter(Boolean).slice(-12).join(' | ')
      throw new FFmpegExecExitError(
        `FFmpeg failed to encode video (exit code ${exitCode}). ${tailLog}`,
      )
    }

    input.onProgress?.({
      phase: 'packaging',
      ratio: 0.96,
      message: 'Finalizing video file…',
    })

    const videoData = await ffmpeg.readFile(outputPath)
    if (!(videoData instanceof Uint8Array) || videoData.byteLength === 0) {
      throw new FFmpegExecExitError('FFmpeg produced an empty video output.')
    }

    return {
      data: videoData,
      mimeType: input.format === 'mp4' ? 'video/mp4' : 'video/webm',
      extension: input.format,
      width: prepared.width,
      height: prepared.height,
      durationSec: prepared.buffers.length / input.fps,
    }
  } catch (error) {
    if (cancelledJobId >= jobId) {
      throw new JobCancelledError()
    }
    throw wrapUnexpectedFFmpegError(
      error,
      'FFmpeg failed while encoding video.',
      logMessages,
      input.onEngineStatusChange,
    )
  } finally {
    ffmpeg.off('log', onLog)
    ffmpeg.off('progress', onExecProgress)
    if (ffmpegInstance === ffmpeg && ffmpeg.loaded) {
      await safeCleanupPaths(ffmpeg, [], [jobDir])
    }
    if (activeJobId === jobId) {
      activeJobId = 0
    }
  }
}
