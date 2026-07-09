import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess } from '../helpers/fakes.js'

// getPrLinkCached() shells out to `gh pr view` in the background and caches the
// result for PR_LINK_CACHE_MS, so the token-usage footer never blocks a turn on
// gh. It's also gated on sessionStartBranch: a session never reports a PR link
// until the current branch diverges from whatever it was when the session
// started, so a brand-new session on a branch that already has an open PR from
// earlier, unrelated work doesn't claim that PR as its own. This exercises:
// (1) it's synchronous and never throws even on a cold cache, (2) it never
// calls gh while still on the session's starting branch, (3) once the branch
// changes, the fetch happens and is cached without re-invoking gh every turn,
// (4) "no open PR" is cached as null too, (5) a further branch change drops the
// stale URL immediately, (6) the env-var kill switch.

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

// Stubs getCurrentBranchSync on the prototype (in effect before the constructor
// runs, since it fires its own warm-cache call) and returns a restore function.
function stubBranch(getBranch: () => string | null): () => void {
  const original = (PiAcpSession.prototype as any).getCurrentBranchSync
  ;(PiAcpSession.prototype as any).getCurrentBranchSync = function () {
    return getBranch()
  }
  return () => {
    ;(PiAcpSession.prototype as any).getCurrentBranchSync = original
  }
}

test('getPrLinkCached: never blocks and returns null on a cold cache', () => {
  ;(PiAcpSession as any).execFileAsync = () => new Promise(() => {}) // never resolves
  const session = makeSession()
  assert.equal(session.getPrLinkCached(), null)
})

test('getPrLinkCached: never calls gh while still on the branch the session started on', async () => {
  let calls = 0
  ;(PiAcpSession as any).execFileAsync = async () => {
    calls++
    return { stdout: 'https://github.com/acme/repo/pull/1\n' }
  }
  const restore = stubBranch(() => 'feature-a')
  try {
    const session = makeSession()
    await flushMicrotasks()

    assert.equal(session.getPrLinkCached(), null)
    assert.equal(calls, 0, 'a session that never changes branch must never shell out to gh')
  } finally {
    restore()
  }
})

test('getPrLinkCached: fetches and caches once the branch changes from the session start branch', async () => {
  let calls = 0
  let branch = 'feature-a'
  ;(PiAcpSession as any).execFileAsync = async () => {
    calls++
    return { stdout: 'https://github.com/acme/repo/pull/42\n' }
  }
  const restore = stubBranch(() => branch)
  try {
    const session = makeSession() // captures sessionStartBranch = 'feature-a'
    branch = 'feature-b'
    session.getPrLinkCached() // triggers the background fetch now that the branch differs
    await flushMicrotasks()

    assert.equal(session.getPrLinkCached(), 'https://github.com/acme/repo/pull/42')
    assert.equal(session.getPrLinkCached(), 'https://github.com/acme/repo/pull/42')
    assert.equal(calls, 1, 'second call should hit the cache, not gh')
  } finally {
    restore()
  }
})

test('getPrLinkCached: caches "no open PR" as null instead of retrying every turn', async () => {
  let calls = 0
  let branch = 'feature-a'
  ;(PiAcpSession as any).execFileAsync = async () => {
    calls++
    throw new Error('no pull requests found for branch')
  }
  const restore = stubBranch(() => branch)
  try {
    const session = makeSession()
    branch = 'feature-b'
    session.getPrLinkCached() // triggers the background fetch now that the branch differs
    await flushMicrotasks()

    assert.equal(session.getPrLinkCached(), null)
    assert.equal(session.getPrLinkCached(), null)
    assert.equal(calls, 1, 'a branch with no PR should not retry gh every turn')
  } finally {
    restore()
  }
})

test('getPrLinkCached: drops the cached URL immediately on a further branch change, instead of showing a stale PR', async () => {
  let calls = 0
  let branch = 'main'
  ;(PiAcpSession as any).execFileAsync = async () => {
    calls++
    return { stdout: `https://github.com/acme/repo/pull/${calls}\n` }
  }
  const restore = stubBranch(() => branch)
  try {
    const session = makeSession() // sessionStartBranch = 'main'
    branch = 'branch-a'
    session.getPrLinkCached() // triggers the background fetch now that the branch differs
    await flushMicrotasks()
    assert.equal(session.getPrLinkCached(), 'https://github.com/acme/repo/pull/1')

    // Hopped to another branch mid-session; the stale PR-1 link must not leak.
    branch = 'branch-b'
    assert.equal(session.getPrLinkCached(), null, 'stale URL from the old branch must not be returned')

    await flushMicrotasks()
    assert.equal(session.getPrLinkCached(), 'https://github.com/acme/repo/pull/2')
    assert.equal(calls, 2, 'branch switch should trigger exactly one re-fetch')
  } finally {
    restore()
  }
})

test('maybeEmitTokenStats: renders the PR link as a markdown link, not a raw URL', async () => {
  let branch = 'main'
  ;(PiAcpSession as any).execFileAsync = async () => ({ stdout: 'https://github.com/acme/repo/pull/42\n' })
  const restore = stubBranch(() => branch)
  try {
    const session = makeSession()
    branch = 'branch-a'
    session.getPrLinkCached() // triggers the background fetch now that the branch differs
    await flushMicrotasks()

    const conn = (session as any).conn as FakeAgentSideConnection
    await (session as any).maybeEmitTokenStats()
    await (session as any).flushEmits()

    const text = conn.updates.map((u: any) => u.update?.content?.text ?? '').join('')
    assert.match(text, /\[#42\]\(https:\/\/github\.com\/acme\/repo\/pull\/42\)/)
    assert.doesNotMatch(text, /·\s*https:\/\//, 'PR URL must not appear as a bare link')
  } finally {
    restore()
  }
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
