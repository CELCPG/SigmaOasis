import { auditedFetch } from './net'
import { pinChatModel } from './modelPin'
import { getSettings } from './store'

/**
 * Main-process access to the local model.
 *
 * Chat normally streams from the renderer (useLMStudio.ts). The research
 * orchestrator, though, runs entirely in the main process — that is the whole
 * point of it, since it keeps a twenty-page crawl out of the conversation
 * history — so it needs its own way to ask the model to plan and to synthesize.
 * Non-streaming is right here: nothing is displayed token by token, and the
 * caller wants a complete structured answer.
 *
 * Traffic goes through `auditedFetch` with the `lmstudio` purpose, so these
 * calls are allowlisted and logged exactly like every other request.
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompleteOptions {
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** Ask the server for JSON. Honored by LM Studio; harmless when ignored. */
  json?: boolean
  /**
   * Constrain the output to a JSON schema (llama.cpp grammar enforcement via
   * LM Studio's structured output). Far stronger than asking nicely: the
   * model literally cannot emit malformed JSON or missing keys. Servers that
   * do not support it reject the request with HTTP 400, which chatCompleteJson
   * turns into a retry without the constraint.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  /**
   * Override the derived timeout. Rarely needed — the default already scales
   * with `maxTokens`, which is the thing that actually determines how long a
   * local model takes.
   */
  timeoutMs?: number
  /**
   * `false` asks a reasoning model not to think before answering.
   *
   * Every call in this module is a utility call — plan, reformulate,
   * summarize, synthesize — whose output is parsed or filed, never read as it
   * arrives. Chain-of-thought buys nothing on any of them and is charged twice:
   * once in latency, and once against `maxTokens`, which is a budget for the
   * answer rather than for the deliberation in front of it. Left undefined the
   * model decides, which is the right default for anything user-facing.
   */
  thinking?: boolean
}

// ---- reasoning ----------------------------------------------------------------

/**
 * Chain-of-thought is invisible to this module by default, and that is a
 * problem rather than a convenience.
 *
 * LM Studio registers a reasoning parser for the Qwen3 family (and others), so
 * the model's thinking is routed out of band into `reasoning_content` while
 * `content` stays empty until it finishes. Reading only `content` — which is
 * what every parser here did through v1.4 — means a model that spends its whole
 * token budget thinking looks exactly like a model that answered with nothing.
 * Measured on qwen3.5-9b-mlx: the research planner (700 tokens) never emitted
 * its JSON, so runs reported "planning did not produce sub-questions", and
 * synthesis (1400 tokens) came back as "the model returned an empty brief"
 * after a full ninety-second crawl. Both are the same starved budget wearing
 * two different error messages.
 *
 * So: thinking is switched off for these calls, parsed when it arrives anyway,
 * and a reply that is *only* thinking is reported as such instead of as silence.
 */

/**
 * How thinking is actually switched off, as measured rather than as documented.
 *
 * v1.4.1 sent `chat_template_kwargs: {enable_thinking: false}` plus Qwen3's
 * `/no_think` token and shipped them unverified. Both are inert on
 * qwen3.5-9b-mlx in LM Studio — measured 2026-08-12, along with
 * `reasoning_effort`, `template_kwargs`, a top-level `enable_thinking`, and
 * `/nothink`. Every one produced byte-for-byte the same behavior as sending
 * nothing: the whole budget spent thinking, no answer at all.
 *
 * What works is prefilling the assistant turn with a thinking block that is
 * already closed, so the model resumes *after* it rather than opening one.
 * Same measurement: the research planner went from an empty reply to valid
 * JSON, and the synthesis brief from empty-after-36s to a cited brief in 6.4s.
 *
 * Raising the token budget is not an alternative. At 1200 tokens this model
 * still produced 4,751 characters of deliberation and no answer; it only got
 * there at 2000, after 69 seconds. Thinking length does not converge, so a
 * budget large enough to always contain it is a budget nothing can afford.
 */
const CLOSED_THINK_PREFILL = '<think>\n\n</think>\n\n'
/**
 * Families whose chain-of-thought is delimited by `<think>` tags, so a closed
 * block is a valid thing to hand them. Gemma 4 is deliberately absent: it
 * marks thinking with its own control tokens, and feeding it another family's
 * tags would put literal markup in the answer rather than suppress anything.
 */
const THINK_TAG_MODELS = /qwen[-_]?3|deepseek[-_]?r1|r1[-_]?distill|magistral/i

/** Inline `<think>…</think>`, in the spellings lib/reasoning.ts also handles. */
const THINK_BLOCK = /<(think|thinking|reason|reasoning)>[\s\S]*?<\/\1>\s*/gi
/** A block the model opened and never closed — everything after it is thinking. */
const UNCLOSED_THINK = /<(think|thinking|reason|reasoning)>[\s\S]*$/i

