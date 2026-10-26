import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

/** An agent whose session map and pi session folder are empty temp dirs, not the user's. */
function isolatedAgent(t: test.TestContext, conn: FakeAgentSideConnection) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-restore-'))
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent')
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = new SessionStore(join(dir, 'session-map.json'))
  return { agent, dir }
}

class FakeSessions {
  closeCalls: string[] = []
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  close(id: string) {
    this.closeCalls.push(id)
  }
}

// Regression test: a session whose pi subprocess already exited (crash, OOM,
// killed while idle) must not be handed back as-is. Previously `autoRestoreSession`
// only checked whether the session existed in the map at all, so any call against
// a zombie session (e.g. a model change) would try to write to a destroyed stdin
// stream and blow up with a raw "write after stream destroyed" error instead of
// transparently respawning.
test('PiAcpAgent: setSessionConfigOption evicts a session whose pi process already exited', async t => {
  const conn = new FakeAgentSideConnection()
  const { agent } = isolatedAgent(t, conn)
  const sessions = new FakeSessions({
    sessionId: 's1',
    proc: { exited: true }
  })
  ;(agent as any).sessions = sessions as any

  // No session-map.json entry or pi session file for 's1', so the fall-through restore path
  // can't actually respawn here -- but that's fine: the point of this test is
  // that we *attempt* eviction + restore rather than silently reusing the corpse.
  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', value: 'anthropic/claude' }),
    (e: any) => e?.code === -32602 && String(e?.data ?? '').includes('Unknown sessionId')
  )

  assert.deepEqual(sessions.closeCalls, ['s1'], 'dead session should be closed/evicted, not reused')
})

test("PiAcpAgent: restoring a dead session missing from the session map finds it in pi's session files", async t => {
  const conn = new FakeAgentSideConnection()
  const { agent, dir } = isolatedAgent(t, conn)
  const sessionsDir = join(dir, 'agent', 'sessions', '--project--')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionFile = join(sessionsDir, '2026-10-23T10-00-00-000Z_s2.jsonl')
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 's2', cwd: '/work/project' }) + '\n')
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's2', proc: { exited: true } }) as any

  const spawned: unknown[] = []
  t.mock.method(PiRpcProcess, 'spawn', async (params: unknown) => {
    spawned.push(params)
    throw new Error('stop after spawn')
  })

  await assert.rejects(() =>
    agent.setSessionConfigOption({ sessionId: 's2', configId: 'model', value: 'anthropic/claude' })
  )
  assert.equal(spawned.length, 1)
  assert.deepEqual(
    { cwd: (spawned[0] as any).cwd, sessionPath: (spawned[0] as any).sessionPath },
    { cwd: '/work/project', sessionPath: sessionFile }
  )
})
