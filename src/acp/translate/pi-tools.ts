import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

type ImageBlock = { type: 'image'; data: string; mimeType: string }

function isImageBlock(c: unknown): c is ImageBlock {
  const block = c as Partial<ImageBlock> | null
  return block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
}

function imageBlocks(result: unknown): ImageBlock[] {
  const content = (result as { content?: unknown } | null)?.content
  return Array.isArray(content) ? content.filter(isImageBlock) : []
}

// Zed's "Go to File" on a tool call loads the file as a text buffer, which fails for images,
// and Zed caches images by path for the app's lifetime. A folder per image content keeps
// paths stable for the same picture (a reopened thread reuses its files) and new for a changed one.
function saveImage(image: ImageBlock, name: string, dir: string): string | undefined {
  const folder = join(dir, createHash('sha256').update(image.data).digest('hex').slice(0, 16))
  try {
    const existing = readdirSync(folder).find(f => !f.endsWith('.tmp'))
    if (existing) return join(folder, existing)
  } catch {
    // not saved yet
  }
  const ext = image.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
  const stem = basename(name, extname(name)).replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'image'
  const file = join(folder, `${stem}.${ext}`)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(tmp, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    void rm(tmp, { force: true }).catch(() => {})
    return undefined
  }
  return file
}

// On Linux the temp dir is shared, so another user could create the folder first and plant files in it.
function isOwnPrivateDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    return stat.isDirectory() && stat.uid === (process.getuid?.() ?? stat.uid) && (stat.mode & 0o022) === 0
  } catch {
    return false
  }
}

// ponytail: copies are left for the OS temp cleanup (about 3 days on macOS); reopening a thread saves them again.
/** Saves each image in a tool result and returns the files, named after `name` (a file path or the tool's name). */
export function saveImages(result: unknown, name: string, dir = join(tmpdir(), 'pi-acp-images')): string[] {
  const images = imageBlocks(result)
  if (!images.length || !isOwnPrivateDir(dir)) return []
  return images.map(image => saveImage(image, name, dir)).filter((file): file is string => Boolean(file))
}

/** A clickable picture for each file. */
export function imageMarkdown(files: string[]): string {
  return files.map(file => `[![${basename(file)}](<${file}>)](<${file}>)`).join('\n\n')
}

/** Saves a tool result's images and returns them with the card text: the pictures, then the result's text. */
export function imageResultText(result: unknown, name: string): { images: string[]; text: string } {
  const images = saveImages(result, name)
  return { images, text: [imageMarkdown(images), toolResultToText(result)].filter(Boolean).join('\n\n') }
}

/** The result with image data left out: Zed only ever shows `rawOutput` as JSON text, and the card shows the images. */
export function withoutImageData(result: unknown): unknown {
  if (!imageBlocks(result).length) return result
  const { content } = result as { content: unknown[] }
  return {
    ...(result as object),
    content: content.map(c => (isImageBlock(c) ? { type: 'image', mimeType: c.mimeType } : c))
  }
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
    return JSON.stringify(withoutImageData(result), null, 2)
  } catch {
    return String(result)
  }
}
