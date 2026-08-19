import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnection, type Socket } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { LiveServer } from '../../src/acp/live.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(id = 's1') {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: id,
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { session, conn, proc }
}

function finishTurn(proc: FakePiRpcProcess) {
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
}

class NdjsonClient {
  readonly messages: unknown[] = []
  private buf = ''
  private readonly pending = new Set<() => void>()

  constructor(readonly socket: Socket) {
    socket.on('data', chunk => {
      this.buf += chunk.toString('utf8')
      let nl = this.buf.indexOf('\n')
      while (nl >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (line) this.messages.push(JSON.parse(line))
        for (const wake of [...this.pending]) wake()
        nl = this.buf.indexOf('\n')
      }
    })
  }

  send(msg: unknown) {
    this.socket.write(JSON.stringify(msg) + '\n')
  }

  async waitFor(pred: (m: unknown) => boolean, ms = 2000): Promise<unknown> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const hit = this.messages.find(pred)
      if (hit) return hit
      await new Promise<void>(resolve => {
        const wake = () => {
          this.pending.delete(wake)
          resolve()
        }
        this.pending.add(wake)
        setTimeout(wake, 20)
      })
    }
    throw new Error(`timeout waiting for socket message; got ${JSON.stringify(this.messages)}`)
  }
}

async function connect(path: string): Promise<NdjsonClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(path)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
  return new NdjsonClient(socket)
}

test('LiveServer: attach fans out session/update to socket and Zed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-live-'))
  const live = new LiveServer({ liveDir: dir, pid: process.pid })
  const { session, conn, proc } = makeSession()
  live.upsert(session, '/tmp/s.jsonl')
  await live.start()
  const client = await connect(live.socketPath)

  try {
    client.send({ id: 1, type: 'attach', sessionId: 's1' })
    await client.waitFor(m => (m as any).id === 1 && (m as any).ok === true)

    proc.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
    })
    await new Promise(r => setTimeout(r, 0))

    assert.equal(conn.updates.length, 1)
    const upd = await client.waitFor(m => (m as any).type === 'update')
    assert.equal((upd as any).sessionId, 's1')
    assert.deepEqual((upd as any).update, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' }
    })
  } finally {
    client.socket.destroy()
    live.dispose()
  }
})

test('LiveServer: socket prompt uses the same queue as Zed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-live-'))
  const live = new LiveServer({ liveDir: dir, pid: process.pid })
  const { session, conn, proc } = makeSession()
  live.upsert(session, '/tmp/s.jsonl')
  await live.start()
  const client = await connect(live.socketPath)

  try {
    const zedTurn = session.prompt('from-zed')
    assert.equal(proc.prompts.length, 1)

    client.send({ id: 2, type: 'prompt', sessionId: 's1', message: 'from-slack' })
    await client.waitFor(m => {
      const u = m as any
      return u.type === 'update' && u.update?.content?.text?.includes('Queued message')
    })

    assert.equal(proc.prompts.length, 1)
    assert.ok(conn.updates.some(u => JSON.stringify(u).includes('Queued message')))

    finishTurn(proc)
    assert.equal(await zedTurn, 'end_turn')
    await new Promise(r => setTimeout(r, 0))
    assert.equal(proc.prompts.length, 2)
    assert.equal(proc.prompts[1]?.message, 'from-slack')

    finishTurn(proc)
    const done = await client.waitFor(m => (m as any).id === 2 && (m as any).ok === true)
    assert.equal((done as any).stopReason, 'end_turn')
  } finally {
    client.socket.destroy()
    live.dispose()
  }
})

test('LiveServer: list / unknown session / cancel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-live-'))
  const live = new LiveServer({ liveDir: dir, pid: process.pid })
  const { session, proc } = makeSession()
  live.upsert(session, '/tmp/s.jsonl')
  await live.start()
  const client = await connect(live.socketPath)

  try {
    client.send({ id: 1, type: 'list' })
    const listed = await client.waitFor(m => (m as any).id === 1)
    assert.equal((listed as any).ok, true)
    assert.equal((listed as any).sessions.length, 1)
    assert.equal((listed as any).sessions[0].sessionId, 's1')
    assert.equal((listed as any).sessions[0].running, false)

    client.send({ id: 2, type: 'attach', sessionId: 'missing' })
    const missing = await client.waitFor(m => (m as any).id === 2)
    assert.equal((missing as any).ok, false)

    const turn = session.prompt('x')
    client.send({ id: 3, type: 'cancel', sessionId: 's1' })
    await client.waitFor(m => (m as any).id === 3 && (m as any).ok === true)
    assert.equal(proc.abortCount, 1)
    finishTurn(proc)
    assert.equal(await turn, 'cancelled')
  } finally {
    client.socket.destroy()
    live.dispose()
  }
})
