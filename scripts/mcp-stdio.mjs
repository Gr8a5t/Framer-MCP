#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')
const entry = path.join(rootDir, 'src', 'server', 'mcpStdio.ts')

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', entry],
  {
    cwd: rootDir,
    env: { ...process.env, FRAMER_ROOT: rootDir },
    stdio: 'inherit',
  },
)

child.on('exit', (code) => {
  process.exit(code ?? 0)
})

