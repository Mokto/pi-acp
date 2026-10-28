import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const SESSION_FILE = '/tmp/project/s1.jsonl'

function fakeProc(switchSession: (path: string) => Promise<void>) {
  const calls = { switched: [] as string[], disposed: 0 }
  const proc = {
    exited: false,
    switchSession: async (path: string) => {
      calls.switched.push(path)
      await switchSession(path)
    },
    dispose: () => {
      calls.disposed++
    },
    onEvent: () => () => {},
    onExit: () => () => {},
    takeEarlyEvents: () => [],
    getMessages: async () => ({ messages: [] }),
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' }),
    getCommands: async () => []
  }
  return { proc, calls }
}

async function loadWithSpare(spareProc: unknown) {
  const spawned: unknown[] = []
  const fresh = fakeProc(async () => {})
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: unknown) => {
    spawned.push(params)
    return fresh.proc
  }
  const warmed: string[] = []
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).store = {
    get: () => ({ sessionId: 's1', cwd: '/tmp/project', sessionFile: SESSION_FILE }),
    upsert() {}
  }
  ;(agent as any).spare = {
    take: (cwd: string) => (cwd === '/tmp/project' ? Promise.resolve(spareProc) : null),
    warm: (cwd: string) => warmed.push(cwd),
    dispose() {}
  }
  try {
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
    return { spawned, warmed, used: (agent as any).sessions.maybeGet('s1')?.proc, fresh: fresh.proc }
  } finally {
    agent.dispose()
    PiRpcProcess.spawn = originalSpawn
  }
}

test('PiAcpAgent: loadSession switches the spare pi to the session instead of starting one', async () => {
  const spare = fakeProc(async () => {})
  const { spawned, warmed, used } = await loadWithSpare(spare.proc)
  assert.equal(used, spare.proc)
  assert.deepEqual(spare.calls.switched, [SESSION_FILE])
  assert.deepEqual(spawned, [])
  assert.deepEqual(warmed, ['/tmp/project'])
})

test('PiAcpAgent: loadSession starts its own pi when the spare refuses the switch', async () => {
  const spare = fakeProc(async () => {
    throw new Error('pi switch_session failed: {"cancelled":true}')
  })
  const { spawned, used, fresh } = await loadWithSpare(spare.proc)
  assert.equal(used, fresh)
  assert.equal(spare.calls.disposed, 1)
  assert.deepEqual(spawned, [{ cwd: '/tmp/project', sessionPath: SESSION_FILE, piCommand: undefined }])
})
