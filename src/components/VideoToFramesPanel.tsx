import {
  ArrowRight,
  Download,
  Film,
  Image as ImageIcon,
  Layers,
  RefreshCw,
  Send,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { triggerBytesDownload } from '../lib/download'
import {
  cancelCurrentFFmpegJob,
  extractFramesFromVideo,
  JobCancelledError,
} from '../lib/ffmpegService'
import {
  clampFps,
  computeScaledDimensions,
  formatBytes,
  formatDuration,
  formatErrorMessage,
  getFileExtension,
  sanitizeBaseName,
} from '../lib/format'
import { stageMediaToMcp } from '../lib/studioApi'
import { createFramesZip } from '../lib/zipFrames'
import type {
  EngineProgress,
  ExtractedZipBundle,
  FpsMode,
  FrameImageFormat,
  JpegQualityPreset,
  ResolutionPreset,
  VideoMetadata,
} from '../types/media'
import { Dropzone } from './Dropzone'
import { FrameGallery } from './FrameGallery'
import { ProgressBanner } from './ProgressBanner'

interface VideoToFramesPanelProps {
  isBusy: boolean
  onBusyChange: (busy: boolean) => void
  onEngineStatusChange: (ready: boolean) => void
  onSendZipToVideo: (zipFile: File) => void
}

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
  'm4v',
  'ogv',
  '3gp',
  'mpeg',
  'mpg',
])

const FPS_PRESETS = [1, 5, 12, 24, 30, 60] as const

const RESOLUTION_OPTIONS: ReadonlyArray<{
  id: ResolutionPreset
  label: string
}> = [
  { id: 'original', label: 'Original' },
  { id: '480p', label: '480p' },
  { id: '720p', label: '720p HD' },
  { id: '1080p', label: '1080p' },
]

const IDLE_PROGRESS: EngineProgress = {
  phase: 'idle',
  ratio: 0,
  message: '',
}

