import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'

type PiModel = { provider: string; id: string; name: string }

class FakeProc {
  readonly setModelCalls: Array<{ provider: string; modelId: string }> = []
  readonly setThinkingCalls: string[] = []
  private currentModel: { provider: string; id: string }
  private thinkingLevel: string

  constructor(
    private readonly models: PiModel[],
    current: { provider: string; id: string },
    thinkingLevel: string
  ) {
    this.currentModel = current
    this.thinkingLevel = thinkingLevel
  }

  async getAvailableModels() {
    return { models: this.models }
  }

  async getState() {
    return { model: this.currentModel, thinkingLevel: this.thinkingLevel }
  }

  async setModel(provider: string, modelId: string) {
    this.setModelCalls.push({ provider, modelId })
    this.currentModel = { provider, id: modelId }
  }

  async setThinkingLevel(level: string) {
    this.setThinkingCalls.push(level)
    this.thinkingLevel = level
  }
}

class FakeSessions {
  constructor(private readonly session: { sessionId: string; proc: FakeProc }) {}
  maybeGet() {
    return this.session
  }
  get() {
    return this.session
  }
}

function makeAgent(proc: FakeProc): PiAcpAgent {
  const conn = { async sessionUpdate() {} } as unknown as AgentSideConnection
  const agent = new PiAcpAgent(conn)
  ;(agent as unknown as { sessions: FakeSessions }).sessions = new FakeSessions({ sessionId: 's1', proc })
  return agent
}

const baseModels: PiModel[] = [
  { provider: 'test', id: 'model-a', name: 'Model A' },
  { provider: 'test', id: 'model-b', name: 'Model B' }
]

test('unstable_setSessionConfigOption: model option applies provider/model and refreshes options', async () => {
  const proc = new FakeProc(baseModels, { provider: 'test', id: 'model-a' }, 'medium')
  const agent = makeAgent(proc)

  const res = await agent.unstable_setSessionConfigOption({ sessionId: 's1', configId: 'model', value: 'test/model-b' })

  assert.deepEqual(proc.setModelCalls, [{ provider: 'test', modelId: 'model-b' }])
  const model = res.configOptions.find(o => o.id === 'model')
  assert.equal(model?.currentValue, 'test/model-b')
})

test('unstable_setSessionConfigOption: resolves a bare model id via available models', async () => {
  const proc = new FakeProc(baseModels, { provider: 'test', id: 'model-a' }, 'medium')
  const agent = makeAgent(proc)

  await agent.unstable_setSessionConfigOption({ sessionId: 's1', configId: 'model', value: 'model-b' })

  assert.deepEqual(proc.setModelCalls, [{ provider: 'test', modelId: 'model-b' }])
})

test('unstable_setSessionConfigOption: thinking option maps to setThinkingLevel and refreshes options', async () => {
  const proc = new FakeProc(baseModels, { provider: 'test', id: 'model-a' }, 'medium')
  const agent = makeAgent(proc)

  const res = await agent.unstable_setSessionConfigOption({ sessionId: 's1', configId: 'thinking', value: 'high' })

  assert.deepEqual(proc.setThinkingCalls, ['high'])
  const think = res.configOptions.find(o => o.id === 'thinking')
  assert.equal(think?.currentValue, 'high')
})

test('unstable_setSessionConfigOption: rejects an invalid thinking level', async () => {
  const proc = new FakeProc(baseModels, { provider: 'test', id: 'model-a' }, 'medium')
  const agent = makeAgent(proc)

  await assert.rejects(
    () => agent.unstable_setSessionConfigOption({ sessionId: 's1', configId: 'thinking', value: 'turbo' }),
    /invalid params/i
  )
  assert.deepEqual(proc.setThinkingCalls, [])
})

test('unstable_setSessionConfigOption: rejects an unknown configId', async () => {
  const proc = new FakeProc(baseModels, { provider: 'test', id: 'model-a' }, 'medium')
  const agent = makeAgent(proc)

  await assert.rejects(
    () => agent.unstable_setSessionConfigOption({ sessionId: 's1', configId: 'bogus', value: 'x' }),
    (err: unknown) =>
      err instanceof Error && String((err as { data?: unknown }).data ?? '').includes('Unknown configId')
  )
})
