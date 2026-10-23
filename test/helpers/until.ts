import assert from 'node:assert/strict'

export async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; !ok(); i++) {
    assert.ok(i < 400, 'timed out waiting')
    await new Promise(r => setTimeout(r, 5))
  }
}
