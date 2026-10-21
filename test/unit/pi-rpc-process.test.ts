import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess, type PiRpcEvent } from '../../src/pi-rpc/process.js'

const TEXT = 'cookies.\u2028Read our policy\u2029end'

// Answers every command; for get_messages it first emits an event, then writes the
// response in two pieces split inside the 3-byte U+2028, so it reaches us as two chunks.
const FAKE_PI = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.3.0'); process.exit(0) }
const TEXT = ${JSON.stringify(TEXT)}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async chunk => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const cmd = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    if (cmd.type !== 'get_messages') {
      process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: {} }) + '\\n')
      continue
    }
    process.stdout.write(JSON.stringify({ type: 'message_update', text: TEXT }) + '\\n')
    const bytes = Buffer.from(JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: { text: TEXT } }) + '\\n')
    const cut = bytes.indexOf(Buffer.from('\\u2028')) + 1
    process.stdout.write(bytes.subarray(0, cut))
    await new Promise(r => setTimeout(r, 50))
    process.stdout.write(bytes.subarray(cut))
  }
})
`

function writeFakePi(dir: string, source: string): string {
  const path = join(dir, 'fake-pi.mjs')
  writeFileSync(path, source)
  chmodSync(path, 0o755)
  return path
}

test(
  'PiRpcProcess: keeps records containing U+2028/U+2029 whole instead of splitting them like readline',
  { timeout: 5_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-framing-'))
    const fakePi = writeFakePi(dir, FAKE_PI)

    const proc = await PiRpcProcess.spawn({ cwd: dir, piCommand: fakePi })
    try {
      const events: PiRpcEvent[] = []
      proc.onEvent(ev => events.push(ev))

      const data = await proc.getMessages()

      assert.deepEqual(data, { text: TEXT })
      assert.deepEqual(events, [{ type: 'message_update', text: TEXT }])
    } finally {
      proc.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('PiRpcProcess: refuses a pi older than 0.80.4 instead of starting sessions whose turns never finish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-old-pi-'))
  const fakePi = writeFakePi(dir, `#!/usr/bin/env node\nconsole.log('0.79.9')\n`)
  try {
    await assert.rejects(
      () => PiRpcProcess.spawn({ cwd: dir, piCommand: fakePi }),
      (e: Error) =>
        e.name === 'PiRpcSpawnError' && e.message.includes('pi v0.79.9 is too old') && e.message.includes('0.80.4')
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'PiRpcProcess: keeps events sent before anyone listens, and hands them over once',
  { timeout: 5_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-early-'))
    const proc = await PiRpcProcess.spawn({ cwd: dir, piCommand: writeFakePi(dir, FAKE_PI) })
    try {
      await proc.getMessages()
      const events: PiRpcEvent[] = []
      proc.onEvent(ev => events.push(ev))
      await proc.getMessages()

      assert.deepEqual(proc.takeEarlyEvents(), [{ type: 'message_update', text: TEXT }])
      assert.deepEqual(proc.takeEarlyEvents(), [])
      assert.deepEqual(events, [{ type: 'message_update', text: TEXT }])
    } finally {
      proc.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