/**
 * Remove inline reasoning from model output.
 *
 * The out-of-band channel is the common case, but the same model on a build
 * without the parser emits the tags in `content` instead. A brief that opens
 * with the model's own deliberation is not a brief.
 */
export function stripReasoning(text: string): string {
  return text.replace(THINK_BLOCK, '').replace(UNCLOSED_THINK, '').trim()
}

/**
 * A completion that produced only chain-of-thought.
 *
 * Distinct from an empty reply on purpose: the causes are different (a budget
 * spent thinking versus a model with nothing to say) and so is the fix, and the
 * caller's disclosure to the user should say which one happened.
 */
export class ReasoningOnlyError extends Error {
  constructor(readonly reasoningChars: number) {
    super(
      `the model spent its whole token budget on chain-of-thought and never began the answer ` +
        `(${reasoningChars} characters of reasoning, no output). Raise maxTokens or disable thinking.`
    )
    this.name = 'ReasoningOnlyError'
  }
}

/** The request shape that turns thinking off, or the request unchanged. */
export function applyThinking(options: CompleteOptions): {
  messages: ChatMessage[]
  body: Record<string, unknown>
} {
  if (options.thinking !== false) return { messages: options.messages, body: {} }
  // Kept although it does nothing here: it is the parameter the API documents,
  // it costs one field, and a server that honors it needs no prefill at all.
  const body = { chat_template_kwargs: { enable_thinking: false } }
  // A grammar and a prefilled assistant turn cannot be combined: LM Studio
  // fails to construct the sampler and rejects the whole request with
  // `Failed to initialize samplers: std::exception` (HTTP 400, measured on
  // qwen3.8-9b, 2026-08-18). That took out every planned turn on the qwen3
  // family — plan.ts asks for both at once — and the retry below then failed
  // for a second, unrelated reason, so the error the user saw named neither
  // cause. The prefill buys nothing here anyway: a grammar that permits only
  // the schema already makes a `<think>` block unemittable.
  if (options.jsonSchema) return { messages: options.messages, body }
  if (!THINK_TAG_MODELS.test(options.model)) return { messages: options.messages, body }
  return {
    messages: [...options.messages, { role: 'assistant', content: CLOSED_THINK_PREFILL }],
    body
  }
}

/**
 * How long to wait, derived from how much the model was asked to write.
 *
 * A single flat timeout was wrong in both directions. Through v1.3 every
 * main-process call — a 400-token query reformulation and a 1400-token
 * research brief alike — got 120 seconds. On laptop-class hardware a 12B model
 * writing 1400 tokens needs well past that, so research runs that had already
 * spent three minutes fetching and ranking sources threw all of it away at the
 * final step (measured: 8 pages across 7 domains, then "Synthesis failed:
 * Request timed out after 120s"). Meanwhile a genuinely hung server held a
 * short call for the full two minutes.
 *
 * So: a fixed allowance for prompt processing, plus time per requested token
 * at a pessimistic generation rate. This is a ceiling for the pathological
 * case, not a delay anyone waits out — a healthy server returns long before it.
 */
const BASE_ALLOWANCE_MS = 15_000
/**
 * Floors, not estimates, and now calibrated against something.
 *
 * v1.5 measured qwen3.5-9b-mlx (4-bit MLX, Apple silicon): ~300 tokens/s of
 * prompt processing and 13–25 tokens/s of generation. The v1.3 constant of 4
 * tokens/s was three to six times under that, which is why every derived
 * timeout pinned to the 300-second ceiling.
 *
 * These stay well below the measurement anyway, because the same constant has
 * to hold for a 12B GGUF on an Intel Mac, and because overshooting costs
 * nothing on a healthy server while undershooting discards real work.
 */
const GENERATION_TOKENS_PER_SECOND = 6
const PROMPT_TOKENS_PER_SECOND = 60
const MIN_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000

/**
 * How long a streaming response may go silent before the connection is treated
 * as dead. Armed only after the first token, so prompt processing — which is
 * legitimately silent, and legitimately long — is governed by the overall
 * budget instead. Between tokens a healthy local model pauses milliseconds.
 *
 * A full minute rather than the ten seconds the measurement would justify,
 * because the thing being timed is not the model. Small writes are coalesced
 * on their way through the socket and the Chromium net stack — a five-byte
 * write never surfaced as a read event at all while writing this — so the gap
 * observed here is a buffer's rhythm, not a token's. Anything tight enough to
 * be interesting would eventually cut off a healthy slow generation, and this
 * is still five times faster than the ceiling it replaces.
 */
export const STREAM_STALL_MS = 60_000

/** Rough token count for a set of messages; the usual four-chars-per-token. */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4)
}

