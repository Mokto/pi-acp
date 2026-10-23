/** Converts a pi message content value (string or block array) to a plain string. */
export function normalizePiMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}

export function normalizePiAssistantText(content: unknown): string {
  // Assistant content is typically an array of blocks; only replay text blocks for MVP.
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}

function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((n: number, c: any) => {
    if (c?.type === 'text' && typeof c.text === 'string') return n + c.text.length
    return c?.type === 'image' ? n + 4800 : n
  }, 0)
}

/**
 * pi's own context estimate (`estimateTokens` in pi's compaction code: characters / 4), which is also the
 * `estimatedTokensAfter` it reports after a compaction. Runs about 30% under the next reply's real count.
 */
export function estimatePiContextTokens(messages: unknown[]): number {
  return messages.reduce((total: number, m: any) => {
    let chars = 0
    switch (m?.role) {
      case 'system':
        chars =
          contentChars(m.content) +
          Object.values(m.sections ?? {}).reduce((n: number, s: any) => n + (typeof s === 'string' ? s.length : 0), 0)
        if (m.toolsAdded) chars += JSON.stringify(m.toolsAdded).length
        break
      case 'user':
      case 'custom':
      case 'toolResult':
        chars = contentChars(m.content)
        break
      case 'assistant':
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c?.type === 'text') chars += String(c.text ?? '').length
          else if (c?.type === 'thinking') chars += String(c.thinking ?? '').length
          else if (c?.type === 'toolCall')
            chars += String(c.name ?? '').length + JSON.stringify(c.arguments ?? {}).length
        }
        break
      case 'bashExecution':
        chars = String(m.command ?? '').length + String(m.output ?? '').length
        break
      case 'branchSummary':
      case 'compactionSummary':
        chars = String(m.summary ?? '').length
        break
    }
    return total + Math.ceil(chars / 4)
  }, 0)
}
