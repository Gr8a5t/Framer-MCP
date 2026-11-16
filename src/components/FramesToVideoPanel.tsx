import {
  AudioLines,
  Download,
  FileArchive,
  Film,
  Music,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { triggerBytesDownload } from '../lib/download'
import {
  cancelCurrentFFmpegJob,
  encodeFramesToVideo,
  JobCancelledError,
} from '../lib/ffmpegService'
import {
  clampFps,
  computeScaledDimensions,
  formatBytes,
  formatDuration,
  formatErrorMessage,
  getFileExtension,
  parseFpsFromFilename,
  sanitizeBaseName,
} from '../lib/format'
import { inspectFramesDimensions } from '../lib/imageNormalize'
import { analyzeAudioTrack } from '../lib/studioApi'
import { extractFramesFromZip, toFrameItems } from '../lib/zipFrames'
import type {
  AudioTrackAttachment,
  EngineProgress,
  GeneratedVideoResult,
  LoadedZipFrames,
  OutputVideoFormat,
  ResolutionPreset,
  VideoQualityPreset,
} from '../types/media'
import { Dropzone } from './Dropzone'
import { FrameGallery } from './FrameGallery'
import { ProgressBanner } from './ProgressBanner'

export interface FramesToVideoHandle {
  loadZipFile: (file: File, audioFile?: File) => Promise<void>
}

interface FramesToVideoPanelProps {
  ref?: Ref<FramesToVideoHandle>
  isBusy: boolean
  onBusyChange: (busy: boolean) => void
  onEngineStatusChange: (ready: boolean) => void
}

const FPS_PRESETS = [12, 15, 24, 30, 60] as const

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

let zipLoadCounter = 0

export function FramesToVideoPanel({
  ref,
  isBusy,
  onBusyChange,
  onEngineStatusChange,
}: FramesToVideoPanelProps) {
  const [loadedZip, setLoadedZip] = useState<LoadedZipFrames | null>(null)
  const [isReadingZip, setIsReadingZip] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)

  const [fpsInput, setFpsInput] = useState('24')
  const [resolution, setResolution] = useState<ResolutionPreset>('720p')
  const [videoFormat, setVideoFormat] = useState<OutputVideoFormat>('mp4')
  const [quality, setQuality] = useState<VideoQualityPreset>('high')

  const [progress, setProgress] = useState<EngineProgress>(IDLE_PROGRESS)
  const [result, setResult] = useState<GeneratedVideoResult | null>(null)
  const [audioTrack, setAudioTrack] = useState<AudioTrackAttachment | null>(null)
  const [isAnalyzingAudio, setIsAnalyzingAudio] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)

  const resultVideoUrl = useMemo(() => {
    if (!result) return null
    const blob = new Blob([result.data.slice()], { type: result.mimeType })
    return URL.createObjectURL(blob)
  }, [result])

  useEffect(() => {
    return () => {
      if (resultVideoUrl) {
        URL.revokeObjectURL(resultVideoUrl)
      }
    }
  }, [resultVideoUrl])

  const loadZipFile = useCallback(async (file: File, attachedAudio?: File) => {
    const ext = getFileExtension(file.name)
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const hasZipSignature =
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)

    if (ext !== 'zip' && !hasZipSignature) {
      setUploadError(
        'Only .zip archives containing frame images are accepted here.',
      )
      return
    }

    setUploadError(null)
    setJobError(null)
    setAudioError(null)
    setResult(null)
    setIsReadingZip(true)
    if (attachedAudio) {
      setAudioTrack({
        file: attachedAudio,
        name: attachedAudio.name,
        size: attachedAudio.size,
        flow: null,
      })
    }

    try {
      const unpacked = await extractFramesFromZip(bytes)
      const frameItems = toFrameItems(unpacked)
      const inspected = await inspectFramesDimensions(frameItems)
      const suggestedFps = parseFpsFromFilename(file.name)
      const loadId = `zip-load-${++zipLoadCounter}`

      setLoadedZip({
        id: loadId,
        zipName: file.name,
        zipSize: file.size,
        frames: inspected.framesWithDimensions,
        width: inspected.width,
        height: inspected.height,
        hasMixedSizes: inspected.hasMixedSizes,
        hasOddDimensions: inspected.hasOddDimensions,
        formatsFound: inspected.formatsFound,
        suggestedFps,
      })

      if (suggestedFps) {
        setFpsInput(String(suggestedFps))
      }
    } catch (error) {
      setLoadedZip(null)
      setUploadError(
        formatErrorMessage(
          error,
          'Could not read frames from this ZIP archive.',
        ),
      )
    } finally {
      setIsReadingZip(false)
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      loadZipFile,
    }),
    [loadZipFile],
  )

  const parsedFps = clampFps(Number.parseFloat(fpsInput), 24)
  const estimatedDurationSec = loadedZip
    ? loadedZip.frames.length / parsedFps
    : 0
  const targetDimensions =
    loadedZip && loadedZip.width > 0 && loadedZip.height > 0
      ? computeScaledDimensions(loadedZip.width, loadedZip.height, resolution)
      : null

  const handleResetZip = () => {
    if (isBusy || isReadingZip) return
    setLoadedZip(null)
    setUploadError(null)
    setJobError(null)
    setResult(null)
  }

  const handleAudioSelected = (file: File) => {
    setAudioError(null)
    setAudioTrack({
      file,
      name: file.name,
      size: file.size,
      flow: null,
    })
  }

  const handleAnalyzeAttachedAudio = async () => {
    if (!audioTrack || isAnalyzingAudio) return
    setAudioError(null)
    setIsAnalyzingAudio(true)
    try {
      const analyzed = await analyzeAudioTrack(audioTrack.file)
      setAudioTrack((prev) =>
        prev ? { ...prev, flow: analyzed.summary } : prev,
      )
    } catch (error) {
      setAudioError(
        formatErrorMessage(error, 'Could not analyze attached audio flow.'),
      )
    } finally {
      setIsAnalyzingAudio(false)
    }
  }

  const handleBuildVideo = async () => {
    if (!loadedZip || isBusy || isReadingZip) return

    setJobError(null)
    setResult(null)
    onBusyChange(true)

    try {
      const output = await encodeFramesToVideo({
        frames: loadedZip.frames,
        fps: parsedFps,
        format: videoFormat,
        quality,
        resolution,
        audioFile: audioTrack?.file ?? null,
        onProgress: setProgress,
        onEngineStatusChange,
      })

      const base = sanitizeBaseName(loadedZip.zipName).replace(
        /_frames(?:_\d+(?:\.\d+)?fps)?$/i,
        '',
      )
      const resSuffix = resolution === 'original' ? '' : `_${resolution}`
      const fileName = `${base || 'framer_video'}_${parsedFps}fps${resSuffix}.${output.extension}`

      setResult({
        fileName,
        data: output.data,
        size: output.data.byteLength,
        mimeType: output.mimeType,
        format: output.extension,
        fps: parsedFps,
        frameCount: loadedZip.frames.length,
        durationSec: output.durationSec,
        width: output.width,
        height: output.height,
        hasAudio: Boolean(audioTrack),
      })
    } catch (error) {
      if (!(error instanceof JobCancelledError)) {
        setJobError(
          formatErrorMessage(error, 'Could not build video from these frames.'),
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

  const handleDownloadVideo = () => {
    if (!result) return
    triggerBytesDownload(result.data, result.fileName, result.mimeType)
  }

  const needsNormalizationNotice =
    loadedZip !== null &&
    (loadedZip.hasMixedSizes ||
      loadedZip.hasOddDimensions ||
      loadedZip.formatsFound.some((f) => f !== 'PNG' && f !== 'JPG'))

  return (
    <div className="panel-stack">
      <div className="panel-grid">
        <section className="studio-card">
          <div className="card-header">
            <div className="card-heading-group">
              <span className="step-badge">1</span>
              <div>
                <h2 className="card-title">Frames ZIP Archive</h2>
                <p className="card-subtitle">
                  Upload a .zip file of sequential image frames.
                </p>
              </div>
            </div>
            {loadedZip ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleResetZip}
                disabled={isBusy || isReadingZip}
              >
                <RefreshCw size={14} />
                Change ZIP
              </button>
            ) : null}
          </div>

          {!loadedZip ? (
            <Dropzone
              accept=".zip,application/zip,application/x-zip-compressed"
              title={
                isReadingZip
                  ? 'Reading ZIP archive…'
                  : 'Drop your frames .zip file here'
              }
              subtitle="or click to select a .zip archive"
              hint="Supports PNG, JPG, WebP, and BMP images inside a .zip — sorted naturally"
              disabled={isBusy || isReadingZip}
              error={uploadError}
              onFileSelected={(file) => void loadZipFile(file)}
            />
          ) : (
            <div className="zip-summary-card">
              <div className="zip-summary-head">
                <div className="zip-icon-badge">
                  <FileArchive size={22} />
                </div>
                <div className="zip-meta-text">
                  <div className="meta-filename" title={loadedZip.zipName}>
                    {loadedZip.zipName}
                  </div>
                  <div className="spec-row">
                    <span className="spec-chip">
                      {loadedZip.frames.length} frames
                    </span>
                    <span className="spec-chip">
                      {formatBytes(loadedZip.zipSize)}
                    </span>
                    {loadedZip.width > 0 && loadedZip.height > 0 ? (
                      <span className="spec-chip">
                        {loadedZip.width} × {loadedZip.height}
                      </span>
                    ) : null}
                    <span className="spec-chip">
                      {loadedZip.formatsFound.join(' + ')}
                    </span>
                  </div>
                </div>
              </div>

              {loadedZip.suggestedFps ? (
                <div className="alert-banner is-info">
                  <Sparkles size={15} />
                  Detected {loadedZip.suggestedFps} fps hint from archive name
                  and pre-filled frame rate.
                </div>
              ) : null}

              {needsNormalizationNotice ? (
                <div className="alert-banner is-info">
                  Mixed sizes, non-PNG/JPG images, or odd dimensions detected —
                  frames will be auto-normalized cleanly before encoding.
                </div>
              ) : null}
            </div>
          )}
        </section>

        <section className="studio-card">
          <div className="card-header">
            <div className="card-heading-group">
              <span className="step-badge">2</span>
              <div>
                <h2 className="card-title">Video Output Settings</h2>
                <p className="card-subtitle">
                  Set playback speed, container format, and encoding quality.
                </p>
              </div>
            </div>
          </div>

          <div className="controls-stack">
            <div className="control-group">
              <label className="control-label">Output Frame Rate (FPS)</label>
              <div className="preset-row">
                {FPS_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={`preset-pill ${Number(fpsInput) === preset ? 'is-active' : ''}`}
                    onClick={() => setFpsInput(String(preset))}
                    disabled={isBusy}
                  >
                    {preset} fps
                  </button>
                ))}
              </div>
              <div className="inline-input-row">
                <label htmlFor="encode-fps-input" className="inline-label">
                  Custom FPS
                </label>
                <input
                  id="encode-fps-input"
                  type="number"
                  min="0.5"
                  max="120"
                  step="0.5"
                  value={fpsInput}
                  disabled={isBusy}
                  onChange={(event) => setFpsInput(event.target.value)}
                  onBlur={() => setFpsInput(String(parsedFps))}
                  className="number-input"
                />
                {loadedZip ? (
                  <span className="mono-pill">
                    Duration: {formatDuration(estimatedDurationSec)}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="control-group">
              <div className="control-label-row">
                <label className="control-label">Output Resolution</label>
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
              <label className="control-label">Video Format</label>
              <div className="segmented-control">
                <button
                  type="button"
                  className={`segment-btn ${videoFormat === 'mp4' ? 'is-active' : ''}`}
                  onClick={() => setVideoFormat('mp4')}
                  disabled={isBusy}
                >
                  <Film size={15} />
                  MP4 (H.264)
                </button>
                <button
                  type="button"
                  className={`segment-btn ${videoFormat === 'webm' ? 'is-active' : ''}`}
                  onClick={() => setVideoFormat('webm')}
                  disabled={isBusy}
                >
                  <Film size={15} />
                  WebM (VP8)
                </button>
              </div>
            </div>

            <div className="control-group">
              <label className="control-label">Encoding Quality</label>
              <div className="segmented-control">
                {(
                  [
                    { id: 'high', label: 'High' },
                    { id: 'balanced', label: 'Balanced' },
                    { id: 'compact', label: 'Compact' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`segment-btn ${quality === opt.id ? 'is-active' : ''}`}
                    onClick={() => setQuality(opt.id)}
                    disabled={isBusy}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="control-group">
              <div className="control-label-row">
                <label className="control-label">
                  Optional Audio / Music Mix
                </label>
                {audioTrack ? (
                  <span className="mono-pill">
                    {formatBytes(audioTrack.size)}
                  </span>
                ) : null}
              </div>

              <input
                ref={audioInputRef}
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleAudioSelected(file)
                  e.currentTarget.value = ''
                }}
              />

              {!audioTrack ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={isBusy}
                  onClick={() => audioInputRef.current?.click()}
                >
                  <Music size={15} />
                  Attach Music / Voiceover (.wav, .mp3, .m4a)
                </button>
              ) : (
                <div className="audio-attach-box">
                  <div className="audio-attach-row">
                    <span className="meta-filename" title={audioTrack.name}>
                      {audioTrack.name}
                    </span>
                    <div className="spec-row">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={isBusy || isAnalyzingAudio}
                        onClick={() => void handleAnalyzeAttachedAudio()}
                      >
                        <AudioLines size={14} />
                        {isAnalyzingAudio ? 'Analyzing…' : 'Analyze Flow'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={isBusy}
                        onClick={() => setAudioTrack(null)}
                        title="Remove audio track"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {audioTrack.flow ? (
                    <div className="audio-flow-preview">
                      <div className="spec-row">
                        <span className="spec-chip">{audioTrack.flow.bpm} BPM</span>
                        <span className="spec-chip">
                          {formatDuration(audioTrack.flow.durationSec)}
                        </span>
                        <span className="spec-chip">
                          {audioTrack.flow.cues.length} cues
                        </span>
                      </div>
                      {audioTrack.flow.flowImageUrl ? (
                        <img
                          src={audioTrack.flow.flowImageUrl}
                          alt="Attached track flow spectrogram"
                          className="flow-spectrogram-img"
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}

              {audioError ? (
                <div className="alert-banner is-error">{audioError}</div>
              ) : null}
            </div>

            <div className="action-footer">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={handleBuildVideo}
                disabled={!loadedZip || isBusy || isReadingZip}
              >
                <Play size={18} />
                Build Video from Frames
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

      {result && resultVideoUrl ? (
        <section className="studio-card result-card">
          <div className="result-header">
            <div className="result-summary">
              <span className="status-dot is-success" />
              <div>
                <h3 className="result-title">Video Ready to Download</h3>
                <div className="spec-row">
                  <span className="spec-chip">
                    {result.format.toUpperCase()}
                  </span>
                  <span className="spec-chip">
                    {result.width} × {result.height}
                  </span>
                  <span className="spec-chip">{result.fps} fps</span>
                  <span className="spec-chip">
                    {formatDuration(result.durationSec)}
                  </span>
                  <span className="spec-chip">{formatBytes(result.size)}</span>
                  {result.hasAudio ? (
                    <span className="spec-chip">With Audio</span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="result-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleDownloadVideo}
              >
                <Download size={16} />
                Download {result.format.toUpperCase()} ({formatBytes(result.size)})
              </button>
            </div>
          </div>

          <div className="video-stage is-output">
            <video
              key={resultVideoUrl}
              src={resultVideoUrl}
              controls
              playsInline
              className="video-player"
            />
          </div>
        </section>
      ) : null}

      {loadedZip ? (
        <section className="studio-card">
          <FrameGallery
            key={loadedZip.id}
            frames={loadedZip.frames}
            title="Frames Loaded from ZIP (Playback Order)"
          />
        </section>
      ) : null}
    </div>
  )
}
