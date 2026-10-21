import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  const usageUpdates = () => conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate === 'usage_update')
  return { conn, proc, session, usageUpdates }
}

test('turn end sends a usage_update with tokens in context and the window size', async () => {
  const { proc, session, usageUpdates } = makeSession()
  proc.sessionStats = { contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: 42 } }

  const turn = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await turn

  assert.deepEqual(
    usageUpdates().map(u => [u.used, u.size]),
    [[84_000, 200_000]]
  )
})

test(
  'a turn finishes, with its footer, when pi never answers the token stats request',
  { timeout: 5_000 },
  async () => {
    const { conn, proc, session } = makeSession()
    proc.getSessionStats = () => new Promise(() => {})

    const turn = session.prompt('hello')
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'agent_end' })
    proc.emit({ type: 'agent_settled' })

    assert.equal(await turn, 'end_turn')
    const text = conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate === 'agent_message_chunk')
    assert.match(text.at(-1)?.content.text ?? '', /^\n\n↳ \d\d:\d\d/)
  }
)

test('sends no usage_update, instead of a 0% or empty ring, when pi has no context window or no count', async () => {
  const { proc, session, usageUpdates } = makeSession()

  proc.sessionStats = {}
  await (session as any).maybeEmitTokenStats()
  proc.sessionStats = { contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }
  await session.pushUsageUpdate()
  await (session as any).flushEmits()

  assert.equal(usageUpdates().length, 0)
})

test('a reopened thread publishes its context usage without waiting for a turn', async () => {
  const { proc, session, usageUpdates } = makeSession()
  proc.sessionStats = { contextUsage: { tokens: 12_000, contextWindow: 400_000, percent: 3 } }

  await session.pushUsageUpdate()
  await (session as any).flushEmits()

  assert.deepEqual(
    usageUpdates().map(u => [u.used, u.size]),
    [[12_000, 400_000]]
  )
})

test('switching model refreshes the ring with the new window, not the old one until the next turn ends', async () => {
  const { proc, session, usageUpdates } = makeSession()
  proc.sessionStats = { contextUsage: { tokens: 50_000, contextWindow: 1_000_000, percent: 5 } }

  await session.setModelWhenIdle('anthropic', 'claude-fable-5')
  await new Promise(r => setTimeout(r, 0))
  await (session as any).flushEmits()

  assert.deepEqual(
    usageUpdates().map(u => [u.used, u.size]),
    [[50_000, 1_000_000]]
  )
})

test('a model switch made mid-turn refreshes the ring once the turn ends and the switch is applied', async () => {
  const { proc, session, usageUpdates } = makeSession()
  proc.sessionStats = { contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 } }

  // pi only reports the new window once the deferred switch actually reaches it.
  const setModel = proc.setModel.bind(proc)
  proc.setModel = async (provider: string, modelId: string) => {
    await setModel(provider, modelId)
    proc.sessionStats = { contextUsage: { tokens: 50_000, contextWindow: 300_000, percent: 17 } }
  }

  const turn = session.prompt('hello')
  await session.setModelWhenIdle('cursor', 'claude-fable-5@300k')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await turn
  await new Promise(r => setTimeout(r, 10))
  await (session as any).flushEmits()

  assert.deepEqual(
    usageUpdates().map(u => [u.used, u.size]),
    [
      [50_000, 200_000],
      [50_000, 300_000]
    ]
  )
})
