import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  PlanEntry,
  SessionConfigOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import type { SparePi } from '../pi-rpc/spare.js'
import { isTransientCursorSdkAuthError, maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { snapshotImageMarkdown, toolResultToText } from './translate/pi-tools.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { NARRATED_TOOL_CALL_COMPACT_TIP, planNarratedToolCallEmit } from './translate/narrated-tool-calls.js'
import { getPlanUsageDir } from './translate/plan-usage.js'
import { extensionName, noticeFromNotify } from './translate/notice.js'
import { compactionStateFromPiEnd, compactionUpdate, type CompactionState } from './translate/compaction.js'
import { MODEL_CONFIG_ID, parseCompactAt, THINKING_CONFIG_ID } from './translate/config-options.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import { pauseStayAwake } from './stay-awake.js'
import { withTimeout } from './timeout.js'
import { getAutoCompactionPoint } from './pi-settings.js'
import { BackgroundCompaction, type SessionFileInfo, type SummaryWriter } from './background-compaction.js'
import { PLAN_TOOL, planEntries } from './translate/plan.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  /** The client advertised `session.compaction`, so compactions use the client's compaction entry. */
  compactionEntries?: boolean
  /** The client advertised `session.notices`, so warnings outside a reply become notices. */
  notices?: boolean
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
}