/**
 * The overall deadline, from what the model was asked to read and to write.
 *
 * Through v1.4 the prompt side was a flat 60 seconds regardless of size, which
 * was generous for a two-line question and short for a 30k-token conversation —
 * wrong in both directions at once, and invisible because the generation term
 * was so inflated that the total always hit the ceiling anyway.
 */
export function timeoutForTokens(
  maxTokens: number | undefined,
  promptTokens = 0
): number {
  const tokens = maxTokens && maxTokens > 0 ? maxTokens : 512
  const derived =
    BASE_ALLOWANCE_MS +
    (promptTokens / PROMPT_TOKENS_PER_SECOND) * 1000 +
    (tokens / GENERATION_TOKENS_PER_SECOND) * 1000
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(derived)))
}

/** One non-streaming completion. Returns the assistant's text. */
export async function chatComplete(options: CompleteOptions): Promise<string> {
  const settings = getSettings()
  // Keep the model resident before reasoning: without the pin, an embedding
  // call between research steps lets LM Studio's auto-evict unload it, and
  // every reflect/synthesize pays a full reload.
  await pinChatModel(options.model)
  const thinking = applyThinking(options)
  try {
    const res = await auditedFetch(
      `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: thinking.messages,
          stream: false,
          temperature: options.temperature ?? 0.2,
          ...thinking.body,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
          ...(options.jsonSchema
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: options.jsonSchema.name,
                    strict: true,
                    schema: options.jsonSchema.schema
                  }
                }
              }
            : options.json
              ? { response_format: { type: 'json_object' } }
              : {})
        }),
        signal: options.signal,
        // No stall detection here: a non-streaming completion is silent from
        // the request until the whole answer lands, so silence carries no
        // information and the overall deadline is all there is.
        timeoutMs:
          options.timeoutMs ??
          timeoutForTokens(options.maxTokens, estimatePromptTokens(thinking.messages))
      },
      'lmstudio'
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LM Studio returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[]
    }
    const message = data.choices?.[0]?.message
    const answer = stripReasoning(message?.content ?? '')
    // Thinking with nothing after it is a starved budget, not an empty reply.
    if (!answer && message?.reasoning_content?.trim()) {
      throw new ReasoningOnlyError(message.reasoning_content.length)
    }
    return answer
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }
}

/**
 * A completion that failed after the model had already written something.
 *
 * `partial` is what arrived before the failure. A research brief that stopped
 * four paragraphs in is worth far more to the user than an error string, and
 * the caller — not this module — decides whether the fragment is usable.
 */
export class PartialCompletionError extends Error {
  constructor(
    message: string,
    readonly partial: string
  ) {
    super(message)
    this.name = 'PartialCompletionError'
  }
}

/**
 * Parse one Server-Sent Events buffer into completion deltas.
 *
 * Returns the text found plus whatever trailing fragment was incomplete, which
 * the caller carries into the next chunk — a delta can split mid-line, and
 * dropping the remainder loses tokens silently.
 *
 * `reasoning` is the out-of-band chain-of-thought channel, kept separate rather
 * than merged or discarded: merging it would put the model's deliberation into
 * a brief, and discarding it makes a reply that was *only* thinking
 * indistinguishable from no reply at all.
 */
export function parseSseDeltas(buffer: string): { text: string; reasoning: string; rest: string } {
  let text = ''
  let reasoning = ''
  const lastBreak = buffer.lastIndexOf('\n')
  if (lastBreak === -1) return { text: '', reasoning: '', rest: buffer }
  const complete = buffer.slice(0, lastBreak)
  const rest = buffer.slice(lastBreak + 1)

  for (const line of complete.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as {
        choices?: {
          delta?: { content?: string; reasoning_content?: string }
          message?: { content?: string; reasoning_content?: string }
        }[]
      }
      const choice = parsed.choices?.[0]
      text += choice?.delta?.content ?? choice?.message?.content ?? ''
      reasoning += choice?.delta?.reasoning_content ?? choice?.message?.reasoning_content ?? ''
    } catch {
      // A malformed frame is skipped rather than failing the whole stream.
    }
  }
  return { text, reasoning, rest }
}

/**
 * One streaming completion, returning the full text.
 *
 * Streams for durability rather than display: nothing here is shown token by
 * token, but accumulating as bytes arrive means a timeout throws a
 * `PartialCompletionError` carrying the text written so far instead of
 * discarding minutes of generation.
 */
export async function chatCompleteStream(options: CompleteOptions): Promise<string> {
  const settings = getSettings()
  await pinChatModel(options.model)
  const thinking = applyThinking(options)

  let accumulated = ''
  let reasoned = ''
  let pending = ''
  const decoder = new TextDecoder()
  const onChunk = (chunk: Uint8Array): void => {
    pending += decoder.decode(chunk, { stream: true })
    const { text, reasoning, rest } = parseSseDeltas(pending)
    accumulated += text
    reasoned += reasoning
    pending = rest
  }

  try {
    const res = await auditedFetch(
      `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: thinking.messages,
          stream: true,
          temperature: options.temperature ?? 0.2,
          ...thinking.body,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {})
        }),
        signal: options.signal,
        timeoutMs:
          options.timeoutMs ??
          timeoutForTokens(options.maxTokens, estimatePromptTokens(thinking.messages)),
        // Tokens arriving is the liveness signal a total deadline cannot see.
        // A dead server now fails in half a minute instead of holding the
        // caller for the whole budget, and a slow one is left alone.
        stallTimeoutMs: STREAM_STALL_MS,
        onChunk
      },
      'lmstudio'
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LM Studio returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    // Flush any final frame the last chunk left incomplete.
    const tail = parseSseDeltas(`${pending}\n`)
    const answer = stripReasoning(accumulated + tail.text)
    // Thinking with nothing after it is a starved budget, not an empty reply.
    if (!answer && (reasoned + tail.reasoning).trim()) {
      throw new ReasoningOnlyError((reasoned + tail.reasoning).length)
    }
    return answer
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof ReasoningOnlyError) throw err
    // The partial is stripped for the same reason the whole reply is: a brief
    // cut off mid-thought is worth keeping, its `<think>` preamble is not.
    const partial = stripReasoning(accumulated)
    if (partial) throw new PartialCompletionError(message, partial)
    throw err instanceof Error ? err : new Error(message)
  }
}

