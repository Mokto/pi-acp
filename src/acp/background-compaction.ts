import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPiAcpCompactionDir } from './paths.js'

/** A pi run on a copy of the thread, only to write its summary. */
export type SummaryWriter = { compact(): Promise<unknown>; dispose(): void }
export type SessionFileInfo = { file: string; id: string }

type CompactResult = {
  summary?: unknown
  firstKeptEntryId?: unknown
  estimatedTokensAfter?: unknown
  details?: unknown
  usage?: unknown
}

/** How far below the chosen size the summary starts: oh-my-pi's clamp(12.5%, 8k, 32k). */
export function backgroundLead(limit: number): number {
  return Math.min(32_000, Math.max(8_000, Math.round(limit * 0.125)))
}

/**
 * Writes the summary in a second pi while the thread keeps going, so the compaction at
 * the end of a reply only has to swap it in. Messages after the snapshot stay word for word.
 */
export class BackgroundCompaction {
  private running: Promise<void> | null = null
  private stopRunning: (() => void) | null = null
  private ready: { refreshAt: number; maxTokensBefore: number; file: string } | null = null
  private generation = 0
  private failed = false

  constructor(private readonly startWriter: (sessionPath: string) => Promise<SummaryWriter>) {}

  shouldStart(tokens: number, limit: number): boolean {
    if (this.running || this.failed || tokens < limit - backgroundLead(limit)) return false
    if (!this.ready) return true
    // Past the limit the reply ends in a compaction, which would wait for a rewrite; the ready summary still works.
    if (tokens >= limit) return tokens >= this.ready.maxTokensBefore
    return tokens >= this.ready.refreshAt
  }

  start(session: Promise<SessionFileInfo>, tokens: number, limit: number): void {
    const generation = ++this.generation
    this.running = this.write(session, tokens, limit, generation)
      .catch(() => {
        // The normal compaction does the work; no retry until the next compaction or size pick.
        if (this.generation === generation) this.failed = true
      })
      .finally(() => {
        if (this.generation === generation) {
          this.running = null
          this.stopRunning = null
        }
      })
  }

  /** Whether a summary is being written, or one that still works for a thread of `tokens` is ready. */
  covers(tokens: number): boolean {
    return this.running !== null || this.isReadyFor(tokens)
  }

  private isReadyFor(tokens: number): boolean {
    return this.ready !== null && tokens < this.ready.maxTokensBefore
  }

  /** Starts a summary unless one covers `tokens` or the last one failed. */
  ensure(session: () => Promise<SessionFileInfo>, tokens: number, limit: number): void {
    if (!this.covers(tokens) && !this.failed) this.start(session(), tokens, limit)
  }

  /** Resolves at once if the ready summary still works for a thread of `tokens`, else when the summary being written is done. */
  async untilUsable(tokens: number): Promise<void> {
    if (this.isReadyFor(tokens)) return
    await this.running
  }

  async discard(): Promise<void> {
    this.generation += 1
    this.failed = false
    this.stopRunning?.()
    this.running = null
    this.stopRunning = null
    const file = this.ready?.file
    this.ready = null
    if (file) await rm(file, { force: true })
  }

  private async write(
    session: Promise<SessionFileInfo>,
    tokens: number,
    limit: number,
    generation: number
  ): Promise<void> {
    const { file, id } = await session
    const dir = getPiAcpCompactionDir()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // mkdir's mode only applies when it creates the folder; it holds copies of whole threads.
    await chmod(dir, 0o700)
    const copy = join(dir, `${randomUUID()}.jsonl`)
    // pi may compact with the older summary while this one is saved, so it must never see a half-written file.
    const partial = join(dir, `${randomUUID()}.json.tmp`)
    const text = await readFile(file, 'utf8')
    try {
      // pi may be appending a line right now; a cut-off last line would not parse.
      await writeFile(copy, text.slice(0, text.lastIndexOf('\n') + 1), { mode: 0o600 })
      if (this.generation !== generation) return
      const writer = await this.startWriter(copy)
      if (this.generation !== generation) return writer.dispose()
      this.stopRunning = () => writer.dispose()
      let result: CompactResult
      try {
        result = (await writer.compact()) as CompactResult
      } finally {
        writer.dispose()
      }
      if (typeof result.summary !== 'string' || typeof result.firstKeptEntryId !== 'string')
        throw new Error('pi returned no summary')
      const handoff = join(dir, `${id}.json`)
      const { summary, firstKeptEntryId, details, usage } = result
      const tokensAfter = typeof result.estimatedTokensAfter === 'number' ? result.estimatedTokensAfter : 0
      // Everything written after the snapshot stays in the thread. Past a quarter of `limit` after the swap a
      // rewrite pays off; past half, the swap saves too little to use at all.
      const refreshAt = tokens + limit / 4 - tokensAfter
      const maxTokensBefore = tokens + limit / 2 - tokensAfter
      await writeFile(partial, JSON.stringify({ summary, firstKeptEntryId, details, usage, maxTokensBefore }), {
        mode: 0o600
      })
      if (this.generation !== generation) return
      await rename(partial, handoff)
      if (this.generation !== generation) {
        await rm(handoff, { force: true })
        return
      }
      this.ready = { refreshAt, maxTokensBefore, file: handoff }
    } finally {
      await rm(copy, { force: true })
      await rm(partial, { force: true })
    }
  }
}
