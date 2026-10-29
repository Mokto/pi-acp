import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Mirrors what /trip-plan (and /optimize, /dev-skills) actually do: the extension
// command's handler runs one or more *independent* nested turns internally via
// pi.sendUserMessage()+waitForIdle(), each firing its own real `agent_start`/`agent_settled`,
// before the command handler itself returns. pi core's RPC `prompt` only resolves once
// the whole handler is done (`_tryExecuteExtensionCommand` is awaited before acking), so
// this fake's `prompt()` only resolves when the test calls `resolvePrompt()` — letting it
// emit `agent_settled` for nested turns first, exactly like the real command would.
class NestedTurnFakePiRpcProcess extends FakePiRpcProcess {
  private resolvers: Array<() => void> = []

  override async prompt(
    message: string,
    attachments: unknown[] = [],
    opts?: { streamingBehavior?: 'steer' | 'followUp' }
  ): Promise<undefined> {
    await super.prompt(message, attachments, opts)
    return new Promise<undefined>(resolve => {
      this.resolvers.push(() => resolve(undefined))
    })
  }

  resolvePrompt(): void {
    this.resolvers.shift()?.()
  }
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

test('PiAcpSession: a registered pi command turn completes on the prompt response (no agent_settled)', async () => {
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc)
  session.setPiExtensionCommands(['cursor-fast'])

  // FakePiRpcProcess.prompt resolves immediately and never emits `agent_settled`.
  // The command turn must still complete; otherwise this await hangs and the test times out.
  const reason = await session.prompt('/cursor-fast')

  assert.equal(reason, 'end_turn')
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['/cursor-fast']
  )
})

test('PiAcpSession: nested agent_settled during a command does not end the ACP turn early', async () => {
  const proc = new NestedTurnFakePiRpcProcess()
  const session = makeSession(proc)
  session.setPiExtensionCommands(['trip-plan'])

  const pending = session.prompt('/trip-plan do the thing')

  // Round 1: internal writer turn finishes — a real agent_settled, but not the command's own.
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(session.hasActiveTurn(), true, 'turn must still be active after a nested agent_settled')

  // Round 2: reviewer requests changes, writer revises — another nested agent_settled.
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(session.hasActiveTurn(), true, 'turn must still be active after a second nested agent_settled')

  // The command handler itself now returns — this is what actually completes the turn.
  proc.resolvePrompt()

  assert.equal(await pending, 'end_turn')
  assert.equal(session.hasActiveTurn(), false)
})

test('PiAcpSession: a message pi reports as handled completes without agent_settled', async () => {
  const proc = new FakePiRpcProcess()
  proc.promptDisposition = 'handled'
  const session = makeSession(proc)

  // Not a known command name: an input handler consumed it. Without the disposition
  // check this await waits for an `agent_settled` that never comes.
  assert.equal(await session.prompt('consumed by an input handler'), 'end_turn')
})

test('PiAcpSession: a non-command message still waits for agent_settled', async () => {
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc)
  session.setPiExtensionCommands(['cursor-fast'])

  const pending = session.prompt('not a command')
  // Resolution only happens once pi reports the agent loop finished.
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await pending, 'end_turn')
})

test('PiAcpSession: a command that ends while its last reply is still being measured compacts the thread once, after the reply footer', async () => {
  const proc = new NestedTurnFakePiRpcProcess()
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: [],
    compactionEntries: true
  })
  session.setPiExtensionCommands(['sync-main'])
  session.setCompactAt('300000')
  const stats = { contextUsage: { tokens: 307_520, contextWindow: 1_000_000 } }
  proc.sessionStats = stats
  let measured: () => void = () => {}
  let compacted: () => void = () => {}
  proc.compactResult = new Promise(resolve => (compacted = () => resolve({ summary: 'S', tokensBefore: 307_520 })))

  const pending = session.prompt('/sync-main')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  await new Promise(resolve => setTimeout(resolve, 0))
  proc.getSessionStats = () => new Promise(resolve => (measured = () => resolve(stats)))
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await new Promise(resolve => setTimeout(resolve, 0))
  proc.resolvePrompt()
  await new Promise(resolve => setTimeout(resolve, 0))
  measured()
  await new Promise(resolve => setTimeout(resolve, 0))
  compacted()
  assert.equal(await pending, 'end_turn')
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(proc.compactCalls, 1)
  const order = conn.updates
    .map(u => u.update as any)
    .filter(u => u.sessionUpdate === 'compaction_update' || u.content?.text?.includes('↳'))
    .map(u => (u.sessionUpdate === 'compaction_update' ? 'compaction' : 'footer'))
  assert.equal(order[0], 'footer')
  assert.equal(order.filter(o => o === 'footer').length, 1)
})
