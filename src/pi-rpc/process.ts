import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getPiAcpCompactionDir } from '../acp/paths.js'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'

function compactionExtensionPath(): string {
  const built = fileURLToPath(new URL('./compaction-extension.js', import.meta.url))
  return existsSync(built) ? built : built.replace(/\.js$/, '.ts')
}

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

// First pi release that emits `agent_settled`; without it no turn ever completes.
const MIN_PI_VERSION = [0, 80, 4]
const supportedPiCommands = new Set<string>()

function assertSupportedPiVersion(cmd: string): void {
  if (supportedPiCommands.has(cmd)) return
  const res = spawnSync(cmd, ['--version'], {
    encoding: 'utf-8',
    timeout: 5_000,
    shell: shouldUseShellForPiCommand(cmd)
  })
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${res.stdout ?? ''}${res.stderr ?? ''}`)
  // Unknown version (not installed, odd output): let the real spawn report it.
  if (!match) return

  const found = match.slice(1, 4).map(Number)
  const differsAt = found.findIndex((n, i) => n !== MIN_PI_VERSION[i])
  if (differsAt !== -1 && found[differsAt]! < MIN_PI_VERSION[differsAt]!) {
    throw new PiRpcSpawnError(
      `pi v${found.join('.')} is too old: pi-acp needs pi ${MIN_PI_VERSION.join('.')} or newer. Update it with \`npm install -g @earendil-works/pi-coding-agent\`, then try again.`
    )
  }
  supportedPiCommands.add(cmd)
}

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

export type PiPromptOptions = {
  streamingBehavior?: 'steer' | 'followUp'
}

// What pi did with a prompt (pi 0.99+). `handled`: an extension command or input handler
// consumed it and no agent run started, so no `agent_settled` will follow.
export type PiPromptDisposition = 'handled' | 'started' | 'queued'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export function isThinkingLevel(x: unknown): x is ThinkingLevel {
  return (THINKING_LEVELS as readonly unknown[]).includes(x)
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'set_thinking_level'; id?: string; level: ThinkingLevel }
  | { type: 'get_available_thinking_levels'; id?: string }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  /** The pi that only writes a background summary: it skips the hand-over extension and everything a summary never reads. */
  summaryWriter?: boolean
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  // Extensions' session_start hooks run before pi answers the first request, so their
  // events arrive before any session listens; kept until the session takes them.
  private earlyEvents: PiRpcEvent[] | null = []
  private exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  private readonly preludeLines: string[] = []
  private hasExited = false

  /** True once the underlying pi process has exited (crash, kill, or normal exit). */
  get exited(): boolean {
    return this.hasExited
  }

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child

    const onLine = (line: string) => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture it so the ACP adapter can surface it on session start.
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      if (msg?.type === 'response') {
        const id = typeof msg.id === 'string' ? msg.id : undefined
        if (id) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            pending.resolve(msg as PiRpcResponse)
            return
          }
        }
      }

      if (this.earlyEvents && this.eventHandlers.length === 0) this.earlyEvents.push(msg as PiRpcEvent)
      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    }

    // pi frames records with LF only. readline also splits on U+2028/U+2029, which
    // JSON.stringify leaves raw inside strings (e.g. web pages in tool results).
    let partial: string[] = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      let start = 0
      for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', start)) {
        partial.push(chunk.slice(start, nl))
        onLine(partial.join('').replace(/\r$/, ''))
        partial = []
        start = nl + 1
      }
      if (start < chunk.length) partial.push(chunk.slice(start))
    })
    child.stdout.on('end', () => {
      if (partial.length) onLine(partial.join(''))
    })

    child.on('exit', (code, signal) => {
      this.hasExited = true
      const err = new Error(`pi process exited (code=${code}, signal=${signal})`)
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
      for (const h of this.exitHandlers) h(code, signal)
    })

    child.on('error', err => {
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })

    // A write that is in flight when pi exits fails with EPIPE. Its callback already rejects the
    // request; without a listener Node also throws the error and exits pi-acp with every thread.
    child.stdin.on('error', () => {})
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)
    assertSupportedPiVersion(cmd)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // The live pi keeps extensions + prompt templates because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows). The summary writer skips what a
    // summary never reads, but keeps extensions: some models (Cursor) come from one.
    const args = ['--mode', 'rpc', '--no-themes']
    if (params.sessionPath) args.push('--session', params.sessionPath)
    if (params.summaryWriter) args.push('--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files')
    else args.push('-e', compactionExtensionPath())

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: params.summaryWriter
        ? process.env
        : { ...process.env, PI_ACP_COMPACTION_HANDOFF_DIR: getPiAcpCompactionDir() },
      shell: shouldUseShellForPiCommand(cmd)
    })

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    // Zed writes each line to Zed.log as "agent stderr: …", so pi's crash traces land there.
    child.stderr.pipe(process.stderr, { end: false })

    const proc = new PiRpcProcess(child)

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState()) as any
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch {
      // ignore for now
    }

    return proc
  }

  /** Events pi sent while nothing listened; returns them once and stops keeping more. */
  takeEarlyEvents(): PiRpcEvent[] {
    const events = this.earlyEvents ?? []
    this.earlyEvents = null
    return events
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  async prompt(
    message: string,
    images: unknown[] = [],
    opts?: PiPromptOptions
  ): Promise<PiPromptDisposition | undefined> {
    const send = (streamingBehavior?: 'steer' | 'followUp') => {
      const behavior = streamingBehavior ?? opts?.streamingBehavior
      return this.request({
        type: 'prompt',
        message,
        images,
        ...(behavior ? { streamingBehavior: behavior } : {})
      })
    }

    let res = await send()
    if (!res.success) {
      const errText = res.error ?? JSON.stringify(res.data)
      // Pi can report "already processing" while streaming or right after agent_end.
      // Queue via followUp instead of racing a bare prompt retry.
      if (typeof errText === 'string' && errText.includes('already processing') && !opts?.streamingBehavior) {
        res = await send('followUp')
      }
      if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
    }
    const disposition = (res.data as { disposition?: unknown } | undefined)?.disposition
    return disposition === 'handled' || disposition === 'started' || disposition === 'queued' ? disposition : undefined
  }

  async abort(): Promise<void> {
    // Kill bash scripts and hooks (pi's children) first so hung subprocesses
    // don't block pi from processing the RPC abort.
    this.killChildren()
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  // ponytail: pkill -P kills direct children only; grandchildren die when their
  // parent dies (SIGHUP from terminal loss covers most shells). Upgrade path:
  // recursive pgrep walk if we ever see zombie grandchildren.
  private killChildren(signal: string = 'TERM'): void {
    const pid = this.child.pid
    if (!pid || process.platform === 'win32') return
    try {
      execFileSync('pkill', [`-${signal}`, '-P', String(pid)], { stdio: 'ignore' })
    } catch {
      // pkill exits 1 when no matching processes — that's fine
    }
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    const res = await this.request({ type: 'get_available_thinking_levels' })
    if (!res.success) {
      throw new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`)
    }
    const levels = (res.data as { levels?: unknown } | undefined)?.levels
    return Array.isArray(levels) ? levels.filter(isThinkingLevel) : []
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getSessionStats(): Promise<unknown> {
    const res = await this.request({ type: 'get_session_stats' })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(cmd: PiRpcCommand): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })

      void this.writeLine(line).catch(error => {
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.child.stdin.write(line, error => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      } catch (error: unknown) {
        reject(error)
      }
    })
  }
}