export function VideoToFramesPanel({
  isBusy,
  onBusyChange,
  onEngineStatusChange,
  onSendZipToVideo,
}: VideoToFramesPanelProps) {
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoMeta, setVideoMeta] = useState<VideoMetadata | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)

  const [fpsMode, setFpsMode] = useState<FpsMode>('original')
  const [customFpsInput, setCustomFpsInput] = useState('24')
  const [frameFormat, setFrameFormat] = useState<FrameImageFormat>('png')
  const [jpegQuality, setJpegQuality] = useState<JpegQualityPreset>('high')
  const [resolution, setResolution] = useState<ResolutionPreset>('original')

  const [progress, setProgress] = useState<EngineProgress>(IDLE_PROGRESS)
  const [result, setResult] = useState<ExtractedZipBundle | null>(null)
  const [isStagingMcp, setIsStagingMcp] = useState(false)
  const [mcpStageMessage, setMcpStageMessage] = useState<string | null>(null)
  const [mcpStageError, setMcpStageError] = useState<string | null>(null)

  const videoUrl = useMemo(
    () => (videoFile ? URL.createObjectURL(videoFile) : null),
    [videoFile],
  )

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl)
      }
    }
  }, [videoUrl])

  const parsedCustomFps = clampFps(Number.parseFloat(customFpsInput), 24)
  const estimatedFrames =
    fpsMode === 'custom' && videoMeta && videoMeta.durationSec > 0
      ? Math.max(1, Math.round(videoMeta.durationSec * parsedCustomFps))
      : null
  const targetDimensions =
    videoMeta && videoMeta.width > 0 && videoMeta.height > 0
      ? computeScaledDimensions(videoMeta.width, videoMeta.height, resolution)
      : null

  const handleVideoSelected = (file: File) => {
    const ext = getFileExtension(file.name)
    const isVideo =
      file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)

    if (!isVideo) {
      setUploadError(
        'Please select a video file (.mp4, .mov, .webm, .mkv, .avi, .m4v).',
      )
      return
    }

    setUploadError(null)
    setJobError(null)
    setPreviewFailed(false)
    setResult(null)
    setMcpStageMessage(null)
    setMcpStageError(null)
    setVideoFile(file)
    setVideoMeta({
      name: file.name,
      size: file.size,
      durationSec: 0,
      width: 0,
      height: 0,
      type: file.type || ext.toUpperCase(),
    })
  }

  const handleResetVideo = () => {
    if (isBusy) return
    setVideoFile(null)
    setVideoMeta(null)
    setPreviewFailed(false)
    setUploadError(null)
    setJobError(null)
    setResult(null)
  }

  const handleExtract = async () => {
    if (!videoFile || isBusy) return

    setJobError(null)
    setResult(null)
    onBusyChange(true)

    try {
      const output = await extractFramesFromVideo({
        file: videoFile,
        fpsMode,
        customFps: parsedCustomFps,
        format: frameFormat,
        jpegQuality,
        resolution,
        fallbackWidth: videoMeta?.width,
        fallbackHeight: videoMeta?.height,
        onProgress: setProgress,
        onEngineStatusChange,
      })

      setProgress({
        phase: 'packaging',
        ratio: 0.98,
        message: `Packaging ${output.frames.length} frames into .zip archive…`,
      })

      const zipData = await createFramesZip(
        output.frames.map((frame) => ({
          name: frame.name,
          data: frame.data,
        })),
      )

      const base = sanitizeBaseName(videoFile.name)
      const fpsLabel = output.effectiveFps
        ? `_${String(output.effectiveFps).replace(/\.0+$/, '')}fps`
        : ''
      const zipFileName = `${base}_frames${fpsLabel}.zip`

      setResult({
        zipFileName,
        zipData,
        zipSize: zipData.byteLength,
        frames: output.frames,
        fpsUsed: output.effectiveFps,
        detectedSourceFps: output.detectedSourceFps,
        frameFormat,
        width: output.width,
        height: output.height,
      })
    } catch (error) {
      if (!(error instanceof JobCancelledError)) {
        setJobError(
          formatErrorMessage(
            error,
            'Could not extract frames from this video.',
          ),
        )
      }
    } finally {
      setProgress(IDLE_PROGRESS)
      onBusyChange(false)
    }
  }

  const handleCancel = () => {
    cancelCurrentFFmpegJob(onEngineStatusChange)
    setProgress(IDLE_PROGRESS)
    onBusyChange(false)
  }

  const handleDownloadZip = () => {
    if (!result) return
    triggerBytesDownload(result.zipData, result.zipFileName, 'application/zip')
  }

  const handleSendToConverter = () => {
    if (!result) return
    const zipFile = new File([result.zipData.slice()], result.zipFileName, {
      type: 'application/zip',
    })
    onSendZipToVideo(zipFile)
  }

  const handleSendToClaudeMcp = async () => {
    if (!result || isStagingMcp) return
    setIsStagingMcp(true)
    setMcpStageError(null)
    setMcpStageMessage(null)
    try {
      const staged = await stageMediaToMcp({
        sourceName: videoFile?.name ?? result.zipFileName,
        fps: result.fpsUsed,
        width: result.width,
        height: result.height,
        frames: result.frames,
        videoFile,
      })
      const flowNote = staged.flowSummary
        ? ` + music flow (${staged.flowSummary.bpm} BPM, ${staged.flowSummary.sections.length} sections)`
        : ''
      setMcpStageMessage(
        `Staged ${staged.frameCount} sample frames${flowNote} to Claude MCP! Ask Claude Web to call framer_get_staged_media.`,
      )
    } catch (error) {
      setMcpStageError(
        formatErrorMessage(error, 'Could not stage frames to Claude MCP.'),
      )
    } finally {
      setIsStagingMcp(false)
    }
  }

  return (
    <div className="panel-stack">
      <div className="panel-grid">
        <section className="studio-card">
          <div className="card-header">
            <div className="card-heading-group">
              <span className="step-badge">1</span>
              <div>
                <h2 className="card-title">Source Video</h2>
                <p className="card-subtitle">
                  Drop any video to split it into frame images.
                </p>
              </div>
            </div>
            {videoFile ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleResetVideo}
                disabled={isBusy}
              >
                <RefreshCw size={14} />
                Change video
              </button>
            ) : null}
          </div>

          {!videoFile ? (
            <Dropzone
              accept="video/*,.mp4,.mov,.webm,.mkv,.avi,.m4v"
              title="Drop a video file here"
              subtitle="or click to browse from your device"
              hint="Supports MP4, MOV, WebM, MKV, AVI — processed 100% locally"
              disabled={isBusy}
              error={uploadError}
              onFileSelected={handleVideoSelected}
            />
          ) : (
            <div className="media-preview-stack">
              <div className="video-stage">
                {videoUrl && !previewFailed ? (
                  <video
                    src={videoUrl}
                    controls
                    playsInline
                    className="video-player"
                    onLoadedMetadata={(event) => {
                      const el = event.currentTarget
                      setVideoMeta((prev) =>
                        prev
                          ? {
                              ...prev,
                              width: el.videoWidth || prev.width,
                              height: el.videoHeight || prev.height,
                              durationSec: Number.isFinite(el.duration)
                                ? el.duration
                                : prev.durationSec,
                            }
                          : prev,
                      )
                    }}
                    onError={() => setPreviewFailed(true)}
                  />
                ) : (
                  <div className="video-fallback-preview">
                    <Film size={28} />
                    <p>
                      Browser video playback isn’t available for this container,
                      but FFmpeg can still extract its frames.
                    </p>
                  </div>
                )}
              </div>

              <div className="meta-bar">
                <span className="meta-filename" title={videoFile.name}>
                  {videoFile.name}
                </span>
                <div className="spec-row">
                  <span className="spec-chip">
                    {formatBytes(videoFile.size)}
                  </span>
                  {videoMeta && videoMeta.width > 0 && videoMeta.height > 0 ? (
                    <span className="spec-chip">
                      {videoMeta.width} × {videoMeta.height}
                    </span>
                  ) : null}
                  {videoMeta && videoMeta.durationSec > 0 ? (
                    <span className="spec-chip">
                      {formatDuration(videoMeta.durationSec)}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="studio-card">
          <div className="card-header">
            <div className="card-heading-group">
              <span className="step-badge">2</span>
              <div>
                <h2 className="card-title">Extraction Settings</h2>
                <p className="card-subtitle">
                  Choose frame rate and image format for the ZIP export.
                </p>
              </div>
            </div>
          </div>

          <div className="controls-stack">
            <div className="control-group">
              <label className="control-label">Frame Rate (FPS)</label>
              <div className="segmented-control">
                <button
                  type="button"
                  className={`segment-btn ${fpsMode === 'original' ? 'is-active' : ''}`}
                  onClick={() => setFpsMode('original')}
                  disabled={isBusy}
                >
                  Original FPS
                </button>
                <button
                  type="button"
                  className={`segment-btn ${fpsMode === 'custom' ? 'is-active' : ''}`}
                  onClick={() => setFpsMode('custom')}
                  disabled={isBusy}
                >
                  Custom FPS
                </button>
              </div>

              {fpsMode === 'original' ? (
                <p className="control-hint">
                  Extracts every native frame directly from the source video.
                </p>
              ) : (
                <div className="custom-fps-panel">
                  <div className="preset-row">
                    {FPS_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={`preset-pill ${Number(customFpsInput) === preset ? 'is-active' : ''}`}
                        onClick={() => setCustomFpsInput(String(preset))}
                        disabled={isBusy}
                      >
                        {preset} fps
                      </button>
                    ))}
                  </div>

                  <div className="inline-input-row">
                    <label htmlFor="extract-fps-input" className="inline-label">
                      Target FPS
                    </label>
                    <input
                      id="extract-fps-input"
                      type="number"
                      min="0.5"
                      max="120"
                      step="0.5"
                      value={customFpsInput}
                      disabled={isBusy}
                      onChange={(event) => setCustomFpsInput(event.target.value)}
                      onBlur={() => setCustomFpsInput(String(parsedCustomFps))}
                      className="number-input"
                    />
                    {estimatedFrames !== null ? (
                      <span className="mono-pill">
                        ~{estimatedFrames} frames
                      </span>
                    ) : null}
                  </div>
                </div>
              )}

              {estimatedFrames !== null && estimatedFrames > 1500 ? (
                <div className="alert-banner is-warning">
                  Large estimate ({estimatedFrames} frames). Extraction and ZIP
                  packaging run in browser memory and may take a bit longer.
                </div>
              ) : null}
            </div>

            <div className="control-group">
              <div className="control-label-row">
                <label className="control-label">Frame Resolution</label>
                {targetDimensions ? (
                  <span className="mono-pill">
                    {targetDimensions.width} × {targetDimensions.height}
                  </span>
                ) : null}
              </div>
              <div className="segmented-control is-four-up">
                {RESOLUTION_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`segment-btn ${resolution === opt.id ? 'is-active' : ''}`}
                    onClick={() => setResolution(opt.id)}
                    disabled={isBusy}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="control-group">
              <label className="control-label">Image Format</label>
              <div className="segmented-control">
                <button
                  type="button"
                  className={`segment-btn ${frameFormat === 'png' ? 'is-active' : ''}`}
                  onClick={() => setFrameFormat('png')}
                  disabled={isBusy}
                >
                  <ImageIcon size={15} />
                  PNG (Lossless)
                </button>
                <button
                  type="button"
                  className={`segment-btn ${frameFormat === 'jpg' ? 'is-active' : ''}`}
                  onClick={() => setFrameFormat('jpg')}
                  disabled={isBusy}
                >
                  <Layers size={15} />
                  JPEG (Smaller ZIP)
                </button>
              </div>

              {frameFormat === 'jpg' ? (
                <div className="quality-row">
                  <span className="inline-label">JPEG Quality</span>
                  <div className="preset-row">
                    {(
                      [
                        { id: 'high', label: 'High (95%)' },
                        { id: 'balanced', label: 'Balanced (85%)' },
                        { id: 'compact', label: 'Compact (70%)' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`preset-pill ${jpegQuality === opt.id ? 'is-active' : ''}`}
                        onClick={() => setJpegQuality(opt.id)}
                        disabled={isBusy}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="action-footer">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={handleExtract}
                disabled={!videoFile || isBusy}
              >
                <Layers size={18} />
                Extract Frames to ZIP
              </button>
            </div>
          </div>
        </section>
      </div>

      <ProgressBanner progress={progress} onCancel={handleCancel} />

      {jobError ? (
        <div className="alert-banner is-error" role="alert">
          {jobError}
        </div>
      ) : null}

      {result ? (
        <section className="studio-card result-card">
          <div className="result-header">
            <div className="result-summary">
              <span className="status-dot is-success" />
              <div>
                <h3 className="result-title">
                  Extracted {result.frames.length} frames
                </h3>
                <div className="spec-row">
                  <span className="spec-chip">
                    {result.frameFormat.toUpperCase()}
                  </span>
                  {result.width > 0 && result.height > 0 ? (
                    <span className="spec-chip">
                      {result.width} × {result.height}
                    </span>
                  ) : null}
                  {result.fpsUsed ? (
                    <span className="spec-chip">{result.fpsUsed} fps</span>
                  ) : null}
                  <span className="spec-chip">
                    ZIP: {formatBytes(result.zipSize)}
                  </span>
                </div>
              </div>
            </div>

            <div className="result-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleSendToClaudeMcp()}
                disabled={isBusy || isStagingMcp}
              >
                <Send size={16} />
                {isStagingMcp
                  ? 'Sending to MCP…'
                  : 'Send to Claude MCP'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleSendToConverter}
                disabled={isBusy}
              >
                Use in Frames → Video
                <ArrowRight size={16} />
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleDownloadZip}
              >
                <Download size={16} />
                Download ZIP ({formatBytes(result.zipSize)})
              </button>
            </div>
          </div>

          {mcpStageMessage ? (
            <div className="alert-banner is-info">{mcpStageMessage}</div>
          ) : null}
          {mcpStageError ? (
            <div className="alert-banner is-error">{mcpStageError}</div>
          ) : null}

          <FrameGallery
            key={result.frames[0]?.id ?? result.zipFileName}
            frames={result.frames}
            title="Extracted Frame Strip"
          />
        </section>
      ) : null}
    </div>
  )
}

