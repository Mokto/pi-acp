import type { PlanEntry } from '@agentclientprotocol/sdk'

export const PLAN_TOOL = 'update_plan'

const STATUSES = new Set<PlanEntry['status']>(['pending', 'in_progress', 'completed'])

export function planEntries(args: unknown): PlanEntry[] | null {
  const { goal, plan } = (args ?? {}) as { goal?: unknown; plan?: unknown }
  if (!Array.isArray(plan)) return null
  const steps = plan.flatMap((s: { step?: unknown; status?: unknown }): PlanEntry[] => {
    const content = typeof s?.step === 'string' ? s.step.trim() : ''
    if (!content) return []
    const status = STATUSES.has(s.status as PlanEntry['status']) ? (s.status as PlanEntry['status']) : 'pending'
    return [{ content, priority: 'medium', status }]
  })
  const goalText = typeof goal === 'string' ? goal.trim() : ''
  // Pending on purpose: the goal stays open while the thread is about it, so the panel never shows "All Done".
  const goalEntry: PlanEntry[] = goalText ? [{ content: `Goal: ${goalText}`, priority: 'high', status: 'pending' }] : []
  return [...goalEntry, ...steps]
}

export function latestPlanEntries(messages: unknown[]): PlanEntry[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown }
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (let j = m.content.length - 1; j >= 0; j--) {
      const c = m.content[j] as { type?: unknown; name?: unknown; arguments?: unknown }
      if (c?.type === 'toolCall' && c.name === PLAN_TOOL) {
        const entries = planEntries(c.arguments)
        if (entries) return entries
      }
    }
  }
  return null
}
