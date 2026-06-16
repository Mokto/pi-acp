import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function makeSession(proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(new FakeAgentSideConnection()),
    fileCommands: []
  })
}

test('PiAcpSession: defers setModel while a turn is active and flushes after agent_end', async () => {
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc)

  const pending = session.prompt('hello')
  assert.equal(proc.setModelCalls.length, 0)

  await session.setModelWhenIdle('test', 'model-b')
  assert.deepEqual(proc.setModelCalls, [])

  proc.emit({ type: 'agent_end' })
  assert.equal(await pending, 'end_turn')
  await flushMicrotasks()

  assert.deepEqual(proc.setModelCalls, [{ provider: 'test', modelId: 'model-b' }])
})

test('PiAcpSession: defers setThinkingLevel while a turn is active and flushes after agent_end', async () => {
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc)

  const pending = session.prompt('hello')
  await session.setThinkingLevelWhenIdle('high')
  assert.deepEqual(proc.setThinkingCalls, [])

  proc.emit({ type: 'agent_end' })
  assert.equal(await pending, 'end_turn')
  await flushMicrotasks()

  assert.deepEqual(proc.setThinkingCalls, ['high'])
})

test('PiAcpSession: pi activity resets the inactivity watchdog', async () => {
  const previousTimeout = process.env.PI_ACP_TURN_INACTIVITY_MS
  process.env.PI_ACP_TURN_INACTIVITY_MS = '40'

  try {
    const proc = new FakePiRpcProcess()
    const session = makeSession(proc)

    const pending = session.prompt('hello')
    await new Promise(resolve => setTimeout(resolve, 25))
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })
    await new Promise(resolve => setTimeout(resolve, 25))
    proc.emit({ type: 'agent_end' })

    assert.equal(await pending, 'end_turn')
    assert.equal(proc.abortCount, 0)
  } finally {
    if (previousTimeout === undefined) delete process.env.PI_ACP_TURN_INACTIVITY_MS
    else process.env.PI_ACP_TURN_INACTIVITY_MS = previousTimeout
  }
})

test('PiAcpSession: turn watchdog aborts a stuck turn and drains the queue', async () => {
  const previousTimeout = process.env.PI_ACP_TURN_INACTIVITY_MS
  const previousStartup = process.env.PI_ACP_INFERENCE_STARTUP_MS
  process.env.PI_ACP_TURN_INACTIVITY_MS = '30'
  process.env.PI_ACP_INFERENCE_STARTUP_MS = '30'

  try {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = new PiAcpSession({
      sessionId: 's1',
      cwd: process.cwd(),
      mcpServers: [],
      proc: proc as unknown as PiRpcProcess,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    const first = session.prompt('stuck')
    const second = session.prompt('queued')

    // Move past inference startup so the *inactivity* watchdog is the one that fires.
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })

    assert.equal(await first, 'error')
    assert.equal(proc.abortCount, 1)
    assert.equal(proc.prompts.length, 2)

    proc.emit({ type: 'agent_end' })
    assert.equal(await second, 'end_turn')

    const timeoutMsg = conn.updates.find(
      u =>
        u.update.sessionUpdate === 'agent_message_chunk' &&
        (u.update as { content?: { text?: string } }).content?.text?.includes('inactivity')
    )
    assert.ok(timeoutMsg, 'expected a turn inactivity timeout message')
  } finally {
    if (previousTimeout === undefined) delete process.env.PI_ACP_TURN_INACTIVITY_MS
    else process.env.PI_ACP_TURN_INACTIVITY_MS = previousTimeout
    if (previousStartup === undefined) delete process.env.PI_ACP_INFERENCE_STARTUP_MS
    else process.env.PI_ACP_INFERENCE_STARTUP_MS = previousStartup
  }
})
