import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  buildPlanUsageOption,
  pickPlanUsageRow,
  readPlanUsage,
  type PlanUsage
} from '../../src/acp/translate/plan-usage.js'
import { buildSessionConfigOptions } from '../../src/acp/translate/config-options.js'

process.env.TZ = 'UTC'

const now = new Date('2026-10-19T15:00:00Z')
const updatedAt = '2026-10-19T14:59:00Z'
const usage: PlanUsage = {
  cursor: {
    updatedAt,
    windows: [{ label: 'Monthly', utilization: 0.05, resetsAt: '2026-11-09T13:19:00Z' }]
  },
  anthropic: {
    updatedAt,
    windows: [
      { label: '5-hour', utilization: 0.3, resetsAt: '2026-10-19T19:48:00Z' },
      { label: 'Weekly', utilization: 0.78, resetsAt: '2026-10-21T19:00:00Z' }
    ]
  }
}

type Select = Extract<SessionConfigOption, { type: 'select' }>
type Group = { group: string; name: string; options: Array<{ value: string; name: string; description: string }> }

function select(o: SessionConfigOption | null): Select {
  assert.ok(o)
  assert.equal(o.type, 'select')
  return o as Select
}
const groups = (o: Select) => o.options as Group[]
const limits = (o: Select) => groups(o).slice(1)
const clock = (iso: string) =>
  new Date(iso).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
const shown = (o: Select) =>
  groups(o)
    .flatMap(g => g.options)
    .find(x => x.value === o.currentValue)?.name

test('plan usage: providers in a fixed order, one row each under a "resets in" heading, dated when over a day away', () => {
  assert.deepEqual(limits(select(buildPlanUsageOption(usage, 'anthropic', now, null))), [
    {
      group: 'anthropic:5-hour',
      name: 'Resets in 4h 48m',
      options: [{ value: 'anthropic:5-hour', name: 'Anthropic / 5-hour · 30%', description: 'Resets 19:48' }]
    },
    {
      group: 'anthropic:Weekly',
      name: `Resets in 2d 4h · ${clock('2026-10-21T19:00:00Z')}`,
      options: [
        {
          value: 'anthropic:Weekly',
          name: 'Anthropic / Weekly · 78%',
          description: `Resets ${clock('2026-10-21T19:00:00Z')}`
        }
      ]
    },
    {
      group: 'cursor:Monthly',
      name: `Resets in 20d 22h · ${clock('2026-11-09T13:19:00Z')}`,
      options: [
        {
          value: 'cursor:Monthly',
          name: 'Cursor / Monthly · 5%',
          description: `Resets ${clock('2026-11-09T13:19:00Z')}`
        }
      ]
    }
  ])
})

test('plan usage: Automatic comes first, mirrors the limit closest to running out without repeating the model provider, and explains itself', () => {
  const o = select(buildPlanUsageOption(usage, 'anthropic', now, null))
  const [automatic] = groups(o)
  assert.equal(automatic?.name, 'Automatic')
  assert.equal(automatic?.options[0]?.value, 'automatic')
  assert.equal(
    automatic?.options[0]?.description.startsWith(
      `Anthropic / Weekly · 78% · Resets ${clock('2026-10-21T19:00:00Z')}. `
    ),
    true
  )
  assert.match(automatic?.options[0]?.description ?? '', /closest to running out/)
  assert.equal(o.currentValue, 'automatic')
  assert.equal(shown(o), 'Weekly · 78%')
})

test("plan usage: the button follows the current model; a pick chooses among that provider's limits", () => {
  assert.equal(shown(select(buildPlanUsageOption(usage, 'cursor', now, null))), 'Monthly · 5%')
  assert.equal(shown(select(buildPlanUsageOption(usage, 'deepseek', now, null))), 'Anthropic / Weekly · 78%')
  const picked = select(buildPlanUsageOption(usage, 'anthropic', now, 'anthropic:5-hour'))
  assert.equal(picked.currentValue, 'anthropic:5-hour')
  assert.equal(shown(picked), 'Anthropic / 5-hour · 30%')
  const otherProvider = select(buildPlanUsageOption(usage, 'cursor', now, 'anthropic:5-hour'))
  assert.equal(otherProvider.currentValue, 'automatic')
  assert.equal(shown(otherProvider), 'Monthly · 5%')
  assert.equal(
    shown(select(buildPlanUsageOption(usage, 'deepseek', now, 'anthropic:5-hour'))),
    'Anthropic / 5-hour · 30%'
  )
})

