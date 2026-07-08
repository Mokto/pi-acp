import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess } from '../helpers/fakes.js'

// getPrLinkCached() shells out to `gh pr view` in the background and caches the
// result for PR_LINK_CACHE_MS, so the token-usage footer never blocks a turn on
// gh. This exercises: (1) it's synchronous and never throws even on a cold
// cache, (2) once the background fetch lands, subsequent calls return it
// without re-invoking gh, (3) "no open PR" (gh failure) is cached as null too.

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function makeSession(): any {
  return new (PiAcpSession as any)({
    sessionId: 's1',
    cwd: '/tmp/whatever',
    mcpServers: [],
    proc: new FakePiRpcProcess(),
    conn: new FakeAgentSideConnection()
  })
}

test('getPrLinkCached: never blocks and returns null on a cold cache', () => {
  ;(PiAcpSession as any).execFileAsync = () => new Promise(() => {}) // never resolves
  const session = makeSession()
  assert.equal(session.getPrLinkCached(), null)
})

test('getPrLinkCached: reflects a successful background fetch and does not re-invoke gh within TTL', async () => {
  let calls = 0
  ;(PiAcpSession as any).execFileAsync = async () => {
    calls++
    return { stdout: 'https://github.com/acme/repo/pull/42\n' }
  }
  const session = makeSession()
  await flushMicrotasks()

  assert.equal(session.getPrLinkCached(), 'https://github.com/acme/repo/pull/42')
  assert.equal(session.getPrLinkCached(), 'https://github.com/acme/repo/pull/42')
  assert.equal(calls, 1, 'second call should hit the cache, not gh')
})

test('getPrLinkCached: caches "no open PR" as null instead of retrying every turn', async () => {
  let calls = 0
  ;(PiAcpSession as any).execFileAsync = async () => {
    calls++
    throw new Error('no pull requests found for branch')
  }
  const session = makeSession()
  await flushMicrotasks()

  assert.equal(session.getPrLinkCached(), null)
  assert.equal(session.getPrLinkCached(), null)
  assert.equal(calls, 1, 'a branch with no PR should not retry gh every turn')
})

test('getPrLinkCached: disabled via PI_ACP_SHOW_PR_LINK=false', async () => {
  ;(PiAcpSession as any).execFileAsync = async () => {
    throw new Error('should not be called')
  }
  process.env.PI_ACP_SHOW_PR_LINK = 'false'
  try {
    const session = makeSession()
    await flushMicrotasks()
    assert.equal(session.getPrLinkCached(), null)
  } finally {
    delete process.env.PI_ACP_SHOW_PR_LINK
  }
})
