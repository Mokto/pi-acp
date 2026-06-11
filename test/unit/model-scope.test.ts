import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEnabledModelIds, type ScopeModel } from '../../src/acp/model-scope.js'

const MODELS: ScopeModel[] = [
  { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (latest)' },
  { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
  { provider: 'anthropic', id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { provider: 'cursor', id: 'composer-2-5', name: 'Composer 2.5 (composer-2-5)' },
  { provider: 'cursor', id: 'composer-2-5:fast', name: 'Composer 2.5 (composer-2-5, fast)' }
]

test('resolveEnabledModelIds: the user config (display name + canonical id)', () => {
  // "anthropic/Claude Sonnet 4.6" is the "provider/Name" display form the
  // adapter advertises to ACP clients, so it must resolve to the matching
  // model — even though pi's own id-based matcher would reject it.
  // "cursor/composer-2-5" is a canonical id.
  const ids = resolveEnabledModelIds(MODELS, ['anthropic/Claude Sonnet 4.6', 'cursor/composer-2-5'])
  assert.deepEqual([...ids].sort(), ['anthropic/claude-sonnet-4-6', 'cursor/composer-2-5'])
})

test('resolveEnabledModelIds: matches the advertised provider/Name display form', () => {
  assert.deepEqual(
    [...resolveEnabledModelIds(MODELS, ['anthropic/Claude Sonnet 4.6'])],
    ['anthropic/claude-sonnet-4-6']
  )
})

test('resolveEnabledModelIds: display-name match is case-insensitive and strips a thinking level', () => {
  assert.deepEqual(
    [...resolveEnabledModelIds(MODELS, ['ANTHROPIC/claude opus 4.8:high'])],
    ['anthropic/claude-opus-4-8']
  )
})

test('resolveEnabledModelIds: canonical provider/id match', () => {
  const ids = resolveEnabledModelIds(MODELS, ['anthropic/claude-sonnet-4-6'])
  assert.deepEqual([...ids], ['anthropic/claude-sonnet-4-6'])
})

test('resolveEnabledModelIds: matching is case-insensitive', () => {
  const ids = resolveEnabledModelIds(MODELS, ['ANTHROPIC/Claude-Sonnet-4-6'])
  assert.deepEqual([...ids], ['anthropic/claude-sonnet-4-6'])
})

test('resolveEnabledModelIds: glob expands to every matching model', () => {
  const ids = resolveEnabledModelIds(MODELS, ['anthropic/*'])
  assert.deepEqual([...ids].sort(), [
    'anthropic/claude-opus-4-8',
    'anthropic/claude-sonnet-4-5',
    'anthropic/claude-sonnet-4-5-20250929',
    'anthropic/claude-sonnet-4-6'
  ])
})

test('resolveEnabledModelIds: glob matches against bare model id too', () => {
  const ids = resolveEnabledModelIds(MODELS, ['*sonnet*'])
  assert.deepEqual([...ids].sort(), [
    'anthropic/claude-sonnet-4-5',
    'anthropic/claude-sonnet-4-5-20250929',
    'anthropic/claude-sonnet-4-6'
  ])
})

test('resolveEnabledModelIds: non-glob partial prefers an alias and picks one model', () => {
  // "sonnet" matches three ids; pi picks a single best model, preferring an
  // alias (no -YYYYMMDD) and the highest-sorting id among them.
  const ids = resolveEnabledModelIds(MODELS, ['sonnet'])
  assert.deepEqual([...ids], ['anthropic/claude-sonnet-4-6'])
})

test('resolveEnabledModelIds: non-glob partial falls back to latest dated version', () => {
  const dated: ScopeModel[] = [
    { provider: 'anthropic', id: 'claude-sonnet-4-5-20250101', name: 'Claude Sonnet 4.5' },
    { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' }
  ]
  const ids = resolveEnabledModelIds(dated, ['sonnet'])
  assert.deepEqual([...ids], ['anthropic/claude-sonnet-4-5-20250929'])
})

test('resolveEnabledModelIds: strips a trailing thinking-level suffix', () => {
  assert.deepEqual([...resolveEnabledModelIds(MODELS, ['cursor/composer-2-5:high'])], ['cursor/composer-2-5'])
  assert.deepEqual([...resolveEnabledModelIds(MODELS, ['anthropic/*:medium'])].sort(), [
    'anthropic/claude-opus-4-8',
    'anthropic/claude-sonnet-4-5',
    'anthropic/claude-sonnet-4-5-20250929',
    'anthropic/claude-sonnet-4-6'
  ])
})

test('resolveEnabledModelIds: keeps a colon suffix that is not a thinking level', () => {
  // The fast variant has a real colon in its id, so it must still match.
  const ids = resolveEnabledModelIds(MODELS, ['cursor/composer-2-5:fast'])
  assert.deepEqual([...ids], ['cursor/composer-2-5:fast'])
})

test('resolveEnabledModelIds: unmatched patterns yield an empty set', () => {
  assert.equal(resolveEnabledModelIds(MODELS, ['totally/unknown', 'nope']).size, 0)
})

test('resolveEnabledModelIds: dedupes across overlapping patterns', () => {
  const ids = resolveEnabledModelIds(MODELS, ['cursor/composer-2-5', 'composer-2-5', 'cursor/composer-2-5:high'])
  assert.deepEqual([...ids], ['cursor/composer-2-5'])
})
