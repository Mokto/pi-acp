import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// The session serialises `session/update` delivery on an internal promise chain.
// Drain the microtask queue to let those queued updates reach the fake connection.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

test('PiAcpSession: thinking_level_changed pushes current_mode_update and a refreshed config_option_update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(conn, proc)

  const refreshed: SessionConfigOption[] = [
    {
      type: 'select',
      id: 'thinking',
      name: 'Thinking',
      currentValue: 'high',
      options: [{ value: 'high', name: 'high' }]
    }
  ]
  session.setConfigOptionsRefresher(async () => refreshed)

  proc.emit({ type: 'thinking_level_changed', level: 'high' })
  await flushMicrotasks()

  const mode = conn.updates.find(u => u.update.sessionUpdate === 'current_mode_update')
  assert.ok(mode, 'expected a current_mode_update')
  assert.equal((mode.update as { currentModeId: string }).currentModeId, 'high')

  const cfg = conn.updates.find(u => u.update.sessionUpdate === 'config_option_update')
  assert.ok(cfg, 'expected a config_option_update')
  assert.deepEqual((cfg.update as { configOptions: SessionConfigOption[] }).configOptions, refreshed)
})

test('PiAcpSession: thinking_level_changed without a refresher still emits current_mode_update only', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  makeSession(conn, proc)

  proc.emit({ type: 'thinking_level_changed', level: 'low' })
  await flushMicrotasks()

  const mode = conn.updates.find(u => u.update.sessionUpdate === 'current_mode_update')
  assert.ok(mode, 'expected a current_mode_update')
  assert.equal((mode.update as { currentModeId: string }).currentModeId, 'low')
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'config_option_update'),
    false
  )
})
