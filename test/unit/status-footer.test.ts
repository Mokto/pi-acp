import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('extension statuses appear only in the footer and can be replaced or cleared', async () => {
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
  proc.sessionStats = { contextUsage: { tokens: 100, contextWindow: 1000 } }
  const setStatus = (statusKey: string, statusText?: string) =>
    proc.emit({ type: 'extension_ui_request', id: 'status-1', method: 'setStatus', statusKey, statusText })
  const footer = async () => {
    conn.updates.length = 0
    await (session as any).maybeEmitTokenStats()
    await (session as any).flushEmits()
    const chunks = conn.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk')
    assert.equal(chunks.length, 1)
    return (chunks[0]!.update as any).content.text as string
  }

  setStatus('sync-health', '/reload ⚠️')
  await (session as any).flushEmits()
  assert.equal(conn.updates.length, 0)
  assert.equal(proc.extensionUiResponses.length, 0)
  assert.match(await footer(), /^\n\n↳ 100 tokens · 10% · .* · \/reload ⚠️$/)
  assert.match(await footer(), / · \/reload ⚠️$/)

  setStatus('other', 'Other status')
  setStatus('sync-health', 'Updated status')
  const updated = await footer()
  assert.match(updated, / · Updated status · Other status$/)
  assert.doesNotMatch(updated, /reload ⚠️/)

  setStatus('sync-health')
  assert.match(await footer(), / · Other status$/)
  setStatus('other', '')
  assert.doesNotMatch(await footer(), /reload ⚠️|Updated status|Other status/)
})