test('plan usage: picking Automatic clears an earlier pick', () => {
  pickPlanUsageRow('anthropic:5-hour')
  assert.equal(select(buildPlanUsageOption(usage, 'anthropic', now)).currentValue, 'anthropic:5-hour')
  pickPlanUsageRow('automatic')
  assert.equal(select(buildPlanUsageOption(usage, 'anthropic', now)).currentValue, 'automatic')
})

test('plan usage: under an hour shows minutes; tiny nonzero usage does not read as 0%', () => {
  const o = select(
    buildPlanUsageOption(
      {
        anthropic: {
          updatedAt,
          windows: [{ label: '5-hour', utilization: 0.004, resetsAt: '2026-10-19T15:07:30Z' }]
        }
      },
      null,
      now,
      null
    )
  )
  assert.equal(limits(o)[0]?.name, 'Resets in 8m')
  assert.equal(limits(o)[0]?.options[0]?.name, 'Anthropic / 5-hour · 0.4%')
})

test('plan usage: a window whose reset has passed shows as reset, not as a stale number', () => {
  const o = select(buildPlanUsageOption(usage, 'anthropic', new Date('2026-10-19T20:00:00Z'), null))
  assert.equal(limits(o)[0]?.options[0]?.name, 'Anthropic / 5-hour · reset')
  assert.equal(shown(o), 'Weekly · 78%')
})

test('plan usage: a provider not updated for a week drops out; nothing left hides the option', () => {
  const later = new Date('2026-10-27T15:00:00Z')
  assert.equal(buildPlanUsageOption(usage, null, later), null)
  assert.equal(buildPlanUsageOption(null, null, now), null)
  assert.equal(readPlanUsage(join(tmpdir(), 'does-not-exist')), null)
})

test('plan usage: one file per provider is read from disk and listed first among the config options', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'plan-usage-')), 'plan-usage')
  mkdirSync(dir)
  writeFileSync(join(dir, 'anthropic.json'), JSON.stringify(usage.anthropic))
  writeFileSync(join(dir, 'broken.json'), '{')
  const read = readPlanUsage(dir)
  assert.deepEqual(Object.keys(read ?? {}), ['anthropic'])
  const options = buildSessionConfigOptions(null, { availableModes: [], currentModeId: 'off' }, read)
  assert.equal(options[0]?.id, 'plan_usage')
})

test('plan usage: malformed windows and odd file names are dropped on read, repeated labels shown once', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'plan-usage-')), 'plan-usage')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'openai-codex.json'),
    JSON.stringify({
      updatedAt,
      windows: [
        null,
        'oops',
        { label: '5-hour', utilization: 0.1, resetsAt: 'not a date' },
        { label: '5-hour', utilization: '0.1', resetsAt: '2026-10-21T19:00:00Z' },
        { label: 'Weekly', utilization: 0.2, resetsAt: '2026-10-21T19:00:00Z' },
        { label: 'Weekly', utilization: 0.3, resetsAt: '2026-10-21T19:00:00Z' }
      ]
    })
  )
  writeFileSync(join(dir, '__proto__.json'), JSON.stringify(usage.anthropic))
  writeFileSync(join(dir, 'null.json'), 'null')
  const read = readPlanUsage(dir)
  assert.deepEqual(Object.keys(read ?? {}), ['openai-codex'])
  assert.deepEqual(
    limits(select(buildPlanUsageOption(read, null, now, null))).map(g => g.options[0]?.name),
    ['OpenAI Codex / Weekly · 20%']
  )
})

test('plan usage: a provider file named after an Object built-in still gets a plain label', () => {
  const o = select(
    buildPlanUsageOption(
      {
        constructor: { updatedAt, windows: [{ label: 'Weekly', utilization: 0.5, resetsAt: '2026-10-21T19:00:00Z' }] }
      },
      null,
      now,
      null
    )
  )
  assert.equal(limits(o)[0]?.options[0]?.name, 'Constructor / Weekly · 50%')
})
