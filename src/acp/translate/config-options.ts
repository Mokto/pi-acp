import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { buildPlanUsageOption, type PlanUsage } from './plan-usage.js'

// Config option ids the adapter advertises. These double as the `configId` the
// client sends back via `session/set_config_option`.
export const MODEL_CONFIG_ID = 'model'
export const THINKING_CONFIG_ID = 'thinking'
export const COMPACT_AT_CONFIG_ID = 'compact_at'

const MODEL_LIMIT = 'model_limit'
const COMPACT_AT_SIZES = [200_000, 300_000, 400_000, 500_000]
let compactAt: number | null = null

/** Zed replays saved picks into new sessions, so an unknown or stale value falls back to pi's default. */
export function pickCompactAt(value: string): void {
  const tokens = Number(value)
  compactAt = COMPACT_AT_SIZES.includes(tokens) ? tokens : null
}

/** Context size at which a finished reply triggers a compaction, or null to leave it to pi. */
export function compactAtTokens(): number | null {
  return compactAt
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}M` : `${Math.round(tokens / 1000)}k`
}

/** Sizes the current model can't reach are left out, and the button then shows what happens instead: the model's limit. */
function buildCompactAtOption(contextWindow: number | null): SessionConfigOption {
  const sizes = COMPACT_AT_SIZES.filter(tokens => !contextWindow || tokens < contextWindow)
  return {
    type: 'select',
    id: COMPACT_AT_CONFIG_ID,
    name: 'Compaction',
    description: 'When to summarize a long thread so the agent stays fast and cheap. Applies to every thread.',
    currentValue: compactAt && sizes.includes(compactAt) ? String(compactAt) : MODEL_LIMIT,
    options: [
      ...(sizes.length
        ? [
            {
              group: 'compact_at',
              name: 'Compact at',
              options: sizes.map(tokens => ({
                value: String(tokens),
                name: formatTokens(tokens),
                description: `Once a reply finishes and the thread is over ${formatTokens(tokens)} tokens, compacts it while you read. Never interrupts a task.`
              }))
            }
          ]
        : []),
      {
        group: 'model_limit',
        name: 'Model limit',
        options: [
          {
            value: MODEL_LIMIT,
            name: contextWindow ? formatTokens(contextWindow) : 'Model limit',
            description:
              "This model's limit, so it follows the model you pick. Pi compacts when the thread is nearly full, which can pause a task midway."
          }
        ]
      }
    ]
  }
}

// Model selection used to be advertised purely via the ACP `models`
// (SessionModelState) field. Recent ACP clients (e.g. Zed >= the 0.13 SDK bump)
// no longer read that field for external agents and instead surface model /
// reasoning selectors through `config_options` + `session/set_config_option`.
// We mirror both selectors here so config-option-aware clients get a working
// picker, while still emitting `models`/`modes` for clients that read those.
export type ConfigModelState = {
  availableModels: Array<{ modelId: string; name: string; description?: string | null; contextWindow?: number | null }>
  currentModelId: string
} | null

export type ConfigThinkingState = {
  availableModes: Array<{ id: string; name: string; description?: string | null }>
  currentModeId: string
}

export function buildSessionConfigOptions(
  models: ConfigModelState,
  thinking: ConfigThinkingState,
  usage: PlanUsage | null = null
): SessionConfigOption[] {
  const options: SessionConfigOption[] = []

  const currentModel = models?.availableModels.find(m => m.modelId === models.currentModelId)
  options.push(buildCompactAtOption(currentModel?.contextWindow ?? null))
  const usageOption = buildPlanUsageOption(usage, models?.currentModelId.split('/')[0] ?? null)
  if (usageOption) options.push(usageOption)

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
        name: m.name,
        description: m.description ?? null
      }))
    })
  }

  return options
}
