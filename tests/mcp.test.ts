import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_TOOLS, McpServerHandler } from '../src/server/mcpHandler.ts'
import {
  safeResolveInside,
  sanitizeProjectId,
  StudioService,
} from '../src/server/studioService.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

describe('StudioService path safety', () => {
  it('sanitizes project ids and blocks traversal', () => {
    expect(sanitizeProjectId('My Ad 2026!')).toBe('my-ad-2026')
    expect(() => sanitizeProjectId('...')).toThrow()
    expect(() =>
      safeResolveInside('/tmp/base', '../../etc/passwd'),
    ).toThrow(/Unsafe path/)
    expect(safeResolveInside('/tmp/base', 'music/score.py')).toBe(
      '/tmp/base/music/score.py',
    )
  })
})

describe('McpServerHandler & Music Flow', () => {
  const studio = new StudioService(REPO_ROOT)
  const mcp = new McpServerHandler(studio)

  it('handles MCP initialize, tools/list, prompts/list, and resources/list', async () => {
    const init = await mcp.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    expect(init?.error).toBeUndefined()
    const initResult = init?.result as { serverInfo: { name: string } } | undefined
    expect(initResult?.serverInfo.name).toBe('framer-lemo-opuscar-mcp')

    const toolsList = await mcp.handleJsonRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    const toolsResult = toolsList?.result as { tools: typeof MCP_TOOLS } | undefined
    const tools = toolsResult?.tools ?? []
    expect(tools.map((t) => t.name)).toContain('lemo_analyze_music_flow')
    expect(tools.map((t) => t.name)).toContain('lemo_render_ad_to_framer')
    expect(tools.map((t) => t.name)).toContain('framer_get_staged_media')

    const promptsList = await mcp.handleJsonRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/list',
    })
    const promptsResult = promptsList?.result as { prompts: unknown[] } | undefined
    expect(promptsResult?.prompts.length ?? 0).toBeGreaterThan(0)
  })

  it('lists Lemo-Opuscar styles and reads STYLE.md / DIRECTOR.md guides', async () => {
    const listResp = await mcp.handleJsonRpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'lemo_list_styles', arguments: { query: 'crt' } },
    })
    const listResult = listResp?.result as
      | { content: Array<{ type: string; text: string }> }
      | undefined
    const listText = listResult?.content[0]?.text ?? '{}'
    const parsed = JSON.parse(listText) as {
      styles: Array<{ slug: string }>
      projects: string[]
    }
    expect(parsed.styles.some((s) => s.slug === 'ascii-crt')).toBe(true)
    expect(parsed.projects).toContain('wirebreak')

    const guideResp = await mcp.handleJsonRpc({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'lemo_read_guide', arguments: { target: 'ascii-crt' } },
    })
    const guideResult = guideResp?.result as
      | { content: Array<{ type: string; text: string }> }
      | undefined
    const guideText = guideResult?.content[0]?.text ?? ''
    expect(guideText).toContain('styles/ascii-crt/STYLE.md')
  }, 15000)

  it('analyzes music flow into structured BPM/sections JSON + visual spectrogram PNG', async () => {
    const flowResp = await mcp.handleJsonRpc({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'lemo_analyze_music_flow',
        arguments: { project_id: 'wirebreak' },
      },
    })
    const flowResult = flowResp?.result as
      | {
          isError?: boolean
          content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
        }
      | undefined
    const content = flowResult?.content ?? []
    expect(flowResult?.isError).toBeUndefined()
    expect(content).toHaveLength(2)
    expect(content[0].type).toBe('text')
    expect(content[1].type).toBe('image')
    expect(content[1].mimeType).toBe('image/png')

    const flowJson = JSON.parse(content[0].text ?? '{}') as {
      bpm: number
      durationSec: number
      sections: unknown[]
      cues: Array<{ t: number; label: string }>
      timelineJs: string
    }
    expect(flowJson.bpm).toBe(120)
    expect(flowJson.durationSec).toBeCloseTo(42.0, 1)
    expect(flowJson.sections.length).toBeGreaterThanOrEqual(4)
    expect(flowJson.cues.length).toBeGreaterThanOrEqual(4)
    expect(flowJson.timelineJs).toContain('export const BPM = 120')

    const pngBytes = Buffer.from(content[1].data ?? '', 'base64')
    // PNG magic header check
    expect(pngBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  }, 60000)

  it('stages frames into isolated workspace and reads them back via framer_get_staged_media', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'framer-mcp-test-'))
    try {
      const tmpStudio = new StudioService(tmpRoot)
      const tmpMcp = new McpServerHandler(tmpStudio)

      const fakePngBase64 = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]).toString('base64')
      const stageResult = await tmpStudio.stageMediaFromFramer({
        sourceName: 'sample.mp4',
        fps: 24,
        width: 1280,
        height: 720,
        frames: [{ name: 'frame_00001.png', base64: fakePngBase64 }],
      })
      expect(stageResult.frameCount).toBe(1)

      const mcpResp = await tmpMcp.handleJsonRpc({
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'framer_get_staged_media', arguments: { max_frames: 4 } },
      })
      const mcpResult = mcpResp?.result as
        | { content: Array<{ type: string; text?: string; mimeType?: string }> }
        | undefined
      const content = mcpResult?.content ?? []
      expect(content.some((b) => b.type === 'image' && b.mimeType === 'image/png')).toBe(
        true,
      )
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('ingests ElevenLabs connector audio_base64 into 24 kHz mono WAV and dur.json', async () => {
    const testProjId = `test-elevenlabs-vo-${Date.now()}`
    const projDir = path.join(REPO_ROOT, 'lemo-opuscar', 'films', testProjId)

    // Build a valid 0.35s 440Hz 16-bit PCM WAV buffer (8 kHz -> converted to 24 kHz by tts_elevenlabs.py)
    const sampleRate = 8000
    const numSamples = Math.round(sampleRate * 0.35)
    const wavBuf = Buffer.alloc(44 + numSamples * 2)
    wavBuf.write('RIFF', 0)
    wavBuf.writeUInt32LE(36 + numSamples * 2, 4)
    wavBuf.write('WAVEfmt ', 8)
    wavBuf.writeUInt32LE(16, 16)
    wavBuf.writeUInt16LE(1, 20)
    wavBuf.writeUInt16LE(1, 22)
    wavBuf.writeUInt32LE(sampleRate, 24)
    wavBuf.writeUInt32LE(sampleRate * 2, 28)
    wavBuf.writeUInt16LE(2, 32)
    wavBuf.writeUInt16LE(16, 34)
    wavBuf.write('data', 36)
    wavBuf.writeUInt32LE(numSamples * 2, 40)
    for (let i = 0; i < numSamples; i += 1) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000)
      wavBuf.writeInt16LE(sample, 44 + i * 2)
    }

    try {
      const resp = await mcp.handleJsonRpc({
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: {
          name: 'lemo_generate_voiceover',
          arguments: {
            project_id: testProjId,
            run_asr_check: false,
            lines: [
              {
                id: 'v1',
                t: 0.4,
                text: 'Dusk. Lights out on time.',
                audio_base64: wavBuf.toString('base64'),
              },
            ],
          },
        },
      })
      const toolRes = resp?.result as
        | { isError?: boolean; content: Array<{ type: string; text?: string }> }
        | undefined
      expect(toolRes?.isError).toBeUndefined()
      const parsed = JSON.parse(toolRes?.content[0]?.text ?? '{}') as {
        engine: string
        durations: Record<string, number>
      }
      expect(parsed.engine).toBe('elevenlabs')
      expect(parsed.durations.v1).toBeGreaterThan(0.2)

      const outWav = path.join(projDir, 'voices', 'v1.wav')
      const outDur = path.join(projDir, 'voices', 'dur.json')
      expect(fs.existsSync(outWav)).toBe(true)
      expect(fs.existsSync(outDur)).toBe(true)
      const header = fs.readFileSync(outWav)
      expect(header.readUInt32LE(24)).toBe(24000)
      expect(header.readUInt16LE(22)).toBe(1)
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true })
    }
  }, 30000)
})
