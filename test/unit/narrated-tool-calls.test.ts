import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findNarratedToolCallIndex,
  looksLikeNarratedToolCalls,
  narratedToolCallHoldbackLength,
  planNarratedToolCallEmit
} from '../../src/acp/translate/narrated-tool-calls.js'

test('findNarratedToolCallIndex: line-start Tool call(', () => {
  assert.equal(findNarratedToolCallIndex('Tool call(Read, path=a)'), 0)
  assert.equal(findNarratedToolCallIndex('Hello\nTool call(Grep, pattern=x)'), 6)
  assert.equal(findNarratedToolCallIndex('see Tool call(Read) inline'), -1)
})

test('looksLikeNarratedToolCalls: space optional', () => {
  assert.equal(looksLikeNarratedToolCalls('Tool call (Read, path=a)'), true)
  assert.equal(looksLikeNarratedToolCalls('nope'), false)
})

test('narratedToolCallHoldbackLength: holds partial marker only at line start', () => {
  assert.equal(narratedToolCallHoldbackLength('hi\nTool cal'), 'Tool cal'.length + 1)
  assert.equal(narratedToolCallHoldbackLength('hello'), 0)
  // Trailing "T" in prose must not stall streaming.
  assert.equal(narratedToolCallHoldbackLength('answer is T'), 0)
  assert.equal(narratedToolCallHoldbackLength('T'), 1)
})

test('planNarratedToolCallEmit: streams prose then suppresses dump', () => {
  const prose = 'Implementing the fix.\n'
  const dump = 'Tool call(Read, path=/tmp/a)\nTool call(Grep, pattern=x)'
  const full = prose + dump

  // Partial marker after newline: hold `\nTool cal` so we don't flash a bare newline.
  const mid = planNarratedToolCallEmit(prose + 'Tool cal', 0)
  assert.equal(mid.suppressFrom, null)
  assert.equal(mid.emit, 'Implementing the fix.')

  const done = planNarratedToolCallEmit(full, mid.emit.length)
  assert.equal(done.suppressFrom, prose.length)
  assert.equal(done.emit, '\n')
})

test('planNarratedToolCallEmit: dump-only emits nothing and suppresses', () => {
  const dump = 'Tool call(Shell, command=ls)'
  const plan = planNarratedToolCallEmit(dump, 0)
  assert.equal(plan.emit, '')
  assert.equal(plan.suppressFrom, 0)
})
