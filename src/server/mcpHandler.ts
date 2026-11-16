import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import {
  StudioService,
  type VoiceoverLineInput,
} from './studioService.ts'

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const SERVER_INFO = {
  name: 'framer-lemo-opuscar-mcp',
  version: '1.0.0',
}

const SERVER_INSTRUCTIONS = [
  'You are connected to Framer + Lemo-Opuscar Motion Ad Studio.',
  'Use these tools to create motion-design video ads (with synced music, sound effects, voiceovers, and captions) and deliver them directly into the Framer web app for the user to preview and download.',
  'Workflow for music-synced ads:',
  '1) If the user uploaded video/frames or music in Framer, call framer_get_staged_media or lemo_analyze_music_flow to SEE the Music Flow Spectrogram PNG + BPM, beats, downbeats, cues, silences, and timelineJs.',
  '2) Pick a visual style with lemo_list_styles and read its STYLE.md + DIRECTOR.md / TECHNIQUE.md / INSTRUMENTS.md / sfx.py with lemo_read_guide.',
  '3) Create an ad project in lemo-opuscar/films/<project_id>/ using lemo_save_ad_project. Every page must expose window.DUR, window.READY = true, window.render(t) (deterministic), optional window.EV = [{t, type, ...}], and window.TEXTS(t). Use absolute library URLs like /core/lib.js.',
  '4) Generate voiceovers with lemo_generate_voiceover (supports realistic ElevenLabs voices via engine="elevenlabs" or ingesting audio_url/audio_base64 from Claude Web’s ElevenLabs Connector, plus Edge TTS or Kokoro; returns dur.json and Whisper word timestamps words.json), write music/score.py + mix.py, and verify the mix with lemo_render_audio_mix (returns mix spectrogram PNG + flow JSON).',
  '5) Render and visually inspect keyframes + contact sheet with lemo_preview_ad_frames.',
  '6) Render the finished -14 LUFS video (.mp4) and frames archive (.zip) directly into Framer with lemo_render_ad_to_framer.',
].join('\n')

