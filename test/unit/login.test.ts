import test from 'node:test'
import assert from 'node:assert/strict'
import {
  looksLikeAuthCode,
  providerFromAuthMethodId,
  runOAuthLogin,
  type ModelRuntimeLike
} from '../../src/acp/login.js'

function fakeRuntime(flow: (interaction: any) => Promise<unknown>) {
  return {
    getProviders: () => [],
    login: (_id: string, _type: 'oauth', interaction: any) => flow(interaction),
    logout: async () => {},
    listCredentials: async () => []
  } as unknown as ModelRuntimeLike
}

test('runOAuthLogin: maps auth_url, select and text prompts onto chat IO', async () => {
  const said: string[] = []
  const opened: string[] = []
  const rt = fakeRuntime(async (i: any) => {
    i.notify({ type: 'auth_url', url: 'https://example.com/auth?a=1&b=2' })
    i.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.com/device' })
    assert.equal(await i.prompt({ type: 'select', message: 'Pick', options: [{ id: 'x', label: 'X' }] }), 'x')
    assert.equal(await i.prompt({ type: 'text', message: 'Domain' }), 'corp.ghe.com')
  })

  await runOAuthLogin(rt, 'anthropic', {
    say: t => said.push(t),
    select: async (_m, opts) => opts[0]!.id,
    text: 'corp.ghe.com',
    openUrl: u => opened.push(u)
  })

  assert.deepEqual(opened, ['https://example.com/auth?a=1&b=2', 'https://example.com/device'])
  assert.match(said[0]!, /\(https:\/\/example\.com\/auth\?a=1&b=2\)/)
  assert.match(said[1]!, /ABCD-1234/)
})

test('runOAuthLogin: manual_code waits for abort; secret prompts are refused', async () => {
  const io = { say: () => {}, select: async () => null }

  const ac = new AbortController()
  const manual = runOAuthLogin(
    fakeRuntime(async (i: any) => i.prompt({ type: 'manual_code', message: 'paste' })),
    'openai',
    io,
    ac.signal
  )
  setTimeout(() => ac.abort(), 10)
  await assert.rejects(manual, /Login cancelled/)

  await assert.rejects(
    runOAuthLogin(
      fakeRuntime(async (i: any) => i.prompt({ type: 'secret', message: 'key' })),
      'x',
      io
    ),
    /terminal/
  )
})

test('providerFromAuthMethodId: only the pi_oauth: prefix maps to a provider', () => {
  assert.equal(providerFromAuthMethodId('pi_oauth:anthropic'), 'anthropic')
  assert.equal(providerFromAuthMethodId('pi_terminal_login'), null)
})

test('looksLikeAuthCode: pasted codes and redirect URLs, not normal prompts', () => {
  assert.ok(looksLikeAuthCode('http://localhost:53692/callback?code=abc&state=xyz'))
  assert.ok(looksLikeAuthCode('a1b2c3d4e5f6g7h8#state123'))
  assert.ok(!looksLikeAuthCode('https://github.com/org/repo/pull/12'))
  assert.ok(!looksLikeAuthCode('fix the failing test'))
})
