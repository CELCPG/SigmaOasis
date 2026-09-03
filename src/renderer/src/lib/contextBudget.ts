import type { ChatMessage, Conversation, ModelConfig, ModelInfo, ToolSchema } from '../types'
import type { RequestEstimate, SettingsTarget } from '../../../shared/failure'
import { budgetContextLength } from './modelInfo'
import { TURN_TOOL_CAP } from './toolSelection'

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

/** One named term of a turn's cost, large enough to be worth telling apart. */
export interface UsageTerm {
  /** How a reader is told to shrink it: "the conversation", "the tool list". */
  label: string
  tokens: number
  /** The Settings tab that changes it, where one exists. */
  tab?: SettingsTarget
}

export interface ContextUsage {
  /**
   * What a turn would cost with the whole conversation on the wire. This is the
   * meter's number: it is what the reader is spending, and it is what starts
   * getting summarized away as it approaches the window.
   */
  used: number
  total: number
  ratio: number
  /** Every term of `used`, largest first. Never empty. */
  terms: UsageTerm[]
  /** The largest term — what a reader shrinks first. */
  largest: UsageTerm
  /**
   * What the app would actually send, after `planHistory` drops what does not
   * fit. Never larger than `used`, and equal to it when nothing is dropped.
   */
  planned: number
  /**
   * No request this app can build would fit — the fixed overhead plus the
   * newest message alone is over the window.
   *
   * This is a deliberately hard test, and it is hard because it gates a
   * control. `used > total` is NOT this: the turn compacts, and disabling
   * Regenerate on a conversation that compaction would have handled is exactly
   * the false accusation this round is about. `planHistory` always keeps the
   * newest message however large, so the only unfittable request is one whose
   * newest message is itself too big — and that one is unfittable however many
   * times it is retried.
   */
  overflows: boolean
}

/**
 * v1.17.3: the tool schemas a turn can put on the wire, as an upper bound.
 *
 * The turn picks `TURN_TOOL_CAP` tools by embedding rank against the user's
 * text, so which ones is not knowable before the message is written — but
 * *how expensive the priciest such subset is* is knowable exactly, and that is
 * the number a "will this fit?" meter wants. The module already errs this way
 * on purpose for images (TOKENS_PER_IMAGE): under-counting overflows the
 * window, over-counting drops one more old message than it had to.
 *
 * Measured over the shipped table: 25 schemas cost ~6.5K estimated tokens in
 * total, and the six priciest cost ~2.7K — a third of an 8192 window, and the
 * single largest thing in most requests. The composer's meter counted none of
 * it, which is how it came to read `~1.7K / 8.2K` on a turn the app was
 * budgeting past the end of the window.
 */
export function toolSchemaCeiling(schemas: ToolSchema[], cap = TURN_TOOL_CAP): number {
  return schemas
    .map(schemaTokens)
    .sort((a, b) => b - a)
    .slice(0, cap)
    .reduce((n, t) => n + t, 0)
}

/**
 * A schema's wire cost, remembered against the schema itself.
 *
 * The schemas come from one module-level table and never change, while this is
 * asked on every keystroke in the composer and on every frame of a streaming
 * reply. Serializing 26KB of JSON at 30fps to reach a constant is not a meter.
 */
const SCHEMA_TOKENS = new WeakMap<ToolSchema, number>()
function schemaTokens(schema: ToolSchema): number {
  const hit = SCHEMA_TOKENS.get(schema)
  if (hit !== undefined) return hit
  const tokens = estimateTokens(JSON.stringify(schema))
  SCHEMA_TOKENS.set(schema, tokens)
  return tokens
}

/**
 * What a turn in this conversation costs, against what the model is loaded with.
 *
 * Returns null when LM Studio never reported a window size: a meter drawn
 * against a guessed denominator would be worse than no meter at all. The
 * numerator is an estimate either way, which the meter's tooltip says out loud.
 *
 * ## Why this counts more than the conversation
 *
 * Round 9 found the app asserting `This conversation … is larger than the
 * context the model is loaded with` while the meter under the composer, over
 * the same conversation and the same model, read `~1.7K / 8.2K`. The meter was
 * not lying about what it measured; it was measuring the wrong thing, and its
 * label ("of 8.2K tokens used") invited the reader to conclude that 6.5K were
 * free. They were not. A request also carries:
 *
 * - the tool schemas — the largest single term on most turns, and the app's own
 *   addition rather than anything the user wrote;
 * - the reply reservation, which `historyBudget` below has always subtracted,
 *   because a history that "fits" still overflows the moment the model answers.
 *
 * Both are spent from the same window and neither was on the meter. Counting
 * them is what lets one number serve the meter, the refusal sentence
 * (shared/failure.ts `RequestEstimate`) and the gate on Regenerate — which is
 * the actual repair, because two spellings of "how full is the window" is how
 * the app came to contradict itself in two places on one screen.
 */
