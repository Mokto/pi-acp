import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

// Zed's "Go to File" on a tool call loads the file as a text buffer, which fails for images,
// and Zed caches images by path for the app's lifetime, so an overwritten file would show a
// stale picture. Saving each image under a fresh path and linking it sidesteps both.
// ponytail: copies are left for the OS temp cleanup; delete per session if disk use matters.
export function snapshotImageMarkdown(
  result: unknown,
  sourcePath: string,
  dir = join(tmpdir(), 'pi-acp-images')
): string | undefined {
  const content = (result as any)?.content
  const image = Array.isArray(content) ? content.find((c: any) => c?.type === 'image') : undefined
  if (typeof image?.data !== 'string' || typeof image?.mimeType !== 'string') return undefined

  const ext = image.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
  const stem = basename(sourcePath, extname(sourcePath)).replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'image'
  const name = `${stem}.${ext}`
  const file = join(dir, randomUUID(), name)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(image.data, 'base64'))
  } catch {
    return undefined
  }
  return `[![${name}](<${file}>)](<${file}>)`
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  if (typeof details?._display === 'string' && details._display.trim()) {
    return details._display
  }

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
