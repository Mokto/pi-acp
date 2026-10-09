import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function fakeSession(command: string, opts: { activeTurn?: boolean } = {}) {
  return {
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    hasActiveTurn: () => opts.activeTurn ?? false,
    setPiExtensionCommands() {},
    proc: {
      getCommands: async () => ({ commands: [{ name: command, source: 'prompt' }] }),
      getState: async () => ({}),
      getAvailableModels: async () => ({ models: [] })
    }
  }
}

function setup(old: ReturnType<typeof fakeSession>) {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const fresh = fakeSession('fresh-cmd')
  let current = old
  const closed: string[] = []
  ;(agent as any).sessions = {
    close: (id: string) => {
      closed.push(id)
      current = fresh
    }
  }
  ;(agent as any).autoRestoreSession = async () => current
  return { conn, agent, closed }
}

const texts = (conn: FakeAgentSideConnection) =>
  conn.updates.flatMap(u => (u.update.sessionUpdate === 'agent_message_chunk' ? [(u.update.content as any).text] : []))

test('PiAcpAgent: /reload respawns pi and re-advertises the fresh process commands', async () => {
  const { conn, agent, closed } = setup(fakeSession('old-cmd'))

  const res = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/reload' }] })

  assert.equal(res.stopReason, 'end_turn')
  assert.deepEqual(closed, ['s1'])
  const advertised = conn.updates.find(u => u.update.sessionUpdate === 'available_commands_update')
  const names = (advertised?.update as any).availableCommands.map((c: any) => c.name)
  assert.ok(names.includes('fresh-cmd'))
  assert.ok(!names.includes('old-cmd'))
  assert.ok(names.includes('reload'))
  assert.ok(conn.updates.some(u => u.update.sessionUpdate === 'config_option_update'))
  assert.match(texts(conn).at(-1) ?? '', /^Reloaded/)
})

test('PiAcpAgent: /reload refuses while a turn is running', async () => {
  const { conn, agent, closed } = setup(fakeSession('old-cmd', { activeTurn: true }))

  await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/reload' }] })

  assert.deepEqual(closed, [])
  assert.match(texts(conn).at(-1) ?? '', /Cannot reload/)
})
