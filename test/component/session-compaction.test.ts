import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import type { SummaryWriter } from '../../src/acp/background-compaction.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { until } from '../helpers/until.js'
import { getPiAcpCompactionDir } from '../../src/acp/paths.js'

const SUMMARY = '## Goal\nShip the compaction entry.'
const END_OK = {
  type: 'compaction_end',
  reason: 'threshold',
  result: { summary: SUMMARY, tokensBefore: 150_000, estimatedTokensAfter: 32_000 },
  aborted: false,
  willRetry: false
}

function session(compactionEntries: boolean, startSummaryWriter?: (sessionPath: string) => Promise<SummaryWriter>) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const s = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    compactionEntries,
    startSummaryWriter
  })
  const updates = async () => {
    await new Promise(r => setTimeout(r, 0))
    return conn.updates.map(u => u.update as any)
  }
  return { proc, updates, s }
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

test("compaction: the context ring drops to pi's estimate right away, not at the next reply", async () => {
  const { proc, updates, s } = session(true)
  proc.sessionStats = { contextUsage: { tokens: 150_000, contextWindow: 200_000 } }
  await s.pushUsageUpdate()
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit(END_OK)
  proc.sessionStats = { contextUsage: { tokens: null, contextWindow: 200_000 } }
  await s.pushUsageUpdate()

  const rings = (await updates()).filter(u => u.sessionUpdate === 'usage_update').map(u => u.used)
  assert.deepEqual(rings, [150_000, 32_000])
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

test("compaction: a reopened compacted thread shows pi's estimate on the ring until the next reply", async () => {
  const restore = stubSpawn({
    onEvent: () => () => {},
    getSessionStats: async () => ({ contextUsage: { tokens: null, contextWindow: 1_000_000, percent: null } }),
    getMessages: async () => ({
      messages: [
        { role: 'compactionSummary', summary: 'x'.repeat(40_000), tokensBefore: 150_000, timestamp: 42 },
        { role: 'user', content: 'y'.repeat(8_000) }
      ]
    })
  })
  try {
    const { conn } = await loadedAgent(true)
    const ring = () => conn.updates.map(u => u.update as any).find(u => u.sessionUpdate === 'usage_update')
    for (let i = 0; i < 200 && !ring(); i++) await new Promise(r => setTimeout(r, 5))
    assert.deepEqual([ring()?.used, ring()?.size], [12_000, 1_000_000])
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

async function finishReply(s: PiAcpSession, proc: FakePiRpcProcess, tokens: number) {
  proc.sessionStats = { contextUsage: { tokens, contextWindow: 1_000_000 } }
  const reply = s.prompt('work')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await reply, 'end_turn')
  await new Promise(r => setTimeout(r, 0))
}

test('compaction: at a chosen size, a reply that ends over it compacts, and a message sent meanwhile waits', async () => {
  const { proc, s, updates } = session(true)
  let finish: (result: unknown) => void = () => {}
  proc.compactResult = new Promise(r => (finish = r))
  s.setCompactAt('400000')
  await finishReply(s, proc, 450_000)
  assert.equal(proc.compactCalls, 1)

  void s.prompt('next')
  assert.equal(proc.prompts.length, 1)

  finish({ summary: SUMMARY, tokensBefore: 450_000, estimatedTokensAfter: 40_000 })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['work', 'next']
  )
  assert.ok((await updates()).some(u => u.sessionUpdate === 'compaction_update' && u.status === 'completed'))
})

test('compaction: each thread keeps its own size, and a reopened thread gets its pick back', () => {
  const store = new SessionStore(join(mkdtempSync(join(tmpdir(), 'pi-acp-map-')), 'session-map.json'))
  const open = (sessionId: string) => {
    store.upsert({ sessionId, cwd: process.cwd(), sessionFile: `/tmp/${sessionId}.jsonl` })
    return new PiAcpSession({
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
      proc: new FakePiRpcProcess() as any,
      conn: asAgentConn(new FakeAgentSideConnection()),
      store
    })
  }
  const a = open('a')
  const b = open('b')
  a.setCompactAt('200000')
  b.setCompactAt('400000')
  assert.deepEqual([a.compactAt, b.compactAt], [200_000, 400_000])

  assert.equal(open('a').compactAt, 200_000)
  b.setCompactAt('model_limit')
  assert.equal(open('b').compactAt, null)
  assert.equal(open('never-picked').compactAt, null)

  store.setCompactAt('a', 123_000)
  assert.equal(open('a').compactAt, null, 'a saved size the menu no longer lists falls back to Model limit')
})

test('compaction: a reply under the chosen size, or with no size chosen, leaves compaction to pi', async () => {
  const { proc, s } = session(true)
  s.setCompactAt('400000')
  await finishReply(s, proc, 350_000)
  s.setCompactAt('model_limit')
  await finishReply(s, proc, 900_000)
  assert.equal(proc.compactCalls, 0)
})

test('compaction: Stop during the after-reply compaction aborts it, drops the waiting message, and later messages run', async () => {
  const { proc, s } = session(true)
  let fail: (err: Error) => void = () => {}
  proc.compactResult = new Promise((_, r) => (fail = r))
  s.setCompactAt('400000')
  await finishReply(s, proc, 450_000)
  const waiting = s.prompt('next')
  await s.cancel()
  assert.equal(await waiting, 'cancelled')
  assert.equal(proc.abortCount, 1)

  fail(new Error('Compaction cancelled'))
  await new Promise(r => setTimeout(r, 0))
  void s.prompt('after')
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['work', 'after']
  )
})

test('compaction: an error while reporting the after-reply compaction still releases waiting messages', async () => {
  const { proc, s } = session(true)
  s.setCompactAt('400000')
  const finishCompaction = s.finishCompaction.bind(s)
  s.finishCompaction = () => {
    throw new Error('boom')
  }
  await finishReply(s, proc, 450_000)
  await new Promise(r => setTimeout(r, 0))
  s.finishCompaction = finishCompaction
  void s.prompt('after')
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['work', 'after']
  )
})

test('compaction: after a failed after-reply compaction, replies stop retrying until the size is picked again or a compaction succeeds', async () => {
  const { proc, s } = session(true)
  const failed = Promise.reject(new Error('pi compact failed: overloaded'))
  failed.catch(() => {})
  proc.compactResult = failed
  s.setCompactAt('400000')
  await finishReply(s, proc, 450_000)
  await finishReply(s, proc, 460_000)
  assert.equal(proc.compactCalls, 1)

  s.setCompactAt('400000')
  await finishReply(s, proc, 465_000)
  assert.equal(proc.compactCalls, 2)

  proc.compactResult = Promise.resolve({ summary: SUMMARY, tokensBefore: 470_000, estimatedTokensAfter: 40_000 })
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit({ type: 'compaction_end', reason: 'manual', result: { summary: SUMMARY, tokensBefore: 470_000 } })
  await finishReply(s, proc, 450_000)
  assert.equal(proc.compactCalls, 3)
})

test('compaction: a size pi measured before its own compaction finished does not compact the thread again', async () => {
  const { proc, s, updates } = session(true)
  s.setCompactAt('300000')
  const stale = { contextUsage: { tokens: 320_000, contextWindow: 1_000_000 } }
  proc.sessionStats = stale
  const reply = s.prompt('work')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.getSessionStats = async () => {
    proc.emit(END_OK)
    return stale
  }
  proc.emit({ type: 'agent_settled' })
  assert.equal(await reply, 'end_turn')
  await new Promise(r => setTimeout(r, 0))

  assert.equal(proc.compactCalls, 0)
  assert.deepEqual(
    (await updates()).filter(u => u.sessionUpdate === 'compaction_update').map(u => u.status),
    ['in_progress', 'completed']
  )

  proc.getSessionStats = async () => stale
  await finishReply(s, proc, 320_000)
  assert.equal(proc.compactCalls, 1)
})

test('compaction: a message that starts while a model switch from the last reply is applied is not compacted under', async () => {
  const { proc, s } = session(true)
  let applied: () => void = () => {}
  const setModel = proc.setModel.bind(proc)
  proc.setModel = async (provider, modelId) => {
    await new Promise<void>(r => (applied = r))
    return setModel(provider, modelId)
  }
  s.setCompactAt('400000')
  proc.sessionStats = { contextUsage: { tokens: 450_000, contextWindow: 1_000_000 } }
  const reply = s.prompt('work')
  proc.emit({ type: 'agent_start' })
  await s.setModelWhenIdle('anthropic', 'claude-sonnet-5-5')
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await reply, 'end_turn')
  void s.prompt('next')
  applied()
  await new Promise(r => setTimeout(r, 0))
  assert.equal(proc.compactCalls, 0)
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['work', 'next']
  )
})

