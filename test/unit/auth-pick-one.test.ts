import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const providers = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' }
]

async function setup(form: boolean) {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  await agent.initialize({ protocolVersion: 1, clientCapabilities: form ? { elicitation: { form: {} } } : {} })
  const pickOne = (agent as any).pickOne.bind(agent) as (
    sessionId: string,
    title: string,
    options: typeof providers
  ) => Promise<string | null>
  return { conn, pickOne }
}

test('/login picker: a radio form when the client supports forms', async () => {
  const { conn, pickOne } = await setup(true)
  conn.nextElicitationResponse = { action: 'accept', content: { choice: 'openai' } }

  assert.equal(await pickOne('s1', 'Log in to', providers), 'openai')
  assert.equal(conn.permissionRequests.length, 0)
  assert.deepEqual((conn.elicitationRequests[0] as any).requestedSchema.properties.choice.oneOf, [
    { const: 'anthropic', title: 'Anthropic' },
    { const: 'openai', title: 'OpenAI' }
  ])

  conn.nextElicitationResponse = { action: 'cancel' }
  assert.equal(await pickOne('s1', 'Log in to', providers), null)
})

test('/login picker: permission buttons when the client has no forms', async () => {
  const { conn, pickOne } = await setup(false)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'anthropic' } }

  assert.equal(await pickOne('s1', 'Log in to', providers), 'anthropic')
  assert.equal(conn.elicitationRequests.length, 0)
})
