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

test('plan usage: providers in a fixed order, with local reset times and dates outside today', () => {
  assert.deepEqual(limits(select(buildPlanUsageOption(usage, 'anthropic', now, null))), [
    {
      group: 'anthropic:5-hour',
      name: 'Resets at 19:48',
      options: [{ value: 'anthropic:5-hour', name: 'Anthropic / 5-hour · 30%', description: 'Resets 19:48' }]
    },
    {
      group: 'anthropic:Weekly',
      name: `Resets at ${clock('2026-10-21T19:00:00Z')}`,
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
      name: `Resets at ${clock('2026-11-09T13:19:00Z')}`,
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

test('plan usage: unchanged usage does not rebuild dropdowns merely because a minute passed', () => {
  assert.deepEqual(
    buildPlanUsageOption(usage, 'anthropic', new Date(now.getTime() + 60_000), null),
    buildPlanUsageOption(usage, 'anthropic', now, null)
  )
})

test('plan usage: fresh percentages still update without changing the reset heading', () => {
  const changed = structuredClone(usage)
  changed.anthropic!.windows[1]!.utilization = 0.8
  const before = select(buildPlanUsageOption(usage, 'anthropic', now, null))
  const after = select(buildPlanUsageOption(changed, 'anthropic', now, null))
  assert.equal(shown(after), 'Weekly · 80%')
  assert.equal(limits(after)[1]?.name, limits(before)[1]?.name)
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

test('plan usage: a nearby reset shows its clock time; tiny nonzero usage does not read as 0%', () => {
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
  assert.equal(limits(o)[0]?.name, 'Resets at 15:07')
  assert.equal(limits(o)[0]?.options[0]?.name, 'Anthropic / 5-hour · 0.4%')
})

test('plan usage: dates distinguish tomorrow and the same weekday next week from today', () => {
  for (const resetsAt of ['2026-10-20T01:00:00Z', '2026-10-26T14:00:00Z']) {
    const o = select(
      buildPlanUsageOption(
        { anthropic: { updatedAt, windows: [{ label: 'Weekly', utilization: 0.1, resetsAt }] } },
        null,
        now,
        null
      )
    )
    assert.equal(limits(o)[0]?.name, `Resets at ${clock(resetsAt)}`)
  }
})

test('plan usage: a window whose reset has passed shows as reset, not as a stale number', () => {
  const o = select(buildPlanUsageOption(usage, 'anthropic', new Date('2026-10-19T19:48:00Z'), null))
  assert.equal(limits(o)[0]?.name, 'Updates after the next reply')
  assert.equal(limits(o)[0]?.options[0]?.name, 'Anthropic / 5-hour · reset')
  assert.equal(shown(o), 'Weekly · 78%')
})

test('plan usage: a provider not updated for a week drops out; nothing left hides the option', () => {
  const later = new Date('2026-10-27T15:00:00Z')
  assert.equal(buildPlanUsageOption(usage, null, later), null)
  assert.equal(buildPlanUsageOption(null, null, now), null)
  assert.equal(readPlanUsage(join(tmpdir(), 'does-not-exist')), null)
})

test('plan usage: one file per provider is read from disk and listed right after the compaction size', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'plan-usage-')), 'plan-usage')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'anthropic.json'),
    JSON.stringify({ ...usage.anthropic, updatedAt: new Date().toISOString() })
  )
  writeFileSync(join(dir, 'broken.json'), '{')
  const read = readPlanUsage(dir)
  assert.deepEqual(Object.keys(read ?? {}), ['anthropic'])
  const options = buildSessionConfigOptions(null, { availableModes: [], currentModeId: 'off' }, read)
  assert.deepEqual(
    options.map(o => o.id),
    ['compact_at', 'plan_usage']
  )
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
