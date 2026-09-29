import type { Conversation, ResponseStats } from '../types'

/**
 * v3.1 (S6): say when the model is reading too slowly to be on the GPU.
 *
 * Every reply already records its prompt tokens and the wait before its first
 * token (`ResponseStats`), which together are how fast the model read the
 * prompt. Measured on the bench machine (RTX 5070, 12 GB), 2026-09-28:
 *
 *   qwen3.8-9b-distill, on the card, 2,010 tokens, nothing cached   ~2,000 /s
 *   the same family's 9B, partly on the CPU                         84–86 /s
 *   prism-ml/bonsai-27b (Q1_0, a 262,144-token window)              40–41 /s
 *   qwen3.8-27b                                                        33 /s
 *
 * The slow ones cost the reader 24–69 s before a word, and nothing on the
 * screen said why; the reader blamed the app. The floor sits just above the
 * worst of them and an order of magnitude under the card's own rate, which
 * leaves room for hardware that fits a model and is simply slower.
 *
 * Only a long wait is judged. A prompt the server had cached is read in a
 * blink whatever the model, so a short wait says nothing about fit — and a
 * long one on a partly cached prompt overstates the rate, which can only hide
 * a slow model, never accuse a fast one. What can: LM Studio busy with another
 * client's request, which queues this one. The sentence names that too.
 */

/** Below this wait the reader was not kept waiting, and a cache hit is likely. */
export const SLOW_READ_WAIT_MS = 8_000
/** Prompt tokens a second under which a long wait is the model's reading, not its size. */
export const SLOW_READ_RATE = 150
/** A loaded window this large is worth naming: its cache needs memory the card may not have. */
export const LARGE_WINDOW = 131_072

export interface SlowReading {
  promptTokens: number
  waitMs: number
  /** Prompt tokens read per second. */
  rate: number
}

/** The reply's reading, when it was slow enough to name; null otherwise. */
export function slowReading(stats: ResponseStats | undefined): SlowReading | null {
  if (!stats?.promptTokens || !stats.ttftMs || stats.ttftMs < SLOW_READ_WAIT_MS) return null
  const rate = stats.promptTokens / (stats.ttftMs / 1000)
  return rate < SLOW_READ_RATE ? { promptTokens: stats.promptTokens, waitMs: stats.ttftMs, rate } : null
}

/** The measured half: what happened, in the reader's units. */
export function slowReadingFact(r: SlowReading): string {
  return (
    `read ${r.promptTokens.toLocaleString('en-US')} prompt tokens at ${Math.round(r.rate)} a second — ` +
    `${(r.waitMs / 1000).toFixed(1)}s before the first word`
  )
}

/** The comparison that makes the measured rate mean something, in one sentence. */
export const FITTING_RATE = 'A model that fits the GPU reads thousands a second.'

/** The advice half, naming the loaded window when it is large enough to matter. */
export function slowReadingAdvice(loadedContextLength?: number): string {
  const window =
    loadedContextLength && loadedContextLength >= LARGE_WINDOW
      ? ` It is loaded with a ${loadedContextLength.toLocaleString('en-US')}-token window, whose cache alone can fill the card.`
      : ''
  return (
    `${FITTING_RATE} In LM Studio, a smaller model or quant, ` +
    `full GPU offload, or a shorter context window is the usual fix.${window} ` +
    'If LM Studio was busy with another request at the time, the wait was the queue instead.'
  )
}

/**
 * For Settings → Roles, where VIBE's reader sees it: the model's most recent
 * reply that recorded stats, if that reply read slowly. Only the latest — a
 * model that has since been reloaded well must not keep an old verdict.
 */
export function latestSlowReading(conversations: Conversation[], modelId: string): SlowReading | null {
  if (!modelId) return null
  let latest: { at: number; stats: ResponseStats } | null = null
  for (const c of conversations) {
    for (const m of c.messages) {
      if (m.role !== 'assistant' || m.modelId !== modelId || !m.stats?.ttftMs) continue
      if (!latest || m.createdAt > latest.at) latest = { at: m.createdAt, stats: m.stats }
    }
  }
  return latest ? slowReading(latest.stats) : null
}
