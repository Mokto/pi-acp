import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SparePi } from '../../src/pi-rpc/spare.js'

// Appends one line per start to $SPAWN_LOG, answers every command.
const FAKE_PI = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.3.0'); process.exit(0) }
require('node:fs').appendFileSync(process.env.SPAWN_LOG, process.cwd() + '\\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const cmd = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: {} }) + '\\n')
  }
})
`

async function withFakePi(fn: (ctx: { dir: string; piCommand: string; cwd: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-spare-'))
  const piCommand = join(dir, 'fake-pi.cjs')
  writeFileSync(piCommand, FAKE_PI)
  chmodSync(piCommand, 0o755)
  const cwd = join(dir, 'project')
  mkdirSync(cwd)
  const env = { ...process.env }
  delete process.env.PI_ACP_PREWARM
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent')
  process.env.SPAWN_LOG = join(dir, 'spawns.log')
  writeFileSync(process.env.SPAWN_LOG, '')
  try {
    await fn({ dir, piCommand, cwd })
  } finally {
    process.env = env
    rmSync(dir, { recursive: true, force: true })
  }
}

test('SparePi: hands its warm pi to the next session in the same cwd, once', { timeout: 10_000 }, async () => {
  await withFakePi(async ({ piCommand, cwd }) => {
    const spare = new SparePi()
    try {
      spare.warm(cwd, piCommand)
      spare.warm(cwd, piCommand)
      const proc = await spare.take(cwd, piCommand)
      assert.ok(proc && !proc.exited)
      assert.equal(readFileSync(process.env.SPAWN_LOG!, 'utf8').trim().split('\n').length, 1)
      assert.equal(spare.take(cwd, piCommand), null)
      proc.dispose()
    } finally {
      spare.dispose()
    }
  })
})

test('SparePi: refuses a spare for another cwd or after a startup file changed', { timeout: 10_000 }, async () => {
  await withFakePi(async ({ dir, piCommand, cwd }) => {
    const spare = new SparePi()
    try {
      spare.warm(cwd, piCommand)
      assert.equal(spare.take(dir, piCommand), null)

      spare.warm(cwd, piCommand)
      writeFileSync(join(cwd, 'AGENTS.md'), 'new rules')
      assert.equal(spare.take(cwd, piCommand), null)
    } finally {
      spare.dispose()
    }
  })
})

test('SparePi: keeps its spare when pi rewrites settings.json with the same content', { timeout: 10_000 }, async () => {
  await withFakePi(async ({ dir, piCommand, cwd }) => {
    const settings = join(dir, 'agent', 'settings.json')
    mkdirSync(join(dir, 'agent'))
    writeFileSync(settings, '{"defaultModel":"a"}')
    const spare = new SparePi()
    try {
      spare.warm(cwd, piCommand)
      await new Promise(r => setTimeout(r, 20))
      writeFileSync(settings, '{"defaultModel":"a"}')
      const proc = await spare.take(cwd, piCommand)
      assert.ok(proc)
      proc.dispose()
    } finally {
      spare.dispose()
    }
  })
})

test('SparePi: PI_ACP_PREWARM=0 starts nothing', async () => {
  await withFakePi(async ({ piCommand, cwd }) => {
    process.env.PI_ACP_PREWARM = '0'
    const spare = new SparePi()
    spare.warm(cwd, piCommand)
    assert.equal(spare.take(cwd, piCommand), null)
  })
})