test('compaction: the summary is written in the background before the size, and the compaction after the reply waits for it', async () => {
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-bg-')), 'session.jsonl')
  writeFileSync(sessionFile, '{"type":"session"}\n')
  let writing: (r: unknown) => void = () => {}
  let writers = 0
  const { proc, s, updates } = session(true, async () => {
    writers += 1
    return { compact: () => new Promise(r => (writing = r)), dispose: () => {} }
  })
  proc.getState = async () => ({ sessionFile, sessionId: `bg-${Date.now()}` })
  s.setCompactAt('300000')
  await finishReply(s, proc, 280_000)
  await until(() => writers > 0)
  assert.equal(writers, 1)
  assert.equal(proc.compactCalls, 0)

  await finishReply(s, proc, 305_000)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(proc.compactCalls, 0, 'the compaction waits for the background summary')
  const compactions = async () => (await updates()).filter(u => u.sessionUpdate === 'compaction_update')
  assert.deepEqual(
    (await compactions()).map(u => u.status),
    ['in_progress'],
    'the divider shows while the summary is still being written'
  )

  let piAnswers: (r: unknown) => void = () => {}
  proc.compactResult = new Promise(r => (piAnswers = r))
  writing({ summary: SUMMARY, firstKeptEntryId: 'k', estimatedTokensAfter: 20_000 })
  await until(() => proc.compactCalls > 0)
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit({ ...END_OK, reason: 'manual' })
  piAnswers(END_OK.result)
  const shown = await compactions()
  assert.deepEqual(
    shown.map(u => u.status),
    ['in_progress', 'completed']
  )
  assert.equal(new Set(shown.map(u => u.compactionId)).size, 1, "pi's own start reuses the divider")
  assert.equal(proc.compactCalls, 1)
  assert.equal(writers, 1)
})

