import type {
  MusicFlowSummary,
  StudioProjectSummary,
  TunnelStatus,
} from '../types/media'

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    throw new Error(text || `HTTP ${res.status}`)
  }
  if (!res.ok) {
    const errMsg =
      parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      typeof (parsed as { error: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `Request failed with status ${res.status}`
    throw new Error(errMsg)
  }
  return parsed as T
}

export async function listStudioProjects(): Promise<StudioProjectSummary[]> {
  const data = await fetchJson<{ projects: StudioProjectSummary[] }>(
    '/api/studio/projects',
  )
  return data.projects
}

export async function previewStudioProject(
  projectId: string,
): Promise<{
  project: StudioProjectSummary
  durSec: number | null
  eventsCount: number | null
  readcheckReport: string
}> {
  return fetchJson(`/api/studio/projects/${encodeURIComponent(projectId)}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 1280, height: 720 }),
  })
}

export async function renderStudioAudio(
  projectId: string,
): Promise<{
  project: StudioProjectSummary
  flowSummary: MusicFlowSummary
  logs: string
}> {
  return fetchJson(
    `/api/studio/projects/${encodeURIComponent(projectId)}/render-audio`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
}

export async function renderStudioVideo(
  projectId: string,
  options: { fps?: number; width?: number; height?: number; grain?: number } = {},
): Promise<{
  project: StudioProjectSummary
  logs: string
}> {
  return fetchJson(
    `/api/studio/projects/${encodeURIComponent(projectId)}/render-video`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    },
  )
}

export async function analyzeAudioTrack(
  file: File,
): Promise<{ summary: MusicFlowSummary; flowImageUrl: string; fileId: string }> {
  const bytes = await file.arrayBuffer()
  return fetchJson(
    `/api/studio/analyze-audio?filename=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    },
  )
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export async function stageMediaToMcp(params: {
  sourceName: string
  fps: number | null
  width: number
  height: number
  frames: Array<{ name: string; data: Uint8Array; timestampSec?: number }>
  videoFile?: File | null
}): Promise<{
  stagedAt: string
  frameCount: number
  hasAudio: boolean
  flowSummary: MusicFlowSummary | null
}> {
  // Sample up to 24 evenly-spaced frames so payload stays fast for remote MCP inspection
  const maxStageFrames = 24
  const selected =
    params.frames.length <= maxStageFrames
      ? params.frames
      : Array.from({ length: maxStageFrames }, (_, i) => {
          const idx = Math.round(
            (i * (params.frames.length - 1)) / (maxStageFrames - 1),
          )
          return params.frames[idx]
        })

  const frames = selected.map((frame) => ({
    name: frame.name,
    base64: uint8ToBase64(frame.data),
    timestampSec: frame.timestampSec,
  }))

  let audioBase64: string | undefined
  let audioFileName: string | undefined
  if (params.videoFile && params.videoFile.size <= 90 * 1024 * 1024) {
    const ab = await params.videoFile.arrayBuffer()
    audioBase64 = uint8ToBase64(new Uint8Array(ab))
    audioFileName = params.videoFile.name
  }

  return fetchJson('/api/studio/stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceName: params.sourceName,
      fps: params.fps,
      width: params.width,
      height: params.height,
      frames,
      audioBase64,
      audioFileName,
    }),
  })
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
  return fetchJson('/api/studio/tunnel')
}

export async function startTunnel(): Promise<TunnelStatus> {
  return fetchJson('/api/studio/tunnel/start', { method: 'POST' })
}

export async function stopTunnel(): Promise<TunnelStatus> {
  return fetchJson('/api/studio/tunnel/stop', { method: 'POST' })
}

export async function fetchFileFromUrl(url: string, fileName: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Could not fetch ${fileName} (HTTP ${res.status})`)
  }
  const blob = await res.blob()
  return new File([blob], fileName, { type: blob.type || 'application/octet-stream' })
}

