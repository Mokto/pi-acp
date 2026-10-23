import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimatePiContextTokens,
  normalizePiAssistantText,
  normalizePiMessageText
} from '../../src/acp/translate/pi-messages.js'

test('normalizePiMessageText: supports string', () => {
  assert.equal(normalizePiMessageText('hello'), 'hello')
})

test('normalizePiMessageText: joins text blocks', () => {
  assert.equal(
    normalizePiMessageText([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'not_text', x: 1 }
    ]),
    'ab'
  )
})

test('normalizePiAssistantText: joins only text blocks', () => {
  assert.equal(
    normalizePiAssistantText([
      { type: 'text', text: 'hi' },
      { type: 'thinking', text: '...' },
      { type: 'text', text: '!' }
    ]),
    'hi!'
  )
})

test("estimatePiContextTokens: characters / 4 per message, rounded up, like pi's estimate", () => {
  assert.equal(
    estimatePiContextTokens([
      { role: 'system', content: 'abcd', sections: { tools: 'abcd' }, toolsAdded: ['x'] },
      { role: 'compactionSummary', summary: 'abcdefgh' },
      { role: 'user', content: [{ type: 'text', text: 'abc' }, { type: 'image' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'abcd' },
          { type: 'text', text: 'abcd' },
          { type: 'toolCall', name: 'read', arguments: { p: 1 } }
        ]
      },
      { role: 'toolResult', content: 'abcde' },
      { role: 'bashExecution', command: 'ls', output: 'ab' },
      { role: 'unknown', content: 'ignored' }
    ]),
    4 + 2 + 1201 + 5 + 2 + 1
  )
})
