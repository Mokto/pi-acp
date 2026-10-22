import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  buildSessionConfigOptions,
  COMPACT_AT_CONFIG_ID,
  compactAtTokens,
  MODEL_CONFIG_ID,
  pickCompactAt,
  THINKING_CONFIG_ID,
  type ConfigModelState,
  type ConfigThinkingState
} from '../../src/acp/translate/config-options.js'

function findSelect(options: SessionConfigOption[], id: string): Extract<SessionConfigOption, { type: 'select' }> {
  const o = options.find(x => x.id === id)
  assert.ok(o)
  assert.equal(o.type, 'select')
  return o as Extract<SessionConfigOption, { type: 'select' }>
}

const models: ConfigModelState = {
  currentModelId: 'anthropic/claude',
  availableModels: [
    { modelId: 'anthropic/claude', name: 'anthropic/Claude', description: null },
    { modelId: 'openai/gpt', name: 'openai/GPT', description: 'fast' }
  ]
}

const thinking: ConfigThinkingState = {
  currentModeId: 'medium',
  availableModes: [
    { id: 'off', name: 'Off' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' }
  ]
}

test('buildSessionConfigOptions: advertises model + thinking selects with categories', () => {
  const options = buildSessionConfigOptions(models, thinking)
  assert.equal(options.length, 3)

  const model = findSelect(options, MODEL_CONFIG_ID)
  assert.equal(model.category, 'model')
  assert.equal(model.currentValue, 'anthropic/claude')
  assert.deepEqual(model.options, [
    { value: 'anthropic/claude', name: 'anthropic/Claude', description: null },
    { value: 'openai/gpt', name: 'openai/GPT', description: 'fast' }
  ])

  const think = findSelect(options, THINKING_CONFIG_ID)
  assert.equal(think.category, 'thought_level')
  assert.equal(think.currentValue, 'medium')
  assert.deepEqual(think.options, [
    { value: 'off', name: 'Off', description: null },
    { value: 'medium', name: 'Medium', description: null },
    { value: 'high', name: 'High', description: null }
  ])
})

test('buildSessionConfigOptions: currentValue is always one of the advertised model values', () => {
  const model = findSelect(buildSessionConfigOptions(models, thinking), MODEL_CONFIG_ID)
  assert.ok(model.options.some(o => 'value' in o && o.value === model.currentValue))
})

test('buildSessionConfigOptions: omits model select when no models are available', () => {
  const options = buildSessionConfigOptions(null, thinking)
  assert.deepEqual(
    options.map(o => o.id),
    [COMPACT_AT_CONFIG_ID, THINKING_CONFIG_ID]
  )
})

test('buildSessionConfigOptions: omits thinking select when no modes are available', () => {
  const options = buildSessionConfigOptions(models, { currentModeId: 'medium', availableModes: [] })
  assert.deepEqual(
    options.map(o => o.id),
    [COMPACT_AT_CONFIG_ID, MODEL_CONFIG_ID]
  )
})

test('compaction option: the button names the pick, and a stale saved value falls back to the model limit', () => {
  const current = () => {
    const o = findSelect(buildSessionConfigOptions(models, thinking), COMPACT_AT_CONFIG_ID)
    const all = o.options.flatMap(x => ('options' in x ? x.options : [x]))
    return all.find(x => x.value === o.currentValue)?.name
  }
  assert.equal(current(), 'Model limit')

  pickCompactAt('400000')
  assert.equal(compactAtTokens(), 400_000)
  assert.equal(current(), '400k')

  pickCompactAt('123')
  assert.equal(compactAtTokens(), null)
  assert.equal(current(), 'Model limit')
})

test('compaction option: sizes that reach the current model window are hidden, and a pick that no longer fits shows the model limit, named by the window size', t => {
  t.after(() => pickCompactAt('model_limit'))
  const withWindow = (contextWindow: number): ConfigModelState => ({
    currentModelId: 'xai/grok',
    availableModels: [{ modelId: 'xai/grok', name: 'Grok', description: null, contextWindow }]
  })
  const menu = (contextWindow: number) => {
    const o = findSelect(buildSessionConfigOptions(withWindow(contextWindow), thinking), COMPACT_AT_CONFIG_ID)
    const rows = o.options.flatMap(x => ('options' in x ? x.options : [x]))
    return {
      headings: o.options.map(x => ('group' in x ? x.name : null)),
      rows: rows.map(x => x.name),
      current: rows.find(x => x.value === o.currentValue)?.name
    }
  }
  pickCompactAt('300000')

  assert.deepEqual(menu(256_000), { headings: ['Compact at', 'Model limit'], rows: ['200k', '256k'], current: '256k' })
  assert.deepEqual(menu(200_000).headings, ['Model limit'])
  assert.deepEqual(menu(300_000).rows, ['200k', '300k'])
  assert.deepEqual(menu(1_000_000).rows, ['200k', '300k', '400k', '500k', '1M'])
  assert.equal(menu(1_000_000).current, '300k')
  assert.equal(menu(1_050_000).rows.at(-1), '1.05M')
  assert.equal(compactAtTokens(), 300_000)
})
