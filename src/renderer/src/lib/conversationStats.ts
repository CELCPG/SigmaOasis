import type { Conversation } from '../types'

export interface ConversationStats {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  /** Prompt tokens the server reported for the most recent reply — roughly the context in use. */
  lastPromptTokens: number | null
  /** Sum of completion tokens across replies that reported them. */
  completionTokens: number
  /** Average tokens/second across replies that reported it. */
  avgTokensPerSecond: number | null
  /** Distinct attachment names, in first-seen order. */
  attachments: { name: string; kind: 'image' | 'file' }[]
  /** Roles that answered in this chat, in first-seen order. */
  roles: string[]
  /** Whether earlier messages have been folded into a summary, and when. */
  compacted: { updatedAt: number } | null
  /** v1.10: what the project spent on the most recent reply's prompt (estimates), if any. */
  lastProjectTokens: { instructions: number; recall: number; files: number } | null
}

/**
 * Cheap, derived-on-render facts about a conversation for the chat panel.
 * Pure so the panel stays a view; nothing here touches the store.
 */
export function conversationStats(c: Conversation): ConversationStats {
  let userMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let completionTokens = 0
  let lastPromptTokens: number | null = null
  let lastProjectTokens: ConversationStats['lastProjectTokens'] = null
  let tpsSum = 0
  let tpsCount = 0
  const attachments: ConversationStats['attachments'] = []
  const seenAttachments = new Set<string>()
  const roles: string[] = []

  for (const m of c.messages) {
    // Markers (rollback notes, etc.) are display-only and not counted as replies.
    if (m.marker) continue
    if (m.role === 'user') userMessages += 1
    else assistantMessages += 1
    toolCalls += m.toolCalls?.length ?? 0
    if (m.stats) {
      if (typeof m.stats.promptTokens === 'number') lastPromptTokens = m.stats.promptTokens
      if (m.stats.projectTokens) lastProjectTokens = m.stats.projectTokens
      if (typeof m.stats.completionTokens === 'number') completionTokens += m.stats.completionTokens
      if (typeof m.stats.tokensPerSecond === 'number' && m.stats.tokensPerSecond > 0) {
        tpsSum += m.stats.tokensPerSecond
        tpsCount += 1
      }
    }
    for (const a of m.attachments ?? []) {
      const key = `${a.kind}:${a.name}`
      if (seenAttachments.has(key)) continue
      seenAttachments.add(key)
      attachments.push({ name: a.name, kind: a.kind })
    }
    if (m.role === 'assistant' && m.roleName && !roles.includes(m.roleName)) roles.push(m.roleName)
  }

  return {
    userMessages,
    assistantMessages,
    toolCalls,
    lastPromptTokens,
    completionTokens,
    avgTokensPerSecond: tpsCount > 0 ? Math.round(tpsSum / tpsCount) : null,
    attachments,
    roles,
    compacted: c.summary ? { updatedAt: c.summary.updatedAt } : null,
    lastProjectTokens
  }
}

/** "just now", "4m ago", "3h ago", "2d ago", else a short date. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 14) return `${d}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}
