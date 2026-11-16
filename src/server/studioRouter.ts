import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { McpServerHandler } from './mcpHandler.ts'
import { type StagedMediaPayload, StudioService } from './studioService.ts'

const MAX_BODY_BYTES = 160 * 1024 * 1024

function getMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.wav':
      return 'audio/wav'
    case '.mp3':
      return 'audio/mpeg'
    case '.ogg':
      return 'audio/ogg'
    case '.m4a':
      return 'audio/mp4'
    case '.zip':
      return 'application/zip'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.srt':
      return 'text/plain; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function serveFileWithRange(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  download: boolean,
) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: 'File not found' })
    return
  }

  const stat = fs.statSync(filePath)
  const totalSize = stat.size
  const mime = getMimeType(filePath)
  res.setHeader('Content-Type', mime)
  res.setHeader('Accept-Ranges', 'bytes')
  if (download) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${path.basename(filePath)}"`,
    )
  }

  const rangeHeader = req.headers.range
  if (rangeHeader && typeof rangeHeader === 'string') {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim())
    if (match) {
      const start = Number.parseInt(match[1], 10)
      const end = match[2]
        ? Math.min(totalSize - 1, Number.parseInt(match[2], 10))
        : totalSize - 1
      if (start <= end && start < totalSize) {
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`)
        res.setHeader('Content-Length', String(end - start + 1))
        fs.createReadStream(filePath, { start, end }).pipe(res)
        return
      }
    }
  }

  res.statusCode = 200
  res.setHeader('Content-Length', String(totalSize))
  fs.createReadStream(filePath).pipe(res)
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body exceeds 160 MB limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createFramerMiddleware(rootDir: string = process.cwd()) {
  const studio = new StudioService(rootDir)
  const mcp = new McpServerHandler(studio)

  const middleware = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: () => void,
  ) => {
    const rawUrl = req.url ?? '/'
    const parsedUrl = new URL(rawUrl, 'http://localhost')
    const urlPath = parsedUrl.pathname
    const query = parsedUrl.searchParams

    const isMcpPath =
      urlPath === '/mcp' || urlPath === '/sse' || urlPath === '/messages'
    const isApiPath = urlPath.startsWith('/api/studio')

    if (!isMcpPath && !isApiPath) {
      next()
      return
    }

    try {
      const shouldReadBody =
        req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
      const body = shouldReadBody ? await readRequestBody(req) : Buffer.alloc(0)

      if (isMcpPath) {
        const handled = await mcp.handleHttpRequest(req, res, urlPath, query, body)
        if (!handled) next()
        return
      }

      // Studio REST API CORS
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }

      if (urlPath === '/api/studio/styles' && req.method === 'GET') {
        sendJson(res, 200, studio.listStyles(query.get('q') ?? undefined))
        return
      }

      if (urlPath === '/api/studio/projects' && req.method === 'GET') {
        sendJson(res, 200, { projects: studio.listProjects() })
        return
      }

      if (urlPath === '/api/studio/tunnel' && req.method === 'GET') {
        sendJson(res, 200, studio.getTunnelStatus())
        return
      }

      if (urlPath === '/api/studio/tunnel/start' && req.method === 'POST') {
        const hostHeader = req.headers.host ?? 'localhost:5173'
        const portMatch = /:(\d+)$/.exec(hostHeader)
        const port = portMatch ? Number.parseInt(portMatch[1], 10) : 5173
        const status = await studio.startTunnel(port)
        sendJson(res, 200, status)
        return
      }

      if (urlPath === '/api/studio/tunnel/stop' && req.method === 'POST') {
        sendJson(res, 200, studio.stopTunnel())
        return
      }

      if (urlPath === '/api/studio/staged' && req.method === 'GET') {
        sendJson(res, 200, studio.getStagedMedia(8))
        return
      }

      if (urlPath === '/api/studio/staged/flow.png' && req.method === 'GET') {
        serveFileWithRange(
          req,
          res,
          studio.resolveStagedFilePath('staged_flow.png'),
          false,
        )
        return
      }

      if (urlPath === '/api/studio/stage' && req.method === 'POST') {
        const payload = JSON.parse(body.toString('utf8')) as StagedMediaPayload
        const staged = await studio.stageMediaFromFramer(payload)
        sendJson(res, 200, staged)
        return
      }

      if (urlPath === '/api/studio/analyze-audio' && req.method === 'POST') {
        const fileName = query.get('filename') || 'track.wav'
        let bytes: Uint8Array
        let resolvedName = fileName
        const contentType = String(req.headers['content-type'] ?? '')
        if (contentType.includes('application/json')) {
          const parsed = JSON.parse(body.toString('utf8')) as {
            fileName?: string
            base64?: string
          }
          resolvedName = parsed.fileName || fileName
          bytes = new Uint8Array(Buffer.from(parsed.base64 ?? '', 'base64'))
        } else {
          bytes = new Uint8Array(body)
        }
        const result = await studio.analyzeAudioBuffer(resolvedName, bytes)
        sendJson(res, 200, result)
        return
      }

      const uploadFlowMatch = /^\/api\/studio\/uploads\/([^/]+)\/flow\.png$/.exec(
        urlPath,
      )
      if (uploadFlowMatch && req.method === 'GET') {
        const fileId = decodeURIComponent(uploadFlowMatch[1])
        serveFileWithRange(
          req,
          res,
          studio.resolveUploadFlowPngPath(fileId),
          false,
        )
        return
      }

      const projectFilesMatch = /^\/api\/studio\/projects\/([^/]+)\/files\/(.+)$/.exec(
        urlPath,
      )
      if (projectFilesMatch && req.method === 'GET') {
        const projectId = decodeURIComponent(projectFilesMatch[1])
        const relPath = decodeURIComponent(projectFilesMatch[2])
        const absPath = studio.resolveProjectFilePath(projectId, relPath)
        const isDownload = query.get('download') === '1'
        serveFileWithRange(req, res, absPath, isDownload)
        return
      }

      const projectActionMatch = /^\/api\/studio\/projects\/([^/]+)\/(preview|render-audio|render-video)$/.exec(
        urlPath,
      )
      if (projectActionMatch && req.method === 'POST') {
        const projectId = decodeURIComponent(projectActionMatch[1])
        const action = projectActionMatch[2]
        const opts =
          body.length > 0
            ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>)
            : {}

        if (action === 'preview') {
          const preview = await studio.previewProjectFrames(projectId, {
            width: typeof opts.width === 'number' ? opts.width : 1280,
            height: typeof opts.height === 'number' ? opts.height : 720,
          })
          sendJson(res, 200, {
            project: studio.getProjectSummary(projectId),
            durSec: preview.durSec,
            eventsCount: preview.eventsCount,
            readcheckReport: preview.readcheckReport,
          })
          return
        }

        if (action === 'render-audio') {
          const audioRes = await studio.renderAudioMix(projectId, {
            force: opts.force === true,
          })
          sendJson(res, 200, {
            project: studio.getProjectSummary(projectId),
            flowSummary: audioRes.flowSummary,
            logs: audioRes.logs,
          })
          return
        }

        if (action === 'render-video') {
          const renderRes = await studio.renderAdToFramer(projectId, {
            fps: typeof opts.fps === 'number' ? opts.fps : 24,
            width: typeof opts.width === 'number' ? opts.width : 1920,
            height: typeof opts.height === 'number' ? opts.height : 1080,
            grain: typeof opts.grain === 'number' ? opts.grain : 0,
            workers: typeof opts.workers === 'number' ? opts.workers : 3,
          })
          sendJson(res, 200, renderRes)
          return
        }
      }

      const singleProjectMatch = /^\/api\/studio\/projects\/([^/]+)$/.exec(urlPath)
      if (singleProjectMatch && req.method === 'GET') {
        const projectId = decodeURIComponent(singleProjectMatch[1])
        sendJson(res, 200, { project: studio.getProjectSummary(projectId) })
        return
      }

      sendJson(res, 404, { error: `Unknown studio endpoint: ${urlPath}` })
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { studio, mcp, middleware }
}

