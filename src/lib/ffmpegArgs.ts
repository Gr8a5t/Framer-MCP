import type {
  FpsMode,
  FrameImageFormat,
  JpegQualityPreset,
  OutputVideoFormat,
  ResolutionPreset,
  VideoQualityPreset,
} from '../types/media'
import { clampFps, getShortEdgeForPreset } from './format'

export interface ExtractFramesArgsOptions {
  inputPath: string
  outputPattern: string
  fpsMode: FpsMode
  customFps: number
  format: FrameImageFormat
  jpegQuality: JpegQualityPreset
  resolution?: ResolutionPreset
}

export interface EncodeVideoArgsOptions {
  inputPattern: string
  outputPath: string
  fps: number
  format: OutputVideoFormat
  quality: VideoQualityPreset
  resolution?: ResolutionPreset
  targetWidth?: number
  targetHeight?: number
  audioInputPath?: string
}

const JPEG_QSCALE_MAP: Record<JpegQualityPreset, number> = {
  high: 2,
  balanced: 5,
  compact: 10,
}

const MP4_CRF_MAP: Record<VideoQualityPreset, string> = {
  high: '16',
  balanced: '20',
  compact: '26',
}

const WEBM_SETTINGS_MAP: Record<
  VideoQualityPreset,
  { crf: string; bitrate: string }
> = {
  high: { crf: '6', bitrate: '8M' },
  balanced: { crf: '12', bitrate: '4M' },
  compact: { crf: '22', bitrate: '1.5M' },
}

function buildPresetScaleFilter(shortEdge: number): string {
  return `scale='if(gte(iw,ih),-2,${shortEdge})':'if(gte(iw,ih),${shortEdge},-2)':flags=lanczos`
}

export function buildExtractFramesArgs(
  options: ExtractFramesArgsOptions,
): string[] {
  const args = ['-i', options.inputPath]
  const vfParts: string[] = []

  if (options.fpsMode === 'custom') {
    vfParts.push(`fps=${clampFps(options.customFps)}`)
  } else {
    args.push('-fps_mode', 'passthrough')
  }

  const shortEdge = getShortEdgeForPreset(options.resolution ?? 'original')
  if (shortEdge !== null) {
    vfParts.push(buildPresetScaleFilter(shortEdge))
  }

  if (vfParts.length > 0) {
    args.push('-vf', vfParts.join(','))
  }

  if (options.format === 'jpg') {
    args.push(
      '-huffman',
      'default',
      '-strict',
      'unofficial',
      '-pix_fmt',
      'yuvj420p',
      '-q:v',
      String(JPEG_QSCALE_MAP[options.jpegQuality]),
    )
  }

  args.push(options.outputPattern)
  return args
}

export function buildEncodeVideoArgs(
  options: EncodeVideoArgsOptions,
): string[] {
  const fps = clampFps(options.fps)
  const resolution = options.resolution ?? 'original'
  const shortEdge = getShortEdgeForPreset(resolution)

  const vfParts: string[] = []
  if (shortEdge !== null) {
    if (
      options.targetWidth &&
      options.targetHeight &&
      options.targetWidth > 0 &&
      options.targetHeight > 0
    ) {
      vfParts.push(
        `scale=${options.targetWidth}:${options.targetHeight}:flags=lanczos`,
      )
    } else {
      vfParts.push(buildPresetScaleFilter(shortEdge))
    }
  }
  vfParts.push('pad=ceil(iw/2)*2:ceil(ih/2)*2')

  const args = [
    '-framerate',
    String(fps),
    '-start_number',
    '1',
    '-i',
    options.inputPattern,
  ]

  if (options.audioInputPath) {
    args.push('-i', options.audioInputPath)
  }

  args.push('-vf', vfParts.join(','))

  if (options.audioInputPath) {
    args.push('-map', '0:v:0', '-map', '1:a:0')
  }

  if (options.format === 'mp4') {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      MP4_CRF_MAP[options.quality],
      '-pix_fmt',
      'yuv420p',
    )
    if (options.audioInputPath) {
      args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
    }
    args.push('-movflags', '+faststart', options.outputPath)
    return args
  }

  const webm = WEBM_SETTINGS_MAP[options.quality]
  args.push(
    '-c:v',
    'libvpx',
    '-crf',
    webm.crf,
    '-b:v',
    webm.bitrate,
    '-deadline',
    'realtime',
    '-cpu-used',
    '4',
    '-pix_fmt',
    'yuv420p',
  )
  if (options.audioInputPath) {
    args.push('-c:a', 'libopus', '-b:a', '160k', '-shortest')
  }
  args.push(options.outputPath)
  return args
}