export function conversationContextUsage(
  conversation: Conversation,
  slot: ModelConfig | undefined,
  catalogEntry: ModelInfo | undefined,
  /** v1.10: text that rides the system prompt beyond the role's own (project instructions). */
  extraSystemText = '',
  /** The tool schemas this slot may send. Omitted (tests, no settings yet) counts as none. */
  toolSchemas: ToolSchema[] = []
): ContextUsage | null {
  const total = budgetContextLength(slot, catalogEntry)
  if (!total) return null

  const conversationTokens =
    conversation.messages.reduce((n, m) => n + estimateMessageTokens(m), 0) +
    estimateTokens(conversation.summary?.text ?? '')
  const promptTokens = estimateTokens((slot?.systemPrompt ?? '') + (slot?.rules ?? '')) + estimateTokens(extraSystemText)
  const toolTokens = toolSchemaCeiling(toolSchemas)
  const reserve = replyReserve(total, slot?.sampling.maxTokens ?? -1)

  const terms: UsageTerm[] = [
    { label: 'the conversation', tokens: conversationTokens },
    { label: 'the tool list', tokens: toolTokens, tab: 'tools' as const },
    { label: 'the role’s instructions', tokens: promptTokens, tab: 'models' as const },
    // No tab: max_tokens is a slot field, but telling someone to shrink the
    // room reserved for the answer is not a remedy for an overflow — it just
    // moves the truncation. It is counted and named, and no control is offered.
    { label: 'room reserved for the reply', tokens: reserve }
  ].sort((a, b) => b.tokens - a.tokens)

  const used = terms.reduce((n, t) => n + t.tokens, 0)

  // What survives compaction, by the same two functions the turn itself uses.
  // `planHistory` keeps the newest message however large, so this is bounded by
  // the window in every case except the one that genuinely cannot be sent.
  const summaryTokens = estimateTokens(conversation.summary?.text ?? '')
  const budget = historyBudget({
    contextLength: total,
    systemPromptTokens: promptTokens,
    toolSchemaTokens: toolTokens,
    maxTokens: slot?.sampling.maxTokens ?? -1
  })
  const plan =
    budget === undefined
      ? planHistoryFallback(conversation.messages)
      : planHistory(conversation.messages, budget)
  const planned = promptTokens + toolTokens + reserve + summaryTokens + plan.usedTokens

  return {
    used,
    total,
    ratio: used / total,
    terms,
    largest: terms[0],
    planned,
    overflows: planned > total
  }
}

/**
 * The window a turn cannot use because the answer has to go somewhere.
 *
 * Extracted from `historyBudget`, which has reserved exactly this since v0.8.2
 * and is the only reason a conversation that "fits" does not overflow on the
 * first token. The meter had to learn the same number: it is a quarter of a
 * small window, which is more than the whole of what the meter used to show.
 */
export function replyReserve(contextLength: number, maxTokens: number): number {
  return maxTokens > 0 ? maxTokens : Math.min(2048, Math.floor(contextLength * 0.25))
}

/**
 * The app's arithmetic in the shape the failure boundary quotes it in.
 *
 * One conversion, so the sentence on a refusal and the number under the
 * composer cannot drift apart again.
 */
export function requestEstimate(usage: ContextUsage): RequestEstimate {
  return {
    // `planned`, not `used`: the sentence is about the request that was sent,
    // and what was sent is what survived compaction.
    total: usage.planned,
    window: usage.total,
    largest: {
      label: usage.largest.label,
      tokens: usage.largest.tokens,
      ...(usage.largest.tab
        ? { control: { label: `Settings → ${TAB_LABEL[usage.largest.tab]}`, tab: usage.largest.tab } }
        : {})
    }
  }
}

/** Mirrors SettingsModal's tab titles, for a control that names where it goes. */
const TAB_LABEL: Record<SettingsTarget, string> = {
  connection: 'Connection',
  models: 'Models',
  search: 'Search',
  tools: 'Tools'
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

  // A safety margin for the estimate itself being off, and for whatever the
  // chat template adds that we never see.
  const safetyMargin = Math.ceil(inputs.contextLength * 0.05)

  const available =
    inputs.contextLength -
    inputs.systemPromptTokens -
    inputs.toolSchemaTokens -
    replyReserve(inputs.contextLength, inputs.maxTokens) -
    safetyMargin

  // A tiny context with a big system prompt can go negative. Return 0 rather
  // than a negative budget so planHistory still keeps the newest message.
  return Math.max(0, available)
}
