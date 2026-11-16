import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { zipSync } from 'fflate'
import type {
  MusicFlowSummary,
  StudioProjectSummary,
  TunnelStatus,
} from '../types/media.ts'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface StyleEntry {
  slug: string
  name: string
  needsImageGen: boolean
  hasDemo: boolean
}

export interface StagedMediaPayload {
  sourceName: string
  fps?: number | null
  width?: number | null
  height?: number | null
  frames: Array<{ name: string; base64: string; timestampSec?: number }>
  audioBase64?: string
  audioFileName?: string
  notes?: string
}

export interface VoiceoverLineInput {
  id: string
  t?: number
  voice?: string
  rate?: string
  pitch?: string
  speed?: number
  lang?: string
  text: string
  say?: string
  asr?: string
  audio_url?: string
  audio_base64?: string
  stability?: number
  similarity_boost?: number
}

const VALID_PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const MAX_READ_CHARS = 32000

export function sanitizeProjectId(rawId: string): string {
  const cleaned = rawId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!cleaned || !VALID_PROJECT_ID.test(cleaned)) {
    throw new Error(
      `Invalid project_id "${rawId}". Use alphanumeric characters, dashes, or underscores.`,
    )
  }
  return cleaned
}

export function safeResolveInside(baseDir: string, relativePath: string): string {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const resolvedBase = path.resolve(baseDir)
  const resolvedTarget = path.resolve(resolvedBase, cleaned)
  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)
  ) {
    throw new Error(`Unsafe path outside project directory: "${relativePath}"`)
  }
  return resolvedTarget
}

export class StudioService {
  readonly rootDir: string
  readonly lemoRoot: string
  readonly filmsDir: string
  readonly stylesDir: string
  readonly workspaceDir: string
  readonly stagedDir: string
  readonly uploadsDir: string
  readonly pythonBin: string
  readonly ffmpegBinDir: string
  readonly musicFlowScript: string
  readonly elevenlabsTtsScript: string
  readonly elevenlabsKeyFile: string

  private tunnelProc: ChildProcess | null = null
  private tunnelPublicUrl: string | null = null
  private tunnelProvider: string | null = null
  private tunnelError: string | null = null
  private activeRenders = new Map<
    string,
    Promise<{ project: StudioProjectSummary; logs: string }>
  >()

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = path.resolve(rootDir)
    this.lemoRoot = path.join(this.rootDir, 'lemo-opuscar')
    this.filmsDir = path.join(this.lemoRoot, 'films')
    this.stylesDir = path.join(this.lemoRoot, 'styles')
    this.workspaceDir = path.join(this.rootDir, '.framer-workspace')
    this.stagedDir = path.join(this.workspaceDir, 'staged')
    this.uploadsDir = path.join(this.workspaceDir, 'uploads')

