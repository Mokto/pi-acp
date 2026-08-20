import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: initialize advertises sessionCapabilities.close', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual(res.agentCapabilities?.sessionCapabilities?.close, {})
  agent.dispose()
})

test('PiAcpAgent: closeSession cancels then closes a live session', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const cancelCalls: string[] = []
  const closeCalls: string[] = []
  const session = {
    sessionId: 's1',
    proc: { exited: false },
    cancel: async () => {
      cancelCalls.push('s1')
    }
  }
  ;(agent as any).sessions = {
    maybeGet: (id: string) => (id === 's1' ? session : undefined),
    close: (id: string) => {
      closeCalls.push(id)
    },
    disposeAll() {}
  }

  try {
    await agent.closeSession({ sessionId: 's1' })
    assert.deepEqual(cancelCalls, ['s1'])
    assert.deepEqual(closeCalls, ['s1'])
  } finally {
    agent.dispose()
  }
})

test('PiAcpAgent: closeSession on an unknown id is a no-op', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const closeCalls: string[] = []
  ;(agent as any).sessions = {
    maybeGet: () => undefined,
    close: (id: string) => {
      closeCalls.push(id)
    },
    disposeAll() {}
  }

  try {
    await agent.closeSession({ sessionId: 'missing' })
    assert.deepEqual(closeCalls, [])
  } finally {
    agent.dispose()
  }
})

test('PiAcpAgent: closeSession still closes when cancel throws', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const closeCalls: string[] = []
  ;(agent as any).sessions = {
    maybeGet: () => ({
      sessionId: 's1',
      proc: { exited: false },
      cancel: async () => {
        throw new Error('abort failed')
      }
    }),
    close: (id: string) => {
      closeCalls.push(id)
    },
    disposeAll() {}
  }

  try {
    await agent.closeSession({ sessionId: 's1' })
    assert.deepEqual(closeCalls, ['s1'])
  } finally {
    agent.dispose()
  }
})
