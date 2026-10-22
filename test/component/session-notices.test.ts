import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { extensionName, noticeFromNotify } from '../../src/acp/translate/notice.js'
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

test('notices: names an extension by its folder, or its file when that is not an index', () => {
  assert.equal(extensionName('/Users/a/.pi/agent/extensions/auth-status/index.ts'), 'auth-status')
  assert.equal(extensionName('/Users/a/.pi/agent/extensions/linear-tools/src/index.ts'), 'linear-tools')
  assert.equal(extensionName('/Users/a/.pi/agent/npm/node_modules/pi-cursor-sdk/dist/index.js'), 'pi-cursor-sdk')
  assert.equal(extensionName('/tmp/boom.ts'), 'boom')
  assert.equal(extensionName(''), 'an extension')
})

test('notices: an extension crash outside a reply is a notice, inside a reply a line of text', async () => {
  const { s, proc, updates } = session(true)
  const crash: PiRpcEvent = {
    type: 'extension_error',
    extensionPath: '/x/extensions/auth-status/index.ts',
    event: 'session_start',
    error: 'Linear token file is unreadable'
  }
  proc.emit(crash)
  void s.prompt('hi')
  await new Promise(r => setTimeout(r, 0))
  proc.emit({ ...crash, event: 'tool_call' })
  const sent = await updates()
  assert.deepEqual(
    sent.find(u => u.sessionUpdate === 'notice'),
    {
      sessionUpdate: 'notice',
      severity: 'error',
      title: "Couldn't run auth-status",
      description: 'Linear token file is unreadable'
    }
  )
  assert.deepEqual(
    sent.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text),
    ["\n\nCouldn't run auth-status. Linear token file is unreadable"]
  )
})

test('notices: pi stopping while idle is a notice, not text glued to the last reply', async () => {
  const { proc, updates } = session(true)
  proc.emitExit(1)
  assert.deepEqual(await updates(), [
    {
      sessionUpdate: 'notice',
      severity: 'warning',
      title: 'pi stopped unexpectedly',
      description: 'It restarts with your next message (exit code 1).'
    }
  ])
})
