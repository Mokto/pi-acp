import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own ~/.pi/agent/* directory.
 */
export function getPiAcpDir(): string {
  return join(homedir(), '.pi', 'pi-acp')
}

export function getPiAcpSessionMapPath(): string {
  return join(getPiAcpDir(), 'session-map.json')
}

/** Directory for opt-in live-attach sockets + per-pid registries (`PI_ACP_LIVE=1`). */
export function getPiAcpLiveDir(): string {
  return join(getPiAcpDir(), 'live')
}

export function getPiAcpLiveSocketPath(pid: number): string {
  return join(getPiAcpLiveDir(), `${pid}.sock`)
}

export function getPiAcpLivePidRegistryPath(pid: number): string {
  return join(getPiAcpLiveDir(), `${pid}.json`)
}
