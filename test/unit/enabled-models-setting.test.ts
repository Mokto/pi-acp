import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEnabledModels } from '../../src/acp/pi-settings.js'

function withAgentDir<T>(settings: Record<string, unknown> | null, run: (agentDir: string) => T): T {
  const prev = process.env.PI_CODING_AGENT_DIR
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-enabledmodels-'))
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    return run(dir)
  } finally {
    if (prev == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
  }
}

test('getEnabledModels: undefined when unset', () => {
  withAgentDir(null, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.equal(getEnabledModels(cwd), undefined)
  })
})

test('getEnabledModels: returns the configured patterns', () => {
  withAgentDir({ enabledModels: ['anthropic/Claude Sonnet 4.6', 'cursor/composer-2-5'] }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.deepEqual(getEnabledModels(cwd), ['anthropic/Claude Sonnet 4.6', 'cursor/composer-2-5'])
  })
})

test('getEnabledModels: drops empty / non-string entries', () => {
  withAgentDir({ enabledModels: ['anthropic/*', '', '   ', 42, null] }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.deepEqual(getEnabledModels(cwd), ['anthropic/*'])
  })
})

test('getEnabledModels: undefined for an empty array', () => {
  withAgentDir({ enabledModels: [] }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.equal(getEnabledModels(cwd), undefined)
  })
})

test('getEnabledModels: project settings override global', () => {
  withAgentDir({ enabledModels: ['anthropic/*'] }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    writeFileSync(
      join(cwd, '.pi', 'settings.json'),
      JSON.stringify({ enabledModels: ['cursor/composer-2-5'] }),
      'utf-8'
    )
    assert.deepEqual(getEnabledModels(cwd), ['cursor/composer-2-5'])
  })
})
