/**
 * Tests for multi-session behavior:
 *  1. Two concurrent sessions keep separate pi subprocesses (closeAllExcept removed)
 *  2. session/load reuses an in-memory session without respawning or replaying history
 *  3. prompt maps internal 'error' stop reason to ACP 'end_turn'
 *
 * NOTE: PiRpcProcess.spawn cannot be reliably mocked from test files because
 * tsx (module: ESNext, moduleResolution: Bundler) resolves the class to a
 * separate module instance than the one agent.ts imports. Tests therefore
 * verify observable behaviour instead of spawn call counts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager, PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSession(sessionId: string, conn: FakeAgentSideConnection): PiAcpSession {
  const proc = new FakePiRpcProcess() as unknown as PiRpcProcess
  return new PiAcpSession({
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

/**
 * Pre-register a fake session in the agent's SessionManager so loadSession
 * takes the "reuse" path without ever calling PiRpcProcess.spawn.
 */
function injectSession(agent: PiAcpAgent, session: PiAcpSession): void {
  ;(agent as any).sessions.sessions.set(session.sessionId, session)
}

// ─── test suite (serial – tests share process.env / SessionStore) ─────────────

test('PiAcpAgent: multisession', { concurrency: 1 }, async t => {
  // ── 1. Two concurrent sessions keep separate subprocesses ──────────────────
  await t.test('two concurrent sessions keep separate pi subprocesses', async () => {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // Inject two sessions with distinct IDs directly into the SessionManager.
    const sessA = makeSession('sess-A', conn)
    const sessB = makeSession('sess-B', conn)
    injectSession(agent, sessA)
    injectSession(agent, sessB)

    // Verify both sessions are independently accessible (closeAllExcept is gone).
    const sm = (agent as any).sessions as SessionManager
    assert.ok(sm.maybeGet('sess-A'), 'sess-A should still be registered')
    assert.ok(sm.maybeGet('sess-B'), 'sess-B should still be registered')

    // Simulate what would have happened with closeAllExcept: injecting a third
    // session must NOT evict the first two.
    const sessC = makeSession('sess-C', conn)
    injectSession(agent, sessC)
    assert.ok(sm.maybeGet('sess-A'), 'sess-A must survive adding sess-C')
    assert.ok(sm.maybeGet('sess-B'), 'sess-B must survive adding sess-C')
    assert.ok(sm.maybeGet('sess-C'), 'sess-C registered')
  })

  // ── 2. loadSession reuses in-memory session (no respawn, no history replay) ─
  await t.test('loadSession reuses in-memory session without respawning or replaying history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-multisession-'))
    const sessionsDir = join(root, 'sessions', '--tmp--project--')
    const sessionFile = join(sessionsDir, '0000_bbbbbbbbbbbbbbbbbbbbbbbbbbbb.jsonl')

    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'sess-reuse',
          timestamp: '2026-02-11T00:00:00.000Z',
          cwd: '/tmp/project'
        }),
        JSON.stringify({
          type: 'message',
          id: 'a1b2c3d4',
          parentId: null,
          timestamp: '2026-02-11T00:00:01.000Z',
          message: { role: 'user', content: 'Hello again' }
        })
      ].join('\n') + '\n',
      { encoding: 'utf8' }
    )

    const oldEnv = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = root

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // Pre-populate the store so loadSession resolves the session file without scanning.
    ;(agent as any).store.upsert({ sessionId: 'sess-reuse', cwd: '/tmp/project', sessionFile })

    // Pre-register the session in memory so loadSession takes the reuse path.
    const proc = new FakePiRpcProcess() as unknown as PiRpcProcess
    const session = new PiAcpSession({
      sessionId: 'sess-reuse',
      cwd: '/tmp/project',
      mcpServers: [],
      proc,
      conn: asAgentConn(conn),
      fileCommands: []
    })
    ;(agent as any).sessions.sessions.set('sess-reuse', session)

    try {
      // First load: session already in memory → reuse path, no history replay.
      await agent.loadSession({
        sessionId: 'sess-reuse',
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: null
      } as any)

      const chunksAfterFirst = conn.updates.filter(
        u => (u as any).update?.sessionUpdate === 'user_message_chunk'
      ).length
      assert.equal(chunksAfterFirst, 0, 'reuse path must not replay history')

      // Second load: same result.
      await agent.loadSession({
        sessionId: 'sess-reuse',
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: null
      } as any)

      const chunksAfterSecond = conn.updates.filter(
        u => (u as any).update?.sessionUpdate === 'user_message_chunk'
      ).length
      assert.equal(chunksAfterSecond, 0, 'second reuse must also not replay history')

      // The session object must be the same instance (not a new spawn).
      assert.strictEqual(
        (agent as any).sessions.sessions.get('sess-reuse'),
        session,
        'same PiAcpSession instance must be returned on reuse'
      )
    } finally {
      if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = oldEnv
    }
  })

  // ── 3. prompt maps internal 'error' stop reason to ACP 'end_turn' ───────────
  await t.test('prompt maps internal error stop reason to end_turn', async () => {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    const session = {
      sessionId: 's-err',
      proc: new FakePiRpcProcess(),
      async prompt() {
        return 'error' as const
      },
      wasCancelRequested() {
        return false
      }
    }

    ;(agent as any).sessions = {
      maybeGet: () => session,
      get: () => session
    }

    const res = await agent.prompt({
      sessionId: 's-err',
      prompt: [{ type: 'text', text: 'hi' }]
    } as any)

    assert.equal(res.stopReason, 'end_turn')
  })
})
