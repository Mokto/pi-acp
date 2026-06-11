import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEnableExtensionCommands } from '../../src/acp/pi-settings.js'

function withAgentDir<T>(settings: Record<string, unknown> | null, run: (agentDir: string) => T): T {
  const prev = process.env.PI_CODING_AGENT_DIR
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-extcmds-'))
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    return run(dir)
  } finally {
    if (prev == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
  }
}

test('getEnableExtensionCommands: defaults to true when unset', () => {
  withAgentDir(null, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.equal(getEnableExtensionCommands(cwd), true)
  })
})

test('getEnableExtensionCommands: respects a global false override', () => {
  withAgentDir({ enableExtensionCommands: false }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.equal(getEnableExtensionCommands(cwd), false)
  })
})

test('getEnableExtensionCommands: project settings override global', () => {
  withAgentDir({ enableExtensionCommands: false }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ enableExtensionCommands: true }), 'utf-8')
    assert.equal(getEnableExtensionCommands(cwd), true)
  })
})
