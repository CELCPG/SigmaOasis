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
const PROMPT_ALLOWANCE_MS = 60_000
/** Pessimistic floor for local generation; slower than any healthy setup. */
const TOKENS_PER_SECOND = 4
const MIN_TIMEOUT_MS = 90_000
const MAX_TIMEOUT_MS = 300_000

export function timeoutForTokens(maxTokens: number | undefined): number {
  const tokens = maxTokens && maxTokens > 0 ? maxTokens : 512
  const derived = PROMPT_ALLOWANCE_MS + (tokens / TOKENS_PER_SECOND) * 1000
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(derived)))
}

/** One non-streaming completion. Returns the assistant's text. */
export async function chatComplete(options: CompleteOptions): Promise<string> {
  const settings = getSettings()
  // Keep the model resident before reasoning: without the pin, an embedding
  // call between research steps lets LM Studio's auto-evict unload it, and
  // every reflect/synthesize pays a full reload.
  await pinChatModel(options.model)
  try {
    const res = await auditedFetch(
      `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          stream: false,
          temperature: options.temperature ?? 0.2,
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
        timeoutMs: options.timeoutMs ?? timeoutForTokens(options.maxTokens)
      },
      'lmstudio'
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LM Studio returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    return data.choices?.[0]?.message?.content ?? ''
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
 */
export function parseSseDeltas(buffer: string): { text: string; rest: string } {
  let text = ''
  const lastBreak = buffer.lastIndexOf('\n')
  if (lastBreak === -1) return { text: '', rest: buffer }
  const complete = buffer.slice(0, lastBreak)
  const rest = buffer.slice(lastBreak + 1)

  for (const line of complete.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; message?: { content?: string } }[]
      }
      const choice = parsed.choices?.[0]
      text += choice?.delta?.content ?? choice?.message?.content ?? ''
    } catch {
      // A malformed frame is skipped rather than failing the whole stream.
    }
  }
  return { text, rest }
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

  let accumulated = ''
  let pending = ''
  const decoder = new TextDecoder()
  const onChunk = (chunk: Uint8Array): void => {
    pending += decoder.decode(chunk, { stream: true })
    const { text, rest } = parseSseDeltas(pending)
    accumulated += text
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
          messages: options.messages,
          stream: true,
          temperature: options.temperature ?? 0.2,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {})
        }),
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? timeoutForTokens(options.maxTokens),
        onChunk
      },
      'lmstudio'
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LM Studio returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    // Flush any final frame the last chunk left incomplete.
    const { text } = parseSseDeltas(`${pending}\n`)
    return accumulated + text
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (accumulated.trim()) throw new PartialCompletionError(message, accumulated)
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
  try {
    const text = await chatComplete({ ...options, json: true })
    return extractJson(text) as T | null
  } catch (err) {
    // A schema-constrained request a server cannot honor fails with HTTP 400.
    // Retry once without the constraint: grammar enforcement is a bonus, not
    // a requirement, and the tolerant parser below is the safety net either way.
    if (options.jsonSchema && err instanceof Error && err.message.includes('HTTP 400')) {
      const { jsonSchema: _dropped, ...rest } = options
      const text = await chatComplete({ ...rest, json: true })
      return extractJson(text) as T | null
    }
    throw err
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
