import test from 'node:test'
import assert from 'node:assert/strict'
import { latestPlanEntries, planEntries } from '../../src/acp/translate/plan.js'

test('planEntries: goal first and open, steps keep their status, junk steps dropped', () => {
  assert.deepEqual(
    planEntries({
      goal: ' Ship /todo ',
      plan: [
        { step: 'Build it', status: 'completed' },
        { step: 'Test it', status: 'in_progress' },
        { step: 'Open PR', status: 'someday' },
        { step: '  ' },
        null
      ]
    }),
    [
      { content: 'Goal: Ship /todo', priority: 'high', status: 'pending' },
      { content: 'Build it', priority: 'medium', status: 'completed' },
      { content: 'Test it', priority: 'medium', status: 'in_progress' },
      { content: 'Open PR', priority: 'medium', status: 'pending' }
    ]
  )
  assert.deepEqual(planEntries({ plan: [] }), [])
  assert.equal(planEntries({ goal: 'x' }), null)
  assert.equal(planEntries(undefined), null)
})

test('latestPlanEntries: newest update_plan call wins, other tools ignored', () => {
  const call = (name: string, args: unknown) => ({
    role: 'assistant',
    content: [{ type: 'toolCall', name, arguments: args }]
  })
  const messages = [
    call('update_plan', { plan: [{ step: 'old', status: 'pending' }] }),
    { role: 'user', content: 'go on' },
    call('update_plan', { plan: [{ step: 'new', status: 'completed' }] }),
    call('bash', { command: 'ls' })
  ]
  assert.deepEqual(latestPlanEntries(messages), [{ content: 'new', priority: 'medium', status: 'completed' }])
  assert.equal(latestPlanEntries([{ role: 'user', content: 'hi' }]), null)
})

test('latestPlanEntries: the list carried past a compaction counts, as pi returns it after one', () => {
  const messages = [
    { role: 'compactionSummary', summary: '...' },
    { role: 'user', content: 'go on' },
    {
      role: 'custom',
      customType: 'todo',
      content: 'Your to-do list...',
      details: { plan: [{ step: 'kept', status: 'in_progress' }] }
    }
  ]
  assert.deepEqual(latestPlanEntries(messages), [{ content: 'kept', priority: 'medium', status: 'in_progress' }])
})
