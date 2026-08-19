import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { isLiveEnabled } from '../../src/acp/live.js'

const prev = process.env.PI_ACP_LIVE

beforeEach(() => {
  delete process.env.PI_ACP_LIVE
})

afterEach(() => {
  if (prev === undefined) delete process.env.PI_ACP_LIVE
  else process.env.PI_ACP_LIVE = prev
})

test('PI_ACP_LIVE: off when unset', () => {
  assert.equal(isLiveEnabled({}), false)
  assert.equal(isLiveEnabled({ PI_ACP_LIVE: '' }), false)
})

test('PI_ACP_LIVE: off for non-true values', () => {
  assert.equal(isLiveEnabled({ PI_ACP_LIVE: '0' }), false)
  assert.equal(isLiveEnabled({ PI_ACP_LIVE: 'false' }), false)
  assert.equal(isLiveEnabled({ PI_ACP_LIVE: 'no' }), false)
})

test('PI_ACP_LIVE: on for 1 / true / yes', () => {
  assert.equal(isLiveEnabled({ PI_ACP_LIVE: '1' }), true)
  assert.equal(isLiveEnabled({ PI_ACP_LIVE: 'true' }), true)
  assert.equal(isLiveEnabled({ PI_ACP_LIVE: 'TRUE' }), true)
  assert.equal(isLiveEnabled({ PI_ACP_LIVE: 'yes' }), true)
})
