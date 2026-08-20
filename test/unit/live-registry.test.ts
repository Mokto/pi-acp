import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { LiveServer, readLiveSessions, sweepStaleLiveFiles } from '../../src/acp/live.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { PiAcpAgent } from '../../src/acp/agent.js'

function makeSession(id = 's1') {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: id,
    cwd: '/tmp/project',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { session, conn, proc }
}

test('PiAcpAgent: live is null when PI_ACP_LIVE is unset', () => {
  const prev = process.env.PI_ACP_LIVE
  delete process.env.PI_ACP_LIVE
  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    assert.equal((agent as any).live, null)
    agent.dispose()
  } finally {
    if (prev === undefined) delete process.env.PI_ACP_LIVE
    else process.env.PI_ACP_LIVE = prev
  }
})

test('readLiveSessions: skips dead pids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-live-'))
  writeFileSync(
    join(dir, '999999999.json'),
    JSON.stringify({
      pid: 999999999,
      sock: join(dir, '999999999.sock'),
      sessions: { dead: { cwd: '/tmp', sessionFile: '/tmp/x.jsonl' } }
    }) + '\n'
  )
  assert.deepEqual(readLiveSessions(dir), {})
})

test('sweepStaleLiveFiles: unlinks dead pid artifacts, keeps this process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-live-'))
  const dead = join(dir, '999999999.json')
  const deadSock = join(dir, '999999999.sock')
  writeFileSync(dead, '{}\n')
  writeFileSync(deadSock, '')
  const live = join(dir, `${process.pid}.json`)
  writeFileSync(live, '{}\n')

  sweepStaleLiveFiles(dir)

  assert.equal(existsSync(dead), false)
  assert.equal(existsSync(deadSock), false)
  assert.equal(existsSync(live), true)
})

test('LiveServer: remove drops one session and keeps the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-live-'))
  const live = new LiveServer({ liveDir: dir, pid: process.pid })
  const a = makeSession('a')
  const b = makeSession('b')
  live.upsert(a.session, '/tmp/a.jsonl')
  live.upsert(b.session, '/tmp/b.jsonl')
  await live.start()
  try {
    live.remove('a')
    const listed = readLiveSessions(dir)
    assert.equal(listed.a, undefined)
    assert.equal(listed.b?.sessionFile, '/tmp/b.jsonl')
  } finally {
    live.dispose()
  }
})

test('LiveServer: writes per-pid registry on start + upsert, removes on dispose', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-live-'))
  const live = new LiveServer({ liveDir: dir, pid: process.pid })
  const { session } = makeSession()

  live.upsert(session, '/tmp/s.jsonl')
  await live.start()

  try {
    const listed = readLiveSessions(dir)
    assert.equal(listed[session.sessionId]?.cwd, '/tmp/project')
    assert.equal(listed[session.sessionId]?.sessionFile, '/tmp/s.jsonl')
    assert.equal(listed[session.sessionId]?.pid, process.pid)
    assert.equal(listed[session.sessionId]?.sock, join(dir, `${process.pid}.sock`))

    const raw = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), 'utf-8'))
    assert.equal(raw.pid, process.pid)
    assert.equal(raw.sessions.s1.sessionFile, '/tmp/s.jsonl')
  } finally {
    live.dispose()
  }

  assert.equal(existsSync(join(dir, `${process.pid}.json`)), false)
  assert.equal(existsSync(join(dir, `${process.pid}.sock`)), false)
})

test('LiveServer does not create its directory until start()', () => {
  const dir = join(tmpdir(), 'pi-acp-live-never-' + Date.now())
  const live = new LiveServer({ liveDir: dir, pid: process.pid })
  assert.equal(existsSync(dir), false)
  live.dispose()
  assert.equal(existsSync(dir), false)
})
