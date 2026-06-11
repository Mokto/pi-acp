import { minimatch } from 'minimatch'

/**
 * Resolve pi's `enabledModels` patterns to the set of concrete models they
 * allow. This is a faithful port of pi's `resolveModelScope` (and the
 * `parseModelPattern` / `tryMatchModel` / `findExactModelReferenceMatch`
 * helpers it builds on) so the ACP model picker scopes like pi does for the
 * same settings.
 *
 * It additionally accepts the "provider/Name" display form the adapter itself
 * advertises to ACP clients (e.g. "anthropic/Claude Sonnet 4.6"). pi's own
 * matcher rejects that — it expects a model id — but it is the exact string the
 * picker shows, so users naturally put it in `enabledModels`.
 *
 * pi never exposes its resolved scope over RPC (`get_available_models` always
 * returns the full registry), so we have to reproduce the matching here.
 */
export type ScopeModel = { provider: string; id: string; name?: string }

const THINKING_LEVELS: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true
}

/** A model id "looks like an alias" when it has no trailing -YYYYMMDD date (or ends with -latest). */
function isAlias(id: string): boolean {
  if (id.endsWith('-latest')) return true
  return !/-\d{8}$/.test(id)
}

function findExactModelReferenceMatch(reference: string, models: ScopeModel[]): ScopeModel | undefined {
  const trimmed = reference.trim()
  if (!trimmed) return undefined

  const normalized = trimmed.toLowerCase()

  const canonical = models.filter(m => `${m.provider}/${m.id}`.toLowerCase() === normalized)
  if (canonical.length === 1) return canonical[0]
  if (canonical.length > 1) return undefined

  const slashIndex = trimmed.indexOf('/')
  if (slashIndex !== -1) {
    const provider = trimmed.slice(0, slashIndex).trim()
    const modelId = trimmed.slice(slashIndex + 1).trim()
    if (provider && modelId) {
      const providerMatches = models.filter(
        m => m.provider.toLowerCase() === provider.toLowerCase() && m.id.toLowerCase() === modelId.toLowerCase()
      )
      if (providerMatches.length === 1) return providerMatches[0]
      if (providerMatches.length > 1) return undefined
    }
  }

  const idMatches = models.filter(m => m.id.toLowerCase() === normalized)
  return idMatches.length === 1 ? idMatches[0] : undefined
}

function tryMatchModel(pattern: string, models: ScopeModel[]): ScopeModel | undefined {
  const exact = findExactModelReferenceMatch(pattern, models)
  if (exact) return exact

  const needle = pattern.toLowerCase()
  const matches = models.filter(
    m => m.id.toLowerCase().includes(needle) || (m.name?.toLowerCase().includes(needle) ?? false)
  )
  if (matches.length === 0) return undefined

  const aliases = matches.filter(m => isAlias(m.id)).sort((a, b) => b.id.localeCompare(a.id))
  if (aliases.length > 0) return aliases[0]

  return matches.filter(m => !isAlias(m.id)).sort((a, b) => b.id.localeCompare(a.id))[0]
}

/**
 * Resolve a non-glob pattern to a model, progressively stripping a trailing
 * ":<suffix>" (thinking level or otherwise) and retrying — mirrors pi's
 * recursive `parseModelPattern`. We only need the model, not the level.
 */
function parseModelPattern(pattern: string, models: ScopeModel[]): ScopeModel | undefined {
  const exact = tryMatchModel(pattern, models)
  if (exact) return exact

  const lastColon = pattern.lastIndexOf(':')
  if (lastColon === -1) return undefined

  return parseModelPattern(pattern.slice(0, lastColon), models)
}
/**
 * Match a pattern against the "provider/Name" display form the adapter
 * advertises (case-insensitive), stripping a trailing ":<thinking level>" if
 * the full string doesn't match. Returns every model whose display form equals
 * the pattern (names are effectively unique per provider, but we don't rely on
 * it). pi's matcher ignores this form, so it's purely additive.
 */
function matchByDisplayName(pattern: string, models: ScopeModel[]): ScopeModel[] {
  const exact = (ref: string): ScopeModel[] => {
    const needle = ref.toLowerCase()
    return models.filter(m => m.name != null && `${m.provider}/${m.name}`.toLowerCase() === needle)
  }

  const direct = exact(pattern)
  if (direct.length > 0) return direct

  const colonIdx = pattern.lastIndexOf(':')
  if (colonIdx !== -1 && THINKING_LEVELS[pattern.slice(colonIdx + 1)]) {
    return exact(pattern.slice(0, colonIdx))
  }

  return []
}

/**
 * Given the full model registry and the `enabledModels` patterns, return the
 * canonical "provider/id" ids that the patterns enable. An empty result means
 * nothing matched (callers should treat that as "no scope", like pi does).
 */
export function resolveEnabledModelIds(models: ScopeModel[], patterns: string[]): Set<string> {
  const allowed = new Set<string>()

  for (const pattern of patterns) {
    if (pattern.includes('*') || pattern.includes('?') || pattern.includes('[')) {
      // Strip a trailing ":<thinking level>" before treating the rest as a glob.
      const colonIdx = pattern.lastIndexOf(':')
      let globPattern = pattern
      if (colonIdx !== -1 && THINKING_LEVELS[pattern.slice(colonIdx + 1)]) {
        globPattern = pattern.slice(0, colonIdx)
      }

      for (const m of models) {
        const fullId = `${m.provider}/${m.id}`
        if (
          minimatch(fullId, globPattern, { nocase: true }) ||
          minimatch(m.id, globPattern, { nocase: true }) ||
          (m.name != null && minimatch(`${m.provider}/${m.name}`, globPattern, { nocase: true }))
        ) {
          allowed.add(fullId)
        }
      }
      continue
    }

    for (const m of matchByDisplayName(pattern, models)) allowed.add(`${m.provider}/${m.id}`)

    const model = parseModelPattern(pattern, models)
    if (model) allowed.add(`${model.provider}/${model.id}`)
  }

  return allowed
}
