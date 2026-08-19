import { createServer, type Server, type Socket } from 'node:net'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { getPiAcpLiveDir, getPiAcpLivePidRegistryPath, getPiAcpLiveSocketPath } from './paths.js'
import type { LiveSessionBridge, PiAcpSession, StopReason } from './session.js'

/**
 * Opt-in live attach for a second local client (Slack daemon).
 *
 * Default off. Public pi-acp installs must not open a socket or write
 * ~/.pi/pi-acp/live/* unless PI_ACP_LIVE is explicitly enabled (Ocean
 * turns this on via Zed agent env in ocean-extensions).
 */
export function isLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PI_ACP_LIVE
  if (v == null || v === '') return false
  const n = v.trim().toLowerCase()
  return n === '1' || n === 'true' || n === 'yes'
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type LiveSessionInfo = {
  sessionId: string
  pid: number
  sock: string
  cwd: string
  sessionFile: string
}

type PidRegistryFile = {
  pid: number
  sock: string
  sessions: Record<string, { cwd: string; sessionFile: string }>
}

type LiveEntry = {
  session: PiAcpSession
  sessionFile: string
}

type LiveRequest = {
  id: number
  type: 'list' | 'attach' | 'detach' | 'prompt' | 'cancel'
  sessionId?: string
  message?: string
  images?: unknown[]
}

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x)
}

export type LiveServerOptions = {
  liveDir?: string
  pid?: number
}

function parsePidRegistry(raw: string): PidRegistryFile | null {
  try {
    const parsed = JSON.parse(raw) as PidRegistryFile
    if (!parsed || typeof parsed.pid !== 'number' || typeof parsed.sock !== 'string') return null
    if (typeof parsed.sessions !== 'object' || !parsed.sessions) return null
    return parsed
  } catch {
    return null
  }
}

/** Merge per-pid registries, dropping rows whose process is gone. */
export function readLiveSessions(liveDir = getPiAcpLiveDir()): Record<string, LiveSessionInfo> {
  const out: Record<string, LiveSessionInfo> = {}
  if (!existsSync(liveDir)) return out

  let names: string[] = []
  try {
    names = readdirSync(liveDir)
  } catch {
    return out
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(liveDir, name)
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    const file = parsePidRegistry(raw)
    if (!file) continue
    if (!isPidAlive(file.pid)) continue
    for (const [sessionId, s] of Object.entries(file.sessions)) {
      out[sessionId] = {
        sessionId,
        pid: file.pid,
        sock: file.sock,
        cwd: s.cwd,
        sessionFile: s.sessionFile
      }
    }
  }
  return out
}

export function sweepStaleLiveFiles(liveDir = getPiAcpLiveDir()): void {
  if (!existsSync(liveDir)) return
  let names: string[] = []
  try {
    names = readdirSync(liveDir)
  } catch {
    return
  }

  const pids = new Set<number>()
  for (const name of names) {
    const m = name.match(/^(\d+)\.(json|sock)$/)
    if (!m) continue
    pids.add(Number(m[1]))
  }

  for (const pid of pids) {
    if (pid === process.pid) continue
    if (isPidAlive(pid)) continue
    for (const ext of ['json', 'sock'] as const) {
      const path = join(liveDir, `${pid}.${ext}`)
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch {
        // ignore
      }
    }
  }
}

type ConnState = {
  socket: Socket
  attached: Map<string, () => void>
}

export class LiveServer implements LiveSessionBridge {
  private readonly liveDir: string
  private readonly pid: number
  private readonly sockPath: string
  private readonly registryPath: string
  private readonly entries = new Map<string, LiveEntry>()
  private readonly connections = new Set<ConnState>()
  private server: Server | null = null
  private started = false
  private disposed = false

  constructor(opts: LiveServerOptions = {}) {
    this.pid = opts.pid ?? process.pid
    this.liveDir = opts.liveDir ?? getPiAcpLiveDir()
    this.sockPath = opts.liveDir ? join(opts.liveDir, `${this.pid}.sock`) : getPiAcpLiveSocketPath(this.pid)
    this.registryPath = opts.liveDir ? join(opts.liveDir, `${this.pid}.json`) : getPiAcpLivePidRegistryPath(this.pid)
  }

  get socketPath(): string {
    return this.sockPath
  }

  upsert(session: PiAcpSession, sessionFile: string): void {
    this.entries.set(session.sessionId, { session, sessionFile })
    if (this.started) this.writeRegistry()
  }

  remove(sessionId: string): void {
    this.entries.delete(sessionId)
    for (const conn of this.connections) {
      const unsub = conn.attached.get(sessionId)
      if (unsub) {
        unsub()
        conn.attached.delete(sessionId)
      }
    }
    if (this.started) this.writeRegistry()
  }

  async start(): Promise<void> {
    if (this.disposed || this.started) return

    mkdirSync(this.liveDir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(this.liveDir, 0o700)
    } catch {
      // ignore (some FS ignore mode)
    }

    sweepStaleLiveFiles(this.liveDir)
    this.unlinkIfExists(this.sockPath)

    const server = createServer(socket => this.onConnection(socket))
    this.server = server

    try {
      await this.listen(server)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') {
        this.unlinkIfExists(this.sockPath)
        await this.listen(server)
      } else {
        this.server = null
        throw err
      }
    }