/** Optional live-attach sidecar. Null unless PI_ACP_LIVE is on. */
export type LiveSessionBridge = {
  upsert(session: PiAcpSession, sessionFile: string): void
  remove(sessionId: string): void
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  showInClient?: boolean
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type DeferredModel = { provider: string; modelId: string }

type ContextUsage = {
  raw: unknown
  displayTokens: number | null
  contextWindow: number | null
}

const DEFAULT_TURN_INACTIVITY_MS = 60 * 60_000
const DEFAULT_INFERENCE_STARTUP_MS = 5 * 60_000
// pi answers get_session_stats in about a millisecond; missing this means pi is frozen, and
// the stats are cosmetic, so the turn finishes with the last known count instead of waiting
// on the watchdog.
const CONTEXT_USAGE_TIMEOUT_MS = 2_000
const MAX_CURSOR_SDK_AUTH_RETRIES = 2

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

// pi's built-in tools whose `path` is a file or folder; an extension tool's `path` can be anything (ui_screenshot: a URL path).
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls'])

function getToolPath(toolName: string, args: unknown): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function getInitialFileDiffContent(
  toolName: string,
  args: unknown,
  cwd: string,
  snapshotOldText?: string | null
): ToolCallContent[] | undefined {
  const rawPath = getToolPath(toolName, args)
  if (!rawPath) return undefined
  // Always use absolute paths so clients (e.g. Zed) can locate the file for
  // their "files changed" / "Review Changes" panels.
  const path = isAbsolute(rawPath) ? rawPath : resolvePath(cwd, rawPath)

  // For edit: do NOT emit fragment diffs (oldText/newText are just the replaced
  // text chunk, not the full file). Defer to tool_execution_end where we have
  // the complete before/after file content from the snapshot.
  if (toolName === 'edit') return undefined

  if (toolName === 'write') {
    const content = (args as { content?: unknown } | null | undefined)?.content
    if (typeof content !== 'string') return undefined

    return [
      {
        type: 'diff',
        path,
        oldText: snapshotOldText ?? null,
        newText: content
      }
    ]
  }

  return undefined
}

function toToolCallLocations(
  toolName: string,
  args: unknown,
  cwd: string,
  line?: number
): ToolCallLocation[] | undefined {
  const path = getToolPath(toolName, args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()
  private readonly live: LiveSessionBridge | null
  private readonly spare: SparePi | null

  constructor(opts?: { live?: LiveSessionBridge | null; spare?: SparePi | null }) {
    this.live = opts?.live ?? null
    this.spare = opts?.spare ?? null
  }

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  pushConfigOptionUpdates(): void {
    for (const s of this.sessions.values()) void s.pushConfigOptionUpdate()
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.markClosed()
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
    this.live?.remove(sessionId)
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess | null = await (this.spare?.take(params.cwd, params.piCommand)?.catch(() => null) ?? null)
    try {
      if (!proc || proc.exited) {
        proc = await PiRpcProcess.spawn({
          cwd: params.cwd,
          piCommand: params.piCommand
        })
      }
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      store: this.store,
      onDead: () => this.forget(sessionId),
      compactionEntries: params.compactionEntries,
      notices: params.notices
    })

    this.sessions.set(sessionId, session)
    this.live?.upsert(session, sessionFile ?? '')
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      store: this.store,
      onDead: () => this.forget(sessionId),
      compactionEntries: params.compactionEntries,
      notices: params.notices
    })

    this.sessions.set(sessionId, session)
    this.live?.upsert(session, this.store.get(sessionId)?.sessionFile ?? '')
    return session
  }

  private forget(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.live?.remove(sessionId)
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSentOutOfTurn = false
  private startupInfoSentInPrompt = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]
  private readonly onDead: (() => void) | null
  private readonly compactionEntries: boolean
  private readonly notices: boolean
  private compactionId: string | null = null
  private compactionsFinishedCount = 0
  private compactionAfterReply: Promise<void> | null = null
  private stopWaitingForSummary: (() => void) | null = null
  private compactAfterReplyFailed = false
  private compactAtPick: number | null = null
  // A stats reply pi measured before a compaction can arrive after it; until the next model step, any size it reports is stale.
  private compactedSinceLastStep = false
  private readonly background: BackgroundCompaction

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private inFlightTurn: QueuedTurn | null = null
  private cursorSdkAuthRetries = 0
  private readonly turnQueue: QueuedTurn[] = []
  private turnWatchdog: ReturnType<typeof setTimeout> | null = null
  private inferenceStartup = false
  private awaitingUserInput = 0

  // Model/thinking changes from the client are deferred while a turn is active so
  // periodic sync heartbeats cannot race with pi's agent loop (see stuck-session bug).
  private deferredModel: DeferredModel | null = null
  private deferredThinkingLevel: string | null = null

  // Names of pi-contributed slash commands (e.g. extension commands) advertised
  // to the client. pi runs these synchronously and emits NO agent loop / `agent_settled`,
  // so a turn carrying such a command is completed on the prompt response instead.
  private piExtensionCommandNames: Set<string> = new Set()

  // Rebuilds the full ACP config-option set (model + thinking) from current pi
  // state. Supplied by the agent so the session can refresh selectors when pi
  // changes thinking/model outside of an ACP set request.
  private refreshConfigOptions: (() => Promise<SessionConfigOption[]>) | null = null
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()
  // Base title (no mid-run _label override) each tool call started with, so
  // tool_execution_end can restore it. Without this, a tool that ever set a
  // progress label via onUpdate({details:{_label}}) (plan, audit, scout, ...)
  // is left showing that stale label forever after it finishes, since
  // tool_execution_end never re-sends `title` on its own.
  private originalToolTitles = new Map<string, string>()
  private customTitledToolCallIds = new Set<string>()
  // Set when a retry/rate-limit failure rejects the ACP prompt (Zed error state).
  private turnTerminalFailureHandled = false

  // pi can emit several `turn_end` and `agent_end` events for one prompt (tool use, retry,
  // compaction, queued follow-ups). The prompt is done only when pi emits `agent_settled`.
  private inAgentLoop = false
  // Error from the current run's `agent_end`, reported on `agent_settled`. Cleared on
  // `agent_start`, so a failed attempt that pi retried doesn't fail the turn.
  private agentRunError = ''

  // Gate for model-narrated `Tool call(...)` text (no structured toolCall). Suppress the
  // dump and tip /compact instead — see translate/narrated-tool-calls.ts.
  private assistantTextAccum = ''
  private assistantTextEmitted = 0
  private narratedToolCallsSuppressed = false
  private sawStructuredToolCall = false

  // Live-socket turns never go through Zed `session/prompt`, so the composer
  // stays Idle. An in-progress Plan is the spinner Zed still draws in that state
  // (activity bar). Skipped while the agent's own plan is showing, which it would overwrite.
  private liveTurnPlanActive = false

  private plan: PlanEntry[] | null = null
  private planToolCallIds = new Set<string>()

  // True while the in-flight turn is a recognised extension command (e.g. /trip-plan).
  // Such commands can drive several *independent* nested turns internally (via
  // pi.sendUserMessage()+waitForIdle(), see trip/index.ts's deliver()), each firing its
  // own real `agent_start`/`agent_settled`. Those are not the command's own completion — the
  // command's RPC `prompt` response only resolves once the whole handler returns (pi core
  // awaits `_tryExecuteExtensionCommand` before acking) — so while this flag is set,
  // `agent_settled`/error events must not complete the ACP turn early; only the `.then()` in
  // startTurn() does, once the command handler itself is done.
  private pendingTurnIsExtensionCommand = false

  // Context window size reported by pi (updated from getSessionStats).
  private contextWindow: number | null = null

  // Peak context tokens seen this session. Context only grows, so we never
  // decrease this — guards against Cursor Composer's "take-once" input
  // accounting where intermediate tool-call turns report input=0, making the
  // last assistant message's totalTokens look tiny.
  private peakContextTokens: number = 0
  private readonly extensionStatuses = new Map<string, string>()

  // Cached `gh pr view` lookup for the footer PR link. Gated on sessionStartBranch
  // (see getPrLinkCached): a session that never changes branch never shells out to
  // gh, so a branch with a pre-existing PR from earlier work doesn't get reported
  // as "this session's" PR. Once the branch does change, refreshed in the
  // background after PR_LINK_CACHE_MS so it never adds latency to a turn — a
  // stale/cold cache just means the footer omits the link until the fetch lands.
  // null url means "no open PR" (also cached, so a branch with no PR doesn't
  // retry every turn).
  private prLinkCache: { url: string | null; branch: string | null; fetchedAt: number } | null = null
  private prLinkRefreshInFlight: Promise<void> | null = null
  // Branch this session started on; undefined until the first check. A link is
  // only ever surfaced once the current branch diverges from this baseline.
  private sessionStartBranch: string | null | undefined = undefined
  // Persists sessionStartBranch across process restarts (see constructor and
  // getPrLinkCached). Null when the session was constructed without a store
  // (e.g. tests) — the footer link heuristic just won't survive a resume.
  private readonly store: SessionStore | null = null

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private fileMutationDiffsEmitted = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()
  private readToolCallPaths = new Map<string, string>()
  // Tracks synthetic tool call IDs emitted for subagent child tool calls.
  // Key: `${parentToolCallId}__${subagentCallId}` → syntheticToolCallId
  private subagentToolCalls = new Map<string, string>()
  // Tool calls the model is still writing, by content index: pi sends only their id and name, then argument text in pieces.
  private streamingToolCalls = new Map<
    number,
    { id: string; name: string; args: string; titleArgs: Record<string, string> | null }
  >()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  // Live-socket observers (Slack). Empty unless something attached; throws are
  // dropped so a dead sidecar cannot break the Zed ACP connection.
  private readonly observers = new Set<(update: SessionUpdate) => void>()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    store?: SessionStore
    /** Called once when the underlying pi process exits, so the owning SessionManager can evict this session. */
    onDead?: () => void
    compactionEntries?: boolean
    notices?: boolean
    /** Starts the pi that writes a summary in the background; tests swap in a fake. */
    startSummaryWriter?: (sessionPath: string) => Promise<SummaryWriter>
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.store = opts.store ?? null
    // A size a later release dropped from the menu would otherwise compact at a size the button can't show.
    this.compactAtPick = parseCompactAt(String(this.store?.get(this.sessionId)?.compactAt))
    this.onDead = opts.onDead ?? null
    this.compactionEntries = opts.compactionEntries ?? false
    this.notices = opts.notices ?? false
    this.background = new BackgroundCompaction(
      opts.startSummaryWriter ??
        (sessionPath => PiRpcProcess.spawn({ cwd: this.cwd, sessionPath, summaryWriter: true }))
    )

    this.proc.onEvent(ev => this.handlePiEvent(ev))
    this.proc.onExit?.((code, signal) => {
      void this.handleProcessExit(code, signal)
    })

    // A reload/resume (computer reboot, Zed restart) constructs a brand new
    // PiAcpSession for the same sessionId. Without this, sessionStartBranch
    // below would reset to the *current* branch and the footer PR link would
    // vanish forever, even though the branch diverged earlier in the same
    // logical session. Recover the original baseline from disk first.
    if (this.store?.hasStartBranch(this.sessionId)) {
      this.sessionStartBranch = this.store.get(this.sessionId)?.startBranch ?? null
    }

    // Captures sessionStartBranch as a side effect; a real gh fetch only happens
    // once the branch changes (see getPrLinkCached).
    this.getPrLinkCached()
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSentOutOfTurn = false
    this.startupInfoSentInPrompt = false
  }

  // Register the pi-contributed slash commands the client may invoke. Used to
  // recognise command turns that complete without an agent loop. Set independently
  // of whether the commands are advertised, so manually-typed commands still resolve.
  setPiExtensionCommands(names: Iterable<string>): void {
    this.piExtensionCommandNames = new Set(names)
  }

  getPiExtensionCommands(): string[] {
    return [...this.piExtensionCommandNames]
  }

  // Provide the builder used to refresh model/thinking selectors after pi changes
  // them on its own (see the `thinking_level_changed` handler).
  setConfigOptionsRefresher(refresh: () => Promise<SessionConfigOption[]>): void {
    this.refreshConfigOptions = refresh
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSentOutOfTurn || !this.startupInfo) return
    this.startupInfoSentOutOfTurn = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  private sendStartupInfoOnFirstPromptIfPending(): void {
    if (this.startupInfoSentInPrompt || !this.startupInfo) return
    this.startupInfoSentInPrompt = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = [], opts?: { showInClient?: boolean }): Promise<StopReason> {
    // Keep a prompt-path fallback because some clients may ignore the best-effort
    // pre-prompt notification sent right after session/new.
    this.sendStartupInfoOnFirstPromptIfPending()

    // Live-socket prompts (Slack) never went through Zed's composer, so the
    // panel has no user bubble unless we emit one. session/prompt from Zed
    // already drew it — do not double.
    if (opts?.showInClient && message.trim()) {
      this.emit({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: message } satisfies ContentBlock
      })
    }

    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = {
        message: expandedMessage,
        images,
        showInClient: opts?.showInClient,
        resolve,
        reject
      }

      // If a turn is running OR there are already-queued turns waiting to start (prevent
      // a new prompt from racing past the queue during the brief window between
      // completeTurn setting pendingTurn=null and startNextQueuedTurn firing).
      if (this.pendingTurn || this.turnQueue.length > 0 || this.compactionAfterReply) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // Zed only applies `title` from this update; `_meta` is dropped.
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // Reserve synchronously so a concurrent prompt() can't slip past before startTurn runs.
      this.pendingTurn = { resolve, reject }
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    this.stopWaitingForSummary?.()
    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  hasActiveTurn(): boolean {
    return this.pendingTurn !== null
  }

  addObserver(fn: (update: SessionUpdate) => void): () => void {
    this.observers.add(fn)
    return () => {
      this.observers.delete(fn)
    }
  }

  async setModelWhenIdle(provider: string, modelId: string): Promise<void> {
    if (this.pendingTurn) {
      this.deferredModel = { provider, modelId }
      return
    }
    await this.proc.setModel(provider, modelId)
    void this.pushUsageUpdate()
  }

  async setThinkingLevelWhenIdle(level: string): Promise<void> {
    if (this.pendingTurn) {
      this.deferredThinkingLevel = level
      return
    }
    await this.proc.setThinkingLevel(level as Parameters<PiRpcProcess['setThinkingLevel']>[0])
  }

  /** Shows a model or thinking change deferred during a reply as selected, so Zed's dropdowns keep the pick. */
  withDeferredConfig(options: SessionConfigOption[]): SessionConfigOption[] {
    const deferred: Record<string, string | null> = {
      [MODEL_CONFIG_ID]: this.deferredModel && `${this.deferredModel.provider}/${this.deferredModel.modelId}`,
      [THINKING_CONFIG_ID]: this.deferredThinkingLevel
    }
    return options.map(o => {
      const value = deferred[o.id]
      if (!value || o.type !== 'select') return o
      const listed = o.options.some(x => ('value' in x ? x.value === value : x.options.some(y => y.value === value)))
      return listed ? { ...o, currentValue: value } : o
    })
  }

  private emit(update: SessionUpdate): void {
    if (this.observers.size > 0) {
      for (const fn of [...this.observers]) {
        try {
          fn(update)
        } catch {
          this.observers.delete(fn)
        }
      }
    }

    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  get compactionsFinished(): number {
    return this.compactionsFinishedCount
  }

  /** Handles the events pi sent before this session listened; call once the client knows the session. */
  replayEarlyEvents(): void {
    for (const ev of this.proc.takeEarlyEvents()) this.handlePiEvent(ev)
  }

  private startCompaction(): void {
    if (this.compactionId) return
    this.compactionId = `compaction-${crypto.randomUUID()}`
    this.emit(compactionUpdate(this.compactionId, { status: 'in_progress' }, this.compactionEntries))
  }

  finishCompaction(state: CompactionState): void {
    // A cancelled compaction left the thread as it was, so the summary written for it still fits.
    if (state.status !== 'cancelled') void this.background.discard()
    const id = this.compactionId ?? `compaction-${crypto.randomUUID()}`
    this.compactionId = null
    this.compactionsFinishedCount += 1
    this.emit(compactionUpdate(id, state, this.compactionEntries))
    // Retrying after every reply would make each next message wait; pi's own limit stays the fallback.
    if (state.status === 'failed' && this.compactionAfterReply) this.compactAfterReplyFailed = true
    if (state.status !== 'completed') return
    this.compactAfterReplyFailed = false
    this.compactedSinceLastStep = true
    // pi reports no context size until the next reply after a compaction, so the ring would
    // keep the pre-compaction size; show pi's estimate (messages only, so it reads low) meanwhile.
    this.peakContextTokens = 0
    if (process.env.PI_ACP_SHOW_TOKEN_USAGE !== 'false')
      this.emitUsageUpdate(state.tokensAfter ?? null, this.contextWindow)
  }

  async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.originalToolTitles.delete(toolCallId)
    this.customTitledToolCallIds.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.fileMutationDiffsEmitted.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
    this.readToolCallPaths.delete(toolCallId)
    // Clean up any subagent tool calls spawned under this parent
    const prefix = `${toolCallId}__`
    for (const [key, syntheticId] of this.subagentToolCalls) {
      if (key.startsWith(prefix)) {
        this.currentToolCalls.delete(syntheticId)
        this.subagentToolCalls.delete(key)
      }
    }
  }

  private turnInactivityMs(): number {
    const raw = process.env.PI_ACP_TURN_INACTIVITY_MS ?? process.env.PI_ACP_TURN_TIMEOUT_MS
    if (!raw) return DEFAULT_TURN_INACTIVITY_MS
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TURN_INACTIVITY_MS
  }

  private inferenceStartupMs(): number {
    const raw = process.env.PI_ACP_INFERENCE_STARTUP_MS
    if (!raw) return DEFAULT_INFERENCE_STARTUP_MS
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INFERENCE_STARTUP_MS
  }

  private resetTurnWatchdog(): void {
    if (!this.pendingTurn) return
    this.clearTurnWatchdog()
    if (this.awaitingUserInput > 0) return
    // Use the longer inference-startup timeout when waiting for the LLM to begin
    // streaming after a turn_end (tool results sent, no tokens yet). Switch back
    // to the normal inactivity timeout once the model starts producing output.
    const ms = this.inferenceStartup ? this.inferenceStartupMs() : this.turnInactivityMs()
    this.turnWatchdog = setTimeout(() => {
      void this.handleTurnWatchdog()
    }, ms).unref()
  }

  private clearTurnWatchdog(): void {
    if (!this.turnWatchdog) return
    clearTimeout(this.turnWatchdog)
    this.turnWatchdog = null
  }

  private async handleTurnWatchdog(): Promise<void> {
    if (!this.pendingTurn) return

    const ms = this.inferenceStartup ? this.inferenceStartupMs() : this.turnInactivityMs()
    const duration = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`
    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Turn timed out: no output from pi for ${duration}.` }
    })

    try {
      await this.proc.abort()
    } catch {
      // ignore
    }

    await this.flushEmits()
    this.completeTurn('error')
  }

  // Set when the manager disposes this session on purpose (close, respawn). The exit that
  // follows is expected: don't warn, and don't evict, since a respawn may already have
  // registered a new session under the same id.
  private closed = false

  markClosed(): void {
    this.closed = true
    void this.background.discard()
  }

  private async handleProcessExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.clearTurnWatchdog()
    void this.background.discard()
    if (this.closed) {
      if (this.pendingTurn) this.completeTurn('cancelled')
      return
    }
    const detail = signal ? `signal ${signal}` : `code ${code}`

    if (!this.pendingTurn) {
      // Pi died while idle (crash, OOM, killed externally). There's no pending
      // ACP request to fail, but the session must not linger as a zombie: the
      // next request against it (a prompt, or a model/thinking change) would
      // otherwise hit a raw "write after stream destroyed" error instead of
      // transparently respawning. Evict it so autoRestoreSession respawns pi
      // on the next request.
      this.emit(
        this.notices
          ? {
              sessionUpdate: 'notice',
              severity: 'warning',
              title: 'pi stopped unexpectedly',
              description: `It restarts with your next message (exit ${detail}).`
            }
          : {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Error: pi process exited unexpectedly (${detail}); it will restart on your next message.`
              }
            }
      )
      await this.flushEmits()
      this.onDead?.()
      return
    }

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Error: pi process exited (${detail})` }
    })

    await this.flushEmits()
    this.completeTurn(this.cancelRequested ? 'cancelled' : 'error')
    this.onDead?.()
  }

  private async flushDeferredConfig(): Promise<void> {
    const model = this.deferredModel
    const thinking = this.deferredThinkingLevel
    this.deferredModel = null
    this.deferredThinkingLevel = null

    try {
      if (model) {
        await this.proc.setModel(model.provider, model.modelId)
        void this.pushUsageUpdate()
      }
      if (thinking) {
        await this.proc.setThinkingLevel(thinking as Parameters<PiRpcProcess['setThinkingLevel']>[0])
      }
    } catch (err) {
      // Must not rethrow: the caller doesn't await this, so an escaping error is an unhandled
      // rejection that exits the adapter. The refresh below puts the selectors back on what pi kept.
      process.stderr.write(`pi-acp: deferred model/thinking change failed (${String(err)})\n`)
    }
    if (model || thinking) void this.pushConfigOptionUpdate()
  }

  private startTurn(t: QueuedTurn, opts?: { streamingBehavior?: 'steer' | 'followUp'; retrying?: boolean }): void {
    if (!opts?.retrying) {
      this.cancelRequested = false
      this.cursorSdkAuthRetries = 0
    }
    this.turnTerminalFailureHandled = false
    this.inAgentLoop = false
    this.agentRunError = ''
    this.inferenceStartup = true
    this.pendingTurn = { resolve: t.resolve, reject: t.reject }
    this.inFlightTurn = t
    this.pendingTurnIsExtensionCommand = this.isExtensionCommandMessage(t.message)
    this.resetTurnWatchdog()

    if (t.showInClient && !opts?.retrying) this.startLiveTurnIndicator()

    // Publish queue depth (0 because we're starting the turn now).
    // Zed ignores `_meta` here; only `title` is applied.
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The full prompt is finished when we see `agent_settled`.
    this.proc.prompt(t.message, t.images, { streamingBehavior: opts?.streamingBehavior }).then(
      disposition => {
        // A prompt pi handled without an agent run (an extension command or input handler)
        // never gets `agent_settled`, so complete the turn on the prompt response instead.
        // pi before 0.99 reports no disposition; fall back to recognising command names.
        const handled = disposition ? disposition === 'handled' : this.isExtensionCommandMessage(t.message)
        if (!handled) return
        void this.flushEmits().finally(() => {
          this.pendingTurnIsExtensionCommand = false
          this.completeTurn(this.cancelRequested ? 'cancelled' : 'end_turn')
        })
      },
      err => {
        // If the subprocess errors before we get `agent_settled`, treat as error unless cancelled.
        void (async () => {
          await this.flushEmits()
          // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
          const authErr = maybeAuthRequiredError(err)
          if (authErr) {
            this.pendingTurn?.reject(authErr)
          } else {
            const errorMessage = err instanceof Error ? err.message : String(err ?? 'Unknown error')
            this.emit({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Error: ${errorMessage}` }
            })
            // Clients close the turn on the prompt response; deliver the chunk first.
            await this.flushEmits()
            const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
            this.pendingTurn?.resolve(reason)
          }

          this.pendingTurn = null
          this.inFlightTurn = null
          this.cursorSdkAuthRetries = 0
          this.pendingTurnIsExtensionCommand = false
          this.inAgentLoop = false
          this.clearTurnWatchdog()

          // If the prompt failed, do not automatically proceed—pi may be unhealthy.
          // But we still clear the queueDepth metadata.
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
          })
        })()
      }
    )
  }

  private isExtensionCommandMessage(message: string): boolean {
    const trimmed = message.trimStart()
    if (!trimmed.startsWith('/')) return false
    const space = trimmed.indexOf(' ')
    const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).trim()
    return name.length > 0 && this.piExtensionCommandNames.has(name)
  }

  private tryRetryCursorSdkAuthFlake(errorMessage: string): boolean {
    if (this.cancelRequested || this.pendingTurnIsExtensionCommand) return false
    if (!isTransientCursorSdkAuthError(errorMessage)) return false
    const turn = this.inFlightTurn
    if (!turn || this.cursorSdkAuthRetries >= MAX_CURSOR_SDK_AUTH_RETRIES) return false

    this.cursorSdkAuthRetries += 1
    this.resetNarratedToolCallGate()
    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: `\n\nCursor SDK API key rejected — retrying (${this.cursorSdkAuthRetries}/${MAX_CURSOR_SDK_AUTH_RETRIES})...`
      } satisfies ContentBlock
    })
    this.startTurn(turn, { retrying: true })
    return true
  }

  private resetNarratedToolCallGate(): void {
    this.assistantTextAccum = ''
    this.assistantTextEmitted = 0
    this.narratedToolCallsSuppressed = false
    this.sawStructuredToolCall = false
  }

  private markStructuredToolCall(): void {
    this.sawStructuredToolCall = true
    if (!this.narratedToolCallsSuppressed) return
    // False positive: dump was real tooling context — flush held text.
    const rest = this.assistantTextAccum.slice(this.assistantTextEmitted)
    if (rest) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: rest } satisfies ContentBlock
      })
      this.assistantTextEmitted = this.assistantTextAccum.length
    }
    this.narratedToolCallsSuppressed = false
  }

  private flushNarratedToolCallGate(): void {
    if (this.narratedToolCallsSuppressed && !this.sawStructuredToolCall) {
      const prefix = this.assistantTextEmitted > 0 ? '\n\n' : ''
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `${prefix}${NARRATED_TOOL_CALL_COMPACT_TIP}` } satisfies ContentBlock
      })
      this.resetNarratedToolCallGate()
      return
    }

    const rest = this.assistantTextAccum.slice(this.assistantTextEmitted)
    if (rest) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: rest } satisfies ContentBlock
      })
    }
    this.resetNarratedToolCallGate()
  }

  showPlan(entries: PlanEntry[]): void {
    this.plan = entries
    this.liveTurnPlanActive = false
    this.emit({ sessionUpdate: 'plan', entries })
  }

  get currentPlan(): PlanEntry[] | null {
    return this.plan
  }

  private startLiveTurnIndicator(): void {
    if (this.plan?.length) return
    this.liveTurnPlanActive = true
    this.emit({
      sessionUpdate: 'plan',
      entries: [{ content: 'Working…', priority: 'medium', status: 'in_progress' }]
    })
  }

  private finishLiveTurnIndicator(): void {
    if (!this.liveTurnPlanActive) return
    this.liveTurnPlanActive = false
    this.emit({ sessionUpdate: 'plan', entries: [] })
  }

  // Resolve the current turn and start the next queued one (if any). Shared by the
  // `agent_settled` event and synchronous command turns that produce no agent loop.
  private completeTurn(reason: StopReason): void {
    this.finishLiveTurnIndicator()
    this.clearTurnWatchdog()
    this.pendingTurn?.resolve(reason)
    this.pendingTurn = null
    this.inFlightTurn = null
    this.cursorSdkAuthRetries = 0
    this.pendingTurnIsExtensionCommand = false
    this.inAgentLoop = false

    void this.flushDeferredConfig().finally(() => {
      if (this.shouldCompactAfterReply(reason)) void this.compactAfterReply()
      else this.startNextQueuedTurn()
    })
  }

  private shouldCompactAfterReply(reason: StopReason): boolean {
    const limit = this.compactAtPick
    return (
      reason === 'end_turn' &&
      !this.pendingTurn &&
      !this.turnQueue.length &&
      limit !== null &&
      this.peakContextTokens >= limit &&
      !this.compactAfterReplyFailed
    )
  }

  /** Runs while the user reads the reply; a prompt sent meanwhile waits in the turn queue. */
  private async compactAfterReply(): Promise<void> {
    const finishedBefore = this.compactionsFinishedCount
    const finishIfPiDidNot = (state: CompactionState) => {
      if (this.compactionsFinishedCount === finishedBefore) this.finishCompaction(state)
    }
    // Shown now, not at pi's compaction_start: a summary still being written can take a while.
    this.startCompaction()
    this.compactionAfterReply = (async () => {
      await Promise.race([
        this.background.untilUsable(this.peakContextTokens),
        new Promise<void>(resolve => (this.stopWaitingForSummary = resolve))
      ])
      this.stopWaitingForSummary = null
      if (this.cancelRequested) return finishIfPiDidNot({ status: 'cancelled' })
      finishIfPiDidNot(compactionStateFromPiEnd({ result: await this.proc.compact() }))
    })().catch(err => finishIfPiDidNot({ status: 'failed', error: err instanceof Error ? err.message : String(err) }))
    try {
      await this.compactionAfterReply
    } catch {
      // The compaction entry may stay unfinished; the waiting messages must still run.
    } finally {
      this.compactionAfterReply = null
      this.startNextQueuedTurn()
    }
  }

  private async handleTerminalFailure(message: string, opts?: { abort?: boolean }): Promise<void> {
    if (this.turnTerminalFailureHandled) return
    this.turnTerminalFailureHandled = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `\n\n${message}` } satisfies ContentBlock
    })

    if (opts?.abort) {
      try {
        await this.proc.abort()
      } catch {
        // ignore
      }
    }

    await this.flushEmits()
    if (this.pendingTurnIsExtensionCommand) return

    this.finishLiveTurnIndicator()
    this.clearTurnWatchdog()
    this.pendingTurn?.reject(RequestError.internalError({}, message))
    this.pendingTurn = null
    this.inFlightTurn = null
    this.cursorSdkAuthRetries = 0
    this.pendingTurnIsExtensionCommand = false
    this.inAgentLoop = false
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
    })
  }

  private startNextQueuedTurn(): void {
    const next = this.turnQueue.shift()
    if (next) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
      })
      this.startTurn(next, { streamingBehavior: 'followUp' })
      return
    }

    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: 0, running: false } }
    })
  }

  private static readonly PR_LINK_CACHE_MS = 30_000
  private static readonly execFileAsync = promisify(execFile)

  // Best-effort, cached GitHub PR URL for the current branch — appended to the
  // token-usage footer so it's visible without running /pr-link manually. Never
  // blocks the caller: returns whatever is cached (possibly null on a cold
  // start) and kicks off a background refresh if the cache is stale.
  //
  // Suppressed until the branch actually changes from whatever it was when the
  // session started: a fresh session on a branch that already has an open PR
  // from earlier, unrelated work has no business reporting that PR as its own.
  private getPrLinkCached(): string | null {
    if (process.env.PI_ACP_SHOW_PR_LINK === 'false') return null
    const currentBranch = this.getCurrentBranchSync()
    if (this.sessionStartBranch === undefined) {
      this.sessionStartBranch = currentBranch
      this.store?.setStartBranch(this.sessionId, currentBranch)
    }
    if (currentBranch === this.sessionStartBranch) return null

    // The branch changed again mid-session (e.g. hopped from one work branch to
    // another) — a cached URL for the previous branch is wrong for this one.
    if (this.prLinkCache && this.prLinkCache.branch !== currentBranch) {
      this.prLinkCache = null
    }

    const now = Date.now()
    const stale = !this.prLinkCache || now - this.prLinkCache.fetchedAt >= PiAcpSession.PR_LINK_CACHE_MS
    if (stale && !this.prLinkRefreshInFlight) {
      this.prLinkRefreshInFlight = this.refreshPrLink(currentBranch).finally(() => {
        this.prLinkRefreshInFlight = null
      })
    }
    return this.prLinkCache?.url ?? null
  }

  // Fast, sync branch read via .git/HEAD — avoids spawning `git` just to decide
  // whether the gh cache is still valid. Falls back to null (treated as "unknown
  // branch", forcing a refresh) for detached HEAD or any read failure.
  private getCurrentBranchSync(): string | null {
    try {
      const head = readFileSync(resolvePath(this.cwd, '.git', 'HEAD'), 'utf8').trim()
      const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
      return match ? match[1] : head || null
    } catch {
      return null
    }
  }

  private async refreshPrLink(branch: string | null): Promise<void> {
    let url: string | null = null
    try {
      const { stdout } = await PiAcpSession.execFileAsync('gh', ['pr', 'view', '--json', 'url', '-q', '.url'], {
        cwd: this.cwd,
        timeout: 3_000
      })
      url = stdout.trim() || null
    } catch {
      url = null
    }
    this.prLinkCache = { url, branch, fetchedAt: Date.now() }
  }

  // Best-effort refresh of the config option selectors. A stale selector is
  // preferable to crashing the event loop, so failures are swallowed.
  async pushConfigOptionUpdate(): Promise<void> {
    const refresh = this.refreshConfigOptions
    if (!refresh) return
    try {
      const configOptions = this.withDeferredConfig(await refresh())
      this.emit({ sessionUpdate: 'config_option_update', configOptions })
    } catch {
      // ignore
    }
  }

  // Drives Zed's context ring next to the composer dropdowns. Skipped when pi doesn't
  // know the model's window or has no post-compaction count yet.
  private emitUsageUpdate(tokens: number | null, contextWindow: number | null): void {
    if (!tokens || !contextWindow) return
    this.emit({ sessionUpdate: 'usage_update', used: tokens, size: this.ringSize(contextWindow) })
  }

  /** Context size at which a finished reply compacts this thread, or null to leave it to pi. */
  get compactAt(): number | null {
    return this.compactAtPick
  }

  /** A pick re-arms after-reply compaction in a thread where it failed, and resizes the ring. */
  setCompactAt(value: string): void {
    this.compactAtPick = parseCompactAt(value)
    this.store?.setCompactAt(this.sessionId, this.compactAtPick)
    this.compactAfterReplyFailed = false
    void this.background.discard()
    void this.pushUsageUpdate()
  }

  /** The ring fills toward the picked compaction size, since that is when the thread compacts. */
  private ringSize(contextWindow: number): number {
    return Math.min(contextWindow, this.compactAtPick ?? contextWindow)
  }

  /** Refreshes the context ring outside turn ends: after each model step, on a reopened thread and after a model switch. */
  async pushUsageUpdate(estimatedTokens?: number): Promise<void> {
    if (process.env.PI_ACP_SHOW_TOKEN_USAGE === 'false') return
    try {
      const usage = await this.readContextUsage()
      this.emitUsageUpdate(usage.displayTokens ?? estimatedTokens ?? null, usage.contextWindow)
    } catch {
      // Stats are cosmetic; the ring appears after the next turn instead.
    }
  }

  private async readContextUsage(): Promise<ContextUsage> {
    const stats = await withTimeout(this.proc.getSessionStats(), CONTEXT_USAGE_TIMEOUT_MS)
    const raw = (stats as { contextUsage?: unknown } | null)?.contextUsage
    const cu = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof cu.contextWindow === 'number') this.contextWindow = cu.contextWindow
    const tokens = typeof cu.tokens === 'number' && !this.compactedSinceLastStep ? cu.tokens : null

    // Use a monotonic peak to guard against Cursor Composer's "take-once" input accounting
    // where intermediate tool-call LLM responses report input=0, making totalTokens tiny.
    if (tokens !== null && tokens > 0) this.peakContextTokens = Math.max(this.peakContextTokens, tokens)
    this.maybeStartBackgroundCompaction()

    return {
      raw,
      displayTokens: this.peakContextTokens > 0 ? this.peakContextTokens : tokens,
      contextWindow: this.contextWindow
    }
  }

  private maybeStartBackgroundCompaction(): void {
    const picked = this.compactAtPick
    const piCompactsAt = this.contextWindow ? getAutoCompactionPoint(this.cwd, this.contextWindow) : null
    const limit = Math.min(picked ?? Infinity, piCompactsAt ?? Infinity)
    if (limit === Infinity || this.compactAfterReplyFailed || this.compactionAfterReply) return
    if (this.background.shouldStart(this.peakContextTokens, limit))
      this.background.start(this.sessionFileInfo(), this.peakContextTokens, limit)
  }

  private async sessionFileInfo(): Promise<SessionFileInfo> {
    const state = (await this.proc.getState()) as { sessionFile?: unknown; sessionId?: unknown } | null
    if (typeof state?.sessionFile !== 'string' || typeof state.sessionId !== 'string')
      throw new Error('pi reported no session file')
    return { file: state.sessionFile, id: state.sessionId }
  }

  private async maybeEmitTokenStats(): Promise<void> {
    if (process.env.PI_ACP_SHOW_TOKEN_USAGE === 'false') return
    const debug = process.env.PI_ACP_DEBUG_TOKEN_USAGE === 'true'

    let usage: ContextUsage
    try {
      usage = await this.readContextUsage()
    } catch (err) {
      if (debug)
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `[token debug] getSessionStats error: ${String(err)}` }
        })
      usage = {
        raw: undefined,
        displayTokens: this.peakContextTokens > 0 ? this.peakContextTokens : null,
        contextWindow: this.contextWindow
      }
    }

    if (debug) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `\n[token debug] contextUsage=${JSON.stringify(usage.raw)}` }
      })
    }

    const { contextWindow, displayTokens } = usage
    this.emitUsageUpdate(displayTokens, contextWindow)
    const parts: string[] = []
    if (displayTokens !== null && displayTokens > 0) {
      parts.push(`${displayTokens.toLocaleString()} tokens`)
      if (contextWindow) {
        const percent = (displayTokens / this.ringSize(contextWindow)) * 100
        parts.push(`${Math.round(percent * 10) / 10}%`)
      }
    }
    const prLink = this.getPrLinkCached()
    if (prLink) {
      const prNumber = /\/pull\/(\d+)\/?$/.exec(prLink)?.[1]
      parts.push(prNumber ? `[#${prNumber}](${prLink})` : `[PR](${prLink})`)
    }
    parts.push(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))
    parts.push(...this.extensionStatuses.values())

    if (parts.length)
      this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n↳ ${parts.join(' · ')}` } })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    if (this.pendingTurn) this.resetTurnWatchdog()

    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text. Suppress narrated `Tool call(...)` dumps (no real tools).
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.inferenceStartup = false
          if (this.narratedToolCallsSuppressed) break

          this.assistantTextAccum += ame.delta
          const plan = planNarratedToolCallEmit(this.assistantTextAccum, this.assistantTextEmitted)
          if (plan.emit) {
            this.assistantTextEmitted += plan.emit.length
            this.emit({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: plan.emit } satisfies ContentBlock
            })
          }
          if (plan.suppressFrom !== null) this.narratedToolCallsSuppressed = true
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.inferenceStartup = false
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'toolcall_start') {
          this.inferenceStartup = false
          this.markStructuredToolCall()
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const index = Number(ame.contentIndex ?? 0)
          // pi 0.84+ sends the whole call only on `toolcall_end`; older pi sends it as `partial` on every event.
          const toolCall = ame.toolCall ?? ame.partial?.content?.[index]
          if (!toolCall && ame.type === 'toolcall_start') {
            this.streamingToolCalls.set(index, {
              id: String(ame.id ?? ''),
              name: String(ame.toolName ?? 'tool'),
              args: '',
              titleArgs: null
            })
          }
          const streaming = this.streamingToolCalls.get(index)
          if (ame.type === 'toolcall_end') this.streamingToolCalls.delete(index)

          const toolCallId = String(toolCall?.id ?? streaming?.id ?? '')
          const toolName = String(toolCall?.name ?? streaming?.name ?? 'tool')
          if (toolName === PLAN_TOOL) break

          let titleArgs: Record<string, string> | undefined
          if (!toolCall && streaming && ame.type === 'toolcall_delta') {
            // One update when the file name or command arrives, not one per piece.
            // ponytail: stops looking after 8 KB of arguments, so a path the model sends after a long
            // `content` shows only when the call ends. Upgrade: a streaming JSON parser.
            if (streaming.titleArgs || streaming.args.length > 8192) break
            streaming.args += String(ame.delta ?? '')
            const found = streamedTitleArgs(streaming.args)
            if (!found) break
            streaming.titleArgs = titleArgs = found
          }

          if (toolCallId) {
            const rawInput =
              toolCall?.arguments && typeof toolCall.arguments === 'object'
                ? toolCall.arguments
                : (titleArgs ?? streaming?.titleArgs ?? undefined)

            const locations = toToolCallLocations(toolName, rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              const title = toToolTitle(toolName, rawInput, this.cwd)
              this.originalToolTitles.set(toolCallId, title)
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Keep the existing status (pending or in_progress).
              const title = toToolTitle(toolName, rawInput, this.cwd)
              this.originalToolTitles.set(toolCallId, title)
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                title,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        this.markStructuredToolCall()
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (toolName === PLAN_TOOL) {
          this.planToolCallIds.add(toolCallId)
          const entries = planEntries(args)
          if (entries) this.showPlan(entries)
          break
        }

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(toolName, args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')

          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(toolName, args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              // Store absolute path so diff content emitted at tool_execution_end
              // also uses an absolute path (required by ACP clients like Zed).
              this.fileSnapshots.set(toolCallId, { path: abs, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              this.fileSnapshots.set(toolCallId, { path: abs, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(toolName, args, this.cwd, line)
        const initialFileContent = isFileMutation
          ? getInitialFileDiffContent(toolName, args, this.cwd, snapshotOldText)
          : undefined
        if (initialFileContent) this.fileMutationDiffsEmitted.add(toolCallId)
        if (toolName === 'read' && locations) this.readToolCallPaths.set(toolCallId, locations[0].path)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          const title = toToolTitle(toolName, args, this.cwd)
          this.originalToolTitles.set(toolCallId, title)
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            content: initialFileContent,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            title: toToolTitle(toolName, args, this.cwd),
            status: 'in_progress',
            locations,
            content: initialFileContent,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId || this.planToolCallIds.has(toolCallId)) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        // Scout extension relays child tool calls via _subagent_tool_call details.
        // Emit them as real tool_call / tool_call_update events with a ↳ prefix.
        const subCall = (partial?.details as Record<string, unknown> | null | undefined)?._subagent_tool_call as
          | { id: string; name?: string; args?: unknown; status: 'in_progress' | 'completed' }
          | undefined
        if (subCall) {
          const mapKey = `${toolCallId}__${subCall.id}`
          if (subCall.status === 'in_progress' && subCall.name) {
            if (!this.subagentToolCalls.has(mapKey)) {
              const syntheticId = `sub__${toolCallId}__${subCall.id}`
              this.subagentToolCalls.set(mapKey, syntheticId)
              this.currentToolCalls.set(syntheticId, 'in_progress')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId: syntheticId,
                title: `${toToolTitle(subCall.name, subCall.args)} (⎇)`,
                kind: 'search',
                status: 'in_progress',
                rawInput: subCall.args
              })
            }
          } else if (subCall.status === 'completed') {
            const syntheticId = this.subagentToolCalls.get(mapKey)
            if (syntheticId) {
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId: syntheticId,
                status: 'completed',
                content: [
                  { type: 'content', content: { type: 'text', text: '(result in scout summary)' } }
                ] satisfies ToolCallContent[]
              })
            }
          }
          break
        }

        // Extensions can pass a custom ACP title via onUpdate({ details: { _label: '...' } })
        const customTitle = typeof partial?.details?._label === 'string' ? partial.details._label : undefined
        // Label-only updates: just update the title, skip content/rawOutput to avoid sending
        // the partial result object (e.g. { content: [], details: { _label: '...' } }) as rawOutput,
        // which would cause toolResultToText to JSON-stringify it and Zed to treat it as the
        // tool's final result (empty content → hidden tool card).
        if (customTitle) {
          this.customTitledToolCallIds.add(toolCallId)
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            title: customTitle
          })
          break
        }

        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)
        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break
        if (this.planToolCallIds.has(toolCallId)) {
          this.planToolCallIds.delete(toolCallId)
          break
        }

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const readPath = this.readToolCallPaths.get(toolCallId)
        const imageMarkdown = readPath && !isError ? snapshotImageMarkdown(result, readPath) : undefined
        const text = imageMarkdown ? `${imageMarkdown}\n\n${toolResultToText(result)}` : toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        const initialDiffEmitted = this.fileMutationDiffsEmitted.has(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && initialDiffEmitted) {
          // Match Claude ACP: once diff content has been emitted with the tool call,
          // the completion update only advances status. Re-sending the same diff on
          // completion can make clients render a second lower block for the tool.
          hasStructuredDiff = true
        }

        if (!isError && !initialDiffEmitted && snapshot) {
          try {
            // snapshot.path is always absolute (stored that way in tool_execution_start).
            const newText = readFileSync(snapshot.path, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        // Restore the base title (e.g. "Plan") if a mid-run _label ever overrode
        // it — otherwise the row is left showing a stale progress message like
        // "Reviewing with claude-opus-4.8 (round 2/3)…" forever after completion.
        const restoredTitle = this.customTitledToolCallIds.has(toolCallId)
          ? this.originalToolTitles.get(toolCallId)
          : undefined

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          ...(restoredTitle ? { title: restoredTitle } : {}),
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        const errorMessage = String((ev as any).errorMessage ?? '').trim()
        if (isRateLimitError(errorMessage)) {
          void this.handleTerminalFailure(extractRateLimitMessage(errorMessage), { abort: true })
          break
        }
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `\n\n${formatAutoRetryMessage(ev)}` } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        if ((ev as any).success === false) {
          const finalError = String((ev as any).finalError ?? '').trim()
          const message = isRateLimitError(finalError)
            ? extractRateLimitMessage(finalError)
            : extractUserFacingError(finalError) || 'Request failed after retries.'
          void this.handleTerminalFailure(message)
          break
        }
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '\n\nRetry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      // pi emits compaction_start/end (with reason: "auto" | "manual").
      // The old auto_compaction_start/end cases below are kept as dead-code
      // fallbacks in case older pi versions still send them.
      case 'compaction_start':
      case 'auto_compaction_start': {
        this.startCompaction()
        break
      }

      case 'compaction_end':
      case 'auto_compaction_end': {
        this.finishCompaction(compactionStateFromPiEnd(ev))
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        this.agentRunError = ''
        this.streamingToolCalls.clear()
        this.resetNarratedToolCallGate()
        break
      }

      case 'thinking_level_changed': {
        // pi changed the reasoning level outside of an ACP set request (e.g. a model
        // switch re-clamped it, or an extension/command changed it). Keep the client's
        // selectors in sync: `current_mode_update` for legacy mode clients and a full
        // `config_option_update` for config-option clients.
        const level = stringProp(ev, 'level')
        if (level) {
          this.emit({ sessionUpdate: 'current_mode_update', currentModeId: level })
        }
        void this.pushConfigOptionUpdate()
        break
      }

      case 'session_info_changed': {
        this.emit({
          sessionUpdate: 'session_info_update',
          title: stringProp(ev, 'name'),
          updatedAt: new Date().toISOString()
        })
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        // Re-arm inference-startup mode: the model is about to receive tool results and
        // may take a while before it starts streaming the next response.
        this.inferenceStartup = true
        this.compactedSinceLastStep = false
        // End of this model segment: tip /compact if it narrated tools, then reset for the next.
        this.flushNarratedToolCallGate()
        void this.pushUsageUpdate()
        if (existsSync(getPlanUsageDir())) void this.pushConfigOptionUpdate()
        break
      }

      case 'agent_end': {
        // Non-retryable LLM failures (e.g. revoked OAuth) land here with an empty
        // assistant content[] and stopReason/errorMessage on the last message. Without
        // this, Zed sees a successful empty end_turn.
        this.agentRunError = this.cancelRequested ? '' : extractAgentEndTurnError(ev)
        this.flushNarratedToolCallGate()
        break
      }

      case 'agent_settled': {
        if (this.turnTerminalFailureHandled) break
        const turnError = this.agentRunError
        if (this.tryRetryCursorSdkAuthFlake(turnError)) break
        if (turnError) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Error: ${turnError}` } satisfies ContentBlock
          })
        }

        this.flushNarratedToolCallGate()

        // Ensure all updates derived from pi events are delivered before we resolve
        // the ACP `session/prompt` request.
        void (async () => {
          await this.flushEmits()
          await this.maybeEmitTokenStats()
          if (existsSync(getPlanUsageDir())) void this.pushConfigOptionUpdate()
          await this.flushEmits()
          // A nested turn inside a still-running extension command (see
          // pendingTurnIsExtensionCommand above) — its own agent_settled, not the command's.
          if (this.pendingTurnIsExtensionCommand) return
          this.completeTurn(this.cancelRequested ? 'cancelled' : turnError ? 'error' : 'end_turn')
        })()
        break
      }

      case 'extension_error': {
        const name = extensionName(stringProp(ev, 'extensionPath') ?? '')
        this.showExtensionMessage(`Couldn't run ${name}. ${stringProp(ev, 'error') ?? 'Unknown error'}`, 'error')
        break
      }

      case 'agent_error':
      case 'error': {
        const message = String((ev as any).message ?? (ev as any).error ?? 'Unknown error')
        if (this.tryRetryCursorSdkAuthFlake(message)) break
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Error: ${message}` } satisfies ContentBlock
        })
        void (async () => {
          await this.flushEmits()
          // Let the extension command's own handler decide how to surface this (it may
          // recover and continue, e.g. retry or a different round) rather than tearing
          // down the whole ACP turn out from under it.
          if (this.pendingTurnIsExtensionCommand) return
          this.completeTurn(this.cancelRequested ? 'cancelled' : 'error')
        })()
        break
      }

      default:
        break
    }
  }

  private showExtensionMessage(message: string, severity: string | null): void {
    const warning = severity === 'warning' || severity === 'error'
    // Outside a reply nobody asked for it: drop info ("… ready" at startup), and show
    // warnings and errors as notices where the client has them.
    if (!this.pendingTurn && warning && this.notices) {
      this.emit(noticeFromNotify(message, severity))
    } else if (this.pendingTurn || warning) {
      // Leading "\n\n", matching the token-footer convention (see the `\n\n\u21b3` emit
      // above): each notify() call arrives as its own agent_message_chunk with no
      // inherent separator, so back-to-back calls from something like /audit's
      // multi-step pipeline ("Gathering diff…" → "Running 4 lenses…" → "lens done…")
      // otherwise render as one run-on sentence instead of a readable progress list.
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `\n\n${message}` } satisfies ContentBlock
      })
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'setStatus') {
      const key = stringProp(ev, 'statusKey')
      if (!key) return
      const text = stringProp(ev, 'statusText')
      if (text) this.extensionStatuses.set(key, text)
      else this.extensionStatuses.delete(key)
      return
    }

    if (method === 'notify') {
      this.showExtensionMessage(stringProp(ev, 'message') ?? 'Pi notification', stringProp(ev, 'notifyType'))
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    // The user may take arbitrarily long to answer; that is not pi inactivity.
    this.awaitingUserInput++
    this.clearTurnWatchdog()
    const resumeAwake = pauseStayAwake()
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    } finally {
      resumeAwake()
      this.awaitingUserInput--
      this.resetTurnWatchdog()
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

const NETWORK_ERROR_PATTERN =
  /fetch failed|network.?error|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|connection.?refused|connection.?reset|connection.?error|unable to connect|no network/i

const RATE_LIMIT_USER_MESSAGE = "This request would exceed your account's rate limit. Please try again later."

function isRateLimitError(errorMessage: string): boolean {
  const s = errorMessage.trim()
  if (!s) return false
  if (/\b429\b/.test(s)) return true
  if (/rate_limit_error/i.test(s)) return true
  if (/exceed your account's rate limit/i.test(s)) return true
  return false
}

function extractUserFacingError(errorMessage: string): string {
  const trimmed = errorMessage.trim()
  if (!trimmed || trimmed === 'Unknown error' || trimmed === 'Retry cancelled') {
    return ''
  }

  const fromJson = extractEmbeddedJsonError(trimmed)
  const provider = /OAuth refresh failed for ([A-Za-z0-9_-]+)/i.exec(trimmed)?.[1]
  // Anthropic (and similar) OAuth dumps are multi-KB stack traces with
  // `invalid_grant` / `Refresh token expired` buried in a token-endpoint body.
  if (
    /OAuth refresh failed/i.test(trimmed) ||
    /invalid_grant/i.test(trimmed) ||
    /Refresh token expired/i.test(trimmed) ||
    /Refresh token expired/i.test(fromJson ?? '')
  ) {
    return provider
      ? `OAuth login expired for ${provider}. Log in again and retry.`
      : 'OAuth login expired. Log in again and retry.'
  }

  if (fromJson) return fromJson

  // Drop Node stacks / trailing `stack=Error:` tails from provider dumps.
  const withoutStack = trimmed
    .split(/\n\s*at\s+/)[0]
    ?.replace(/\s*;\s*stack=Error:[\s\S]*$/i, '')
    .trim()
  return withoutStack || trimmed
}

/** Pull a nested provider/API error string out of a message that embeds JSON. */
function extractEmbeddedJsonError(s: string): string | null {
  const jsonStart = s.indexOf('{')
  if (jsonStart < 0) return null

  const candidates: string[] = []
  const balanced = extractFirstJsonObject(s.slice(jsonStart))
  if (balanced) candidates.push(balanced)
  candidates.push(s.slice(jsonStart))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        error?: { message?: unknown } | string
        error_description?: unknown
        message?: unknown
      }
      if (typeof parsed.error_description === 'string' && parsed.error_description.trim()) {
        return parsed.error_description.trim()
      }
      const nested = typeof parsed.error === 'object' && parsed.error !== null ? parsed.error.message : undefined
      const msg = nested ?? parsed.message
      if (typeof msg === 'string' && msg.trim()) return msg.trim()
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim()
    } catch {
      // try next candidate
    }
  }
  return null
}

function extractFirstJsonObject(s: string): string | null {
  if (!s.startsWith('{')) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(0, i + 1)
    }
  }
  return null
}

/** Best-effort user-facing error from a terminal (non-retrying) `agent_end`. */
function extractAgentEndTurnError(ev: PiRpcEvent): string {
  const direct = String((ev as any).errorMessage ?? '').trim()
  if (direct) {
    return extractUserFacingError(direct) || direct
  }

  const messages = (ev as any).messages
  if (!Array.isArray(messages)) return ''

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | null
    if (!msg || typeof msg !== 'object') continue
    if (msg.role !== 'assistant') continue
    if (msg.stopReason !== 'error') return ''
    const raw = String(msg.errorMessage ?? '').trim()
    if (!raw) return 'Unknown error'
    return extractUserFacingError(raw) || raw
  }

  return ''
}

function extractRateLimitMessage(errorMessage: string): string {
  const extracted = extractUserFacingError(errorMessage)
  if (extracted && /rate.?limit|429/i.test(extracted)) return extracted
  if (/exceed your account's rate limit/i.test(errorMessage)) return RATE_LIMIT_USER_MESSAGE
  return RATE_LIMIT_USER_MESSAGE
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  const errorMessage = String((ev as any).errorMessage ?? '').trim()
  const isNetworkError = NETWORK_ERROR_PATTERN.test(errorMessage)
  const facing = extractUserFacingError(errorMessage)
  const reason = isNetworkError || !facing ? (isNetworkError ? 'Network error' : null) : truncateTitle(facing, 150)
  const prefix = reason ? `${reason} — r` : 'R'
  return `${prefix}etrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

const TITLE_ARG_PATTERN = /"(path|file_path|query|url|command)"\s*:\s*"((?:[^"\\]|\\.)*)"/g

