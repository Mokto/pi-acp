// Loaded by pi itself (`pi -e`), built as its own file, so it imports nothing from pi-acp.
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

type Handoff = {
  summary: string
  firstKeptEntryId: string
  details?: unknown
  usage?: unknown
  maxTokensBefore?: number
}
type Entry = { id: string; type: string }
type BeforeCompactEvent = {
  customInstructions?: string
  branchEntries: Entry[]
  preparation: { tokensBefore: number }
}
type Context = { sessionManager: { getSessionId(): string } }
type ExtensionApi = {
  on(event: 'session_before_compact', handler: (e: BeforeCompactEvent, ctx: Context) => unknown): void
}

/** Hands pi a summary pi-acp wrote in the background, so the compaction finishes at once. */
export default function compactionHandoff(pi: ExtensionApi): void {
  const dir = process.env.PI_ACP_COMPACTION_HANDOFF_DIR
  if (!dir) return
  pi.on('session_before_compact', (event, ctx) => {
    if (event.customInstructions) return
    const file = join(dir, `${ctx.sessionManager.getSessionId()}.json`)
    let handoff: Handoff
    try {
      handoff = JSON.parse(readFileSync(file, 'utf8')) as Handoff
    } catch {
      return
    }
    rmSync(file, { force: true })
    // After a compaction or a rewind since the snapshot, the kept start is missing or before the newest compaction.
    const entries = event.branchEntries
    const lastCompaction = entries.map(e => e.type).lastIndexOf('compaction')
    if (entries.findIndex(e => e.id === handoff.firstKeptEntryId) <= lastCompaction) return
    if (event.preparation.tokensBefore >= (handoff.maxTokensBefore ?? Infinity)) return
    return {
      compaction: {
        summary: handoff.summary,
        firstKeptEntryId: handoff.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: handoff.details,
        usage: handoff.usage
      }
    }
  })
}
