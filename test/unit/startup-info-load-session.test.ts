import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

test('PiAcpAgent: loadSession writes summary file and sets startup info when getMessages times out', async () => {
  // Use a very short timeout so the test completes quickly with real timers.
  const prev = process.env.PI_ACP_GET_MESSAGES_TIMEOUT_MS
  process.env.PI_ACP_GET_MESSAGES_TIMEOUT_MS = '50'

  const root = mkdtempSync(join(tmpdir(), 'pi-acp-timeout-'))
  const sessionFile = join(root, 'session.jsonl')

  // Write a minimal session JSONL with a couple of messages.
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 's-timeout', timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello from history' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } }),
  ]
  writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf-8')

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => ({
    onEvent: () => () => {},
    // getMessages never resolves — simulates a hung pi process
    getMessages: () => new Promise(() => {}),
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' }),
    getCommands: async () => ({ commands: [] }),
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

    // Summary file should have been written to cwd.
    const summaryPath = join(root, '.pi-history-summary.md')
    assert.ok(existsSync(summaryPath), '.pi-history-summary.md should be written')

    const summary = readFileSync(summaryPath, 'utf-8')
    assert.ok(summary.includes('hello from history'), 'summary should include user message')
    assert.ok(summary.includes('hi there'), 'summary should include assistant message')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (prev === undefined) delete process.env.PI_ACP_GET_MESSAGES_TIMEOUT_MS
    else process.env.PI_ACP_GET_MESSAGES_TIMEOUT_MS = prev
  }
})
