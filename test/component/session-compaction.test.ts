import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const SUMMARY = '## Goal\nShip the compaction entry.'
const END_OK = {
  type: 'compaction_end',
  reason: 'threshold',
  result: { summary: SUMMARY, tokensBefore: 150_000, estimatedTokensAfter: 32_000 },
  aborted: false,
  willRetry: false
}

function session(compactionEntries: boolean) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    compactionEntries
  })
  const updates = async () => {
    await new Promise(r => setTimeout(r, 0))
    return conn.updates.map(u => u.update as any)
  }
  return { proc, updates }
}

test('compaction: a client with compaction entries gets one entry, started then completed', async () => {
  const { proc, updates } = session(true)
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit(END_OK)

  const [start, end] = await updates()
  assert.equal(start.sessionUpdate, 'compaction_update')
  assert.equal(start.status, 'in_progress')
  assert.deepEqual(end, {
    sessionUpdate: 'compaction_update',
    compactionId: start.compactionId,
    status: 'completed',
    summary: [{ type: 'text', text: SUMMARY }]
  })
})

test('compaction: other clients get one collapsed tool card with the summary inside', async () => {
  const { proc, updates } = session(false)
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit(END_OK)

  const [start, end] = await updates()
  assert.equal(start.sessionUpdate, 'tool_call')
  assert.equal(start.title, 'Compacting context…')
  assert.equal(start.status, 'in_progress')
  assert.deepEqual(end, {
    sessionUpdate: 'tool_call',
    toolCallId: start.toolCallId,
    title: 'Context compacted · 150k → 32k tokens',
    kind: 'think',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: SUMMARY } }]
  })
})

test('compaction: a failure shows pi reason, a cancel shows as cancelled', async () => {
  const { proc, updates } = session(true)
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit({
    type: 'compaction_end',
    reason: 'manual',
    aborted: false,
    willRetry: false,
    errorMessage: 'Compaction failed: Nothing to compact (session too small)'
  })
  proc.emit({ type: 'auto_compaction_start' })
  proc.emit({ type: 'auto_compaction_end', aborted: true })

  const [, failed, , cancelled] = await updates()
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'Nothing to compact (session too small)')
  assert.equal(cancelled.status, 'cancelled')
})

function stubSpawn(proc: Record<string, unknown>) {
  const original = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => ({
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' }),
    getMessages: async () => ({ messages: [] }),
    takeEarlyEvents: () => [],
    ...proc
  })
  return () => {
    PiRpcProcess.spawn = original
  }
}

async function loadedAgent(compaction: boolean) {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = {
    get: () => ({ sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: '' }),
    upsert() {}
  }
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: compaction ? { session: { compaction: {} } } : {}
  } as any)
  await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
  return { agent, conn }
}

test('compaction: reopening a compacted thread marks where the earlier history went', async () => {
  const restore = stubSpawn({
    onEvent: () => () => {},
    getMessages: async () => ({
      messages: [
        { role: 'compactionSummary', summary: SUMMARY, tokensBefore: 150_000, timestamp: 42 },
        { role: 'user', content: 'and now?' }
      ]
    })
  })
  try {
    const withEntries = (await loadedAgent(true)).conn.updates.map(u => u.update as any)
    const entry = withEntries.find(u => u.sessionUpdate === 'compaction_update')
    assert.deepEqual(entry, {
      sessionUpdate: 'compaction_update',
      compactionId: 'compaction-42',
      status: 'completed',
      summary: [{ type: 'text', text: SUMMARY }]
    })
    assert.ok(withEntries.indexOf(entry) < withEntries.findIndex(u => u.sessionUpdate === 'user_message_chunk'))

    const card = (await loadedAgent(false)).conn.updates
      .map(u => u.update as any)
      .find(u => u.sessionUpdate === 'tool_call')
    assert.equal(card.title, 'Context compacted · 150k tokens summarized')
    assert.equal(card.status, 'completed')
  } finally {
    restore()
  }
})

test('compaction: /compact shows the entry instead of pasting the summary into the reply', async () => {
  let handler: (ev: PiRpcEvent) => void = () => {}
  const restore = stubSpawn({
    onEvent: (h: typeof handler) => {
      handler = h
      return () => {}
    },
    compact: async () => {
      handler({ type: 'compaction_start', reason: 'manual' })
      handler({ ...END_OK, reason: 'manual' })
      return { summary: SUMMARY, tokensBefore: 150_000 }
    }
  })
  try {
    const { agent, conn } = await loadedAgent(true)
    const res = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/compact' }] } as any)
    assert.equal(res.stopReason, 'end_turn')
    const updates = conn.updates.map(u => u.update as any)
    assert.ok(updates.some(u => u.sessionUpdate === 'compaction_update' && u.status === 'completed'))
    assert.ok(!updates.some(u => u.sessionUpdate === 'agent_message_chunk' && u.content.text.includes(SUMMARY)))
  } finally {
    restore()
  }
})

test('compaction: /compact shows the result pi returns when no compaction_end arrives', async () => {
  const restore = stubSpawn({
    onEvent: () => () => {},
    compact: async () => ({ summary: SUMMARY, tokensBefore: 150_000, estimatedTokensAfter: 32_000 })
  })
  try {
    const { agent, conn } = await loadedAgent(true)
    await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/compact' }] } as any)
    const entry = conn.updates.map(u => u.update as any).find(u => u.sessionUpdate === 'compaction_update')
    assert.equal(entry?.status, 'completed')
    assert.deepEqual(entry?.summary, [{ type: 'text', text: SUMMARY }])
  } finally {
    restore()
  }
})

test('compaction: /compact still surfaces an error pi raises before compaction starts', async () => {
  const restore = stubSpawn({
    onEvent: () => () => {},
    compact: async () => {
      throw new Error('pi compact failed: busy')
    }
  })
  try {
    const { agent } = await loadedAgent(true)
    await assert.rejects(agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: '/compact' }] } as any), /busy/)
  } finally {
    restore()
  }
})
