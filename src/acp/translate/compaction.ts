import type { SessionUpdate } from '@agentclientprotocol/sdk'

export type CompactionState =
  | { status: 'in_progress' }
  | { status: 'completed'; summary: string; tokensBefore?: number; tokensAfter?: number }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' }

/** Reads pi's `compaction_end` event (`result` is set only on success). */
export function compactionStateFromPiEnd(ev: unknown): CompactionState {
  const e = (ev ?? {}) as {
    aborted?: unknown
    errorMessage?: unknown
    result?: { summary?: unknown; tokensBefore?: unknown; estimatedTokensAfter?: unknown }
  }
  if (e.aborted === true) return { status: 'cancelled' }
  if (typeof e.result?.summary === 'string') {
    return {
      status: 'completed',
      summary: e.result.summary,
      tokensBefore: finiteNumber(e.result.tokensBefore),
      tokensAfter: finiteNumber(e.result.estimatedTokensAfter)
    }
  }
  const message = typeof e.errorMessage === 'string' ? e.errorMessage.replace(/^Compaction failed:\s*/i, '') : ''
  return { status: 'failed', error: message || 'Unknown error' }
}

/**
 * One compaction as a session update. Clients that advertise `session.compaction` get their
 * own compaction entry; others get a tool card, which Zed upserts by id and draws collapsed.
 */
export function compactionUpdate(compactionId: string, state: CompactionState, entries: boolean): SessionUpdate {
  if (entries) {
    if (state.status === 'completed') {
      return {
        sessionUpdate: 'compaction_update',
        compactionId,
        status: 'completed',
        summary: [{ type: 'text', text: state.summary }]
      }
    }
    if (state.status === 'failed') {
      return { sessionUpdate: 'compaction_update', compactionId, status: 'failed', error: state.error }
    }
    return { sessionUpdate: 'compaction_update', compactionId, status: state.status }
  }

  const text = state.status === 'completed' ? state.summary : state.status === 'failed' ? state.error : ''
  return {
    sessionUpdate: 'tool_call',
    toolCallId: compactionId,
    title: compactionTitle(state),
    kind: 'think',
    status: state.status === 'in_progress' ? 'in_progress' : state.status === 'completed' ? 'completed' : 'failed',
    content: text ? [{ type: 'content', content: { type: 'text', text } }] : []
  }
}

function compactionTitle(state: CompactionState): string {
  switch (state.status) {
    case 'in_progress':
      return 'Compacting context…'
    case 'failed':
      return 'Compaction failed'
    case 'cancelled':
      return 'Compaction cancelled'
    case 'completed': {
      const { tokensBefore: before, tokensAfter: after } = state
      if (before !== undefined && after !== undefined) {
        return `Context compacted · ${formatTokens(before)} → ${formatTokens(after)} tokens`
      }
      if (before !== undefined) return `Context compacted · ${formatTokens(before)} tokens summarized`
      return 'Context compacted'
    }
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