export const MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'lemo_list_styles',
    description:
      'List all 99 Lemo-Opuscar motion design styles, available guide files, and existing ad projects in films/. Optional keyword query filters styles.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional keyword filter (e.g. "crt", "swiss", "kinetic", "3d", "blueprint").',
        },
      },
    },
  },
  {
    name: 'lemo_read_guide',
    description:
      'Read a Lemo-Opuscar style guide (STYLE.md by slug, e.g. "ascii-crt" or "dark-tech-keynote") or production guide ("DIRECTOR.md", "TECHNIQUE.md", "core/README.md", "core/lib.js", "INSTRUMENTS.md", "sfx.py", "pluck.py"), or a project file under films/<id>/....',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Style slug (e.g. "ascii-crt"), guide name ("DIRECTOR.md", "TECHNIQUE.md", "INSTRUMENTS.md", "sfx.py"), or relative path ("films/wirebreak/timeline.js").',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'framer_get_staged_media',
    description:
      'Inspect media currently staged by the user in the Framer UI (extracted video frames as images + audio/music flow JSON and spectrogram PNG). Use this whenever the user clicked "Send to Claude MCP" in Framer.',
    inputSchema: {
      type: 'object',
      properties: {
        max_frames: {
          type: 'number',
          description: 'Maximum evenly-spaced sample frames to return as images (1-16, default 8).',
        },
      },
    },
  },
  {
    name: 'lemo_analyze_music_flow',
    description:
      'Convert an audio or video file (or an existing project track) into a visual Music Flow Spectrogram PNG + structured Beat/Cue/Energy/Silence JSON and ready-to-use timeline.js so you can see the music flow and sync motion design ads to every beat and drop.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Analyze audio from films/<project_id>/ (mix.wav or music/score.wav).',
        },
        file_path: {
          type: 'string',
          description: 'Optional absolute path or path relative to lemo-opuscar/ of an audio/video file.',
        },
      },
    },
  },
  {
    name: 'lemo_save_ad_project',
    description:
      'Create or update files in a motion design ad project under lemo-opuscar/films/<project_id>/ (e.g. index.html, main.js, timeline.js, lines.json, music/score.py, mix.py, TREATMENT.md, CREDITS).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Short lowercase project slug (e.g. "nova-launch-ad").',
        },
        files: {
          type: 'object',
          description: 'Map of relative file paths within the project folder to UTF-8 text contents.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['project_id', 'files'],
    },
  },
  {
    name: 'lemo_read_project_file',
    description: 'Read a text file inside an existing ad project under lemo-opuscar/films/<project_id>/.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        path: { type: 'string', description: 'Relative path inside the project, e.g. "main.js" or "timeline.js".' },
      },
      required: ['project_id', 'path'],
    },
  },
  {
    name: 'lemo_generate_voiceover',
    description:
      'Prepare/synthesize voiceover WAV files (24 kHz mono) for lines.json and optionally run faster-whisper ASR check for word-level timestamps (voices/words.json & voices/dur.json). Supports realistic ElevenLabs voices EITHER by passing audio_url / audio_base64 generated by Claude Web’s ElevenLabs Connector onto each line, OR by setting engine="elevenlabs" with default_voice (e.g. "Adam", "Rachel", "Josh", "Brian", or a voice_id) + elevenlabs_api_key (saved locally for reuse). Falls back to Edge Neural TTS ("edge") or offline Kokoro ("kokoro").',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        lines: {
          type: 'array',
          description: 'Optional lines array to write to lines.json before synthesis/ingestion.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              t: { type: 'number' },
              voice: {
                type: 'string',
                description: 'ElevenLabs voice name/ID (e.g. "Adam", "Rachel", "Brian", "George") or Edge voice (e.g. "en-US-GuyNeural").',
              },
              rate: { type: 'string', description: 'e.g. "+0%", "+8%", "-5%" (Edge TTS).' },
              pitch: { type: 'string', description: 'e.g. "+0Hz" (Edge TTS).' },
              text: { type: 'string' },
              say: { type: 'string' },
              asr: { type: 'string' },
              audio_url: {
                type: 'string',
                description: 'HTTP/HTTPS URL to an external audio clip (e.g. returned by an ElevenLabs MCP connector) to ingest for this line.',
              },
              audio_base64: {
                type: 'string',
                description: 'Base64-encoded audio (or data:audio/...;base64,...) generated externally (e.g. from ElevenLabs) to ingest for this line.',
              },
              stability: {
                type: 'number',
                description: 'ElevenLabs voice stability (0-1, default 0.5).',
              },
              similarity_boost: {
                type: 'number',
                description: 'ElevenLabs voice similarity_boost (0-1, default 0.75).',
              },
            },
            required: ['id', 'text'],
          },
        },
        engine: {
          type: 'string',
          enum: ['elevenlabs', 'edge', 'kokoro'],
          description: 'Voice engine: "elevenlabs" (realistic neural voice via API or audio_url/audio_base64 ingestion), "edge" (Microsoft Edge Neural TTS), or "kokoro" (offline).',
        },
        default_voice: { type: 'string' },
        elevenlabs_api_key: {
          type: 'string',
          description: 'Optional ElevenLabs API key; persisted locally in .framer-workspace/elevenlabs_key.txt for reuse.',
        },
        model_id: {
          type: 'string',
          description: 'Optional ElevenLabs model ID (default "eleven_multilingual_v2").',
        },
        run_asr_check: { type: 'boolean' },
        lang: { type: 'string', description: 'ASR language code ("en", "zh", "auto").' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'lemo_render_audio_mix',
    description:
      'Export window.EV -> events.json, run music/score.py and mix.py to build mix.wav (music + procedural SFX + voiceover), and return the resulting Music Flow JSON + visual spectrogram PNG so you can verify audio pacing. Skips up-to-date cached steps unless force=true.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        force: {
          type: 'boolean',
          description: 'Set true to re-synthesize score.wav, events.json, and mix.wav even if files appear up to date.',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'lemo_preview_ad_frames',
    description:
      'Render preview stills + a contact sheet JPEG for visual inspection and run readcheck.mjs on on-screen text timings. Returns the contact sheet and keyframe images directly so you can inspect visual quality before full rendering.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        times: {
          type: 'array',
          items: { type: 'number' },
          description: 'Specific timestamps in seconds to render (e.g. [0.5, 3.0, 8.0, 14.5]).',
        },
        range: {
          type: 'string',
          description: 'Range a:b:step in seconds (e.g. "0:15:2.5").',
        },
        width: { type: 'number', description: 'Preview width (even, default 1280).' },
        height: { type: 'number', description: 'Preview height (even, default 720).' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'lemo_render_ad_to_framer',
    description:
      'Render the full motion design ad (24/30/60 fps frames via headless Chrome + -14 LUFS loudnorm audio mastering + frames .zip bundle) and publish it directly into the Framer web app for immediate preview and download.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        fps: { type: 'number', description: 'Target frame rate (default 24; 24, 30, or 60).' },
        width: { type: 'number', description: 'Output width (even, default 1920).' },
        height: { type: 'number', description: 'Output height (even, default 1080; use 1080x1920 for vertical reels).' },
        grain: { type: 'number', description: 'Film grain strength (0 for clean vector/UI, 2 for film look).' },
        workers: { type: 'number', description: 'Parallel Chrome render workers (1-4, default 3).' },
      },
      required: ['project_id'],
    },
  },
]