test("compaction: on Model limit, the summary is written in the background before pi's own compaction point", async () => {
  const prev = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-agent-'))
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-bg-')), 'session.jsonl')
  writeFileSync(sessionFile, '{"type":"session"}\n')
  let writers = 0
  const { proc, s } = session(true, async () => {
    writers += 1
    return { compact: () => new Promise(() => {}), dispose: () => {} }
  })
  proc.getState = async () => ({ sessionFile, sessionId: `bg-${Date.now()}` })
  try {
    await finishReply(s, proc, 950_000)
    await new Promise(r => setTimeout(r, 20))
    assert.equal(writers, 0, "more than 32k below pi's point (1M window minus its default 16,384 reserve)")
    await finishReply(s, proc, 952_000)
    await until(() => writers > 0)
    assert.equal(proc.compactCalls, 0, 'pi compacts on its own; pi-acp only prepares the summary')
  } finally {
    s.markClosed()
    if (prev == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
  }
})

test('compaction: Stop while the background summary is still being written skips the compaction but keeps the summary', async () => {
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-bg-')), 'session.jsonl')
  writeFileSync(sessionFile, '{"type":"session","id":"e1"}\n')
  const sessionId = `bg-${Date.now()}`
  let finishWriter: (result: unknown) => void = () => {}
  let writers = 0
  const { proc, s, updates } = session(true, async () => ({
    compact: () => {
      writers += 1
      return new Promise(resolve => (finishWriter = resolve))
    },
    dispose: () => {}
  }))
  proc.getState = async () => ({ sessionFile, sessionId })
  try {
    s.setCompactAt('300000')
    await finishReply(s, proc, 280_000)
    await until(() => writers > 0)
    await finishReply(s, proc, 305_000)
    const queued = s.prompt('next')
    await s.cancel()
    assert.equal(await queued, 'cancelled')
    await new Promise(r => setTimeout(r, 20))
    assert.equal(proc.compactCalls, 0)
    assert.deepEqual(
      (await updates()).filter(u => u.sessionUpdate === 'compaction_update').map(u => u.status),
      ['in_progress', 'cancelled']
    )

    finishWriter({ summary: SUMMARY, firstKeptEntryId: 'e1', estimatedTokensAfter: 30_000 })
    const handoff = join(getPiAcpCompactionDir(), `${sessionId}.json`)
    await until(() => existsSync(handoff))
    await finishReply(s, proc, 306_000)
    assert.equal(proc.compactCalls, 1, 'the next reply over the size compacts with the kept summary')
    assert.equal(writers, 1, 'without writing it again')
  } finally {
    s.markClosed()
  }
})

const MIN = 60_000
const realSetTimeout = setTimeout

async function idleThread(
  opts: { provider?: string; pick?: string; tokens?: number; retention?: string; optedIn?: boolean } = {}
) {
  const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-idle-')), 'session.jsonl')
  writeFileSync(sessionFile, '{"type":"session","id":"e1"}\n')
  let writers = 0
  let finishWriter: (result: unknown) => void = () => {}
  const { proc, s, updates } = session(true, async () => {
    writers += 1
    return { compact: () => new Promise(r => (finishWriter = r)), dispose: () => {} }
  })
  proc.getState = async () => ({
    model: { provider: opts.provider ?? 'anthropic', id: 'claude' },
    sessionFile,
    sessionId: `idle-${Math.random()}`
  })
  const prev = process.env.PI_CACHE_RETENTION
  const prevSwitch = process.env.PI_ACP_IDLE_COMPACTION
  if (opts.retention === undefined) process.env.PI_CACHE_RETENTION = 'long'
  else delete process.env.PI_CACHE_RETENTION
  if (opts.optedIn === false) delete process.env.PI_ACP_IDLE_COMPACTION
  else process.env.PI_ACP_IDLE_COMPACTION = '1'
  test.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const settle = () => new Promise(r => realSetTimeout(r, 30))
  const eventually = async (ok: () => boolean, message: string) => {
    for (let i = 0; !ok(); i++) {
      assert.ok(i < 200, message)
      await settle()
    }
  }
  const reply = async (tokens: number) => {
    proc.sessionStats = { contextUsage: { tokens, contextWindow: 1_000_000 } }
    const done = s.prompt('work')
    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'turn_start' })
    proc.emit({ type: 'turn_end' })
    proc.emit({ type: 'agent_end' })
    proc.emit({ type: 'agent_settled' })
    await done
    await settle()
  }
  s.setCompactAt(opts.pick ?? '300000')
  await reply(opts.tokens ?? 250_000)
  const wait = async (ms: number) => {
    test.mock.timers.tick(ms)
    await settle()
  }
  const cleanup = () => {
    test.mock.timers.reset()
    s.markClosed()
    if (prev == null) delete process.env.PI_CACHE_RETENTION
    else process.env.PI_CACHE_RETENTION = prev
    if (prevSwitch == null) delete process.env.PI_ACP_IDLE_COMPACTION
    else process.env.PI_ACP_IDLE_COMPACTION = prevSwitch
  }
  return {
    proc,
    s,
    updates,
    reply,
    wait,
    settle,
    eventually,
    cleanup,
    writers: () => writers,
    finishWriter: (r: unknown) => finishWriter(r)
  }
}

