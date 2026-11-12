import { randomUUID } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

// Saved images are shared across runs and keep their first name, so each run uses new bytes.
const replayedBytes = `replayed-bytes-${randomUUID()}`

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
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'echo hello' } },
              { type: 'toolCall', id: 'call_3', name: 'grep', arguments: { pattern: 'match', path: 'src' } },
              { type: 'toolCall', id: 'call_4', name: 'page_snapshot', arguments: { url: 'https://example.com' } },
              { type: 'toolCall', id: 'call_5', name: 'ui_screenshot', arguments: { url: 'https://example.com' } }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
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
          },
          {
            role: 'toolResult',
            toolCallId: 'call_3',
            toolName: 'grep',
            content: [{ type: 'text', text: 'src/a.ts:1: match' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_4',
            toolName: 'page_snapshot',
            content: [
              { type: 'text', text: 'Script on /, 1 image.' },
              { type: 'image', data: Buffer.from(replayedBytes).toString('base64'), mimeType: 'image/png' }
            ],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_5',
            toolName: 'ui_screenshot',
            content: [{ type: 'text', text: 'http://localhost:5173/pricing, 1440x900.' }],
            details: { _label: 'Screenshot http://localhost:5173/pricing' },
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

    const grepCall = updates.find(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === 'call_3')
    assert.equal(grepCall?.kind, 'search')
    assert.equal(grepCall?.title, 'Grep src', 'titled from the call’s arguments, like a live card')

    const shotCall = updates.find(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === 'call_4')
    assert.equal(shotCall?.rawOutput, undefined, 'the result goes once, on the update')
    const shotDone = updates.find(u => u?.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call_4')
    const text = shotDone?.content?.[0]?.content?.text as string
    const file = text.match(/^\[!\[page_snapshot\.png\]\(<(.+)>\)\]\(<\1>\)\n\nScript on \/, 1 image\.$/)?.[1]
    assert.ok(file, text)
    assert.equal(readFileSync(file, 'utf8'), replayedBytes)
    assert.equal(shotDone.title, `[Page Snapshot: https://example.com](<${file}>)`)

    const labelled = updates.find(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === 'call_5')
    assert.equal(labelled?.title, 'Screenshot http://localhost:5173/pricing', 'the finished result’s _label wins')
    assert.doesNotMatch(JSON.stringify(shotDone.rawOutput), /cG5n/, 'no image bytes in rawOutput')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
