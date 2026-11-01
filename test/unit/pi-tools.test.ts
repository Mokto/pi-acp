import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  imageLinkTitle,
  imageMarkdown,
  saveImages,
  toolResultToText,
  withoutImageData
} from '../../src/acp/translate/pi-tools.js'

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

const png = (bytes: string) => ({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' })

test('saveImages: saves each picture once, in a folder of its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const result = { content: [{ type: 'text', text: 'Read image file [image/png]' }, png('png-bytes')] }

  const [file] = saveImages(result, '~/Desktop/My shot #2 (é).PNG', dir)

  assert.ok(file?.startsWith(dir) && file.endsWith('/My-shot-2-é-.png'), file)
  assert.equal(readFileSync(file, 'utf8'), 'png-bytes')
  assert.deepEqual(
    saveImages(result, 'read', dir),
    [file],
    'the same picture keeps its file, so a reopened thread reuses it'
  )
  assert.notDeepEqual(saveImages({ content: [png('other-bytes')] }, 'shot.png', dir), [file])
  assert.deepEqual(saveImages({ content: [{ type: 'text', text: 'hi' }] }, 'a.png', dir), [])
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('saveImages: refuses a folder others can write to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  chmodSync(dir, 0o777)
  assert.deepEqual(saveImages({ content: [png('png-bytes')] }, 'a.png', dir), [])
})

test('saveImages: ignores a write that never finished', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const [file] = saveImages({ content: [png('png-bytes')] }, 'a.png', dir)
  rmSync(file!)
  writeFileSync(`${file}.123.tmp`, 'png-')

  assert.deepEqual(saveImages({ content: [png('png-bytes')] }, 'a.png', dir), [file])
  assert.equal(readFileSync(file!, 'utf8'), 'png-bytes')
})

test('saveImages: saves every image in a result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const files = saveImages({ content: [png('one'), { type: 'text', text: 'x' }, png('two')] }, 'page_snapshot', dir)
  assert.deepEqual(
    files.map(f => readFileSync(f, 'utf8')),
    ['one', 'two']
  )
  assert.ok(files.every(f => f.endsWith('/page_snapshot.png')))
})

test('imageMarkdown: a picture per file that links to itself', () => {
  assert.equal(
    imageMarkdown(['/a/x.png', '/b/y.png']),
    '[![x.png](</a/x.png>)](</a/x.png>)\n\n[![y.png](</b/y.png>)](</b/y.png>)'
  )
  assert.equal(imageMarkdown([]), '')
})

test('imageLinkTitle: the whole title links to the image, brackets escaped', () => {
  assert.equal(imageLinkTitle('Read [draft] shot.png', '/a/b.png'), '[Read \\[draft\\] shot.png](</a/b.png>)')
})

test('withoutImageData: keeps everything but the image bytes', () => {
  const result = { content: [{ type: 'text', text: 'hi' }, png('png-bytes')], details: { a: 1 } }
  assert.deepEqual(withoutImageData(result), {
    content: [
      { type: 'text', text: 'hi' },
      { type: 'image', mimeType: 'image/png' }
    ],
    details: { a: 1 }
  })
  const textOnly = { content: [{ type: 'text', text: 'hi' }] }
  assert.equal(withoutImageData(textOnly), textOnly)
  assert.doesNotMatch(toolResultToText({ content: [png('png-bytes')] }), /cG5n/)
})