    try {
      chmodSync(this.sockPath, 0o600)
    } catch {
      // ignore
    }

    this.started = true
    this.writeRegistry()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.started = false

    for (const conn of this.connections) {
      for (const unsub of conn.attached.values()) unsub()
      conn.attached.clear()
      try {
        conn.socket.destroy()
      } catch {
        // ignore
      }
    }
    this.connections.clear()
    this.entries.clear()

    const server = this.server
    this.server = null
    if (server) {
      try {
        server.close()
      } catch {
        // ignore
      }
    }

    this.unlinkIfExists(this.sockPath)
    this.unlinkIfExists(this.registryPath)
  }

  private listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.sockPath)
    })
  }

  private writeRegistry(): void {
    const sessions: PidRegistryFile['sessions'] = {}
    for (const [sessionId, entry] of this.entries) {
      sessions[sessionId] = { cwd: entry.session.cwd, sessionFile: entry.sessionFile }
    }
    const data: PidRegistryFile = { pid: this.pid, sock: this.sockPath, sessions }
    const tmp = `${this.registryPath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
      renameSync(tmp, this.registryPath)
      chmodSync(this.registryPath, 0o600)
    } catch {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // ignore
      }
    }
  }

  private onConnection(socket: Socket): void {
    const conn: ConnState = { socket, attached: new Map() }
    this.connections.add(conn)

    let buf = ''
    socket.on('data', chunk => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) void this.handleLine(conn, line)
        nl = buf.indexOf('\n')
      }
    })

    const cleanup = () => {
      for (const unsub of conn.attached.values()) unsub()
      conn.attached.clear()
      this.connections.delete(conn)
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  }

  private async handleLine(conn: ConnState, line: string): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.writeJson(conn.socket, { id: -1, ok: false, error: 'invalid json' })
      return
    }

    const req = this.asRequest(raw)
    if (!req) {
      const id = isObject(raw) && typeof raw.id === 'number' ? raw.id : -1
      this.writeJson(conn.socket, { id, ok: false, error: 'invalid request' })
      return
    }

    try {
      await this.dispatch(conn, req)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.writeJson(conn.socket, { id: req.id, ok: false, error: message })
    }
  }

  private asRequest(raw: unknown): LiveRequest | null {
    if (!isObject(raw)) return null
    if (typeof raw.id !== 'number') return null
    const type = raw.type
    if (type !== 'list' && type !== 'attach' && type !== 'detach' && type !== 'prompt' && type !== 'cancel') {
      return null
    }
    const req: LiveRequest = { id: raw.id, type }
    if (typeof raw.sessionId === 'string') req.sessionId = raw.sessionId
    if (typeof raw.message === 'string') req.message = raw.message
    if (Array.isArray(raw.images)) req.images = raw.images
    return req
  }

  private async dispatch(conn: ConnState, req: LiveRequest): Promise<void> {
    switch (req.type) {
      case 'list':
        this.writeJson(conn.socket, { id: req.id, ok: true, sessions: this.list() })
        return
      case 'attach':
        this.attach(conn, this.requireSessionId(req))
        this.writeJson(conn.socket, { id: req.id, ok: true })
        return
      case 'detach':
        this.detach(conn, this.requireSessionId(req))
        this.writeJson(conn.socket, { id: req.id, ok: true })
        return
      case 'prompt': {
        const sessionId = this.requireSessionId(req)
        if (typeof req.message !== 'string') throw new Error('message required')
        this.attach(conn, sessionId)
        const stopReason: StopReason = await this.entries.get(sessionId)!.session.prompt(req.message, req.images ?? [])
        this.writeJson(conn.socket, { id: req.id, ok: true, stopReason })
        return
      }
      case 'cancel':
        await this.requireEntry(this.requireSessionId(req)).session.cancel()
        this.writeJson(conn.socket, { id: req.id, ok: true })
        return
    }
  }

  private list(): Array<{ sessionId: string; cwd: string; sessionFile: string; running: boolean }> {
    return [...this.entries.values()].map(e => ({
      sessionId: e.session.sessionId,
      cwd: e.session.cwd,
      sessionFile: e.sessionFile,
      running: e.session.hasActiveTurn()
    }))
  }

  private requireSessionId(req: LiveRequest): string {
    if (!req.sessionId) throw new Error('sessionId required')
    return req.sessionId
  }

  private requireEntry(sessionId: string): LiveEntry {
    const entry = this.entries.get(sessionId)
    if (!entry) throw new Error(`unknown sessionId: ${sessionId}`)
    return entry
  }

  private attach(conn: ConnState, sessionId: string): void {
    if (conn.attached.has(sessionId)) return
    const entry = this.requireEntry(sessionId)
    const unsub = entry.session.addObserver((update: SessionUpdate) => {
      this.writeJson(conn.socket, { type: 'update', sessionId, update })
    })
    conn.attached.set(sessionId, unsub)
  }

  private detach(conn: ConnState, sessionId: string): void {
    const unsub = conn.attached.get(sessionId)
    if (!unsub) return
    unsub()
    conn.attached.delete(sessionId)
  }

  private writeJson(socket: Socket, msg: unknown): void {
    if (socket.destroyed || !socket.writable) return
    try {
      socket.write(JSON.stringify(msg) + '\n')
    } catch {
      // drop; close handler unsubscribes
    }
  }

  private unlinkIfExists(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // ignore
    }
  }
}