test('idle compaction: a thread over 200k left alone gets its summary at 54 minutes and is compacted at the hour', async () => {
  const t = await idleThread()
  try {
    await t.wait(53 * MIN)
    assert.equal(t.writers(), 0)
    await t.wait(1 * MIN)
    await t.eventually(() => t.writers() === 1, 'the summary is written before the 1-hour cache expires')
    t.finishWriter({ summary: SUMMARY, firstKeptEntryId: 'e1', estimatedTokensAfter: 30_000 })
    await t.settle()
    await t.wait(5 * MIN)
    assert.equal(t.proc.compactCalls, 0, 'the cache is still warm, so the full thread stays')
    await t.wait(1 * MIN)
    await t.eventually(() => t.proc.compactCalls === 1, 'compacted at the hour')
    test.mock.timers.reset()
    assert.ok((await t.updates()).some(u => u.sessionUpdate === 'compaction_update' && u.status === 'in_progress'))
  } finally {
    t.cleanup()
  }
})

test('idle compaction: a message before the hour keeps the full thread', async () => {
  const t = await idleThread()
  try {
    await t.wait(55 * MIN)
    await t.eventually(() => t.writers() === 1, 'summary started')
    await t.reply(150_000)
    await t.wait(10 * MIN)
    assert.equal(t.proc.compactCalls, 0)
  } finally {
    t.cleanup()
  }
})

test('idle compaction: skipped unless opted in, asleep past the hour, under 200k, on Model limit, off Anthropic, or without the 1-hour cache', async () => {
  const cases = [
    { name: 'not opted in', opts: { optedIn: false } },
    { name: 'asleep', opts: {}, asleep: true },
    { name: 'under 200k', opts: { tokens: 150_000 } },
    { name: 'Model limit', opts: { pick: 'model_limit' } },
    { name: 'other provider', opts: { provider: 'cursor' } },
    { name: 'short cache', opts: { retention: 'short' } }
  ]
  for (const c of cases) {
    const t = await idleThread(c.opts)
    try {
      if (c.asleep) test.mock.timers.setTime(Date.now() + 2 * 60 * MIN)
      await t.wait(54 * MIN)
      await t.wait(6 * MIN)
      assert.equal(t.writers(), 0, c.name)
      assert.equal(t.proc.compactCalls, 0, c.name)
    } finally {
      t.cleanup()
    }
  }
})

test('idle compaction: a failed summary leaves the thread to pi instead of compacting from the expired cache', async () => {
  const t = await idleThread()
  try {
    await t.wait(54 * MIN)
    await t.eventually(() => t.writers() === 1, 'summary started')
    t.finishWriter({})
    await t.eventually(() => !(t.s as any).background.covers(250_000), 'the failed summary never finished')
    await t.wait(6 * MIN)
    assert.equal(t.proc.compactCalls, 0)
  } finally {
    t.cleanup()
  }
})
