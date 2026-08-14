/**
 * Tests that turns complete properly when the process reports errors or exits.
 *
 * Kept in a separate file from session-turn-guard.test.ts so they do not race
 * on PI_ACP_TURN_INACTIVITY_MS (that file's tests set it to 30–40 ms and
 * top-level test() calls run concurrently within a file).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(conn: FakeAgentSideConnection): { session: PiAcpSession; proc: FakePiRpcProcess } {
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { session, proc }
}

test('PiAcpSession: agent_error event completes the pending turn', async () => {
  const conn = new FakeAgentSideConnection()
  const { session, proc } = makeSession(conn)

  const pending = session.prompt('hello')
  proc.emit({ type: 'agent_error', message: 'boom' })

  assert.equal(await pending, 'error')

  const errMsg = conn.updates.find(
    u =>
      u.update.sessionUpdate === 'agent_message_chunk' &&
      (u.update as { content?: { text?: string } }).content?.text?.includes('boom')
  )
  assert.ok(errMsg, 'expected error message in updates')
})

test('PiAcpSession: unexpected subprocess exit completes the pending turn', async () => {
  const conn = new FakeAgentSideConnection()
  const { session, proc } = makeSession(conn)

  const pending = session.prompt('hello')
  proc.emitExit(null, 'SIGTERM')

  assert.equal(await pending, 'error')

  const exitMsg = conn.updates.find(
    u =>
      u.update.sessionUpdate === 'agent_message_chunk' &&
      (u.update as { content?: { text?: string } }).content?.text?.includes('pi process exited')
  )
  assert.ok(exitMsg, 'expected exit message in updates')
})

test('PiAcpSession: idle subprocess exit (no pending turn) still notifies and evicts the session', async () => {
  const conn = new FakeAgentSideConnection()
  let evicted = false
  const proc = new FakePiRpcProcess()
  const _session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    onDead: () => {
      evicted = true
    }
  })

  // No prompt in flight — pi crashes/exits between turns.
  proc.emitExit(1, null)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(evicted, true, 'onDead should fire even without a pending turn')
  assert.equal(proc.exited, true)

  const exitMsg = conn.updates.find(
    u =>
      u.update.sessionUpdate === 'agent_message_chunk' &&
      (u.update as { content?: { text?: string } }).content?.text?.includes('pi process exited unexpectedly')
  )
  assert.ok(exitMsg, 'expected an idle-exit notice instead of silence')
})

class SlowFakeAgentSideConnection extends FakeAgentSideConnection {
  override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
    await new Promise(r => setTimeout(r, 30))
    await super.sessionUpdate(msg)
  }
}

class RejectingFakePiRpcProcess extends FakePiRpcProcess {
  override async prompt(
    message: string,
    attachments: unknown[] = [],
    opts?: { streamingBehavior?: 'steer' | 'followUp' }
  ): Promise<void> {
    this.prompts.push({ message, attachments, streamingBehavior: opts?.streamingBehavior })
    throw new Error('write after stream destroyed')
  }
}

test('PiAcpSession: prompt RPC rejection flushes Error text before the turn resolves', async () => {
  const conn = new SlowFakeAgentSideConnection()
  const proc = new RejectingFakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const reason = await session.prompt('hello')
  assert.equal(reason, 'error')

  const errMsg = conn.updates.find(
    u =>
      u.update.sessionUpdate === 'agent_message_chunk' &&
      (u.update as { content?: { text?: string } }).content?.text === 'Error: write after stream destroyed'
  )
  assert.ok(errMsg, 'expected Error chunk to be delivered before session/prompt resolves')
})
