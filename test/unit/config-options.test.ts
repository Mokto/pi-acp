import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  buildSessionConfigOptions,
  MODEL_CONFIG_ID,
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
  assert.equal(options.length, 2)

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
    [THINKING_CONFIG_ID]
  )
})

test('buildSessionConfigOptions: omits thinking select when no modes are available', () => {
  const options = buildSessionConfigOptions(models, { currentModeId: 'medium', availableModes: [] })
  assert.deepEqual(
    options.map(o => o.id),
    [MODEL_CONFIG_ID]
  )
})
