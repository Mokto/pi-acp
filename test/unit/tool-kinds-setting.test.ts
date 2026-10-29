import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getToolKinds } from '../../src/acp/pi-settings.js'

function withAgentDir<T>(settings: Record<string, unknown> | null, run: (agentDir: string) => T): T {
  const prev = process.env.PI_CODING_AGENT_DIR
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-toolkinds-'))
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    return run(dir)
  } finally {
    if (prev == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
  }
}

test('getToolKinds: empty when unset', () => {
  withAgentDir(null, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.deepEqual([...getToolKinds(cwd)], [])
  })
})

test('getToolKinds: keeps valid ACP kinds and drops anything else', () => {
  withAgentDir({ acpToolKinds: { a: 'fetch', b: 'hammer', c: 3, d: 'switch_mode' } }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.deepEqual(Object.fromEntries(getToolKinds(cwd)), { a: 'fetch', d: 'switch_mode' })
  })
})

test('getToolKinds: project settings add to and override global ones', () => {
  withAgentDir({ acpToolKinds: { a: 'fetch', b: 'edit' } }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ acpToolKinds: { b: 'read', c: 'search' } }))
    assert.deepEqual(Object.fromEntries(getToolKinds(cwd)), { a: 'fetch', b: 'read', c: 'search' })
  })
})
