import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAutoCompactionPoint } from '../../src/acp/pi-settings.js'

function withSettings(
  global: Record<string, unknown> | null,
  project: Record<string, unknown> | null,
  run: (cwd: string) => void
) {
  const prev = process.env.PI_CODING_AGENT_DIR
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-agent-'))
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
  if (global) writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(global))
  if (project) {
    mkdirSync(join(cwd, '.pi'))
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(project))
  }
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    run(cwd)
  } finally {
    if (prev == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
  }
}

test("getAutoCompactionPoint: pi's default reserve below the window", () => {
  withSettings(null, null, cwd => assert.equal(getAutoCompactionPoint(cwd, 1_000_000), 983_616))
})

test('getAutoCompactionPoint: reserveTokens from global settings, overridden by the project', () => {
  withSettings({ compaction: { reserveTokens: 32_768 } }, null, cwd =>
    assert.equal(getAutoCompactionPoint(cwd, 1_000_000), 967_232)
  )
  withSettings({ compaction: { reserveTokens: 32_768 } }, { compaction: { reserveTokens: 50_000 } }, cwd =>
    assert.equal(getAutoCompactionPoint(cwd, 1_000_000), 950_000)
  )
})

test('getAutoCompactionPoint: none when automatic compaction is off', () => {
  withSettings({ compaction: { enabled: false, reserveTokens: 32_768 } }, null, cwd =>
    assert.equal(getAutoCompactionPoint(cwd, 1_000_000), null)
  )
})
