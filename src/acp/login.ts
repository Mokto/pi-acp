import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPiCommand } from '../pi-rpc/command.js'

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent'
const LOGIN_TIMEOUT_MS = 5 * 60_000

export type OAuthProvider = {
  id: string
  name: string
  auth: { oauth?: { name?: string; loginLabel?: string }; apiKey?: unknown }
}

type AuthPrompt = {
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  options?: readonly { id: string; label: string }[]
  signal?: AbortSignal
}

type AuthEvent =
  | { type: 'info' | 'progress'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }

/** The slice of pi's `ModelRuntime` (pi >= 0.99) used for login/logout. */
export type ModelRuntimeLike = {
  getProviders(): readonly OAuthProvider[]
  login(
    providerId: string,
    type: 'oauth',
    interaction: {
      signal: AbortSignal
      prompt(p: AuthPrompt): Promise<string>
      notify(e: AuthEvent): void
    }
  ): Promise<unknown>
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>
  listCredentials(options?: { signal?: AbortSignal }): Promise<readonly { providerId: string; type: string }[]>
}

export type LoginIO = {
  say(text: string): void
  select(message: string, options: { id: string; label: string }[]): Promise<string | null>
  /** Answer for free-text prompts (e.g. Copilot's GitHub Enterprise domain); blank = provider default. */
  text?: string
  /** Supplies a pasted code / redirect URL for `manual_code` prompts. Without it, only pi's localhost callback can finish. */
  code?: (signal: AbortSignal) => Promise<string>
  openUrl?: (url: string) => void
}

/** Locate the pi install behind the `pi` command the adapter spawns. */
export function findPiPackageDir(piCommand = getPiCommand(process.env.PI_ACP_PI_COMMAND)): string | null {
  let bin = piCommand
  if (!isAbsolute(bin)) {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf-8' })
    bin =
      String(which.stdout ?? '')
        .split(/\r?\n/)[0]
        ?.trim() ?? ''
    if (!bin) return null
  }

  let dir: string
  try {
    dir = dirname(realpathSync(bin))
  } catch {
    return null
  }

  for (;;) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        if (JSON.parse(readFileSync(pkgPath, 'utf-8'))?.name === PI_PACKAGE_NAME) return dir
      } catch {
        // keep walking up
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Load pi's SDK from the installed pi and create a runtime backed by ~/.pi/agent/auth.json. Null if unavailable. */
export async function loadModelRuntime(pkgDir = findPiPackageDir()): Promise<ModelRuntimeLike | null> {
  if (!pkgDir) return null
  const entry = join(pkgDir, 'dist', 'index.js')
  if (!existsSync(entry)) return null
  try {
    const sdk: any = await import(pathToFileURL(entry).href)
    if (typeof sdk?.ModelRuntime?.create !== 'function') return null
    const rt = await sdk.ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false })
    return typeof rt?.login === 'function' ? (rt as ModelRuntimeLike) : null
  } catch {
    return null
  }
}

export function oauthProviders(rt: ModelRuntimeLike): OAuthProvider[] {
  return rt
    .getProviders()
    .filter(p => p.auth?.oauth)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function providerLabel(p: OAuthProvider): string {
  return p.auth.oauth?.name ?? p.name
}

export function findProvider(rt: ModelRuntimeLike, ref: string): OAuthProvider | undefined {
  const r = ref.trim().toLowerCase()
  return rt
    .getProviders()
    .find(p => p.id.toLowerCase() === r || p.name.toLowerCase() === r || p.auth?.oauth?.name?.toLowerCase() === r)
}

/** Heuristic for "this chat message is a pasted OAuth code/redirect URL", not a normal prompt. */
export function looksLikeAuthCode(text: string): boolean {
  const t = text.trim()
  if (/^https?:\/\//.test(t)) return /[?&#]code=/.test(t)
  return /^\S{16,}$/.test(t)
}

/** Opens a URL without a shell (Windows `cmd /c start` would re-parse `&` in OAuth URLs). */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()
}

function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () =>
      reject(new Error(signal?.reason?.name === 'TimeoutError' ? 'Login timed out' : 'Login cancelled'))
    if (signal?.aborted) return fail()
    signal?.addEventListener('abort', fail, { once: true })
  })
}

/** Run pi's OAuth flow for one provider, mapping its prompts/events onto chat-friendly IO. */
export async function runOAuthLogin(
  rt: ModelRuntimeLike,
  providerId: string,
  io: LoginIO,
  signal?: AbortSignal
): Promise<void> {
  const loginSignal = AbortSignal.any([AbortSignal.timeout(LOGIN_TIMEOUT_MS), ...(signal ? [signal] : [])])

  await rt.login(providerId, 'oauth', {
    signal: loginSignal,
    async prompt(p) {
      const s = AbortSignal.any([loginSignal, ...(p.signal ? [p.signal] : [])])
      if (p.type === 'select') {
        const picked = await Promise.race([io.select(p.message, [...(p.options ?? [])]), rejectOnAbort(s)])
        if (picked === null) throw new Error('Login cancelled')
        return picked
      }
      if (p.type === 'text') return io.text ?? ''
      if (p.type === 'secret') {
        throw new Error(
          'This provider needs a secret pi cannot collect in chat. Run `pi` in a terminal and use /login.'
        )
      }
      // manual_code usually races pi's localhost callback server, which aborts p.signal when it wins.
      return Promise.race([io.code ? io.code(s) : rejectOnAbort(s), rejectOnAbort(s)])
    },
    notify(e) {
      if (e.type === 'auth_url') {
        io.openUrl?.(e.url)
        io.say(
          `[Open the login page](${e.url}) and finish signing in there.` +
            (io.code
              ? "\n\nIf the browser can't reach this machine, or the page shows a code, stop this turn and send the final redirect URL or the code as your next message."
              : '')
        )
      } else if (e.type === 'device_code') {
        io.openUrl?.(e.verificationUri)
        io.say(`Enter code **${e.userCode}** at ${e.verificationUri}`)
      } else {
        const links = (e.links ?? []).map(l => `[${l.label ?? l.url}](${l.url})`).join(' ')
        io.say(links ? `${e.message} ${links}` : e.message)
      }
    }
  })
}

const ZED_OAUTH_METHOD_PREFIX = 'pi_oauth:'

// ponytail: static list of providers whose flow is browser-redirect only (no device code to show,
// no select), so it works from session-less ACP `authenticate`. Others go through /login in chat.
const AUTHENTICATE_PROVIDERS = [
  { providerId: 'anthropic', label: 'Claude Pro/Max' },
  { providerId: 'openai', label: 'ChatGPT Plus/Pro' },
  { providerId: 'openrouter', label: 'OpenRouter' }
]

export function oauthAuthMethods() {
  return AUTHENTICATE_PROVIDERS.map(p => ({
    id: `${ZED_OAUTH_METHOD_PREFIX}${p.providerId}`,
    name: `Log in with ${p.label}`,
    description: `Sign in to ${p.label} in your browser`
  }))
}

export function providerFromAuthMethodId(methodId: string): string | null {
  return methodId.startsWith(ZED_OAUTH_METHOD_PREFIX) ? methodId.slice(ZED_OAUTH_METHOD_PREFIX.length) : null
}
