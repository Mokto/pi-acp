import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { noticeFromNotify } from '../../src/acp/translate/notice.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const STALE_SYNC: PiRpcEvent = {
  type: 'extension_ui_request',
  id: 'n1',
  method: 'notify',
  notifyType: 'warning',
  message: "Auto-sync hasn't run in 30 hours. Extensions may be out of date."
}
const READY: PiRpcEvent = {
  type: 'extension_ui_request',
  id: 'n2',
  method: 'notify',
  notifyType: 'info',
  message: 'Linear tools ready'
}

function session(notices: boolean) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const s = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    notices
  })
  const updates = async () => {
    await new Promise(r => setTimeout(r, 0))
    return conn.updates.map(u => u.update as any)
  }
  return { s, proc, updates }
}

test('notices: splits notify text into a title and a description', () => {
  assert.deepEqual(noticeFromNotify(STALE_SYNC.message as string, 'warning'), {
    sessionUpdate: 'notice',
    severity: 'warning',
    title: "Auto-sync hasn't run in 30 hours",
    description: 'Extensions may be out of date.'
  })
  assert.deepEqual(
    noticeFromNotify(
      'MCP servers need attention:\n  linear: needs sign-in\n  docs: offline\nRun /mcp to fix.',
      'warning'
    ),
    {
      sessionUpdate: 'notice',
      severity: 'warning',
      title: 'MCP servers need attention',
      description: 'linear: needs sign-in\ndocs: offline\nRun /mcp to fix.'
    }
  )
  assert.deepEqual(noticeFromNotify('Anthropic isn’t signed in.', 'error'), {
    sessionUpdate: 'notice',
    severity: 'error',
    title: 'Anthropic isn’t signed in'
  })
  const long = `${'x'.repeat(120)}. Detail.`
  assert.deepEqual(noticeFromNotify(long, 'error'), {
    sessionUpdate: 'notice',
    severity: 'error',
    title: 'Extension error',
    description: long
  })
})

test('notices: outside a reply, warnings become notices and info is dropped', async () => {
  const { proc, updates } = session(true)
  proc.emit(STALE_SYNC)
  proc.emit(READY)
  const sent = await updates()
  assert.deepEqual(
    sent.map(u => u.sessionUpdate),
    ['notice']
  )
  assert.equal(proc.extensionUiResponses.length, 2)
})

test('notices: a client without notices still gets outside-a-reply warnings as text', async () => {
  const { proc, updates } = session(false)
  proc.emit(STALE_SYNC)
  proc.emit(READY)
  const sent = await updates()
  assert.deepEqual(sent, [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n${STALE_SYNC.message}` } }
  ])
})

test('notices: inside a reply, notify text stays in the reply', async () => {
  const { s, proc, updates } = session(true)
  void s.prompt('/sync-main')
  await new Promise(r => setTimeout(r, 0))
  proc.emit({ ...READY, message: 'git fetch…' })
  proc.emit(STALE_SYNC)
  const texts = (await updates()).filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text)
  assert.deepEqual(texts, ['\n\ngit fetch…', `\n\n${STALE_SYNC.message}`])
})

test('notices: a new thread shows warnings pi sent before the session listened, after the response', async () => {
  const proc = new FakePiRpcProcess()
  proc.earlyEvents = [READY, STALE_SYNC]
  const original = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => proc
  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    await agent.initialize({ protocolVersion: 1, clientCapabilities: { session: { notices: {} } } } as any)
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    assert.equal(conn.updates.filter(u => (u.update as any).sessionUpdate === 'notice').length, 0)
    await new Promise(r => setTimeout(r, 10))
    const notices = conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate === 'notice')
    assert.deepEqual(
      notices.map(n => n.title),
      ["Auto-sync hasn't run in 30 hours"]
    )
  } finally {
    PiRpcProcess.spawn = original
  }
})
