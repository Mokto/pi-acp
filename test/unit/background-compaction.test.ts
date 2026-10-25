import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundCompaction, backgroundLead, type SummaryWriter } from '../../src/acp/background-compaction.js'
import { getPiAcpCompactionDir } from '../../src/acp/paths.js'
import { until } from '../helpers/until.js'

function fakeWriter(result: unknown = { summary: 'S', firstKeptEntryId: 'k1', estimatedTokensAfter: 20_000 }) {
  const calls = { copies: [] as string[], disposed: 0 }
  let finish: (r: unknown) => void = () => {}
  const pending = new Promise(r => (finish = r))
  const start = async (copy: string): Promise<SummaryWriter> => {
    calls.copies.push(readFileSync(copy, 'utf8'))
    return { compact: () => pending, dispose: () => void (calls.disposed += 1) }
  }
  return { calls, start, finish: () => finish(result) }
}

function sessionFile(text: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'pi-acp-bg-')), 'session.jsonl')
  writeFileSync(file, text)
  return { file, id: randomUUID() }
}

const settle = () => new Promise(r => setTimeout(r, 10))

test('background compaction: starts a lead below the size, rewrites an outgrown summary only before the size', async () => {
  const w = fakeWriter({ summary: 'S', firstKeptEntryId: 'k1', estimatedTokensAfter: 60_000 })
  const bg = new BackgroundCompaction(w.start)
  assert.equal(backgroundLead(300_000), 32_000)
  assert.equal(backgroundLead(200_000), 25_000)
  assert.equal(bg.shouldStart(267_999, 300_000), false)
  assert.equal(bg.shouldStart(268_000, 300_000), true)

  bg.start(Promise.resolve(sessionFile('{"a":1}\n')), 270_000, 300_000)
  assert.equal(bg.shouldStart(290_000, 300_000), false)
  w.finish()
  await bg.untilUsable(0)
  assert.equal(bg.shouldStart(284_999, 300_000), false, 'a summary that still saves enough is kept')
  assert.equal(bg.shouldStart(285_000, 300_000), true)
  assert.equal(bg.shouldStart(300_000, 300_000), false, 'past the size a rewrite would make the compaction wait')
  assert.equal(bg.shouldStart(360_000, 300_000), true, 'unless the ready summary no longer works')
  await bg.discard()
})

test('background compaction: summarizes a copy cut at the last full line and leaves the summary for pi', async () => {
  const w = fakeWriter()
  const bg = new BackgroundCompaction(w.start)
  const session = sessionFile('{"a":1}\n{"b":2}\n{"c":')
  bg.start(Promise.resolve(session), 270_000, 300_000)
  await until(() => w.calls.copies.length > 0)
  assert.deepEqual(w.calls.copies, ['{"a":1}\n{"b":2}\n'])
  w.finish()
  await bg.untilUsable(0)

  const handoff = join(getPiAcpCompactionDir(), `${session.id}.json`)
  assert.deepEqual(
    JSON.parse(readFileSync(handoff, 'utf8')),
    { summary: 'S', firstKeptEntryId: 'k1', maxTokensBefore: 400_000 },
    '20k after the swap plus growth since the 270k snapshot reaches half of 300k at 400k'
  )
  assert.equal(w.calls.disposed, 1)
})

test('background compaction: the end of a reply waits for a summary still being written', async () => {
  const w = fakeWriter()
  const bg = new BackgroundCompaction(w.start)
  const session = sessionFile('{"a":1}\n')
  bg.start(Promise.resolve(session), 270_000, 300_000)
  let written = false
  const wait = bg.untilUsable(300_000).then(() => (written = true))
  await settle()
  assert.equal(written, false)
  w.finish()
  await wait
  assert.ok(existsSync(join(getPiAcpCompactionDir(), `${session.id}.json`)))
  await bg.discard()
})

test('background compaction: the end of a reply uses the ready summary instead of waiting for its rewrite', async () => {
  const first = fakeWriter({ summary: 'S', firstKeptEntryId: 'k1', estimatedTokensAfter: 60_000 })
  const rewrite = fakeWriter()
  const writers = [first, rewrite]
  const bg = new BackgroundCompaction(copy => writers.shift()!.start(copy))
  const session = sessionFile('{"a":1}\n')
  bg.start(Promise.resolve(session), 270_000, 300_000)
  first.finish()
  await bg.untilUsable(0)
  bg.start(Promise.resolve(session), 290_000, 300_000)
  await until(() => rewrite.calls.copies.length > 0)

  let usedReady = false
  void bg.untilUsable(303_000).then(() => (usedReady = true))
  await settle()
  assert.equal(usedReady, true, '303k is under the 360k the ready summary works up to')

  let waited = false
  const outgrown = bg.untilUsable(360_000).then(() => (waited = true))
  await settle()
  assert.equal(waited, false)
  rewrite.finish()
  await outgrown
  await bg.discard()
})

test('background compaction: discarding stops the writer and leaves nothing for pi', async () => {
  const w = fakeWriter()
  const bg = new BackgroundCompaction(w.start)
  const session = sessionFile('{"a":1}\n')
  bg.start(Promise.resolve(session), 270_000, 300_000)
  await until(() => w.calls.copies.length > 0)
  await bg.discard()
  assert.equal(w.calls.disposed, 1)
  w.finish()
  await settle()
  assert.equal(existsSync(join(getPiAcpCompactionDir(), `${session.id}.json`)), false)
  assert.equal(readdirSync(getPiAcpCompactionDir()).filter(f => f.endsWith('.json.tmp')).length, 0)
  assert.equal(bg.shouldStart(270_000, 300_000), true)
})

test('background compaction: a thread that changes while the second pi starts never gets summarized', async () => {
  let started: (w: SummaryWriter) => void = () => {}
  let compacted = 0
  let disposed = 0
  let writerAsked: () => void = () => {}
  const asked = new Promise<void>(r => (writerAsked = r))
  const bg = new BackgroundCompaction(
    () =>
      new Promise(r => {
        started = r
        writerAsked()
      })
  )
  bg.start(Promise.resolve(sessionFile('{"a":1}\n')), 270_000, 300_000)
  await asked
  await bg.discard()
  started({ compact: async () => void (compacted += 1), dispose: () => void (disposed += 1) })
  await until(() => disposed > 0)
  assert.equal(compacted, 0)
  assert.equal(disposed, 1)
})

test('background compaction: a summary that fails is not retried until the next compaction or size pick', async () => {
  let attempts = 0
  const bg = new BackgroundCompaction(async () => {
    attempts += 1
    return { compact: async () => ({ error: 'nothing to compact' }), dispose: () => {} }
  })
  bg.start(Promise.resolve(sessionFile('{"a":1}\n')), 270_000, 300_000)
  await bg.untilUsable(0)
  assert.equal(attempts, 1)
  assert.equal(bg.shouldStart(280_000, 300_000), false)
  await bg.discard()
  assert.equal(bg.shouldStart(280_000, 300_000), true)
})
