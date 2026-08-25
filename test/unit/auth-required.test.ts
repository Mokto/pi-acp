import test from 'node:test'
import assert from 'node:assert/strict'
import { isTransientCursorSdkAuthError, maybeAuthRequiredError } from '../../src/acp/auth-required.js'

const CURSOR_SDK_AUTH_FLAKE =
  'Cursor SDK request failed because the Cursor SDK API key may be invalid or unauthorized. Cursor Agent CLI/Desktop login is not reused. Run /login -> Use an API key -> Cursor, verify CURSOR_API_KEY, or pass --api-key, then retry.'

test('isTransientCursorSdkAuthError: matches pi-cursor-sdk 401 rewrite', () => {
  assert.equal(isTransientCursorSdkAuthError(CURSOR_SDK_AUTH_FLAKE), true)
  assert.equal(
    isTransientCursorSdkAuthError(
      'Cursor SDK runs require a Cursor SDK API key. Cursor Agent CLI/Desktop login is not reused.'
    ),
    false
  )
})

test('maybeAuthRequiredError: ignores transient Cursor SDK 401s', () => {
  assert.equal(maybeAuthRequiredError(new Error(CURSOR_SDK_AUTH_FLAKE)), null)
})

test('maybeAuthRequiredError: still flags a missing key', () => {
  const err = maybeAuthRequiredError(new Error('Missing API key for anthropic'))
  assert.ok(err)
  assert.match(String(err), /Configure an API key or log in with an OAuth provider/i)
})