/**
 * Pull a JSON value out of model output.
 *
 * Local models routinely ignore "return only JSON": they wrap it in prose, fence
 * it as markdown, or add a trailing explanation. Being tolerant here is the
 * difference between a planner that works on a 7B model and one that only works
 * on a frontier model, so this walks the text for the first balanced JSON value
 * rather than trusting the whole string to parse.
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // Fast path: the model actually complied.
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through to scanning.
  }

  // Strip markdown fences, which are the most common wrapper.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      // Keep scanning the original text.
    }
  }

  // Scan for the first balanced {...} or [...], respecting strings and escapes
  // so a brace inside a string value cannot end the scan early.
  for (let i = 0; i < trimmed.length; i++) {
    const open = trimmed[i]
    if (open !== '{' && open !== '[') continue
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false

    for (let j = i; j < trimmed.length; j++) {
      const ch = trimmed[j]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(i, j + 1))
          } catch {
            break // Malformed; try the next opening brace.
          }
        }
      }
    }
  }
  return null
}

/** A completion parsed as JSON, or null when the model produced nothing usable. */
export async function chatCompleteJson<T>(options: CompleteOptions): Promise<T | null> {
  const isRejection = (err: unknown): boolean =>
    err instanceof Error && err.message.includes('HTTP 400')
  try {
    const text = await chatComplete({ ...options, json: true })
    return extractJson(text) as T | null
  } catch (err) {
    if (!options.jsonSchema || !isRejection(err)) throw err
    // A constraint the server cannot honor fails with HTTP 400, so step down
    // one rung at a time: grammar, then JSON mode, then nothing. Both are a
    // bonus — every caller's prompt asks for JSON in words, and `extractJson`
    // is the tolerant parser that has to work regardless.
    //
    // The second rung is why this needs two catches rather than one. Through
    // v1.9.1 the fallback went straight to `json_object`, which LM Studio
    // itself rejects (`'response_format.type' must be 'json_schema' or
    // 'text'`) — so the recovery path threw a fresh 400, and that second
    // error, about a format the caller never chose, was the one shown.
    const { jsonSchema: _grammar, json: _mode, ...plain } = options
    try {
      const text = await chatComplete({ ...plain, json: true })
      return extractJson(text) as T | null
    } catch (retryErr) {
      if (!isRejection(retryErr)) throw retryErr
      const text = await chatComplete(plain)
      return extractJson(text) as T | null
    }
  }
}

/**
 * Which model should do the reasoning. The caller's own model is preferred — the
 * orchestrator should think with whatever the user is already talking to — and
 * auto-detection is only a fallback for when that is unknown.
 */
export async function resolveChatModel(preferred?: string): Promise<string | null> {
  const trimmed = (preferred ?? '').trim()
  if (trimmed) return trimmed
  try {
    const settings = getSettings()
    const res = await auditedFetch(
      `${settings.baseUrl.replace(/\/+$/, '')}/models`,
      undefined,
      'lmstudio'
    )
    if (!res.ok) return null
    const data = (await res.json()) as { data?: { id: string }[] }
    // Embedding models cannot chat; skip them.
    return data.data?.find((m) => !/embed/i.test(m.id))?.id ?? null
  } catch {
    return null
  }
}
