import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

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

test('PiAcpSession: a non-command message still waits for agent_end', async () => {
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc)
  session.setPiExtensionCommands(['cursor-fast'])

  const pending = session.prompt('not a command')
  // Resolution only happens once pi reports the agent loop finished.
  proc.emit({ type: 'agent_end' })

  assert.equal(await pending, 'end_turn')
})
