import type { ChatMessage, Conversation, ModelConfig, ModelInfo } from '../types'
import { budgetContextLength } from './modelInfo'

/**
 * Deciding how much of a conversation fits in the model's context window.
 *
 * Through v0.8.1 this was two constants — 40 messages, 48,000 characters —
 * applied identically to a 4K model and a 128K one. Whatever did not fit was
 * dropped with no summary and no signal, so a long conversation quietly
 * forgot how it started and the user found out by watching the model
 * contradict itself.
 *
 * Two changes: budget against the context length LM Studio actually reports,
 * and hand the dropped span back to the caller so it can be summarized rather
 * than discarded (see the compaction path in useLMStudio.ts).
 *
 * Kept free of React so the arithmetic — the part that is easy to get subtly
 * wrong and impossible to notice — can be tested directly.
 */

/** Fallbacks matching v0.8.1 exactly, used when no context length is known. */
export const FALLBACK_MAX_MESSAGES = 40
export const FALLBACK_MAX_CHARS = 48_000

/**
 * Characters per token. A crude ratio, and deliberately so: a real tokenizer
 * would mean shipping and matching the vocabulary of whatever model the user
 * loaded, and being wrong by 15% in a budget that already reserves headroom
 * costs nothing. Everything downstream calls this an estimate, including the
 * tooltip on the context meter.
 */
const CHARS_PER_TOKEN = 4

/**
 * Rough token cost of an image in a multimodal request. Vision encoders vary
 * wildly (a few hundred tokens to a few thousand); this errs high, because
 * under-counting overflows the window while over-counting only drops one more
 * old message than strictly necessary.
 */
const TOKENS_PER_IMAGE = 1200

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Estimated wire cost of one message, including its attachments. */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = estimateTokens(message.content)
  for (const a of message.attachments ?? []) {
    if (a.kind === 'image') tokens += TOKENS_PER_IMAGE
    else if (a.textContent) tokens += estimateTokens(a.textContent)
  }
  // Tool results are replayed as part of the turn and are often the largest
  // thing in it — counting only the visible text would understate badly.
  for (const tc of message.toolCalls ?? []) {
    tokens += estimateTokens(tc.result ?? '')
  }
  // Per-message wire overhead (role, delimiters) — small but not zero.
  return tokens + 4
}

export interface ContextUsage {
  used: number
  total: number
  ratio: number
}

/**
 * How full the active model's context window is, for the meter on the composer.
 *
 * Returns null when LM Studio never reported a window size: a meter drawn
 * against a guessed denominator would be worse than no meter at all. The
 * numerator is an estimate either way, which the meter's tooltip says out loud.
 */
export function conversationContextUsage(
  conversation: Conversation,
  slot: ModelConfig | undefined,
  catalogEntry: ModelInfo | undefined,
  /** v1.10: text that rides the system prompt beyond the role's own (project instructions). */
  extraSystemText = ''
): ContextUsage | null {
  const total = budgetContextLength(slot, catalogEntry)
  if (!total) return null
  const used =
    conversation.messages.reduce((n, m) => n + estimateMessageTokens(m), 0) +
    estimateTokens(slot?.systemPrompt ?? '') +
    estimateTokens(extraSystemText) +
    estimateTokens(conversation.summary?.text ?? '')
  return { used, total, ratio: used / total }
}

export interface HistoryPlan {
  /** Messages to send, oldest first. */
  keep: ChatMessage[]
  /** Messages that did not fit — candidates for summarization. */
  drop: ChatMessage[]
  /** Estimated tokens the kept messages will cost. */
  usedTokens: number
}

/**
 * Choose the newest slice of a conversation that fits `budgetTokens`.
 *
 * The newest message is always kept, however large it is: dropping the thing
 * the user just sent to make room for older context is never the right answer,
 * and an oversized message is the server's error to report, not ours to hide.
 */
export function planHistory(messages: ChatMessage[], budgetTokens: number): HistoryPlan {
  if (messages.length === 0) return { keep: [], drop: [], usedTokens: 0 }

  const keep: ChatMessage[] = []
  let usedTokens = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(messages[i])
    if (keep.length > 0 && usedTokens + cost > budgetTokens) break
    keep.unshift(messages[i])
    usedTokens += cost
  }

  return { keep, drop: messages.slice(0, messages.length - keep.length), usedTokens }
}

/**
 * The v0.8.1 rule, kept verbatim for servers that report no context length.
 * An older LM Studio must behave exactly as it did before this module existed.
 */
export function planHistoryFallback(messages: ChatMessage[]): HistoryPlan {
  const keep: ChatMessage[] = []
  let chars = 0
  for (let i = messages.length - 1; i >= 0 && keep.length < FALLBACK_MAX_MESSAGES; i--) {
    const m = messages[i]
    const size =
      m.content.length + (m.attachments ?? []).reduce((n, a) => n + (a.textContent?.length ?? 0), 0)
    if (keep.length > 0 && chars + size > FALLBACK_MAX_CHARS) break
    keep.unshift(m)
    chars += size
  }
  return {
    keep,
    drop: messages.slice(0, messages.length - keep.length),
    usedTokens: Math.ceil(chars / CHARS_PER_TOKEN)
  }
}

export interface BudgetInputs {
  /** Context the model is loaded with, from the model catalog. */
  contextLength?: number
  /** Tokens the system prompt (plus any recalled memory) will cost. */
  systemPromptTokens: number
  /** Tokens the tool schemas will cost. */
  toolSchemaTokens: number
  /** The slot's max_tokens, or -1 for "server default". */
  maxTokens: number
}

/**
 * How many tokens of history we can afford, or undefined when the context
 * length is unknown and the caller should use the fallback rule.
 *
 * The reply reservation is the subtle part: max_tokens of -1 means the server
 * decides, so we reserve a fixed slice rather than nothing. Reserving nothing
 * is how a history that "fits" still overflows the moment the model answers.
 */
export function historyBudget(inputs: BudgetInputs): number | undefined {
  if (!inputs.contextLength || inputs.contextLength <= 0) return undefined

  const replyReserve =
    inputs.maxTokens > 0
      ? inputs.maxTokens
      : Math.min(2048, Math.floor(inputs.contextLength * 0.25))

  // A safety margin for the estimate itself being off, and for whatever the
  // chat template adds that we never see.
  const safetyMargin = Math.ceil(inputs.contextLength * 0.05)

  const available =
    inputs.contextLength -
    inputs.systemPromptTokens -
    inputs.toolSchemaTokens -
    replyReserve -
    safetyMargin

  // A tiny context with a big system prompt can go negative. Return 0 rather
  // than a negative budget so planHistory still keeps the newest message.
  return Math.max(0, available)
}