    const venvPython = path.join(this.lemoRoot, '.venv', 'bin', 'python')
    this.pythonBin = fs.existsSync(venvPython) ? venvPython : 'python3'
    this.ffmpegBinDir = path.join(this.lemoRoot, '.bin')
    this.musicFlowScript = path.join(this.rootDir, 'src', 'server', 'music_flow.py')
    this.elevenlabsTtsScript = path.join(
      this.rootDir,
      'src',
      'server',
      'tts_elevenlabs.py',
    )
    this.elevenlabsKeyFile = path.join(this.workspaceDir, 'elevenlabs_key.txt')
  }

  private getExecEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
    const existingPath = process.env.PATH ?? ''
    const nextPath = fs.existsSync(this.ffmpegBinDir)
      ? `${this.ffmpegBinDir}${path.delimiter}${existingPath}`
      : existingPath
    return {
      ...process.env,
      PATH: nextPath,
      LIB: this.lemoRoot,
      ...extraEnv,
    }
  }

  private async runCommand(
    cmd: string,
    args: string[],
    cwd: string = this.lemoRoot,
    timeoutMs: number = 600_000,
    extraEnv?: Record<string, string>,
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: this.getExecEnv(extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${cmd} ${args.join(' ')}`))
      }, timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, stdout, stderr })
      })
    })
  }

  private ensureDir(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
  }

  private findProjectDir(projectId: string): string {
    const safeId = sanitizeProjectId(projectId)
    return path.join(this.filmsDir, safeId)
  }

  private requireProjectDir(projectId: string): string {
    const dir = this.findProjectDir(projectId)
    if (!fs.existsSync(dir)) {
      throw new Error(`Project "${projectId}" does not exist in lemo-opuscar/films/.`)
    }
    return dir
  }

  listStyles(query?: string): {
    styles: StyleEntry[]
    total: number
    projects: string[]
    coreGuides: string[]
  } {
    const styles: StyleEntry[] = []
    if (fs.existsSync(this.stylesDir)) {
      const entries = fs.readdirSync(this.stylesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const slug = entry.name
        const styleMdPath = path.join(this.stylesDir, slug, 'STYLE.md')
        const styleJsonPath = path.join(this.stylesDir, slug, 'style.json')
        let name = slug
        let needsImageGen = false

        if (fs.existsSync(styleMdPath)) {
          const firstLines = fs
            .readFileSync(styleMdPath, 'utf8')
            .split('\n')
            .slice(0, 4)
          const heading = firstLines.find((l) => l.startsWith('# '))
          if (heading) {
            name = heading.replace(/^#\s+/, '').trim()
          }
        }
        if (fs.existsSync(styleJsonPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(styleJsonPath, 'utf8')) as {
              name?: string
              needs?: string[]
            }
            if (parsed.name) name = parsed.name
            if (Array.isArray(parsed.needs) && parsed.needs.includes('image-generation')) {
              needsImageGen = true
            }
          } catch {
            // ignore malformed style.json
          }
        }

        const hasDemo = fs.existsSync(path.join(this.stylesDir, slug, 'demo'))
        styles.push({ slug, name, needsImageGen, hasDemo })
      }
    }

    styles.sort((a, b) => a.slug.localeCompare(b.slug))
    const q = query?.trim().toLowerCase()
    const filtered = q
      ? styles.filter(
          (s) =>
            s.slug.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
        )
      : styles

    const projects = fs.existsSync(this.filmsDir)
      ? fs
          .readdirSync(this.filmsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
      : []

    return {
      styles: filtered,
      total: styles.length,
      projects,
      coreGuides: [
        'AGENTS.md',
        'DIRECTOR.md',
        'TECHNIQUE.md',
        'core/README.md',
        'core/lib.js',
        'core/audio/INSTRUMENTS.md',
        'core/audio/sfx.py',
        'core/audio/pluck.py',
      ],
    }
  }

  readGuide(target: string): { target: string; path: string; content: string; truncated: boolean } {
    const clean = target.trim().replace(/^\/+/, '')
    const candidates: string[] = []

    const directMap: Record<string, string> = {
      agents: 'AGENTS.md',
      'agents.md': 'AGENTS.md',
      director: 'DIRECTOR.md',
      'director.md': 'DIRECTOR.md',
      technique: 'TECHNIQUE.md',
      'technique.md': 'TECHNIQUE.md',
      core: 'core/README.md',
      'core/readme.md': 'core/README.md',
      'core/lib.js': 'core/lib.js',
      instruments: 'core/audio/INSTRUMENTS.md',
      'instruments.md': 'core/audio/INSTRUMENTS.md',
      'core/audio/instruments.md': 'core/audio/INSTRUMENTS.md',
      sfx: 'core/audio/sfx.py',
      'sfx.py': 'core/audio/sfx.py',
      'core/audio/sfx.py': 'core/audio/sfx.py',
      pluck: 'core/audio/pluck.py',
      'pluck.py': 'core/audio/pluck.py',
    }

    const mapped = directMap[clean.toLowerCase()]
    if (mapped) {
      candidates.push(safeResolveInside(this.lemoRoot, mapped))
    }

    if (fs.existsSync(path.join(this.stylesDir, clean, 'STYLE.md'))) {
      candidates.push(path.join(this.stylesDir, clean, 'STYLE.md'))
    }
    if (clean.startsWith('styles/') || clean.startsWith('films/') || clean.startsWith('core/')) {
      candidates.push(safeResolveInside(this.lemoRoot, clean))
    }

    const found = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile())
    if (!found) {
      throw new Error(
        `Guide or style "${target}" not found. Try a style slug (e.g. "ascii-crt", "swiss-motion", "dark-tech-keynote") or a guide name ("DIRECTOR.md", "TECHNIQUE.md", "INSTRUMENTS.md", "sfx.py").`,
      )
    }

    const raw = fs.readFileSync(found, 'utf8')
    const truncated = raw.length > MAX_READ_CHARS
    const content = truncated
      ? `${raw.slice(0, MAX_READ_CHARS)}\n\n... [truncated at ${MAX_READ_CHARS} chars of ${raw.length}]`
      : raw

    return {
      target,
      path: path.relative(this.lemoRoot, found),
      content,
      truncated,
    }
  }

  async analyzeAudioFile(
    inputFilePath: string,
    outDir?: string,
    baseName: string = 'flow',
  ): Promise<{ summary: MusicFlowSummary; pngPath: string; jsonPath: string }> {
    const absInput = path.resolve(inputFilePath)
    if (!fs.existsSync(absInput)) {
      throw new Error(`Audio/video input file not found: ${absInput}`)
    }
    const targetDir = outDir ? path.resolve(outDir) : path.join(this.workspaceDir, 'analysis')
    this.ensureDir(targetDir)

    const outJson = path.join(targetDir, `${baseName}.json`)
    const outPng = path.join(targetDir, `${baseName}.png`)

    const res = await this.runCommand(
      this.pythonBin,
      [this.musicFlowScript, absInput, '--out-json', outJson, '--out-png', outPng],
      this.rootDir,
      120_000,
    )
    if (res.code !== 0 || !fs.existsSync(outJson)) {
      throw new Error(
        `Music flow analysis failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
      )
    }

    const summary = JSON.parse(fs.readFileSync(outJson, 'utf8')) as MusicFlowSummary
    return { summary, pngPath: outPng, jsonPath: outJson }
  }

  async analyzeAudioBuffer(
    fileName: string,
    bytes: Uint8Array,
  ): Promise<{ summary: MusicFlowSummary; flowImageUrl: string; fileId: string }> {
    this.ensureDir(this.uploadsDir)
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'track.wav'
    const fileId = `${Date.now()}_${safeName}`
    const uploadPath = path.join(this.uploadsDir, fileId)
    const analysisDir = path.join(this.uploadsDir, `${fileId}_flow`)
    fs.writeFileSync(uploadPath, bytes)

    const { summary } = await this.analyzeAudioFile(uploadPath, analysisDir, 'music_flow')
    const flowImageUrl = `/api/studio/uploads/${encodeURIComponent(fileId)}/flow.png`
    summary.flowImageUrl = flowImageUrl
    return { summary, flowImageUrl, fileId }
  }

  async stageMediaFromFramer(payload: StagedMediaPayload): Promise<{
    stagedAt: string
    frameCount: number
    hasAudio: boolean
    flowSummary: MusicFlowSummary | null
  }> {
    this.ensureDir(this.stagedDir)
    const framesDir = path.join(this.stagedDir, 'frames')
    fs.rmSync(framesDir, { recursive: true, force: true })
    this.ensureDir(framesDir)

    for (let i = 0; i < payload.frames.length; i += 1) {
      const f = payload.frames[i]
      const cleanName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]+/g, '_') || `frame_${i + 1}.jpg`
      const buf = Buffer.from(f.base64, 'base64')
      fs.writeFileSync(path.join(framesDir, cleanName), buf)
    }

    const audioOutPath = path.join(this.stagedDir, 'staged_audio')
    let savedAudioPath: string | null = null
    if (payload.audioBase64 && payload.audioFileName) {
      const ext = path.extname(payload.audioFileName) || '.mp4'
      savedAudioPath = `${audioOutPath}${ext}`
      fs.writeFileSync(savedAudioPath, Buffer.from(payload.audioBase64, 'base64'))
    }

    let flowSummary: MusicFlowSummary | null = null
    if (savedAudioPath) {
      try {
        const analyzed = await this.analyzeAudioFile(
          savedAudioPath,
          this.stagedDir,
          'staged_flow',
        )
        flowSummary = analyzed.summary
        flowSummary.flowImageUrl = '/api/studio/staged/flow.png'
      } catch {
        // Video might not have an audio stream; staging frames still succeeds.
        flowSummary = null
      }
    }

    const meta = {
      sourceName: payload.sourceName,
      fps: payload.fps ?? null,
      width: payload.width ?? null,
      height: payload.height ?? null,
      frameCount: payload.frames.length,
      frameFiles: fs.readdirSync(framesDir).sort(),
      audioFile: savedAudioPath ? path.basename(savedAudioPath) : null,
      notes: payload.notes ?? '',
      stagedAt: new Date().toISOString(),
    }
    fs.writeFileSync(
      path.join(this.stagedDir, 'manifest.json'),
      JSON.stringify(meta, null, 2),
      'utf8',
    )

    return {
      stagedAt: meta.stagedAt,
      frameCount: payload.frames.length,
      hasAudio: Boolean(flowSummary),
      flowSummary,
    }
  }

  getStagedMedia(maxFrames: number = 8): {
    manifest: Record<string, unknown> | null
    sampleFrames: Array<{ name: string; mimeType: string; base64: string }>
    flowSummary: MusicFlowSummary | null
    flowPngBase64: string | null
  } {
    const manifestPath = path.join(this.stagedDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      return {
        manifest: null,
        sampleFrames: [],
        flowSummary: null,
        flowPngBase64: null,
      }
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      frameFiles?: string[]
    } & Record<string, unknown>

    const framesDir = path.join(this.stagedDir, 'frames')
    const allFiles = Array.isArray(manifest.frameFiles) ? manifest.frameFiles : []
    const count = Math.max(1, Math.min(24, maxFrames))
    const picked: string[] = []
    if (allFiles.length <= count) {
      picked.push(...allFiles)
    } else {
      for (let i = 0; i < count; i += 1) {
        const idx = Math.round((i * (allFiles.length - 1)) / (count - 1))
        const f = allFiles[idx]
        if (f && !picked.includes(f)) picked.push(f)
      }
    }

    const sampleFrames = picked
      .map((name) => {
        const p = path.join(framesDir, name)
        if (!fs.existsSync(p)) return null
        const ext = path.extname(name).toLowerCase()
        const mimeType =
          ext === '.png'
            ? 'image/png'
            : ext === '.webp'
              ? 'image/webp'
              : 'image/jpeg'
        return {
          name,
          mimeType,
          base64: fs.readFileSync(p).toString('base64'),
        }
      })
      .filter((x): x is { name: string; mimeType: string; base64: string } => x !== null)

    const flowJsonPath = path.join(this.stagedDir, 'staged_flow.json')
    const flowPngPath = path.join(this.stagedDir, 'staged_flow.png')
    const flowSummary = fs.existsSync(flowJsonPath)
      ? (JSON.parse(fs.readFileSync(flowJsonPath, 'utf8')) as MusicFlowSummary)
      : null
    const flowPngBase64 = fs.existsSync(flowPngPath)
      ? fs.readFileSync(flowPngPath).toString('base64')
      : null

    return { manifest, sampleFrames, flowSummary, flowPngBase64 }
  }

  saveProjectFiles(
    projectId: string,
    files: Record<string, string>,
  ): { projectId: string; projectDir: string; writtenFiles: string[] } {
    const safeId = sanitizeProjectId(projectId)
    const projDir = path.join(this.filmsDir, safeId)
    this.ensureDir(projDir)

    const writtenFiles: string[] = []
    for (const [relPath, content] of Object.entries(files)) {
      const target = safeResolveInside(projDir, relPath)
      this.ensureDir(path.dirname(target))
      fs.writeFileSync(target, content, 'utf8')
      writtenFiles.push(path.relative(projDir, target))
    }

    return { projectId: safeId, projectDir: projDir, writtenFiles }
  }

  readProjectFile(projectId: string, relPath: string): string {
    const projDir = this.requireProjectDir(projectId)
    const target = safeResolveInside(projDir, relPath)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`File "${relPath}" not found in project "${projectId}".`)
    }
    return fs.readFileSync(target, 'utf8')
  }

  async generateVoiceover(
    projectId: string,
    options: {
      lines?: VoiceoverLineInput[]
      engine?: 'edge' | 'kokoro' | 'elevenlabs'
      defaultVoice?: string
      elevenlabsApiKey?: string
      modelId?: string
      runAsrCheck?: boolean
      lang?: string
    } = {},
  ): Promise<{
    projectId: string
    engine: string
    durations: Record<string, number>
    words: Record<string, [string, number, number][]> | null
    asrReport: string
  }> {
    const safeId = sanitizeProjectId(projectId)
    const projDir = path.join(this.filmsDir, safeId)
    this.ensureDir(projDir)

    const linesPath = path.join(projDir, 'lines.json')
    if (options.lines && options.lines.length > 0) {
      fs.writeFileSync(linesPath, JSON.stringify(options.lines, null, 2), 'utf8')
    }
    if (!fs.existsSync(linesPath)) {
      throw new Error(`lines.json not found in films/${safeId}/`)
    }

    const voicesDir = path.join(projDir, 'voices')
    this.ensureDir(voicesDir)

    const suppliedKey = options.elevenlabsApiKey?.trim()
    if (suppliedKey) {
      this.ensureDir(this.workspaceDir)
      fs.writeFileSync(this.elevenlabsKeyFile, suppliedKey, {
        encoding: 'utf8',
        mode: 0o600,
      })
    }

    const storedKey =
      suppliedKey ||
      process.env.ELEVENLABS_API_KEY?.trim() ||
      (fs.existsSync(this.elevenlabsKeyFile)
        ? fs.readFileSync(this.elevenlabsKeyFile, 'utf8').trim()
        : '')

    const parsedLines = JSON.parse(
      fs.readFileSync(linesPath, 'utf8'),
    ) as VoiceoverLineInput[]
    const hasConnectorAudio = parsedLines.some(
      (line) =>
        (typeof line.audio_url === 'string' && line.audio_url.trim().length > 0) ||
        (typeof line.audio_base64 === 'string' &&
          line.audio_base64.trim().length > 0),
    )

    const engine: 'edge' | 'kokoro' | 'elevenlabs' =
      options.engine === 'elevenlabs' ||
      hasConnectorAudio ||
      (!options.engine && storedKey.length > 0)
        ? 'elevenlabs'
        : options.engine ?? 'edge'

    if (engine === 'elevenlabs') {
      const elArgs = [this.elevenlabsTtsScript, linesPath, voicesDir]
      if (options.defaultVoice) {
        elArgs.push('--voice', options.defaultVoice)
      }
      if (options.modelId) {
        elArgs.push('--model', options.modelId)
      }
      const elRes = await this.runCommand(
        this.pythonBin,
        elArgs,
        this.lemoRoot,
        180_000,
        storedKey ? { ELEVENLABS_API_KEY: storedKey } : undefined,
      )
      if (elRes.code !== 0) {
        throw new Error(
          `ElevenLabs TTS failed (exit ${elRes.code}): ${elRes.stderr.trim() || elRes.stdout.trim()}`,
        )
      }
    } else {
      const script =
        engine === 'kokoro'
          ? path.join(this.lemoRoot, 'core', 'tts', 'tts.py')
          : path.join(this.lemoRoot, 'core', 'tts', 'tts_zh.py')

      const buildTtsArgs = (voiceOverride?: string) => {
        const args = [script, linesPath, voicesDir]
        const voice = voiceOverride ?? options.defaultVoice
        if (engine === 'edge' && voice) {
          args.push('--voice', voice)
        }
        return args
      }

      let ttsRes: RunResult = { code: 1, stdout: '', stderr: '' }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        let attemptVoice: string | undefined
        if (attempt === 3 && engine === 'edge') {
          attemptVoice = 'en-US-GuyNeural'
          const fallbackLines = parsedLines.map((line) => ({
            ...line,
            voice: attemptVoice,
          }))
          fs.writeFileSync(linesPath, JSON.stringify(fallbackLines, null, 2), 'utf8')
        }

        ttsRes = await this.runCommand(
          this.pythonBin,
          buildTtsArgs(attemptVoice),
          this.lemoRoot,
          180_000,
        )
        if (ttsRes.code === 0) break
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
      if (ttsRes.code !== 0) {
        throw new Error(
          `TTS failed (exit ${ttsRes.code}): ${ttsRes.stderr.trim() || ttsRes.stdout.trim()}`,
        )
      }
    }

    const durPath = path.join(voicesDir, 'dur.json')
    const durations = fs.existsSync(durPath)
      ? (JSON.parse(fs.readFileSync(durPath, 'utf8')) as Record<string, number>)
      : {}

    let asrReport = 'skipped'
    if (options.runAsrCheck !== false) {
      const asrScript = path.join(this.lemoRoot, 'core', 'tts', 'asr_check.py')
      const asrRes = await this.runCommand(
        this.pythonBin,
        [asrScript, linesPath, voicesDir, '--lang', options.lang ?? 'auto'],
        this.lemoRoot,
        240_000,
      )
      asrReport = `${asrRes.stdout}\n${asrRes.stderr}`.trim()
    }

    const wordsPath = path.join(voicesDir, 'words.json')
    const words = fs.existsSync(wordsPath)
      ? (JSON.parse(fs.readFileSync(wordsPath, 'utf8')) as Record<
          string,
          [string, number, number][]
        >)
      : null

    return { projectId: safeId, engine, durations, words, asrReport }
  }

  async renderAudioMix(
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<{
    projectId: string
    audioPath: string
    flowSummary: MusicFlowSummary
    flowPngBase64: string
    logs: string
  }> {
    const safeId = sanitizeProjectId(projectId)
    const projDir = this.requireProjectDir(safeId)
    const force = options.force === true
    const logs: string[] = []

    const eventsJson = path.join(projDir, 'events.json')
    const eventInputs = [
      path.join(projDir, 'index.html'),
      path.join(projDir, 'main.js'),
      path.join(projDir, 'timeline.js'),
      path.join(projDir, 'art.js'),
      path.join(projDir, 'lines.json'),
      path.join(projDir, 'words.json'),
      path.join(projDir, 'voices', 'dur.json'),
      path.join(projDir, 'voices', 'words.json'),
    ]

    // Export window.EV -> events.json if index.html exists and events.json is stale
    if (fs.existsSync(path.join(projDir, 'index.html'))) {
      if (!force && this.isOutputFresh(eventsJson, eventInputs)) {
        logs.push('[cached] events.json is up to date')
      } else {
        const evRes = await this.runCommand(
          'node',
          ['core/render/events.mjs', `films/${safeId}`],
          this.lemoRoot,
          300_000,
        )
        logs.push(evRes.stdout.trim(), evRes.stderr.trim())
        if (evRes.code !== 0) {
          throw new Error(`events.mjs failed: ${evRes.stderr || evRes.stdout}`)
        }
      }
    }

    // Run music/score.py if present and music/score.wav is stale
    const scoreScript = path.join(projDir, 'music', 'score.py')
    const scoreWav = path.join(projDir, 'music', 'score.wav')
    if (fs.existsSync(scoreScript)) {
      const scoreInputs = this.listDirFiles(path.join(projDir, 'music'), [
        '.py',
      ])
      if (!force && this.isOutputFresh(scoreWav, scoreInputs)) {
        logs.push('[cached] music/score.wav is up to date')
      } else {
        const scRes = await this.runCommand(
          this.pythonBin,
          [scoreScript],
          this.lemoRoot,
          420_000,
        )
        logs.push(scRes.stdout.trim(), scRes.stderr.trim())
        if (scRes.code !== 0) {
          throw new Error(`score.py failed: ${scRes.stderr || scRes.stdout}`)
        }
      }
    }

    // Run mix.py if present and existing mix.wav is stale
    const mixScript = path.join(projDir, 'mix.py')
    if (fs.existsSync(mixScript)) {
      const existingMix = [
        path.join(projDir, 'mix.wav'),
        path.join(projDir, 'out', 'mix.wav'),
      ].find((p) => fs.existsSync(p))
      const mixInputs = [
        mixScript,
        eventsJson,
        scoreWav,
        path.join(projDir, 'lines.json'),
        path.join(this.lemoRoot, 'core', 'audio', 'sfx.py'),
        ...this.listDirFiles(path.join(projDir, 'voices'), ['.wav']),
      ]
      if (!force && existingMix && this.isOutputFresh(existingMix, mixInputs)) {
        logs.push(`[cached] ${path.relative(projDir, existingMix)} is up to date`)
      } else {
        const mixRes = await this.runCommand(
          this.pythonBin,
          [mixScript],
          this.lemoRoot,
          420_000,
        )
        logs.push(mixRes.stdout.trim(), mixRes.stderr.trim())
        if (mixRes.code !== 0) {
          throw new Error(`mix.py failed: ${mixRes.stderr || mixRes.stdout}`)
        }
      }
    }

    const audioCandidate = this.findProjectAudioPath(projDir)
    if (!audioCandidate) {
      throw new Error(
        `No mix.wav or score.wav found in films/${safeId}/. Add music/score.py or mix.py first.`,
      )
    }

    const outDir = path.join(projDir, 'out')
    this.ensureDir(outDir)
    const flowJsonPath = path.join(outDir, 'music_flow.json')
    const flowPngPath = path.join(outDir, 'music_flow.png')
    let summary: MusicFlowSummary
    let pngPath: string

    if (
      !force &&
      this.isOutputFresh(flowJsonPath, [audioCandidate]) &&
      this.isOutputFresh(flowPngPath, [audioCandidate])
    ) {
      summary = JSON.parse(fs.readFileSync(flowJsonPath, 'utf8')) as MusicFlowSummary
      pngPath = flowPngPath
      logs.push('[cached] out/music_flow.{json,png} is up to date')
    } else {
      const analyzed = await this.analyzeAudioFile(
        audioCandidate,
        outDir,
        'music_flow',
      )
      summary = analyzed.summary
      pngPath = analyzed.pngPath
    }
    summary.flowImageUrl = `/api/studio/projects/${encodeURIComponent(safeId)}/files/out/music_flow.png`

    return {
      projectId: safeId,
      audioPath: path.relative(projDir, audioCandidate),
      flowSummary: summary,
      flowPngBase64: fs.readFileSync(pngPath).toString('base64'),
      logs: logs.filter(Boolean).join('\n'),
    }
  }

  async previewProjectFrames(
    projectId: string,
    options: { times?: number[]; range?: string; width?: number; height?: number } = {},
  ): Promise<{
    projectId: string
    stillPaths: string[]
    stillImages: Array<{ name: string; base64: string }>
    contactSheetBase64: string | null
    readcheckReport: string
    eventsCount: number | null
    durSec: number | null
  }> {
    const safeId = sanitizeProjectId(projectId)
    const projDir = this.requireProjectDir(safeId)
    if (!fs.existsSync(path.join(projDir, 'index.html'))) {
      throw new Error(`Project "${safeId}" has no index.html yet.`)
    }

    const outDir = path.join(projDir, 'out')
    const stillDir = path.join(outDir, 'stills')
    fs.rmSync(stillDir, { recursive: true, force: true })
    this.ensureDir(stillDir)

    const sizeArg =
      options.width && options.height
        ? `${options.width}x${options.height}`
        : '1280x720'

    // Run events.mjs only if events.json is missing or stale
    const eventsJsonPath = path.join(projDir, 'events.json')
    const eventInputs = [
      path.join(projDir, 'index.html'),
      path.join(projDir, 'main.js'),
      path.join(projDir, 'timeline.js'),
      path.join(projDir, 'art.js'),
    ]
    if (!this.isOutputFresh(eventsJsonPath, eventInputs)) {
      const evRes = await this.runCommand(
        'node',
        ['core/render/events.mjs', `films/${safeId}`, '--size', sizeArg],
        this.lemoRoot,
        300_000,
      )
      if (evRes.code !== 0) {
        throw new Error(`events.mjs failed: ${evRes.stderr || evRes.stdout}`)
      }
    }
    let durSec: number | null = null
    let eventsCount: number | null = null
    if (fs.existsSync(eventsJsonPath)) {
      const evData = JSON.parse(fs.readFileSync(eventsJsonPath, 'utf8')) as {
        dur?: number
        ev?: unknown[]
      }
      durSec = typeof evData.dur === 'number' ? evData.dur : null
      eventsCount = Array.isArray(evData.ev) ? evData.ev.length : null
    }

    const stillArgs = ['core/render/still.mjs', `films/${safeId}`]
    if (options.times && options.times.length > 0) {
      for (const t of options.times) {
        stillArgs.push(String(t))
      }
    } else if (options.range) {
      stillArgs.push('--range', options.range)
    } else {
      const dur = durSec && durSec > 0 ? durSec : 15
      const step = Math.max(0.5, Number((dur / 7.0).toFixed(2)))
      stillArgs.push('--range', `0:${Math.max(0.5, dur - 0.1).toFixed(2)}:${step}`)
    }
    stillArgs.push('--out', stillDir, '--size', sizeArg)

    const stillRes = await this.runCommand('node', stillArgs, this.lemoRoot, 300_000)
    if (stillRes.code !== 0) {
      throw new Error(`still.mjs failed: ${stillRes.stderr || stillRes.stdout}`)
    }

    const stillFiles = fs
      .readdirSync(stillDir)
      .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
      .sort()
    const stillPaths = stillFiles.map((f) => path.join(stillDir, f))

    // Build contact sheet
    let contactSheetBase64: string | null = null
    const sheetPath = path.join(outDir, 'contact_sheet.jpg')
    if (stillPaths.length > 0) {
      const sheetRes = await this.runCommand(
        this.pythonBin,
        ['core/render/sheet.py', sheetPath, ...stillPaths, '--cols', '4', '--w', '480'],
        this.lemoRoot,
        120_000,
      )
      if (sheetRes.code === 0 && fs.existsSync(sheetPath)) {
        contactSheetBase64 = fs.readFileSync(sheetPath).toString('base64')
      }
    }

    // Readability check (if window.TEXTS exists)
    const rcRes = await this.runCommand(
      'node',
      ['core/render/readcheck.mjs', `films/${safeId}`, '--step', '0.2', '--size', sizeArg],
      this.lemoRoot,
      300_000,
    )
    const readcheckReport = `${rcRes.stdout}\n${rcRes.stderr}`.trim()

    // Pick up to 4 individual frames in addition to the contact sheet
    const sampled: Array<{ name: string; base64: string }> = []
    if (stillFiles.length <= 4) {
      for (const f of stillFiles) {
        sampled.push({
          name: f,
          base64: fs.readFileSync(path.join(stillDir, f)).toString('base64'),
        })
      }
    } else {
      for (let i = 0; i < 4; i += 1) {
        const idx = Math.round((i * (stillFiles.length - 1)) / 3)
        const f = stillFiles[idx]
        sampled.push({
          name: f,
          base64: fs.readFileSync(path.join(stillDir, f)).toString('base64'),
        })
      }
    }

    return {
      projectId: safeId,
      stillPaths: stillFiles.map((f) => `out/stills/${f}`),
      stillImages: sampled,
      contactSheetBase64,
      readcheckReport,
      eventsCount,
      durSec,
    }
  }

  async renderAdToFramer(
    projectId: string,
    options: {
      fps?: number
      workers?: number
      grain?: number
      width?: number
      height?: number
      skipAudioRebuild?: boolean
      force?: boolean
    } = {},
  ): Promise<{
    project: StudioProjectSummary
    logs: string
  }> {
    const safeId = sanitizeProjectId(projectId)
    const existing = this.activeRenders.get(safeId)
    if (existing) {
      return existing
    }

    const promise = this.runRenderAdToFramer(safeId, options).finally(() => {
      if (this.activeRenders.get(safeId) === promise) {
        this.activeRenders.delete(safeId)
      }
    })
    this.activeRenders.set(safeId, promise)
    return promise
  }

  private async runRenderAdToFramer(
    safeId: string,
    options: {
      fps?: number
      workers?: number
      grain?: number
      width?: number
      height?: number
      skipAudioRebuild?: boolean
      force?: boolean
    },
  ): Promise<{
    project: StudioProjectSummary
    logs: string
  }> {
    const projDir = this.requireProjectDir(safeId)
    const fps = Math.max(12, Math.min(60, Math.round(options.fps ?? 24)))
    const workers = Math.max(1, Math.min(4, Math.round(options.workers ?? 2)))
    const grain = Math.max(0, Math.min(10, options.grain ?? 0))
    const width = options.width ?? 1920
    const height = options.height ?? 1080
    const sizeArg = `${width}x${height}`
    const force = options.force === true
    const logs: string[] = []

    const finalVideoPath = path.join(projDir, `${safeId}.mp4`)
    const zipPath = path.join(projDir, `${safeId}_frames_${fps}fps.zip`)
    const sourceInputs = [
      path.join(projDir, 'index.html'),
      path.join(projDir, 'main.js'),
      path.join(projDir, 'timeline.js'),
      path.join(projDir, 'art.js'),
      path.join(projDir, 'mix.py'),
      path.join(projDir, 'music', 'score.py'),
      path.join(projDir, 'lines.json'),
    ]
    if (
      !force &&
      this.isOutputFresh(finalVideoPath, sourceInputs) &&
      this.isOutputFresh(zipPath, sourceInputs)
    ) {
      return {
        project: this.getProjectSummary(safeId),
        logs: '[cached] video and frames zip are already up to date',
      }
    }

    const outDir = path.join(projDir, 'out')
    this.ensureDir(outDir)

    // 1. Reuse cached audio mix (and events/score/music_flow) unless force/skipAudioRebuild
    if (!options.skipAudioRebuild) {
      const audioRes = await this.renderAudioMix(safeId, { force })
      if (audioRes.logs) logs.push(audioRes.logs)
    } else if (fs.existsSync(path.join(projDir, 'index.html'))) {
      const eventsJson = path.join(projDir, 'events.json')
      if (!this.isOutputFresh(eventsJson, sourceInputs.slice(0, 4))) {
        const evRes = await this.runCommand(
          'node',
          ['core/render/events.mjs', `films/${safeId}`, '--size', sizeArg],
          this.lemoRoot,
          300_000,
        )
        logs.push(evRes.stdout.trim(), evRes.stderr.trim())
        if (evRes.code !== 0) {
          throw new Error(`events.mjs failed: ${evRes.stderr || evRes.stdout}`)
        }
      }
    }
    const audioPath = this.findProjectAudioPath(projDir)

    // 2. Render silent video via headless Chrome frames -> video.mp4
    const rawVideoOut = path.join(outDir, 'video_raw.mp4')
    const vidRes = await this.runCommand(
      'node',
      [
        'core/render/video.mjs',
        `films/${safeId}`,
        '--fps',
        String(fps),
        '--workers',
        String(workers),
        '--size',
        sizeArg,
        '--out',
        rawVideoOut,
      ],
      this.lemoRoot,
      600_000,
    )
    logs.push(vidRes.stdout.trim(), vidRes.stderr.trim())
    if (vidRes.code !== 0 || !fs.existsSync(rawVideoOut)) {
      throw new Error(`video.mjs failed: ${vidRes.stderr || vidRes.stdout}`)
    }

    // 3. Mux with -14 LUFS loudness normalization if audio exists, else copy as mp4
    if (audioPath) {
      // Pre-limit hot peaks gently so loudnorm hits -14 LUFS cleanly
      const limPath = path.join(outDir, 'mix_lim.wav')
      const preRes = await this.runCommand(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-i',
          audioPath,
          '-af',
          'aresample=192000,alimiter=limit=0.6:attack=1:release=60:level=false,aresample=48000',
          '-c:a',
          'pcm_s24le',
          limPath,
        ],
        this.lemoRoot,
        120_000,
      )
      const audioForMux = preRes.code === 0 && fs.existsSync(limPath) ? limPath : audioPath
      const muxRes = await this.runCommand(
        'sh',
        ['core/render/mux.sh', rawVideoOut, audioForMux, finalVideoPath, String(fps), String(grain)],
        this.lemoRoot,
        300_000,
      )
      logs.push(muxRes.stdout.trim(), muxRes.stderr.trim())
      if (muxRes.code !== 0 || !fs.existsSync(finalVideoPath)) {
        throw new Error(`mux.sh failed: ${muxRes.stderr || muxRes.stdout}`)
      }
    } else {
      fs.copyFileSync(rawVideoOut, finalVideoPath)
    }

    // 5. Extract frames into out/frames/ and package <project>_frames_<fps>fps.zip for Framer
    const framesDir = path.join(outDir, 'frames')
    fs.rmSync(framesDir, { recursive: true, force: true })
    this.ensureDir(framesDir)
    const extRes = await this.runCommand(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-i',
        finalVideoPath,
        '-q:v',
        '2',
        path.join(framesDir, 'frame_%05d.jpg'),
      ],
      this.lemoRoot,
      180_000,
    )
    if (extRes.code === 0) {
      const frameNames = fs
        .readdirSync(framesDir)
        .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
        .sort()
      const zipEntries: Record<string, Uint8Array> = {}
      for (const name of frameNames) {
        zipEntries[name] = new Uint8Array(fs.readFileSync(path.join(framesDir, name)))
      }
      const zipped = zipSync(zipEntries, { level: 0 })
      fs.writeFileSync(zipPath, zipped)
    }

    // 6. Generate contact sheet if stills aren't present yet
    const stillDir = path.join(outDir, 'stills')
    if (!fs.existsSync(path.join(outDir, 'contact_sheet.jpg'))) {
      await this.previewProjectFrames(safeId, { width: 1280, height: 720 }).catch(() => null)
    } else if (fs.existsSync(stillDir)) {
      const stillPaths = fs
        .readdirSync(stillDir)
        .filter((f) => f.endsWith('.jpg'))
        .sort()
        .map((f) => path.join(stillDir, f))
      if (stillPaths.length > 0) {
        await this.runCommand(
          this.pythonBin,
          ['core/render/sheet.py', path.join(outDir, 'contact_sheet.jpg'), ...stillPaths],
          this.lemoRoot,
          60_000,
        ).catch(() => null)
      }
    }

    const project = this.getProjectSummary(safeId)
    return { project, logs: logs.filter(Boolean).join('\n') }
  }

  private listDirFiles(dirPath: string, exts: string[]): string[] {
    if (!fs.existsSync(dirPath)) return []
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          exts.includes(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => path.join(dirPath, entry.name))
  }

  private isOutputFresh(outputPath: string, inputPaths: string[]): boolean {
    if (!fs.existsSync(outputPath)) return false
    const outMtime = fs.statSync(outputPath).mtimeMs
    return inputPaths.every(
      (inputPath) =>
        !fs.existsSync(inputPath) || fs.statSync(inputPath).mtimeMs <= outMtime,
    )
  }

  private findProjectAudioPath(projDir: string): string | null {
    const candidates = [
      path.join(projDir, 'mix.wav'),
      path.join(projDir, 'out', 'mix.wav'),
      path.join(projDir, 'out', 'mix_lim.wav'),
      path.join(projDir, 'music', 'score.wav'),
    ]
    return candidates.find((p) => fs.existsSync(p)) ?? null
  }

  listProjects(): StudioProjectSummary[] {
    if (!fs.existsSync(this.filmsDir)) return []
    const dirs = fs
      .readdirSync(this.filmsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    return dirs.map((id) => this.getProjectSummary(id))
  }

  getProjectSummary(projectId: string): StudioProjectSummary {
    const safeId = sanitizeProjectId(projectId)
    const projDir = this.requireProjectDir(safeId)
    const baseUrl = `/api/studio/projects/${encodeURIComponent(safeId)}/files`

    const mp4Files = fs
      .readdirSync(projDir)
      .filter((f) => f.endsWith('.mp4'))
      .sort()
    const preferredMp4 = mp4Files.includes(`${safeId}.mp4`)
      ? `${safeId}.mp4`
      : mp4Files[0] ?? null

    const zipFiles = fs
      .readdirSync(projDir)
      .filter((f) => f.endsWith('.zip'))
      .sort()
    const preferredZip = zipFiles[0] ?? null

    const srtFiles = fs
      .readdirSync(projDir)
      .filter((f) => f.endsWith('.srt'))
      .sort()
    const preferredSrt = srtFiles[0] ?? null

    const audioPath = this.findProjectAudioPath(projDir)
    const audioRel = audioPath ? path.relative(projDir, audioPath).replace(/\\/g, '/') : null

    const flowJsonPath = path.join(projDir, 'out', 'music_flow.json')
    const flowPngPath = path.join(projDir, 'out', 'music_flow.png')
    const sheetPath = path.join(projDir, 'out', 'contact_sheet.jpg')
    const stillDir = path.join(projDir, 'out', 'stills')
    const wordsPath = path.join(projDir, 'voices', 'words.json')
    const treatmentPath = path.join(projDir, 'TREATMENT.md')
    const scoreJsonPath = path.join(projDir, 'music', 'score.json')
    const eventsJsonPath = path.join(projDir, 'events.json')

    let flowSummary: MusicFlowSummary | null = null
    if (fs.existsSync(flowJsonPath)) {
      try {
        flowSummary = JSON.parse(fs.readFileSync(flowJsonPath, 'utf8')) as MusicFlowSummary
        if (fs.existsSync(flowPngPath)) {
          flowSummary.flowImageUrl = `${baseUrl}/out/music_flow.png`
        }
      } catch {
        flowSummary = null
      }
    }

    let durationSec = flowSummary?.durationSec ?? null
    let bpm = flowSummary?.bpm ?? null
    if (durationSec === null && fs.existsSync(eventsJsonPath)) {
      try {
        const ev = JSON.parse(fs.readFileSync(eventsJsonPath, 'utf8')) as { dur?: number }
        if (typeof ev.dur === 'number') durationSec = ev.dur
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(scoreJsonPath)) {
      try {
        const sc = JSON.parse(fs.readFileSync(scoreJsonPath, 'utf8')) as {
          dur?: number
          bpm?: number
        }
        if (durationSec === null && typeof sc.dur === 'number') durationSec = sc.dur
        if (bpm === null && typeof sc.bpm === 'number') bpm = sc.bpm
      } catch {
        // ignore
      }
    }

    const stillUrls = fs.existsSync(stillDir)
      ? fs
          .readdirSync(stillDir)
          .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
          .sort()
          .map((f) => `${baseUrl}/out/stills/${encodeURIComponent(f)}`)
      : []

    let voiceWords: Record<string, [string, number, number][]> | null = null
    if (fs.existsSync(wordsPath)) {
      try {
        voiceWords = JSON.parse(fs.readFileSync(wordsPath, 'utf8')) as Record<
          string,
          [string, number, number][]
        >
      } catch {
        voiceWords = null
      }
    }

    let treatmentExcerpt: string | null = null
    let title = safeId
    if (fs.existsSync(treatmentPath)) {
      const text = fs.readFileSync(treatmentPath, 'utf8')
      const heading = text.split('\n').find((l) => l.startsWith('# '))
      if (heading) title = heading.replace(/^#\s+/, '').trim()
      treatmentExcerpt = text.slice(0, 600)
    }

    const topFiles = fs
      .readdirSync(projDir)
      .filter((f) => !f.startsWith('.'))
      .sort()

    const stat = fs.statSync(projDir)

    return {
      id: safeId,
      title,
      durationSec,
      bpm,
      hasVideo: Boolean(preferredMp4),
      hasAudioMix: Boolean(audioRel),
      hasScore: fs.existsSync(path.join(projDir, 'music', 'score.py')),
      hasVoiceover: fs.existsSync(path.join(projDir, 'voices', 'dur.json')) || Boolean(voiceWords),
      hasFramesZip: Boolean(preferredZip),
      hasSrt: Boolean(preferredSrt),
      hasFlowMap: fs.existsSync(flowPngPath),
      hasContactSheet: fs.existsSync(sheetPath),
      videoUrl: preferredMp4 ? `${baseUrl}/${encodeURIComponent(preferredMp4)}` : null,
      audioMixUrl: audioRel ? `${baseUrl}/${audioRel}` : null,
      framesZipUrl: preferredZip ? `${baseUrl}/${encodeURIComponent(preferredZip)}` : null,
      srtUrl: preferredSrt ? `${baseUrl}/${encodeURIComponent(preferredSrt)}` : null,
      flowPngUrl: fs.existsSync(flowPngPath) ? `${baseUrl}/out/music_flow.png` : null,
      contactSheetUrl: fs.existsSync(sheetPath) ? `${baseUrl}/out/contact_sheet.jpg` : null,
      stillUrls,
      flowSummary,
      voiceWords,
      treatmentExcerpt,
      files: topFiles,
      updatedAt: stat.mtime.toISOString(),
    }
  }

  resolveProjectFilePath(projectId: string, relPath: string): string {
    const projDir = this.requireProjectDir(projectId)
    return safeResolveInside(projDir, relPath)
  }

  resolveUploadFlowPngPath(fileId: string): string {
    const cleanId = path.basename(fileId)
    return safeResolveInside(this.uploadsDir, `${cleanId}_flow/music_flow.png`)
  }

  resolveStagedFilePath(relPath: string): string {
    return safeResolveInside(this.stagedDir, relPath)
  }

  private detectTunnelProvider(): string | null {
    const pathEntries = [
      this.ffmpegBinDir,
      ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    ]
    for (const bin of ['cloudflared', 'ngrok']) {
      for (const dir of pathEntries) {
        const candidate = path.join(dir, bin)
        if (fs.existsSync(candidate)) return bin
      }
    }
    return null
  }

  getTunnelStatus(): TunnelStatus {
    return {
      active: Boolean(this.tunnelProc && !this.tunnelProc.killed && this.tunnelPublicUrl),
      publicUrl: this.tunnelPublicUrl,
      provider: this.tunnelProvider,
      availableProvider: this.detectTunnelProvider(),
      error: this.tunnelError,
    }
  }

  async startTunnel(port: number): Promise<TunnelStatus> {
    if (this.tunnelProc && !this.tunnelProc.killed && this.tunnelPublicUrl) {
      return this.getTunnelStatus()
    }
    const provider = this.detectTunnelProvider()
    if (!provider) {
      this.tunnelError =
        'Neither cloudflared nor ngrok is installed on PATH. Run `cloudflared tunnel --url http://localhost:' +
        port +
        '` or paste any public HTTPS tunnel URL below.'
      return this.getTunnelStatus()
    }

    this.tunnelError = null
    this.tunnelPublicUrl = null
    this.tunnelProvider = provider

    if (provider === 'cloudflared') {
      const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
        env: this.getExecEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.tunnelProc = proc
      const url = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 25_000)
        const onData = (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
          if (match) {
            clearTimeout(timeout)
            resolve(match[0])
          }
        }
        proc.stdout.on('data', onData)
        proc.stderr.on('data', onData)
        proc.on('close', () => {
          clearTimeout(timeout)
          this.tunnelProc = null
          this.tunnelPublicUrl = null
          resolve(null)
        })
      })
      this.tunnelPublicUrl = url
      if (!url) {
        this.tunnelError = 'cloudflared started but did not emit a trycloudflare.com URL within 15s.'
      }
    }
    return this.getTunnelStatus()
  }

  stopTunnel(): TunnelStatus {
    if (this.tunnelProc && !this.tunnelProc.killed) {
      this.tunnelProc.kill('SIGTERM')
    }
    this.tunnelProc = null
    this.tunnelPublicUrl = null
    this.tunnelProvider = null
    this.tunnelError = null
    return this.getTunnelStatus()
  }
}

