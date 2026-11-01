import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {
    // noop
  }
}

test('PiAcpAgent: does not emit startup info on loadSession', async () => {
  // spy on timers (commands update is scheduled)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      takeEarlyEvents: () => [],
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // Inject store so loadSession resolves without depending on actual filesystem.
    ;(agent as any).store = new FakeStore()

    const res = await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    assert.equal((res as any)?._meta?.piAcp?.startupInfo, null)

    // Two timeouts are scheduled:
    //  1. the get_messages timeout guard (withTimeout, clears immediately when getMessages resolves fast)
    //  2. the available_commands_update notification
    assert.equal(timeouts.length, 2)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    PiRpcProcess.spawn = originalSpawn
  }
})

test("PiAcpAgent: loadSession links pi's session file, writing nothing to the project, when getMessages times out", async () => {
  // Use a very short timeout so the test completes quickly with real timers.
  const prev = process.env.PI_ACP_GET_MESSAGES_TIMEOUT_MS
  process.env.PI_ACP_GET_MESSAGES_TIMEOUT_MS = '50'

  const root = mkdtempSync(join(tmpdir(), 'pi-acp-timeout-'))
  const sessionFile = join(root, 'session.jsonl')

  // Write a minimal session JSONL with a couple of messages.
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 's-timeout', timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'hello from history' }] }
    }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } })
  ]
  writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf-8')

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => ({
    onEvent: () => () => {},
    takeEarlyEvents: () => [],
    // getMessages never resolves — simulates a hung pi process
    getMessages: () => new Promise(() => {}),
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' }),
    getCommands: async () => ({ commands: [] })
  })

  class FakeStore2 {
    get(_id: string) {
      return { sessionId: 's-timeout', cwd: root, sessionFile, updatedAt: new Date().toISOString() }
    }
    upsert() {}
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore2()

    // loadSession resolves after the 50ms timeout fires.
    const res = await agent.loadSession({ sessionId: 's-timeout', cwd: root, mcpServers: [] } as any)

    // startupInfo is surfaced via session.setStartupInfo (not in _meta).
    assert.equal((res as any)?._meta?.piAcp?.startupInfo, null)

    const shownText = () =>
      conn.updates
        .map(u => (u.update as any).content?.text)
        .filter(Boolean)
        .join('')
    for (let waited = 0; !shownText().includes("Couldn't show") && waited < 1000; waited += 10) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const text = shownText()
    assert.match(text, /Couldn't show this thread's earlier messages/)
    assert.ok(text.includes(pathToFileURL(sessionFile).href), 'message should link the session file')
    assert.deepEqual(readdirSync(root), ['session.jsonl'], 'nothing should be written to the project')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (prev === undefined) delete process.env.PI_ACP_GET_MESSAGES_TIMEOUT_MS
    else process.env.PI_ACP_GET_MESSAGES_TIMEOUT_MS = prev
  }
})
