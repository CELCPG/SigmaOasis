import { auditedFetch } from './net'
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
}

const DEFAULT_TIMEOUT_MS = 120_000

/** One non-streaming completion. Returns the assistant's text. */
export async function chatComplete(options: CompleteOptions): Promise<string> {
  const settings = getSettings()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  // Honor an upstream cancellation (the user pressing Stop) as well as our own
  // timeout, without leaking a listener when this call finishes first.
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })

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
          ...(options.json ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: controller.signal
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
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
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
  const text = await chatComplete({ ...options, json: true })
  return extractJson(text) as T | null
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
