import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Regression check for the /audit pipeline's back-to-back ctx.ui.notify() calls
// rendering as one squished run-on sentence in ACP clients (Zed) — see the
// `method === 'notify'` case in handleExtensionUiRequest. Each notify() must
// carry its own leading separator so consecutive calls read as distinct lines.
test('PiAcpSession: notify extension UI request is separated with a leading blank line', async () => {
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
  void session.prompt('/audit')
  await new Promise(r => setTimeout(r, 0))

  proc.emit({
    type: 'extension_ui_request',
    id: 'req-1',
    method: 'notify',
    message: 'Running 4 lenses in parallel…',
    notifyType: 'info'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  const chunks = conn.updates.filter(u => (u.update as any).sessionUpdate === 'agent_message_chunk')
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '\n\nRunning 4 lenses in parallel…' }
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'req-1', cancelled: true }])
})
