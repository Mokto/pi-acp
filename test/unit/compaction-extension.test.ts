import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import compactionHandoff from '../../src/pi-rpc/compaction-extension.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-handoff-'))
  const old = process.env.PI_ACP_COMPACTION_HANDOFF_DIR
  process.env.PI_ACP_COMPACTION_HANDOFF_DIR = dir
  let handler: ((e: any, ctx: any) => unknown) | null = null
  compactionHandoff({ on: (_event, h) => void (handler = h as any) })
  process.env.PI_ACP_COMPACTION_HANDOFF_DIR = old
  const file = join(dir, 'pi-session.json')
  writeFileSync(
    file,
    JSON.stringify({ summary: 'S', firstKeptEntryId: 'k', details: { readFiles: [] }, maxTokensBefore: 320_000 })
  )
  const run = (entries: Array<{ id: string; type: string }>, customInstructions?: string, tokensBefore = 310_000) =>
    handler!(
      { branchEntries: entries, customInstructions, preparation: { tokensBefore } },
      { sessionManager: { getSessionId: () => 'pi-session' } }
    )
  return { file, run }
}

const m = (id: string) => ({ id, type: 'message' })

test('compaction extension: hands pi the background summary once, with the live size', () => {
  const { file, run } = setup()
  assert.deepEqual(run([{ id: 'c0', type: 'compaction' }, m('a'), m('k'), m('b')]), {
    compaction: {
      summary: 'S',
      firstKeptEntryId: 'k',
      tokensBefore: 310_000,
      details: { readFiles: [] },
      usage: undefined
    }
  })
  assert.equal(existsSync(file), false)
  assert.equal(run([m('a'), m('k')]), undefined)
})

test('compaction extension: leaves pi to summarize when the summary no longer fits the thread', () => {
  assert.equal(setup().run([m('a'), m('k'), { id: 'c1', type: 'compaction' }, m('b')]), undefined)
  assert.equal(setup().run([m('a'), m('b')]), undefined)
  assert.equal(
    setup().run([m('a'), m('k')], undefined, 320_000),
    undefined,
    'a thread that grew too far since the summary, e.g. a reply that overflowed, gets a fresh one'
  )
  const { file, run } = setup()
  assert.equal(run([m('a'), m('k')], 'focus on the API'), undefined)
  assert.ok(existsSync(file), '/compact with instructions keeps the summary for later')
})

test('compaction extension: does nothing outside pi-acp', () => {
  let registered = false
  const old = process.env.PI_ACP_COMPACTION_HANDOFF_DIR
  delete process.env.PI_ACP_COMPACTION_HANDOFF_DIR
  compactionHandoff({ on: () => void (registered = true) })
  process.env.PI_ACP_COMPACTION_HANDOFF_DIR = old
  assert.equal(registered, false)
})
