import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []
  private exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []

  // spies
  readonly prompts: Array<{
    message: string
    attachments: unknown[]
    streamingBehavior?: 'steer' | 'followUp'
  }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
    for (const h of this.exitHandlers) h(code, signal)
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(
    message: string,
    attachments: unknown[] = [],
    opts?: { streamingBehavior?: 'steer' | 'followUp' }
  ): Promise<void> {
    this.prompts.push({ message, attachments, streamingBehavior: opts?.streamingBehavior })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  readonly setModelCalls: Array<{ provider: string; modelId: string }> = []
  readonly setThinkingCalls: string[] = []
  private currentModel = { provider: 'test', id: 'model' }
  private thinkingLevel = 'medium'

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getState(): Promise<any> {
    return { model: this.currentModel, thinkingLevel: this.thinkingLevel }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.setModelCalls.push({ provider, modelId })
    this.currentModel = { provider, id: modelId }
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.setThinkingCalls.push(level)
    this.thinkingLevel = level
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
