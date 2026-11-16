import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import type { Plugin, ViteDevServer } from 'vite'
import { defineConfig } from 'vite'
import { createFramerMiddleware } from './src/server/studioRouter.ts'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const ffmpegCoreDir = path.resolve(
  rootDir,
  'node_modules/@ffmpeg/core/dist/esm',
)

const FFMPEG_ASSETS = [
  {
    fileName: 'ffmpeg-core.js',
    contentType: 'application/javascript; charset=utf-8',
  },
  {
    fileName: 'ffmpeg-core.wasm',
    contentType: 'application/wasm',
  },
] as const

function attachFFmpegMiddleware(
  middlewares: ViteDevServer['middlewares'],
  baseUrl: string,
) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`

  middlewares.use((req, res, next) => {
    const reqPath = (req.url ?? '').split('?')[0]
    for (const asset of FFMPEG_ASSETS) {
      const expectedPath = `${normalizedBase}ffmpeg/${asset.fileName}`
      if (reqPath === expectedPath || reqPath === `/ffmpeg/${asset.fileName}`) {
        const filePath = path.join(ffmpegCoreDir, asset.fileName)
        if (!fs.existsSync(filePath)) {
          next()
          return
        }
        res.setHeader('Content-Type', asset.contentType)
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        fs.createReadStream(filePath).pipe(res)
        return
      }
    }
    next()
  })
}

/**
 * Serves @ffmpeg/core ESM assets locally during dev/preview and copies them
 * into dist/ffmpeg during production builds so no external CDN is required.
 */
function ffmpegCoreAssetsPlugin(): Plugin {
  let resolvedBase = '/'

  return {
    name: 'ffmpeg-core-local-assets',
    configResolved(config) {
      resolvedBase = config.base
    },
    configureServer(server) {
      attachFFmpegMiddleware(server.middlewares, resolvedBase)
    },
    configurePreviewServer(server) {
      attachFFmpegMiddleware(server.middlewares, resolvedBase)
    },
    generateBundle() {
      for (const asset of FFMPEG_ASSETS) {
        const filePath = path.join(ffmpegCoreDir, asset.fileName)
        this.emitFile({
          type: 'asset',
          fileName: `ffmpeg/${asset.fileName}`,
          source: fs.readFileSync(filePath),
        })
      }
    },
  }
}

function framerMcpAndStudioPlugin(): Plugin {
  const { middleware } = createFramerMiddleware(rootDir)

  return {
    name: 'framer-mcp-and-studio',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void middleware(req, res, next)
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void middleware(req, res, next)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ffmpegCoreAssetsPlugin(), framerMcpAndStudioPlugin()],
  server: {
    host: true,
    allowedHosts: true,
    cors: true,
  },
  preview: {
    host: true,
    allowedHosts: true,
    cors: true,
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
})
