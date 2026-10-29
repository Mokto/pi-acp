import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotImageMarkdown, toolResultToText } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: shows details._display instead of the text the agent reads', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'PR_URL=https://example.com/1\nTITLE=Fix' }],
    details: { _display: '[Fix](https://example.com/1)\n\nBody' }
  })
  assert.equal(text, '[Fix](https://example.com/1)\n\nBody')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('snapshotImageMarkdown: saves the image under a fresh path and links it to itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const result = {
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' }
    ]
  }

  const first = snapshotImageMarkdown(result, '~/Desktop/My shot #2 (é).PNG', dir)!
  const second = snapshotImageMarkdown(result, '~/Desktop/My shot #2 (é).PNG', dir)!
  const file = first.match(/^\[!\[My-shot-2-é-\.png\]\(<(.+)>\)\]\(<\1>\)$/)?.[1]

  assert.ok(file?.startsWith(dir), first)
  assert.equal(readFileSync(file!, 'utf8'), 'png-bytes')
  assert.notEqual(first, second)
  assert.equal(snapshotImageMarkdown({ content: [{ type: 'text', text: 'hi' }] }, 'a.png', dir), undefined)
})
