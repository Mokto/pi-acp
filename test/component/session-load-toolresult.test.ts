import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-load-'))
mkdirSync(join(cwd, '.pi'))
writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ acpToolKinds: { team_lookup_tool: 'fetch' } }))

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd, sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

test('PiAcpAgent: loadSession replays toolResult as tool_call + tool_call_update', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      takeEarlyEvents: () => [],
      getMessages: async () => ({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            args: { command: 'echo hello' },
            content: [{ type: 'text', text: 'hello from bash' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_2',
            toolName: 'team_lookup_tool',
            content: [{ type: 'text', text: 'RAW=1' }],
            details: { _display: 'Shown' },
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd, mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.deepEqual(toolCall.content, [{ type: 'terminal', terminalId: 'call_1' }])
    assert.deepEqual(toolCall._meta, { terminal_info: { terminal_id: 'call_1', cwd } })
    assert.equal(toolCall.rawOutput, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate._meta, {
      terminal_output: { terminal_id: 'call_1', data: 'hello from bash' },
      terminal_exit: { terminal_id: 'call_1', exit_code: 0, signal: null }
    })
    assert.equal(toolCallUpdate.rawOutput, undefined)

    const lookupCall = updates.find(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === 'call_2')
    assert.equal(lookupCall?.kind, 'fetch')
    const lookupDone = updates.find(u => u?.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_2')
    assert.deepEqual(lookupDone?.content, [{ type: 'content', content: { type: 'text', text: 'Shown' } }])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
