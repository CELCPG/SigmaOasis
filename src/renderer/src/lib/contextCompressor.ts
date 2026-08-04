/**
 * v1.4 local context compression — the fallback half of conversation summarization.
 *
 * The primary path is `planAndCompact` in hooks/useLMStudio.ts, which asks the
 * model itself to fold dropped messages into a rolling summary. That produces a
 * genuinely semantic summary and is always preferred.
 *
 * But it can fail: LM Studio may be mid-model-swap, the summarizer call can time
 * out, or the server can return `ok: false`. Before v1.4 every one of those paths
 * returned the *previous* summary and silently discarded the newly dropped
 * messages — the conversation lost its middle with no record that anything went.
 *
 * This module fills that gap with a mechanical, model-free digest. It is
 * deliberately not as good as the model's summary; it exists so that a failed
 * summarizer degrades to "a thin account of what was dropped" instead of "those
 * messages never happened". No network, no model call, so it cannot fail in turn.
 *
 * It does not do trimming. Which messages get dropped is decided by
 * `planHistory` in lib/contextBudget.ts against the model's real token budget —
 * a second, char-based trimmer competing with it would only desynchronize the
 * two.
 */

import type { ChatMessage } from '../types'

/** Marks a digest produced here, so it is recognizable in a summary chain. */
export const LOCAL_DIGEST_PREFIX = '[Local digest — summarizer unavailable]'

const MAX_TOPICS = 5
const TOPIC_CHARS = 100

function firstLine(text: string, limit: number): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  const trimmed = line.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

/**
 * A mechanical digest of messages about to leave the context window.
 *
 * Keeps what survives summarization worst — the questions actually asked — plus
 * a count of the code and tool activity, so a later turn can at least tell that
 * a topic was covered and roughly where. Returns '' for an empty input so the
 * caller can distinguish "nothing to record" from "recorded nothing".
 */
export function heuristicSummary(messages: ChatMessage[]): string {
  if (messages.length === 0) return ''

  const parts: string[] = []

  const userQueries = messages
    .filter((m) => m.role === 'user' && !m.marker)
    .map((m) => firstLine(m.content, TOPIC_CHARS))
    .filter((l) => l.length > 0)
    .slice(0, MAX_TOPICS)
  if (userQueries.length > 0) {
    parts.push(`User asked about: ${userQueries.join('; ')}`)
  }

  const assistantTopics = messages
    .filter((m) => m.role === 'assistant' && !m.marker)
    .map((m) => firstLine(m.content, TOPIC_CHARS))
    .filter((l) => l.length > 0)
    .slice(0, MAX_TOPICS)
  if (assistantTopics.length > 0) {
    parts.push(`Assistant covered: ${assistantTopics.join('; ')}`)
  }

  const codeBlocks = messages.filter((m) => m.content.includes('```')).length
  if (codeBlocks > 0) {
    parts.push(`${codeBlocks} message(s) contained code blocks`)
  }

  const toolCalls = messages.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0)
  if (toolCalls > 0) {
    const names = [...new Set(messages.flatMap((m) => (m.toolCalls ?? []).map((t) => t.name)))]
    parts.push(`${toolCalls} tool call(s) ran (${names.slice(0, MAX_TOPICS).join(', ')})`)
  }

  if (parts.length === 0) return ''
  return `${LOCAL_DIGEST_PREFIX}\n${parts.join('.\n')}.`
}

/**
 * Fold a local digest onto an existing summary, keeping the model-written part
 * first so the better text leads. Used only when the summarizer call failed.
 *
 * Returns null when there was nothing worth recording, which the caller must
 * treat as "keep the existing summary and do not advance `throughMessageId`" —
 * advancing it on an empty digest would mark the span as covered by nothing.
 */
export function foldLocalDigest(
  previousSummary: string | undefined,
  dropped: ChatMessage[]
): string | null {
  const digest = heuristicSummary(dropped)
  if (!digest) return null
  return previousSummary ? `${previousSummary}\n\n${digest}` : digest
}
