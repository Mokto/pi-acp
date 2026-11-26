import {
  methods,
  type AgentContext,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from '@agentclientprotocol/sdk'

export type AcpClient = {
  sessionUpdate(params: SessionNotification): Promise<void>
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>
}

export function acpClient(client: AgentContext): AcpClient {
  return {
    sessionUpdate: params => client.notify(methods.client.session.update, params),
    requestPermission: params => client.request(methods.client.session.requestPermission, params),
    createElicitation: params => client.request(methods.client.elicitation.create, params)
  }
}
