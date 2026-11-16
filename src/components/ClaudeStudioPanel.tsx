import {
  AudioLines,
  Check,
  Copy,
  Download,
  FileArchive,
  Film,
  Globe,
  Layers,
  Music,
  Play,
  RefreshCw,
  Sparkles,
  Subtitles,
  Upload,
  Wand2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDuration, formatErrorMessage } from '../lib/format'
import {
  analyzeAudioTrack,
  fetchFileFromUrl,
  getTunnelStatus,
  listStudioProjects,
  previewStudioProject,
  renderStudioAudio,
  renderStudioVideo,
  startTunnel,
  stopTunnel,
} from '../lib/studioApi'
import type {
  MusicFlowSummary,
  StudioProjectSummary,
  TunnelStatus,
} from '../types/media'

interface ClaudeStudioPanelProps {
  isBusy: boolean
  onSendProjectToEditor: (zipFile: File, audioFile?: File) => void
}

const STARTER_PROMPT = `You are connected to Framer + Lemo-Opuscar MCP!
Let's create a motion-design video ad synced to music flow, sound effects, and voiceover:
1. Check framer_get_staged_media (if I sent frames/audio from Framer) or call lemo_list_styles + lemo_read_guide to pick a visual style.
2. Call lemo_analyze_music_flow on the music/track so you can visually SEE the beat grid, drops, silences, and energy sections in the spectrogram image.
3. Save the ad project under lemo-opuscar/films/<project_id>/ via lemo_save_ad_project (TREATMENT.md, timeline.js, index.html, main.js, lines.json, music/score.py, mix.py).
4. Run lemo_generate_voiceover + lemo_render_audio_mix + lemo_preview_ad_frames to inspect the audio spectrogram and visual contact sheet.
5. Call lemo_render_ad_to_framer so I can preview and download the finished .mp4, .wav, .srt, and frames .zip directly in Framer!`

