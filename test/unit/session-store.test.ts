import test from 'node:test'
import assert from 'node:assert/strict'
import { linkSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../src/acp/session-store.js'

test('SessionStore replaces the map file instead of rewriting it in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-store-'))
  const path = join(dir, 'session-map.json')
  const store = new SessionStore(path)
  store.upsert({ sessionId: 'a', cwd: '/w', sessionFile: '/w/a.jsonl' })

  // A hard link keeps pointing at the old file once the map is replaced; an in-place write would change it too.
  const before = join(dir, 'before.json')
  linkSync(path, before)
  store.upsert({ sessionId: 'b', cwd: '/w', sessionFile: '/w/b.jsonl' })

  assert.deepEqual(Object.keys(JSON.parse(readFileSync(before, 'utf8')).sessions), ['a'])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8')).sessions), ['a', 'b'])
  assert.equal(store.get('b')?.sessionFile, '/w/b.jsonl')
})
