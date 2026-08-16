import { useAppStore } from '../stores/appStore'
import { createReasoningSplitter } from '../lib/reasoning'
import { createNativeToolExtractor, type NativeToolCall } from '../lib/nativeToolCall'
import { getFromCache, setInCache } from '../lib/responseCache'
import { resolveSampling } from '../lib/sampling'
import type { ApiMessage, ApiToolCall, ApiUsage } from '../lib/agentLoop'
import type { ChatMessage, SamplingSettings, ToolSchema } from '../types'
import { uid } from './turnHelpers'

/**
 * The transport under every model call: one streamed chat completion against
 * LM Studio's OpenAI-compatible API (SSE parsing, reasoning channels, native
 * tool-call markup, the response cache), the sampling fields it sends, and the
 * streaming tail that paces tokens into the UI. Extracted verbatim from
 * useLMStudio.ts in v1.4.8.
 */

// ---- OpenAI wire types --------------------------------------------------------
// ApiMessage / ApiToolCall / ApiContentPart / ApiUsage live in lib/agentLoop.ts,
// which owns the wire history across tool-loop iterations.

/**
 * Cap on how often streamed text is flushed to the UI (~30 fps). Tokens can
 * arrive far faster than the screen repaints; flushing each one bought nothing
 * visually and cost a store commit per token.
 */
export const TAIL_FLUSH_MS = 33

/**
 * Routes a streaming message's tokens through the store's streamingTail slice
 * instead of patchMessage. A per-token patchMessage rebuilds the conversations
 * array — which re-renders every subscriber, for every token, for the whole
 * reply (O(n²) with the markdown re-parse on top). The tail is a two-field
 * object only the streaming bubble subscribes to. `assistantMsg.content`
 * remains the turn's source of truth; the caller appends chunks to it and
 * calls `schedule()`, commits it into the message at round boundaries with
 * `commit()`, and must call `finish()` when the turn ends, however it ends.
 *
 * Pacing is driven by chunk arrival, never by a timer: Chromium throttles
 * timers in occluded windows (measured here as a stream coalescing into
 * one-per-minute jumps behind another window), while network callbacks keep
 * firing. A chunk flushes if TAIL_FLUSH_MS has passed since the last flush;
 * a sub-interval remainder is picked up by the next chunk or by commit().
 */
export function makeTailStream(
  assistantMsg: ChatMessage,
  patch: (p: Partial<ChatMessage>) => void
): { schedule: () => void; commit: () => void; finish: () => void } {
  let lastFlush = 0
  const setTail = (): void =>
    useAppStore
      .getState()
      .setStreamingTail({ messageId: assistantMsg.id, text: assistantMsg.content })
  return {
    schedule(): void {
      const now = Date.now()
      if (now - lastFlush >= TAIL_FLUSH_MS) {
        lastFlush = now
        setTail()
      }
    },
    commit(): void {
      patch({ content: assistantMsg.content })
      setTail()
    },
    finish(): void {
      patch({ content: assistantMsg.content })
      useAppStore.getState().setStreamingTail(null)
    }
  }
}

/**
 * The sampling fields of a completion request.
 *
 * `top_k` and `min_p` are omitted rather than sent as zero: zero is a valid
 * "off" for some servers and an error for others, and a field left out is the
 * only spelling of "you decide" that every OpenAI-compatible server agrees on.
 */
export function wireSampling(sampling: SamplingSettings, modelId: string): Record<string, unknown> {
  const s = resolveSampling(sampling, modelId)
  return {
    temperature: s.temperature,
    top_p: s.topP,
    ...(s.maxTokens > 0 ? { max_tokens: s.maxTokens } : {}),
    ...(s.seed !== null ? { seed: s.seed } : {}),
    ...(s.topK > 0 ? { top_k: s.topK } : {}),
    ...(s.minP > 0 ? { min_p: s.minP } : {})
  }
}

/**
 * Stream one chat completion. Calls `onContent` for each answer delta,
 * `onReasoning` for each chain-of-thought delta, and returns any accumulated
 * tool calls once the stream ends.
 *
 * Reasoning arrives one of two ways depending on the model and the LM Studio
 * build: out-of-band in `delta.reasoning_content`, or inline in the content
 * stream wrapped in `<think>` tags. Both are handled — the inline case through
 * the splitter in lib/reasoning.ts, which is where the chunk-boundary and
 * false-positive edge cases live.
 */
