export type WorkspaceTab =
  | 'video-to-frames'
  | 'frames-to-video'
  | 'claude-studio'

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
  hasAudio?: boolean
}

export interface EngineProgress {
  phase: 'idle' | 'loading-engine' | 'preparing' | 'processing' | 'packaging'
  ratio: number
  message: string
}

export interface MusicFlowCue {
  t: number
  strength: number
  prominence: number
  dominantBand: 'bass' | 'mid' | 'high'
  label: string
}

export interface MusicFlowSection {
  id: string
  t0: number
  t1: number
  bpm: number
  avgRmsDb: number
  bassEnergyRatio: number
  energyLevel: 'silence' | 'low' | 'medium' | 'high' | 'peak'
  motionGuidance: string
}

export interface MusicFlowEnergyPoint {
  t: number
  rmsDb: number
  bass: number
  mid: number
  high: number
  onset: number
}

export interface MusicFlowSummary {
  sourceName: string
  durationSec: number
  sampleRate: number
  channels: number
  bpm: number
  beatIntervalSec: number
  beats: number[]
  downbeats: number[]
  silences: [number, number][]
  cues: MusicFlowCue[]
  sections: MusicFlowSection[]
  energyCurve: MusicFlowEnergyPoint[]
  timelineJs: string
  flowImageUrl?: string
}

export interface AudioTrackAttachment {
  file: File
  name: string
  size: number
  flow?: MusicFlowSummary | null
}

export interface StudioProjectSummary {
  id: string
  title: string
  durationSec: number | null
  bpm: number | null
  hasVideo: boolean
  hasAudioMix: boolean
  hasScore: boolean
  hasVoiceover: boolean
  hasFramesZip: boolean
  hasSrt: boolean
  hasFlowMap: boolean
  hasContactSheet: boolean
  videoUrl: string | null
  audioMixUrl: string | null
  framesZipUrl: string | null
  srtUrl: string | null
  flowPngUrl: string | null
  contactSheetUrl: string | null
  stillUrls: string[]
  flowSummary: MusicFlowSummary | null
  voiceWords: Record<string, [string, number, number][]> | null
  treatmentExcerpt: string | null
  files: string[]
  updatedAt: string
}

export interface TunnelStatus {
  active: boolean
  publicUrl: string | null
  provider: string | null
  availableProvider: string | null
  error: string | null
}

