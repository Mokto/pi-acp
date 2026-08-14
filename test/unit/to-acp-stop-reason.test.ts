import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: maps session error stopReason to ACP end_turn', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({
    sessionId: 's1',
    proc: { exited: false },
    wasCancelRequested: () => false,
    prompt: async () => 'error'
  }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'hello' }]
  } as any)

  // ACP has no error stop reason; refusal triggers Cursor's content-policy UI.
  assert.equal(res.stopReason, 'end_turn')
})

test('PiAcpAgent: maps session end_turn to ACP end_turn', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({
    sessionId: 's1',
    proc: { exited: false },
    wasCancelRequested: () => false,
    prompt: async () => 'end_turn'
  }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'hello' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
})