export async function streamChat(
  baseUrl: string,
  modelId: string,
  messages: ApiMessage[],
  tools: ToolSchema[],
  signal: AbortSignal,
  onContent: (chunk: string) => void,
  onReasoning?: (chunk: string) => void,
  sampling?: SamplingSettings,
  /**
   * v1.4 response cache. Opt-in per call site and never on by default: the
   * critic, claim-check, consultation and plan-step passes all route through
   * here, and serving any of them a cached verdict would mean re-verifying
   * nothing while still reporting that the check ran.
   */
  cacheable = false
): Promise<{
  toolCalls: ApiToolCall[]
  usage: ApiUsage | null
  ttftMs: number | null
  /** The reply hit max_tokens; it stops mid-thought. */
  truncated: boolean
}> {
  const startedAt = Date.now()

  // Tool rounds are never cached in either direction: tool output is
  // time-varying, so replaying one could restate stale figures as current.
  const useCache = cacheable && tools.length === 0
  if (useCache) {
    const cached = getFromCache(messages, modelId)
    if (cached.hit) {
      if (cached.reasoning) onReasoning?.(cached.reasoning)
      onContent(cached.response)
      // usage/ttft stay null: nothing was generated, and recordStats already
      // null-guards both. Reporting a fabricated token count here would put
      // invented telemetry into the trace and SFT exports.
      return { toolCalls: [], usage: null, ttftMs: null, truncated: false }
    }
  }

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: true,
      // Ask for token counts. Servers that do not know the option ignore it,
      // and the stats readout falls back to timing alone.
      stream_options: { include_usage: true },
      ...(sampling ? wireSampling(sampling, modelId) : {}),
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
    }),
    signal
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LM Studio returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  if (!res.body) throw new Error('LM Studio returned an empty response body.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pending = new Map<number, ApiToolCall>()
  const splitter = createReasoningSplitter()
  // Gemma 4's native tool-call markup arrives inside the content stream on
  // servers without a gemma4 parser (LM Studio today). The extractor strips
  // it from the visible answer and returns the calls in OpenAI shape, so they
  // execute through the same loop as real tool_calls.
  const nativeTools = createNativeToolExtractor(tools.map((t) => t.function.name))
  const nativeCalls: NativeToolCall[] = []
  let usage: ApiUsage | null = null
  let ttftMs: number | null = null
  /**
   * v1.4.6: did the reply stop because it ran out of budget?
   *
   * `finish_reason` was parsed nowhere, so a reply cut off at max_tokens
   * looked exactly like a finished one — the user got a sentence that simply
   * stopped, with nothing saying why. That has to be visible before a length
   * cap is a reasonable thing to recommend to anyone.
   */
  let truncated = false

  // What the caller actually saw, accumulated for the cache. Captured after the
  // native-tool extractor so a replay reproduces the visible answer, not the raw
  // stream with its markup still in it.
  let cachedAnswer = ''
  let cachedReasoning = ''

  const emitText = (text: string): void => {
    if (!text) return
    const out = nativeTools.push(text)
    if (out.text) {
      onContent(out.text)
      cachedAnswer += out.text
    }
    nativeCalls.push(...out.calls)
  }

  const emit = (delta: { answer: string; reasoning: string }): void => {
    if ((delta.answer || delta.reasoning) && ttftMs === null) ttftMs = Date.now() - startedAt
    emitText(delta.answer)
    if (delta.reasoning) {
      onReasoning?.(delta.reasoning)
      cachedReasoning += delta.reasoning
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE events are separated by blank lines.
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const event of events) {
      const line = event.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: {
            content?: string
            /** LM Studio's out-of-band reasoning channel; needs no parsing. */
            reasoning_content?: string
            tool_calls?: {
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }[]
          }
          /** 'length' means the reply hit max_tokens and stops mid-thought. */
          finish_reason?: string | null }[]
          usage?: ApiUsage
        }
        // The usage block rides a final chunk whose `choices` is empty.
        if (json.usage) usage = json.usage
        if (json.choices?.[0]?.finish_reason === 'length') truncated = true
        const delta = json.choices?.[0]?.delta
        if (delta?.reasoning_content) emit({ answer: '', reasoning: delta.reasoning_content })
        if (delta?.content) emit(splitter.push(delta.content))
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0
          const existing = pending.get(idx) ?? {
            id: tc.id ?? `call_${uid()}`,
            type: 'function' as const,
            function: { name: '', arguments: '' }
          }
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.function.name += tc.function.name
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          pending.set(idx, existing)
        }
      } catch {
        // Partial JSON chunk — the next SSE event completes it.
      }
    }
  }

  // A stream that ended mid-`<think>` (max_tokens, abort) still has text held
  // back by the splitter — surface it as reasoning rather than losing it.
  emit(splitter.flush())
  const tail = nativeTools.flush()
  if (tail.text) {
    onContent(tail.text)
    cachedAnswer += tail.text
  }
  nativeCalls.push(...tail.calls)

  const toolCalls = [...pending.values()]
  for (const call of nativeCalls) {
    toolCalls.push({
      id: `call_native_${uid()}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments }
    })
  }

  // Only a clean text round is cacheable. A round that ended in tool calls is
  // the model asking for live data, and an aborted round is a partial answer —
  // storing either would serve back something that was never a finished reply.
  if (useCache && toolCalls.length === 0 && !signal.aborted && cachedAnswer) {
    setInCache(messages, modelId, cachedAnswer, cachedReasoning)
  }

  return { toolCalls, usage, ttftMs, truncated }
}