export class McpServerHandler {
  private readonly studio: StudioService
  private readonly sseSessions = new Map<string, http.ServerResponse>()

  constructor(studio: StudioService) {
    this.studio = studio
  }

  async handleJsonRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = req.id === undefined
    const id = req.id ?? null

    try {
      switch (req.method) {
        case 'initialize': {
          const clientVer =
            typeof req.params?.protocolVersion === 'string'
              ? req.params.protocolVersion
              : '2025-03-26'
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: clientVer,
              capabilities: {
                tools: { listChanged: false },
                prompts: { listChanged: false },
                resources: { listChanged: false },
              },
              serverInfo: SERVER_INFO,
              instructions: SERVER_INSTRUCTIONS,
            },
          }
        }

        case 'notifications/initialized':
        case 'notifications/cancelled':
          if (isNotification) return null
          return { jsonrpc: '2.0', id, result: {} }

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} }

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: MCP_TOOLS },
          }

        case 'tools/call': {
          const name = typeof req.params?.name === 'string' ? req.params.name : ''
          const args =
            req.params?.arguments && typeof req.params.arguments === 'object'
              ? (req.params.arguments as Record<string, unknown>)
              : {}
          const toolResult = await this.executeTool(name, args)
          return { jsonrpc: '2.0', id, result: toolResult }
        }

        case 'prompts/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              prompts: [
                {
                  name: 'create-music-synced-video-ad',
                  description:
                    'Design and render a complete motion-design video ad synced to music flow, voiceover, and sound effects, then push it to Framer.',
                  arguments: [
                    { name: 'topic', description: 'Product, brand, or ad message', required: true },
                    { name: 'style', description: 'Preferred visual style (optional)', required: false },
                  ],
                },
              ],
            },
          }

        case 'prompts/get': {
          const args =
            req.params?.arguments && typeof req.params.arguments === 'object'
              ? (req.params.arguments as Record<string, string>)
              : {}
          return {
            jsonrpc: '2.0',
            id,
            result: {
              description: 'Motion design ad production prompt',
              messages: [
                {
                  role: 'user',
                  content: {
                    type: 'text',
                    text: `Create a motion-design video ad about: ${args.topic || 'the staged media'}${args.style ? ` in style "${args.style}"` : ''}. First check framer_get_staged_media or lemo_list_styles, analyze any music flow with lemo_analyze_music_flow so you can see the beat map spectrogram, write TREATMENT.md + timeline.js + index.html/main.js + lines.json + score.py + mix.py with lemo_save_ad_project, synthesize voiceover, render audio mix, inspect frames with lemo_preview_ad_frames, and publish the final ad to Framer with lemo_render_ad_to_framer.`,
                  },
                },
              ],
            },
          }
        }

        case 'resources/list':
          return { jsonrpc: '2.0', id, result: { resources: [] } }

        case 'resources/templates/list':
          return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }

        default:
          if (isNotification) return null
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          }
      }
    } catch (error) {
      if (isNotification) return null
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: McpContentBlock[]; isError?: boolean }> {
    try {
      switch (name) {
        case 'lemo_list_styles': {
          const query = typeof args.query === 'string' ? args.query : undefined
          const data = this.studio.listStyles(query)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data, null, 2),
              },
            ],
          }
        }

        case 'lemo_read_guide': {
          const target = String(args.target ?? '')
          const guide = this.studio.readGuide(target)
          return {
            content: [
              {
                type: 'text',
                text: `# ${guide.path}${guide.truncated ? ' (truncated)' : ''}\n\n${guide.content}`,
              },
            ],
          }
        }

        case 'framer_get_staged_media': {
          const maxFrames = typeof args.max_frames === 'number' ? args.max_frames : 8
          const staged = this.studio.getStagedMedia(maxFrames)
          if (!staged.manifest) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No media is currently staged from the Framer UI. Ask the user to drop a video or audio track in Framer and click "Send to Claude MCP", or use lemo_list_styles + lemo_save_ad_project to create an original ad from scratch.',
                },
              ],
            }
          }

          const content: McpContentBlock[] = [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  manifest: staged.manifest,
                  flowSummary: staged.flowSummary,
                },
                null,
                2,
              ),
            },
          ]

          if (staged.flowPngBase64) {
            content.push({
              type: 'image',
              data: staged.flowPngBase64,
              mimeType: 'image/png',
            })
          }

          for (const frame of staged.sampleFrames) {
            content.push({
              type: 'image',
              data: frame.base64,
              mimeType: frame.mimeType,
            })
          }
          return { content }
        }

        case 'lemo_analyze_music_flow': {
          const projectId =
            typeof args.project_id === 'string' ? args.project_id : undefined
          const filePath =
            typeof args.file_path === 'string' ? args.file_path : undefined

          if (projectId) {
            const proj = this.studio.getProjectSummary(projectId)
            const outDir = path.join(this.studio.filmsDir, proj.id, 'out')
            const audioRel =
              proj.files.includes('mix.wav')
                ? 'mix.wav'
                : this.studio.resolveProjectFilePath(proj.id, 'music/score.wav')
            const absAudio = path.isAbsolute(audioRel)
              ? audioRel
              : this.studio.resolveProjectFilePath(proj.id, audioRel)
            const analyzed = await this.studio.analyzeAudioFile(
              absAudio,
              outDir,
              'music_flow',
            )
            const pngB64 = fs.readFileSync(analyzed.pngPath).toString('base64')
            return {
              content: [
                { type: 'text', text: JSON.stringify(analyzed.summary, null, 2) },
                { type: 'image', data: pngB64, mimeType: 'image/png' },
              ],
            }
          }

          if (!filePath) {
            throw new Error('Provide either project_id or file_path.')
          }
          const resolved = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(this.studio.lemoRoot, filePath)
          const analyzed = await this.studio.analyzeAudioFile(resolved)
          const pngB64 = fs.readFileSync(analyzed.pngPath).toString('base64')
          return {
            content: [
              { type: 'text', text: JSON.stringify(analyzed.summary, null, 2) },
              { type: 'image', data: pngB64, mimeType: 'image/png' },
            ],
          }
        }

        case 'lemo_save_ad_project': {
          const projectId = String(args.project_id ?? '')
          const filesRaw = args.files
          if (!filesRaw || typeof filesRaw !== 'object') {
            throw new Error('files must be a map of relative path -> string content.')
          }
          const files: Record<string, string> = {}
          for (const [k, v] of Object.entries(filesRaw as Record<string, unknown>)) {
            files[k] = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
          }
          const res = this.studio.saveProjectFiles(projectId, files)
          return {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          }
        }

        case 'lemo_read_project_file': {
          const projectId = String(args.project_id ?? '')
          const relPath = String(args.path ?? '')
          const text = this.studio.readProjectFile(projectId, relPath)
          return {
            content: [{ type: 'text', text }],
          }
        }

        case 'lemo_generate_voiceover': {
          const projectId = String(args.project_id ?? '')
          const lines = Array.isArray(args.lines)
            ? (args.lines as VoiceoverLineInput[])
            : undefined
          const engine =
            args.engine === 'elevenlabs' ||
            args.engine === 'kokoro' ||
            args.engine === 'edge'
              ? args.engine
              : undefined
          const defaultVoice =
            typeof args.default_voice === 'string' ? args.default_voice : undefined
          const elevenlabsApiKey =
            typeof args.elevenlabs_api_key === 'string'
              ? args.elevenlabs_api_key
              : undefined
          const modelId =
            typeof args.model_id === 'string' ? args.model_id : undefined
          const runAsrCheck =
            typeof args.run_asr_check === 'boolean' ? args.run_asr_check : true
          const lang = typeof args.lang === 'string' ? args.lang : 'auto'

          const res = await this.studio.generateVoiceover(projectId, {
            lines,
            engine,
            defaultVoice,
            elevenlabsApiKey,
            modelId,
            runAsrCheck,
            lang,
          })
          return {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          }
        }

        case 'lemo_render_audio_mix': {
          const projectId = String(args.project_id ?? '')
          const force = args.force === true
          const res = await this.studio.renderAudioMix(projectId, { force })
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    projectId: res.projectId,
                    audioPath: res.audioPath,
                    flowSummary: res.flowSummary,
                    logs: res.logs,
                  },
                  null,
                  2,
                ),
              },
              {
                type: 'image',
                data: res.flowPngBase64,
                mimeType: 'image/png',
              },
            ],
          }
        }

        case 'lemo_preview_ad_frames': {
          const projectId = String(args.project_id ?? '')
          const times = Array.isArray(args.times)
            ? args.times.filter((n): n is number => typeof n === 'number')
            : undefined
          const range = typeof args.range === 'string' ? args.range : undefined
          const width = typeof args.width === 'number' ? args.width : 1280
          const height = typeof args.height === 'number' ? args.height : 720

          const preview = await this.studio.previewProjectFrames(projectId, {
            times,
            range,
            width,
            height,
          })

          const content: McpContentBlock[] = [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  projectId: preview.projectId,
                  durSec: preview.durSec,
                  eventsCount: preview.eventsCount,
                  stillPaths: preview.stillPaths,
                  readcheckReport: preview.readcheckReport,
                },
                null,
                2,
              ),
            },
          ]

          if (preview.contactSheetBase64) {
            content.push({
              type: 'image',
              data: preview.contactSheetBase64,
              mimeType: 'image/jpeg',
            })
          }
          for (const st of preview.stillImages) {
            content.push({
              type: 'image',
              data: st.base64,
              mimeType: 'image/jpeg',
            })
          }
          return { content }
        }

        case 'lemo_render_ad_to_framer': {
          const projectId = String(args.project_id ?? '')
          const fps = typeof args.fps === 'number' ? args.fps : 24
          const width = typeof args.width === 'number' ? args.width : 1920
          const height = typeof args.height === 'number' ? args.height : 1080
          const grain = typeof args.grain === 'number' ? args.grain : 0
          const workers = typeof args.workers === 'number' ? args.workers : 2

          const res = await this.studio.renderAdToFramer(projectId, {
            fps,
            width,
            height,
            grain,
            workers,
          })

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'published_to_framer',
                    message:
                      `Rendered and published "${res.project.id}" to Framer! Tell the user they can now preview and download the video (.mp4), audio mix (.wav), frames (.zip), and subtitles (.srt) inside Framer's "Claude MCP & Ad Studio" tab.`,
                    project: res.project,
                    logs: res.logs,
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        }

        default:
          return {
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          }
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }
  }

  async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    urlPath: string,
    query: URLSearchParams,
    rawBody: Buffer,
  ): Promise<boolean> {
    if (urlPath !== '/mcp' && urlPath !== '/sse' && urlPath !== '/messages') {
      return false
    }

    this.applyCors(req, res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return true
    }

    // Legacy SSE endpoint for MCP clients using GET /sse + POST /messages
    if (urlPath === '/sse' && req.method === 'GET') {
      const sessionId = crypto.randomUUID()
      const sse = this.openSseStream(
        req,
        res,
        `event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`,
      )

      this.sseSessions.set(sessionId, res)
      req.on('close', () => {
        sse.stop()
        this.sseSessions.delete(sessionId)
      })
      return true
    }

    if (urlPath === '/messages' && req.method === 'POST') {
      const sessionId = query.get('sessionId') ?? ''
      const sseRes = this.sseSessions.get(sessionId)
      let payload: JsonRpcRequest
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as JsonRpcRequest
      } catch {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Invalid JSON body' }))
        return true
      }

      if (sseRes && !sseRes.writableEnded) {
        res.statusCode = 202
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ accepted: true }))
        void this.handleJsonRpc(payload).then((rpcResp) => {
          if (rpcResp && !sseRes.writableEnded) {
            sseRes.write(`event: message\ndata: ${JSON.stringify(rpcResp)}\n\n`)
          }
        })
        return true
      }

      const rpcResp = await this.handleJsonRpc(payload)
      res.statusCode = 202
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(rpcResp ?? { accepted: true }))
      return true
    }

    // Streamable HTTP Transport (/mcp)
    if (urlPath === '/mcp') {
      if (req.method === 'DELETE') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ closed: true }))
        return true
      }

      if (req.method === 'GET') {
        const accept = String(req.headers.accept ?? '')
        if (accept.includes('text/event-stream')) {
          const sse = this.openSseStream(req, res, ': streamable-http-connected\n\n')
          req.on('close', () => sse.stop())
          return true
        }

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify(
            {
              name: SERVER_INFO.name,
              version: SERVER_INFO.version,
              status: 'ready',
              transports: ['streamable-http (/mcp)', 'sse (/sse)'],
              tools: MCP_TOOLS.map((t) => t.name),
            },
            null,
            2,
          ),
        )
        return true
      }

      if (req.method === 'POST') {
        let parsed: JsonRpcRequest | JsonRpcRequest[]
        try {
          parsed = JSON.parse(rawBody.toString('utf8')) as
            | JsonRpcRequest
            | JsonRpcRequest[]
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            }),
          )
          return true
        }

        const sessionId =
          typeof req.headers['mcp-session-id'] === 'string'
            ? req.headers['mcp-session-id']
            : crypto.randomUUID()
        res.setHeader('Mcp-Session-Id', sessionId)
        res.setHeader('MCP-Protocol-Version', '2025-03-26')

        const accept = String(req.headers.accept ?? '')
        const hasToolCall = Array.isArray(parsed)
          ? parsed.some((item) => item.method === 'tools/call')
          : parsed.method === 'tools/call'
        const useSseStream = hasToolCall && accept.includes('text/event-stream')

        const sse = useSseStream
          ? this.openSseStream(req, res, ': processing\n\n')
          : null
        if (sse) {
          req.on('close', () => sse.stop())
        }

        let responsePayload: JsonRpcResponse | JsonRpcResponse[] | null = null
        try {
          if (Array.isArray(parsed)) {
            const responses = (
              await Promise.all(parsed.map((item) => this.handleJsonRpc(item)))
            ).filter((r): r is JsonRpcResponse => r !== null)
            responsePayload = responses.length > 0 ? responses : null
          } else {
            responsePayload = await this.handleJsonRpc(parsed)
          }
        } finally {
          sse?.stop()
        }

        if (sse) {
          if (!res.writableEnded) {
            if (responsePayload !== null) {
              res.write(`event: message\ndata: ${JSON.stringify(responsePayload)}\n\n`)
            }
            res.end()
          }
          return true
        }

        if (responsePayload === null) {
          res.statusCode = 202
          res.end()
          return true
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(responsePayload))
        return true
      }
    }

    return false
  }

  private openSseStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    initialFrame: string,
  ): { stop: () => void } {
    req.socket?.setTimeout(0)
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    res.write(initialFrame)

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n')
      }
    }, 10_000)

    return {
      stop: () => clearInterval(keepAlive),
    }
  }

  private applyCors(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '*'
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-ID, MCP-Protocol-Version',
    )
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Mcp-Session-Id, MCP-Protocol-Version',
    )
  }
}
