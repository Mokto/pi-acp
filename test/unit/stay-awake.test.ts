import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stayAwake, stayAwakeHolds } from '../../src/acp/stay-awake.js'

const caffeinatePids = () => {
  try {
    return execFileSync('pgrep', ['-f', `caffeinate -dims -w ${process.pid}`], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

test('assertion is refcounted: one caffeinate for overlapping turns, gone after the last release', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS only')

  assert.equal(caffeinatePids().length, 0)

  const releaseA = stayAwake()
  const releaseB = stayAwake()
  await new Promise(r => setTimeout(r, 200))

  assert.equal(stayAwakeHolds(), 2)
  assert.equal(caffeinatePids().length, 1, 'second hold must not spawn a second caffeinate')

  releaseA()
  releaseA() // double release must not underflow the refcount
  await new Promise(r => setTimeout(r, 200))
  assert.equal(stayAwakeHolds(), 1)
  assert.equal(caffeinatePids().length, 1, 'assertion must survive while a turn is still running')

  releaseB()
  await new Promise(r => setTimeout(r, 300))
  assert.equal(stayAwakeHolds(), 0)
  assert.equal(caffeinatePids().length, 0, 'assertion must be released when no turn is running')
})

test('a caffeinate that dies on its own is respawned by the next turn', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS only')

  const release = stayAwake()
  await new Promise(r => setTimeout(r, 200))
  const [pid] = caffeinatePids()
  assert.ok(pid, 'expected a caffeinate for the first hold')

  execFileSync('kill', ['-9', pid])
  await new Promise(r => setTimeout(r, 300))
  assert.equal(caffeinatePids().length, 0)

  const release2 = stayAwake()
  await new Promise(r => setTimeout(r, 200))
  const pids = caffeinatePids()
  assert.equal(pids.length, 1, 'next turn must re-acquire the lost assertion')
  assert.notEqual(pids[0], pid)

  release()
  release2()
  await new Promise(r => setTimeout(r, 300))
  assert.equal(caffeinatePids().length, 0)
})
