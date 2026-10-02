import test from 'node:test'
import assert from 'node:assert/strict'
import { getAuthMethods, PI_SETUP_METHOD_ID } from '../../src/acp/auth.js'

test('getAuthMethods: includes Zed terminal-auth metadata when enabled', () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: true })
  const m: any = methods[0]

  assert.equal(m.id, PI_SETUP_METHOD_ID)
  assert.ok(m._meta)
  assert.ok(m._meta['terminal-auth'])
  assert.ok(typeof m._meta['terminal-auth'].command === 'string')
  assert.deepEqual(m._meta['terminal-auth'].args, ['--terminal-login'])
  assert.equal(m._meta['terminal-auth'].label, 'Launch pi')
})

test('getAuthMethods: omits Zed terminal-auth metadata when disabled', () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: false })
  const m: any = methods[0]
  assert.ok(!m._meta || !m._meta['terminal-auth'])
})

test('getAuthMethods: adds agent-handled OAuth methods after terminal auth', () => {
  const ids = getAuthMethods().map(m => m.id)
  assert.equal(ids[0], PI_SETUP_METHOD_ID)
  assert.ok(ids.includes('pi_oauth:anthropic'))
})
