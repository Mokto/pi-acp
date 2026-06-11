import type { SessionConfigOption } from '@agentclientprotocol/sdk'

// Config option ids the adapter advertises. These double as the `configId` the
// client sends back via `session/set_config_option`.
export const MODEL_CONFIG_ID = 'model'
export const THINKING_CONFIG_ID = 'thinking'

// Model selection used to be advertised purely via the ACP `models`
// (SessionModelState) field. Recent ACP clients (e.g. Zed >= the 0.13 SDK bump)
// no longer read that field for external agents and instead surface model /
// reasoning selectors through `config_options` + `session/set_config_option`.
// We mirror both selectors here so config-option-aware clients get a working
// picker, while still emitting `models`/`modes` for clients that read those.
export type ConfigModelState = {
  availableModels: Array<{ modelId: string; name: string; description?: string | null }>
  currentModelId: string
} | null

export type ConfigThinkingState = {
  availableModes: Array<{ id: string; name: string; description?: string | null }>
  currentModeId: string
}

export function buildSessionConfigOptions(
  models: ConfigModelState,
  thinking: ConfigThinkingState
): SessionConfigOption[] {
  const options: SessionConfigOption[] = []

  if (models && models.availableModels.length) {
    options.push({
      type: 'select',
      id: MODEL_CONFIG_ID,
      name: 'Model',
      category: 'model',
      currentValue: models.currentModelId,
      options: models.availableModels.map(m => ({
        value: m.modelId,
        name: m.name,
        description: m.description ?? null
      }))
    })
  }

  if (thinking.availableModes.length) {
    options.push({
      type: 'select',
      id: THINKING_CONFIG_ID,
      name: 'Thinking',
      category: 'thought_level',
      currentValue: thinking.currentModeId,
      options: thinking.availableModes.map(m => ({
        value: m.id,
        name: m.id,
        description: m.description ?? null
      }))
    })
  }

  return options
}
