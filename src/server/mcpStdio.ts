import readline from 'node:readline'
import { type JsonRpcRequest, McpServerHandler } from './mcpHandler.ts'
import { StudioService } from './studioService.ts'

const rootDir = process.env.FRAMER_ROOT || process.cwd()
const studio = new StudioService(rootDir)
const mcp = new McpServerHandler(studio)

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  void (async () => {
    try {
      const req = JSON.parse(trimmed) as JsonRpcRequest
      const resp = await mcp.handleJsonRpc(req)
      if (resp) {
        process.stdout.write(`${JSON.stringify(resp)}\n`)
      }
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: error instanceof Error ? error.message : String(error),
          },
        })}\n`,
      )
    }
  })()
})

