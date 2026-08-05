/**
 * Detects when the model narrates tool calls as plain text
 * (`Tool call(Read, …)`) instead of emitting structured toolCall blocks.
 * That failure mode correlates with oversized context; /compact usually clears it.
 */

const NARRATED_TOOL_CALL_RE = /(?:^|\n)Tool call\s*\(/

/** Shown instead of the narrated Tool call(...) dump. */
export const NARRATED_TOOL_CALL_COMPACT_TIP =
  'The model wrote tool calls as text instead of running them (often from a large context). Run /compact and retry.'

/** Index of the `T` in the first line-starting `Tool call(`, or -1. */
export function findNarratedToolCallIndex(text: string): number {
  const match = NARRATED_TOOL_CALL_RE.exec(text)
  if (!match || match.index === undefined) return -1
  return match[0].startsWith('\n') ? match.index + 1 : match.index
}

export function looksLikeNarratedToolCalls(text: string): boolean {
  return findNarratedToolCallIndex(text) >= 0
}

const MARKER_CANDIDATES = ['\nTool call (', '\nTool call(', 'Tool call (', 'Tool call('] as const

/** How many trailing chars might still grow into a narrated-tool-call marker. */
export function narratedToolCallHoldbackLength(text: string): number {
  let hold = 0
  for (const candidate of MARKER_CANDIDATES) {
    for (let len = 1; len < candidate.length; len += 1) {
      const prefix = candidate.slice(0, len)
      if (!text.endsWith(prefix)) continue
      // Bare "Tool call" markers only count at buffer start or after a newline.
      if (!candidate.startsWith('\n')) {
        const before = text.slice(0, text.length - len)
        if (before.length > 0 && !before.endsWith('\n')) continue
      }
      hold = Math.max(hold, len)
    }
  }
  return hold
}

/**
 * Decide what new assistant text is safe to stream.
 * Once a narrated dump starts, suppressFrom is set and further text should be held.
 */
export function planNarratedToolCallEmit(
  accumulated: string,
  alreadyEmitted: number
): { emit: string; suppressFrom: number | null } {
  const idx = findNarratedToolCallIndex(accumulated)
  if (idx >= 0) {
    const emit = idx > alreadyEmitted ? accumulated.slice(alreadyEmitted, idx) : ''
    return { emit, suppressFrom: idx }
  }

  const hold = narratedToolCallHoldbackLength(accumulated)
  const emitEnd = accumulated.length - hold
  const emit = emitEnd > alreadyEmitted ? accumulated.slice(alreadyEmitted, emitEnd) : ''
  return { emit, suppressFrom: null }
}