/** The arguments a tool card's title is made from, once the model has finished sending them, or null before that. */
function streamedTitleArgs(json: string): Record<string, string> | null {
  const args: Record<string, string> = {}
  for (const [, key, raw] of json.matchAll(TITLE_ARG_PATTERN)) {
    if (key in args) continue
    try {
      args[key] = JSON.parse(`"${raw}"`) as string
    } catch {
      // ignore
    }
  }
  return Object.keys(args).length ? args : null
}

/** Truncate a string for display in tool titles. */
function truncateTitle(s: string, max = 60): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

function toToolTitle(toolName: string, args: unknown, cwd?: string): string {
  const p = getToolPath(toolName, args)
  if (p) {
    // Show a short relative path when possible; fall back to basename, then full path.
    let display = p
    if (cwd) {
      try {
        const rel = relative(cwd, isAbsolute(p) ? p : resolvePath(cwd, p))
        display = rel.length < p.length ? rel : basename(p)
      } catch {
        display = basename(p)
      }
    } else {
      display = basename(p)
    }
    const verb = toolVerb(toolName)
    return `${verb} ${display}`
  }

  // For tools with a query/url/command/path arg, append it for context.
  const a = args as Record<string, unknown> | null | undefined
  const hint = ['query', 'url', 'command', 'path'].map(k => a?.[k]).find((v): v is string => typeof v === 'string')
  if (hint) return `${toolVerb(toolName)}: ${truncateTitle(hint)}`

  return toolVerb(toolName)
}

const TITLE_ACRONYMS = new Set(['ui', 'pr', 'cdn', 'ssh', 'url', 'api', 'id', 'sql', 'mcp'])

function toolVerb(toolName: string): string {
  switch (toolName) {
    case 'edit':
      return 'Edit'
    case 'write':
      return 'Write'
    case 'read':
      return 'Read'
    case 'bash':
      return 'Bash'
    default:
      // Convert snake_case to Title Case (e.g. web_search → Web Search, create_pr → Create PR)
      return toolName
        .split('_')
        .map(w => (TITLE_ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ')
  }
}

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    case 'grep':
    case 'find':
    case 'ls':
      return 'search'
    default:
      return 'other'
  }
}
