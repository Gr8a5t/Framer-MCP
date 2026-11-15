export type WorkspaceTab = 'video-to-frames' | 'frames-to-video'

export type FpsMode = 'original' | 'custom'
export type FrameImageFormat = 'png' | 'jpg'
export type JpegQualityPreset = 'high' | 'balanced' | 'compact'
export type ResolutionPreset = 'original' | '480p' | '720p' | '1080p'

export type OutputVideoFormat = 'mp4' | 'webm'
export type VideoQualityPreset = 'high' | 'balanced' | 'compact'

export interface FrameItem {
  id: string
  name: string
  data: Uint8Array
  size: number
  width?: number
  height?: number
  timestampSec?: number
}

export interface VideoMetadata {
  name: string
  size: number
  durationSec: number
  width: number
  height: number
  type: string
}

export interface ExtractedZipBundle {
  zipFileName: string
  zipData: Uint8Array
  zipSize: number
  frames: FrameItem[]
  fpsUsed: number | null
  detectedSourceFps: number | null
  frameFormat: FrameImageFormat
  width: number
  height: number
}

export interface LoadedZipFrames {
  id: string
  zipName: string
  zipSize: number
  frames: FrameItem[]
  width: number
  height: number
  hasMixedSizes: boolean
  hasOddDimensions: boolean
  formatsFound: string[]
  suggestedFps: number | null
}

export interface GeneratedVideoResult {
  fileName: string
  data: Uint8Array
  size: number
  mimeType: string
  format: OutputVideoFormat
  fps: number
  frameCount: number
  durationSec: number
  width: number
  height: number
}

export interface EngineProgress {
  phase: 'idle' | 'loading-engine' | 'preparing' | 'processing' | 'packaging'
  ratio: number
  message: string
}

