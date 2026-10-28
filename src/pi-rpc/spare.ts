import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from '../acp/pi-settings.js'
import { PiRpcProcess } from './process.js'

// Bounds both the memory an idle spare holds and how long it can run outdated
// extension code, which startupInputs() doesn't see.
const MAX_AGE_MS = 10 * 60_000

type Spare = {
  key: string
  inputs: string
  proc: Promise<PiRpcProcess>
  ready?: PiRpcProcess
  timer: ReturnType<typeof setTimeout>
}

/**
 * What pi reads once at startup: a pi started before any of it changed is outdated.
 * Files count by content, since pi rewrites settings.json with the same values on
 * every model pick. auth.json is left out: pi re-reads it when it needs a token.
 */
function startupInputs(cwd: string): string {
  const agentDir = getAgentDir()
  const paths = ['settings.json', 'models.json', 'AGENTS.md', 'CLAUDE.md', 'extensions', 'skills', 'prompts'].map(f =>
    join(agentDir, f)
  )
  paths.push(join(cwd, '.pi', 'settings.json'), join(cwd, '.pi', 'extensions'))
  for (let dir = cwd; ; dir = dirname(dir)) {
    paths.push(join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'))
    if (dirname(dir) === dir) break
  }
  const hash = createHash('sha1')
  for (const p of paths) {
    try {
      const st = statSync(p)
      hash.update(st.isDirectory() ? String(st.mtimeMs) : readFileSync(p))
    } catch {
      hash.update('-')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * One pi started ahead of the next session/new, which then skips pi's startup
 * (seconds with many extensions). `PI_ACP_PREWARM=0` turns it off.
 */
export class SparePi {
  private spare: Spare | null = null

  /** The spare, if it was started for this cwd/command and is still current. */
  take(cwd: string, piCommand?: string): Promise<PiRpcProcess> | null {
    const spare = this.spare
    if (!spare) return null
    this.spare = null
    clearTimeout(spare.timer)
    if (spare.key !== keyOf(cwd, piCommand) || spare.inputs !== startupInputs(cwd)) {
      disposeSpare(spare)
      return null
    }
    return spare.proc
  }

  /** Start a spare for this cwd unless one is already there. */
  warm(cwd: string, piCommand?: string): void {
    if (process.env.PI_ACP_PREWARM === '0') return
    const key = keyOf(cwd, piCommand)
    if (this.spare?.key === key && !this.spare.ready?.exited) return
    this.dispose()
    const inputs = startupInputs(cwd)
    const proc = PiRpcProcess.spawn({ cwd, piCommand })
    const spare: Spare = { key, inputs, proc, timer: setTimeout(() => this.drop(spare), MAX_AGE_MS) }
    proc.then(
      p => (spare.ready = p),
      () => {}
    )
    spare.timer.unref?.()
    this.spare = spare
  }

  dispose(): void {
    const spare = this.spare
    this.spare = null
    if (!spare) return
    clearTimeout(spare.timer)
    disposeSpare(spare)
  }

  private drop(spare: Spare): void {
    if (this.spare === spare) this.dispose()
  }
}

function keyOf(cwd: string, piCommand?: string): string {
  return `${piCommand ?? ''}\0${cwd}`
}

// Synchronous when pi is up: pi-acp's shutdown calls process.exit right after.
function disposeSpare(spare: Spare): void {
  if (spare.ready) return spare.ready.dispose()
  void spare.proc.then(
    p => p.dispose(),
    () => {}
  )
}
