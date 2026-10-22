import type { SessionUpdate } from '@agentclientprotocol/sdk'

const MAX_TITLE_LENGTH = 100

/**
 * An extension's `ctx.ui.notify` text as a client notice. Extensions write one string, read as
 * "Title. Detail.": the title runs to the first ". " or line break, the rest is the description.
 * A title too long to stand alone becomes a generic one.
 */
export function noticeFromNotify(message: string, severity: 'warning' | 'error'): SessionUpdate {
  const text = message.trim()
  const split = /^(.*?)(?:\.\s|\n)(.*)$/s.exec(text)
  const title = (split?.[1] ?? text).replace(/[.:]$/, '').trim()
  const description = (split?.[2] ?? '')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim()

  if (!title || title.length > MAX_TITLE_LENGTH) {
    return {
      sessionUpdate: 'notice',
      severity,
      title: severity === 'error' ? 'Extension error' : 'Extension warning',
      ...(text ? { description: text } : {})
    }
  }
  return { sessionUpdate: 'notice', severity, title, ...(description ? { description } : {}) }
}

/** A readable name for the extension at `path`: its folder for an `index` entry point, else its file. */
export function extensionName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  const file = (parts.pop() ?? '').replace(/\.[cm]?[jt]s$/, '')
  if (file && file !== 'index') return file
  while (['src', 'dist', 'lib'].includes(parts.at(-1) ?? '')) parts.pop()
  return parts.at(-1) ?? 'an extension'
}
