import { RequestError } from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'

/** pi-cursor-sdk maps transient Cursor SDK 401s to this; the same key works on retry. */
export function isTransientCursorSdkAuthError(message: string): boolean {
  return /cursor sdk request failed because the cursor sdk api key may be invalid or unauthorized/i.test(message)
}

/**
 * Best-effort detection of missing credentials / not-configured errors from pi/providers.
 *
 * We can't do a full provider-specific check here, so we look for common substrings.
 */
export function maybeAuthRequiredError(err: unknown): RequestError | null {
  const msg = String((err as any)?.message ?? err ?? '')
  if (isTransientCursorSdkAuthError(msg)) return null
  const s = msg.toLowerCase()

  const patterns = [
    'api key',
    'apikey',
    'missing key',
    'no key',
    'not configured',
    'unauthorized',
    'authentication',
    'permission denied',
    'forbidden',
    '401',
    '403'
  ]

  const hit = patterns.some(p => s.includes(p))
  if (!hit) return null

  // Include terminal auth method options in error data.
  return RequestError.authRequired(
    {
      authMethods: getAuthMethods()
    },
    'Configure an API key or log in with an OAuth provider.'
  )
}