export function ClaudeStudioPanel({
  isBusy,
  onSendProjectToEditor,
}: ClaudeStudioPanelProps) {
  const [projects, setProjects] = useState<StudioProjectSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isLoadingProjects, setIsLoadingProjects] = useState(true)
  const [studioAction, setStudioAction] = useState<string | null>(null)
  const [studioError, setStudioError] = useState<string | null>(null)
  const [studioNotice, setStudioNotice] = useState<string | null>(null)

  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null)
  const [customPublicOrigin, setCustomPublicOrigin] = useState<string>(() => {
    try {
      return localStorage.getItem('framer_public_mcp_origin') ?? ''
    } catch {
      return ''
    }
  })
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const [standaloneFlow, setStandaloneFlow] = useState<MusicFlowSummary | null>(
    null,
  )
  const [flowCacheStamp, setFlowCacheStamp] = useState(1)
  const [isAnalyzingAudio, setIsAnalyzingAudio] = useState(false)
  const [audioAnalyzeError, setAudioAnalyzeError] = useState<string | null>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)

  const refreshProjects = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoadingProjects(true)
    try {
      const list = await listStudioProjects()
      setProjects(list)
      setSelectedId((prev) => {
        if (prev && list.some((p) => p.id === prev)) return prev
        return list[0]?.id ?? null
      })
      setFlowCacheStamp((n) => n + 1)
    } catch (error) {
      if (!quiet) {
        setStudioError(
          formatErrorMessage(error, 'Could not load Lemo-Opuscar ad projects.'),
        )
      }
    } finally {
      setIsLoadingProjects(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    const loadInitial = async () => {
      try {
        const list = await listStudioProjects()
        if (!active) return
        setProjects(list)
        setSelectedId((prev) => {
          if (prev && list.some((p) => p.id === prev)) return prev
          return list[0]?.id ?? null
        })
      } catch {
        // user can retry via Refresh button
      } finally {
        if (active) setIsLoadingProjects(false)
      }
    }
    void loadInitial()
    void getTunnelStatus()
      .then((status) => {
        if (active) setTunnel(status)
      })
      .catch(() => null)
    const timer = window.setInterval(() => {
      void refreshProjects(true)
    }, 8000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [refreshProjects])

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  )

  const effectiveOrigin = useMemo(() => {
    const cleanedCustom = customPublicOrigin.trim().replace(/\/+$/, '')
    if (cleanedCustom) return cleanedCustom
    if (tunnel?.publicUrl) return tunnel.publicUrl.replace(/\/+$/, '')
    return window.location.origin
  }, [customPublicOrigin, tunnel])

  const mcpUrl = `${effectiveOrigin}/mcp`
  const sseUrl = `${effectiveOrigin}/sse`
  const isHttpsConnector = mcpUrl.startsWith('https://')

  const handleCustomOriginChange = (val: string) => {
    setCustomPublicOrigin(val)
    try {
      localStorage.setItem('framer_public_mcp_origin', val)
    } catch {
      // ignore storage errors
    }
  }

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(key)
      window.setTimeout(() => setCopiedField(null), 1800)
    } catch {
      setStudioError('Clipboard copy failed — copy the text manually.')
    }
  }

  const handleToggleTunnel = async () => {
    setStudioError(null)
    try {
      const next = tunnel?.active ? await stopTunnel() : await startTunnel()
      setTunnel(next)
      if (next.error) setStudioError(next.error)
    } catch (error) {
      setStudioError(formatErrorMessage(error, 'Could not manage tunnel.'))
    }
  }

  const handleAnalyzeStandaloneAudio = async (file: File) => {
    setAudioAnalyzeError(null)
    setIsAnalyzingAudio(true)
    try {
      const res = await analyzeAudioTrack(file)
      setStandaloneFlow(res.summary)
      setFlowCacheStamp((n) => n + 1)
    } catch (error) {
      setAudioAnalyzeError(
        formatErrorMessage(error, 'Could not analyze audio flow.'),
      )
    } finally {
      setIsAnalyzingAudio(false)
    }
  }

  const runProjectAction = async (
    label: string,
    fn: () => Promise<StudioProjectSummary | null>,
  ) => {
    if (!selectedProject) return
    setStudioError(null)
    setStudioNotice(null)
    setStudioAction(label)
    try {
      const updated = await fn()
      await refreshProjects(true)
      if (updated) setSelectedId(updated.id)
      setStudioNotice(`${label} completed for "${selectedProject.id}".`)
    } catch (error) {
      setStudioError(formatErrorMessage(error, `${label} failed.`))
    } finally {
      setStudioAction(null)
    }
  }

  const handleSendToFramesEditor = async () => {
    if (!selectedProject) return
    if (!selectedProject.framesZipUrl) {
      setStudioError(
        'Render the Full Ad (.mp4 + .zip) first so a frames .zip is available.',
      )
      return
    }
    setStudioAction('Loading project into Frames → Video editor…')
    setStudioError(null)
    try {
      const zipFile = await fetchFileFromUrl(
        selectedProject.framesZipUrl,
        `${selectedProject.id}_frames.zip`,
      )
      let audioFile: File | undefined
      if (selectedProject.audioMixUrl) {
        audioFile = await fetchFileFromUrl(
          selectedProject.audioMixUrl,
          `${selectedProject.id}_mix.wav`,
        )
      }
      onSendProjectToEditor(zipFile, audioFile)
    } catch (error) {
      setStudioError(
        formatErrorMessage(error, 'Could not transfer frames to editor.'),
      )
    } finally {
      setStudioAction(null)
    }
  }

  const activeFlow = standaloneFlow ?? selectedProject?.flowSummary ?? null

  return (
    <div className="panel-stack">
      <div className="panel-grid">
        <section className="studio-card">
          <div className="card-header">
            <div className="card-heading-group">
              <span className="step-badge">1</span>
              <div>
                <h2 className="card-title">Claude Web Custom Connector (MCP)</h2>
                <p className="card-subtitle">
                  Connect Framer + Lemo-Opuscar directly inside claude.ai Web.
                </p>
              </div>
            </div>
            <span className="status-pill is-ready">
              <span className="status-dot is-success" />
              MCP Ready
            </span>
          </div>

          <div className="controls-stack">
            <div className="control-group">
              <label htmlFor="mcp-public-origin" className="control-label">
                Public HTTPS Tunnel URL (for Claude Web)
              </label>
              <div className="inline-input-row">
                <input
                  id="mcp-public-origin"
                  type="url"
                  className="text-input-wide"
                  placeholder="https://your-tunnel.trycloudflare.com (optional if local)"
                  value={customPublicOrigin}
                  onChange={(e) => handleCustomOriginChange(e.target.value)}
                />
                {tunnel?.availableProvider ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleToggleTunnel()}
                  >
                    <Globe size={14} />
                    {tunnel.active ? 'Stop Tunnel' : `Start ${tunnel.availableProvider}`}
                  </button>
                ) : null}
              </div>
              <p className="control-hint">
                Claude Web requires an HTTPS URL. Run{' '}
                <code>
                  cloudflared tunnel --url http://localhost:{window.location.port || '5173'}
                </code>{' '}
                (or <code>ngrok http {window.location.port || '5173'}</code>) and paste
                the <code>https://…</code> origin above.
              </p>
            </div>

            <div className="connector-url-box">
              <div className="connector-url-row">
                <span className="inline-label">Connector URL (Streamable HTTP)</span>
                <div className="connector-copy-group">
                  <code className="connector-code">{mcpUrl}</code>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleCopy('mcp', mcpUrl)}
                  >
                    {copiedField === 'mcp' ? <Check size={14} /> : <Copy size={14} />}
                    {copiedField === 'mcp' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="connector-url-row">
                <span className="inline-label">SSE Fallback URL</span>
                <div className="connector-copy-group">
                  <code className="connector-code">{sseUrl}</code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void handleCopy('sse', sseUrl)}
                  >
                    {copiedField === 'sse' ? <Check size={14} /> : <Copy size={14} />}
                    {copiedField === 'sse' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>

            {!isHttpsConnector ? (
              <div className="alert-banner is-warning">
                Currently showing local HTTP ({mcpUrl}). Paste your{' '}
                <code>https://…</code> tunnel origin above before adding to Claude.ai
                Connectors.
              </div>
            ) : (
              <div className="alert-banner is-info">
                <Sparkles size={15} />
                Ready for Claude Web: go to{' '}
                <strong>claude.ai → Settings → Connectors → Add custom connector</strong>{' '}
                and paste <code>{mcpUrl}</code>.
              </div>
            )}

            <div className="inline-input-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleCopy('prompt', STARTER_PROMPT)}
              >
                {copiedField === 'prompt' ? <Check size={16} /> : <Wand2 size={16} />}
                {copiedField === 'prompt'
                  ? 'Starter Prompt Copied!'
                  : 'Copy Starter Prompt for Claude Web'}
              </button>
            </div>
          </div>
        </section>

        <section className="studio-card">
          <div className="card-header">
            <div className="card-heading-group">
              <span className="step-badge">2</span>
              <div>
                <h2 className="card-title">Music Flow Visual Analyzer</h2>
                <p className="card-subtitle">
                  Convert any song or video into a Beat Grid + Spectrogram Image Claude can
                  see.
                </p>
              </div>
            </div>
          </div>

          <div className="controls-stack">
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*,video/*,.mp3,.wav,.m4a,.ogg,.flac,.mp4,.mov,.webm"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleAnalyzeStandaloneAudio(f)
                e.currentTarget.value = ''
              }}
            />
            <button
              type="button"
              className="btn btn-secondary btn-lg"
              disabled={isAnalyzingAudio || isBusy}
              onClick={() => audioInputRef.current?.click()}
            >
              <Upload size={17} />
              {isAnalyzingAudio
                ? 'Analyzing BPM, Beats & Energy Flow…'
                : 'Analyze Audio / Video Track (.mp3, .wav, .mp4)'}
            </button>

            {audioAnalyzeError ? (
              <div className="alert-banner is-error">{audioAnalyzeError}</div>
            ) : null}

            {activeFlow ? (
              <div className="flow-mini-summary">
                <div className="spec-row">
                  <span className="spec-chip">{activeFlow.sourceName}</span>
                  <span className="spec-chip">{activeFlow.bpm} BPM</span>
                  <span className="spec-chip">
                    {formatDuration(activeFlow.durationSec)}
                  </span>
                  <span className="spec-chip">
                    {activeFlow.sections.length} sections
                  </span>
                  <span className="spec-chip">{activeFlow.cues.length} hit cues</span>
                  <span className="spec-chip">
                    {activeFlow.silences.length} silences
                  </span>
                </div>
                <p className="control-hint">
                  Claude receives both the spectrogram image below and a ready{' '}
                  <code>timeline.js</code> with all {activeFlow.beats.length} beat
                  timestamps so animations and cuts hit on-beat.
                </p>
              </div>
            ) : (
              <div className="alert-banner is-info">
                <Music size={15} />
                Upload a track here or select a Lemo-Opuscar project below to inspect its
                visual Music Flow Map.
              </div>
            )}
          </div>
        </section>
      </div>

      {activeFlow?.flowImageUrl ? (
        <section className="studio-card">
          <div className="card-header">
            <div className="card-heading-group">
              <AudioLines size={18} className="accent-icon" />
              <div>
                <h3 className="card-title">
                  Music Flow Map — {activeFlow.sourceName} ({activeFlow.bpm} BPM)
                </h3>
                <p className="card-subtitle">
                  This visual spectrogram + beat/cue timeline is sent directly into Claude
                  Web’s vision context.
                </p>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void handleCopy('timeline', activeFlow.timelineJs)}
            >
              {copiedField === 'timeline' ? <Check size={14} /> : <Copy size={14} />}
              {copiedField === 'timeline' ? 'Copied timeline.js' : 'Copy timeline.js'}
            </button>
          </div>

          <div className="flow-image-frame">
            <img
              src={`${activeFlow.flowImageUrl}?v=${flowCacheStamp}`}
              alt={`Music flow spectrogram for ${activeFlow.sourceName}`}
              className="flow-spectrogram-img"
            />
          </div>

          <div className="flow-sections-grid">
            {activeFlow.sections.map((sec) => (
              <div key={sec.id} className="flow-section-card">
                <div className="flow-section-top">
                  <span className="meta-filename">{sec.id}</span>
                  <span className={`energy-badge is-${sec.energyLevel}`}>
                    {sec.energyLevel}
                  </span>
                </div>
                <div className="spec-row">
                  <span className="spec-chip">
                    {sec.t0.toFixed(1)}s – {sec.t1.toFixed(1)}s
                  </span>
                  <span className="spec-chip">{sec.avgRmsDb} dBFS</span>
                </div>
                <p className="flow-guidance-text">{sec.motionGuidance}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="studio-card">
        <div className="card-header">
          <div className="card-heading-group">
            <span className="step-badge">3</span>
            <div>
              <h2 className="card-title">
                Ad Projects &amp; Framer Downloads (lemo-opuscar/films)
              </h2>
              <p className="card-subtitle">
                Ads built by Claude Web appear here automatically with video, music,
                voiceover, and frame archives.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void refreshProjects(false)}
            disabled={isLoadingProjects || Boolean(studioAction)}
          >
            <RefreshCw size={14} className={isLoadingProjects ? 'spin-icon' : ''} />
            Refresh
          </button>
        </div>

        {studioAction ? (
          <div className="alert-banner is-info">
            <RefreshCw size={15} className="spin-icon" />
            {studioAction} — this may take a moment while headless Chrome / FFmpeg
            renders.
          </div>
        ) : null}
        {studioNotice ? (
          <div className="alert-banner is-info">{studioNotice}</div>
        ) : null}
        {studioError ? (
          <div className="alert-banner is-error" role="alert">
            {studioError}
          </div>
        ) : null}

        {projects.length === 0 && !isLoadingProjects ? (
          <div className="alert-banner is-info">
            No ad projects in <code>lemo-opuscar/films/</code> yet. Ask Claude Web via
            the MCP connector to create one!
          </div>
        ) : (
          <div className="studio-project-layout">
            <div className="project-list-col">
              {projects.map((proj) => (
                <button
                  key={proj.id}
                  type="button"
                  className={`project-item-btn ${selectedProject?.id === proj.id ? 'is-active' : ''}`}
                  onClick={() => setSelectedId(proj.id)}
                >
                  <div className="project-item-head">
                    <span className="meta-filename">{proj.id}</span>
                    {proj.bpm ? <span className="spec-chip">{proj.bpm} BPM</span> : null}
                  </div>
                  <div className="spec-row">
                    {proj.durationSec ? (
                      <span className="spec-chip">
                        {formatDuration(proj.durationSec)}
                      </span>
                    ) : null}
                    {proj.hasVideo ? <span className="spec-chip">MP4</span> : null}
                    {proj.hasAudioMix ? <span className="spec-chip">Audio</span> : null}
                    {proj.hasFramesZip ? <span className="spec-chip">Frames ZIP</span> : null}
                  </div>
                </button>
              ))}
            </div>

            {selectedProject ? (
              <div className="project-detail-col">
                <div className="result-header">
                  <div>
                    <h3 className="result-title">{selectedProject.title}</h3>
                    <div className="spec-row">
                      <span className="spec-chip">films/{selectedProject.id}</span>
                      {selectedProject.durationSec ? (
                        <span className="spec-chip">
                          {formatDuration(selectedProject.durationSec)}
                        </span>
                      ) : null}
                      {selectedProject.bpm ? (
                        <span className="spec-chip">{selectedProject.bpm} BPM</span>
                      ) : null}
                      {selectedProject.hasVoiceover ? (
                        <span className="spec-chip">Voiceover Ready</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="result-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={Boolean(studioAction) || isBusy}
                      onClick={() =>
                        void runProjectAction('Preview Stills', async () => {
                          const res = await previewStudioProject(selectedProject.id)
                          return res.project
                        })
                      }
                    >
                      <Layers size={14} />
                      Preview Stills
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={Boolean(studioAction) || isBusy}
                      onClick={() =>
                        void runProjectAction('Render Audio & Flow', async () => {
                          const res = await renderStudioAudio(selectedProject.id)
                          setStandaloneFlow(null)
                          return res.project
                        })
                      }
                    >
                      <Music size={14} />
                      Render Audio &amp; Flow
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={Boolean(studioAction) || isBusy}
                      onClick={() =>
                        void runProjectAction('Full Render (.mp4 + .zip)', async () => {
                          const res = await renderStudioVideo(selectedProject.id, {
                            fps: 24,
                            width: 1920,
                            height: 1080,
                            grain: 0,
                          })
                          setStandaloneFlow(null)
                          return res.project
                        })
                      }
                    >
                      <Play size={14} />
                      Render Full Ad
                    </button>
                  </div>
                </div>

                <div className="download-bar">
                  {selectedProject.videoUrl ? (
                    <a
                      className="btn btn-primary btn-sm"
                      href={`${selectedProject.videoUrl}?download=1`}
                      download
                    >
                      <Download size={14} />
                      Download MP4
                    </a>
                  ) : null}
                  {selectedProject.framesZipUrl ? (
                    <a
                      className="btn btn-secondary btn-sm"
                      href={`${selectedProject.framesZipUrl}?download=1`}
                      download
                    >
                      <FileArchive size={14} />
                      Download Frames ZIP
                    </a>
                  ) : null}
                  {selectedProject.audioMixUrl ? (
                    <a
                      className="btn btn-secondary btn-sm"
                      href={`${selectedProject.audioMixUrl}?download=1`}
                      download
                    >
                      <Music size={14} />
                      Download Audio WAV
                    </a>
                  ) : null}
                  {selectedProject.srtUrl ? (
                    <a
                      className="btn btn-secondary btn-sm"
                      href={`${selectedProject.srtUrl}?download=1`}
                      download
                    >
                      <Subtitles size={14} />
                      Download Subtitles (.srt)
                    </a>
                  ) : null}
                  {selectedProject.framesZipUrl ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void handleSendToFramesEditor()}
                      disabled={Boolean(studioAction) || isBusy}
                    >
                      <Film size={14} />
                      Open in Frames → Video Editor
                    </button>
                  ) : null}
                </div>

                {selectedProject.videoUrl ? (
                  <div className="video-stage is-output">
                    <video
                      key={selectedProject.videoUrl}
                      src={selectedProject.videoUrl}
                      controls
                      playsInline
                      className="video-player"
                    />
                  </div>
                ) : selectedProject.contactSheetUrl ? (
                  <div className="flow-image-frame">
                    <img
                      src={selectedProject.contactSheetUrl}
                      alt={`Contact sheet for ${selectedProject.id}`}
                      className="flow-spectrogram-img"
                    />
                  </div>
                ) : (
                  <div className="alert-banner is-info">
                    Click <strong>Preview Stills</strong> for quick keyframes or{' '}
                    <strong>Render Full Ad</strong> to build the final video &amp;
                    frames ZIP.
                  </div>
                )}

                {selectedProject.audioMixUrl ? (
                  <div className="audio-player-bar">
                    <span className="inline-label">Mastered Mix / Score:</span>
                    <audio
                      key={selectedProject.audioMixUrl}
                      src={selectedProject.audioMixUrl}
                      controls
                      className="audio-player-el"
                    />
                  </div>
                ) : null}

                {selectedProject.stillUrls.length > 0 ? (
                  <div className="stills-strip">
                    {selectedProject.stillUrls.map((url) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="still-thumb-link"
                      >
                        <img src={url} alt="" className="still-thumb-img" loading="lazy" />
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}
