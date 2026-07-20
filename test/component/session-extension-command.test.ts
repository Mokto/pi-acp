import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Mirrors what /trip-plan (and /optimize, /dev-skills) actually do: the extension
// command's handler runs one or more *independent* nested turns internally via
// pi.sendUserMessage()+waitForIdle(), each firing its own real `agent_start`/`agent_end`,
// before the command handler itself returns. pi core's RPC `prompt` only resolves once
// the whole handler is done (`_tryExecuteExtensionCommand` is awaited before acking), so
// this fake's `prompt()` only resolves when the test calls `resolvePrompt()` — letting it
// emit `agent_end` for nested turns first, exactly like the real command would.
class NestedTurnFakePiRpcProcess extends FakePiRpcProcess {
  private resolvers: Array<() => void> = []

  override async prompt(
    message: string,
    attachments: unknown[] = [],
    opts?: { streamingBehavior?: 'steer' | 'followUp' }
  ): Promise<void> {
    await super.prompt(message, attachments, opts)
    return new Promise<void>(resolve => {
      this.resolvers.push(resolve)
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

test('PiAcpSession: a registered pi command turn completes on the prompt response (no agent_end)', async () => {
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc)
  session.setPiExtensionCommands(['cursor-fast'])

  // FakePiRpcProcess.prompt resolves immediately and never emits `agent_end`.
  // The command turn must still complete; otherwise this await hangs and the test times out.
  const reason = await session.prompt('/cursor-fast')

  assert.equal(reason, 'end_turn')
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['/cursor-fast']
  )
})

test('PiAcpSession: nested agent_end during a command does not end the ACP turn early', async () => {
  const proc = new NestedTurnFakePiRpcProcess()
  const session = makeSession(proc)
  session.setPiExtensionCommands(['trip-plan'])

  const pending = session.prompt('/trip-plan do the thing')

  // Round 1: internal writer turn finishes — a real agent_end, but not the command's own.
  proc.emit({ type: 'agent_end' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(session.hasActiveTurn(), true, 'turn must still be active after a nested agent_end')

  // Round 2: reviewer requests changes, writer revises — another nested agent_end.
  proc.emit({ type: 'agent_end' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(session.hasActiveTurn(), true, 'turn must still be active after a second nested agent_end')

  // The command handler itself now returns — this is what actually completes the turn.
  proc.resolvePrompt()

  assert.equal(await pending, 'end_turn')
  assert.equal(session.hasActiveTurn(), false)
})

test('PiAcpSession: a non-command message still waits for agent_end', async () => {
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc)
  session.setPiExtensionCommands(['cursor-fast'])

  const pending = session.prompt('not a command')
  // Resolution only happens once pi reports the agent loop finished.
  proc.emit({ type: 'agent_end' })

  assert.equal(await pending, 'end_turn')
})
