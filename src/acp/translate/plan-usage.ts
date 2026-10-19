import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { getAgentDir } from '../pi-settings.js'
import { providerDisplayName } from './provider-name.js'

export const PLAN_USAGE_CONFIG_ID = 'plan_usage'
const AUTOMATIC = 'automatic'

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const PROVIDER_ORDER = ['anthropic', 'openai-codex', 'cursor']

export type UsageWindow = { label: string; utilization: number; resetsAt: string }

// One file per provider (`<agentDir>/plan-usage/<provider>.json`, named after
// pi's provider id), written by a pi extension from response headers or the
// provider's usage API. The figures are account-wide, so every session reads
// the same files.
export type ProviderUsage = { updatedAt: string; windows: UsageWindow[] }
export type PlanUsage = Record<string, ProviderUsage>

// ponytail: one pick for the whole process, since the limits are account-wide
// and Zed replays its saved default into every new session anyway. Ceiling: two
// Zed windows can't show different limits; keep the pick per session to lift it.
let pickedRow: string | null = null

export function pickPlanUsageRow(value: string): void {
  pickedRow = value === AUTOMATIC ? null : value
}

export function getPlanUsageDir(): string {
  return join(getAgentDir(), 'plan-usage')
}

function isUsageWindow(w: unknown): w is UsageWindow {
  const { label, utilization, resetsAt } = (w ?? {}) as Partial<UsageWindow>
  return (
    typeof label === 'string' &&
    typeof utilization === 'number' &&
    Number.isFinite(utilization) &&
    typeof resetsAt === 'string' &&
    !Number.isNaN(Date.parse(resetsAt))
  )
}

export function readPlanUsage(dir = getPlanUsageDir()): PlanUsage | null {
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => /^[a-z0-9-]+\.json$/.test(f))
  } catch {
    return null
  }
  const usage: PlanUsage = {}
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Partial<ProviderUsage> | null
      if (typeof parsed?.updatedAt !== 'string' || !Array.isArray(parsed.windows)) continue
      usage[basename(file, '.json')] = { updatedAt: parsed.updatedAt, windows: parsed.windows.filter(isUsageWindow) }
    } catch {
      // ignore
    }
  }
  return Object.keys(usage).length ? usage : null
}

function formatPercent(fraction: number): string {
  const pct = fraction * 100
  const whole = Math.round(pct)
  return whole === 0 && pct > 0 ? `${Number(pct.toFixed(2))}%` : `${whole}%`
}

function formatTimeUntil(ms: number): string {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function formatClock(date: Date, now: Date): string {
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (date.toDateString() === now.toDateString()) return time
  return `${date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

function providerRank(id: string): number {
  const i = PROVIDER_ORDER.indexOf(id)
  return i === -1 ? PROVIDER_ORDER.length : i
}

type LimitRow = { id: string; value: string; heading: string; name: string; description: string; utilization: number }

function limitRows(usage: PlanUsage, now: Date): LimitRow[] {
  const seen = new Set<string>()
  return Object.entries(usage)
    .filter(([, p]) => now.getTime() - Date.parse(p.updatedAt) <= STALE_AFTER_MS)
    .sort(([a], [b]) => providerRank(a) - providerRank(b) || a.localeCompare(b))
    .flatMap(([id, provider]) =>
      provider.windows.flatMap(w => {
        const value = `${id}:${w.label}`
        if (seen.has(value)) return []
        seen.add(value)
        const resetsAt = new Date(w.resetsAt)
        const msLeft = resetsAt.getTime() - now.getTime()
        const label = `${providerDisplayName(id)} / ${w.label}`
        const expired = msLeft <= 0
        return [
          {
            id,
            value,
            heading: expired ? 'Updates after the next reply' : `Resets in ${formatTimeUntil(msLeft)}`,
            name: `${label} · ${expired ? 'reset' : formatPercent(w.utilization)}`,
            description: `${expired ? 'Reset at' : 'Resets'} ${formatClock(resetsAt, now)}`,
            utilization: expired ? -1 : w.utilization
          }
        ]
      })
    )
}

export function buildPlanUsageOption(
  usage: PlanUsage | null,
  currentProvider: string | null = null,
  now = new Date(),
  picked = pickedRow
): SessionConfigOption | null {
  if (!usage) return null

  const rows = limitRows(usage, now)
  if (!rows.length) return null

  const closestToLimit = (candidates: LimitRow[]) =>
    candidates.reduce((a, b) => (b.utilization > a.utilization ? b : a))
  const forModel = rows.filter(r => r.id === currentProvider)
  const automatic = closestToLimit(forModel.length ? forModel : rows)
  const pickedLimit = rows.find(r => r.value === picked)
  const pickApplies = pickedLimit && (!forModel.length || pickedLimit.id === currentProvider)

  return {
    type: 'select',
    id: PLAN_USAGE_CONFIG_ID,
    name: 'Plan usage',
    description:
      'Subscription limits per provider, for the whole account. The button follows the current model and shows the limit closest to running out, unless you pick one.',
    currentValue: pickApplies ? pickedLimit.value : AUTOMATIC,
    options: [
      {
        group: AUTOMATIC,
        name: 'Automatic',
        options: [
          {
            value: AUTOMATIC,
            name: automatic.name,
            description:
              "Shows whichever of the current model's limits is closest to running out. Pick a limit below to always show that one instead."
          }
        ]
      },
      ...rows.map(({ value, heading, name, description }) => ({
        group: value,
        name: heading,
        options: [{ value, name, description }]
      }))
    ]
  }
}
