import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

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
test('PiAcpAgent: unstable_setSessionModel evicts a session whose pi process already exited', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = new FakeSessions({
    sessionId: 's1',
    proc: { exited: true }
  })
  ;(agent as any).sessions = sessions as any

  // No stored session-map.json entry for 's1', so the fall-through restore path
  // can't actually respawn here -- but that's fine: the point of this test is
  // that we *attempt* eviction + restore rather than silently reusing the corpse.
  await assert.rejects(
    () => agent.unstable_setSessionModel({ sessionId: 's1', modelId: 'anthropic/claude' }),
    (e: any) => e?.code === -32602 && String(e?.data ?? '').includes('Unknown sessionId')
  )

  assert.deepEqual(sessions.closeCalls, ['s1'], 'dead session should be closed/evicted, not reused')
})
