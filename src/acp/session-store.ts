import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getPiAcpSessionMapPath } from './paths.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  sessionFile: string
  updatedAt: string
  // Branch the session started on, for the footer PR-link heuristic (see
  // getPrLinkCached in session.ts). Persisted so a resumed/reloaded session
  // (new PiAcpSession instance, same sessionId) doesn't reset its baseline to
  // the current branch and permanently suppress a link it was already showing.
  // Absent = not yet captured; null = captured but branch was undetectable
  // (e.g. detached HEAD).
  startBranch?: string | null
}

type SessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function loadFile(path: string): SessionMapFile {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as SessionMapFile
    if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || !parsed.sessions) {
      return { version: 1, sessions: {} }
    }
    return parsed
  } catch {
    return { version: 1, sessions: {} }
  }
}

function saveFile(path: string, data: SessionMapFile): void {
  ensureParentDir(path)
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

export class SessionStore {
  private readonly path: string

  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path
  }

  get(sessionId: string): StoredSession | null {
    const db = loadFile(this.path)
    return db.sessions[sessionId] ?? null
  }

  upsert(entry: { sessionId: string; cwd: string; sessionFile: string }): void {
    const db = loadFile(this.path)
    const existing = db.sessions[entry.sessionId]
    db.sessions[entry.sessionId] = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      updatedAt: new Date().toISOString(),
      ...(existing && 'startBranch' in existing ? { startBranch: existing.startBranch } : {})
    }
    saveFile(this.path, db)
  }

  /** True once `setStartBranch` has recorded a baseline for this session (even null). */
  hasStartBranch(sessionId: string): boolean {
    const db = loadFile(this.path)
    const existing = db.sessions[sessionId]
    return existing ? 'startBranch' in existing : false
  }

  /** Record the branch a session started on. No-op if the session isn't registered yet. */
  setStartBranch(sessionId: string, branch: string | null): void {
    const db = loadFile(this.path)
    const existing = db.sessions[sessionId]
    if (!existing) return
    existing.startBranch = branch
    saveFile(this.path, db)
  }

  delete(sessionId: string): void {
    const db = loadFile(this.path)
    if (!db.sessions[sessionId]) return
    delete db.sessions[sessionId]
    saveFile(this.path, db)
  }
}
