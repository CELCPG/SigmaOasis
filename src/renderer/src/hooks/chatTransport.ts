import { useAppStore } from '../stores/appStore'
import { createReasoningSplitter } from '../lib/reasoning'
import { createNativeToolExtractor, type NativeToolCall } from '../lib/nativeToolCall'
import { getFromCache, setInCache } from '../lib/responseCache'
import { resolveSampling } from '../lib/sampling'
import type { ApiMessage, ApiToolCall, ApiUsage } from '../lib/agentLoop'
import type { ChatMessage, SamplingSettings, ToolSchema } from '../types'
import { ExplainedError, explainFailure } from '../../../shared/failure'
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
 * Cap on how often streamed text is published to the UI (~30 fps). Tokens can
 * arrive far faster than the screen repaints; publishing each one bought
 * nothing visually and cost a store commit — and a markdown re-parse of the
 * live tail — per token.
 */
export const TAIL_FLUSH_MS = 33

/**
 * How far (in characters) the paced display cursor may trail the buffered
 * content before it stops gliding and jumps the backlog. Keeps a huge burst —
 * a cache hit, a reconnect — from turning into seconds of typewriter replay.
 */
const CATCH_UP_SNAP_CHARS = 1200

/**
 * Frames stop entirely in an occluded window. When the last frame is this
 * stale, the pacer assumes occlusion and flushes whole chunks from the network
 * callback instead — the pre-v2.1 behavior, which is the one that keeps
 * working behind another window.
 */
const OCCLUDED_AFTER_MS = 250

/**
 * How long the request may produce nothing at all — headers, then the first
 * byte. Prompt processing is legitimately silent and legitimately long (a
 * 30k-token conversation is most of a minute of it on a 9B), so this is a
 * ceiling shaped like the one in main/ipc/llm.ts, not a tight one.
 */
export const FIRST_BYTE_TIMEOUT_MS = 300_000

/**
 * How long a live stream may go quiet between chunks. Same number and same
 * reasoning as STREAM_STALL_MS in main/ipc/llm.ts: what is being timed is a
 * socket's rhythm, not a token's.
 */
export const STREAM_STALL_MS = 60_000

const NO_ANSWER = `LM Studio accepted the request and then sent nothing for ${FIRST_BYTE_TIMEOUT_MS / 1000}s. The server is not answering — check that the model is still loaded in LM Studio, then try again.`
const STALLED = `The reply stalled — nothing received for ${STREAM_STALL_MS / 1000}s. LM Studio stopped sending mid-answer; whatever arrived before that is above.`

/**
 * A deadline for a stream that has none of its own.
 *
 * The renderer reaches LM Studio through `fetch`, which takes a signal and
 * nothing else — no timeoutMs, no stall detection, unlike auditedFetch on
 * every main-process path. A server that accepted the POST and then wrote
 * nothing therefore held the turn open for as long as the user was willing to
 * watch it.
 *
 * The caller's signal is chained in, so Stop still stops. `expired()`
 * separates the two afterwards: a user abort unwinds quietly, a watchdog abort
 * is a failure that has to name itself.
 */
export function armWatchdog(outer: AbortSignal): {
  signal: AbortSignal
  /** Restart the clock. Called before the request, then on every chunk. */
  touch: (ms: number, message: string) => void
  /** The watchdog's error, if the watchdog is what stopped the stream. */
  expired: () => Error | null
  stop: () => void
} {
  const inner = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let expired: Error | null = null
  const onOuterAbort = (): void => inner.abort()
  if (outer.aborted) inner.abort()
  else outer.addEventListener('abort', onOuterAbort)
  return {
    signal: inner.signal,
    touch(ms, message): void {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        expired = new Error(message)
        inner.abort()
      }, ms)
    },
    expired: () => expired,
    stop(): void {
      if (timer) clearTimeout(timer)
      timer = null
      outer.removeEventListener('abort', onOuterAbort)
    }
  }
}

/**
 * One SSE frame from /chat/completions.
 *
 * v1.6: LM Studio can answer 200 and then put the failure in the stream —
 * measured, a request over the loaded context length streams one
 * `{"error": {...}}` frame and ends, which through v1.5 rendered as an empty
 * reply with no explanation.
 */
interface SseFrame {
  choices?: {
    delta?: {
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
    finish_reason?: string | null
  }[]
  usage?: ApiUsage
  error?: { message?: string; type?: string; code?: number } | string
}

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
 * v2.1: publishes are paced, not raw. Chunks arrive in bursts — a slab of
 * text, a silence, another slab — and publishing each burst whole made the
 * reply load in visible jolts. A display cursor now glides toward the
 * buffered content a few characters per animation frame, faster the further
 * behind it is, so it smooths a burst over roughly a quarter second without
 * ever trailing the stream by more than CATCH_UP_SNAP_CHARS.
 *
 * The occlusion rule survives the redesign, because rAF stops in an occluded
 * window exactly like timers do (measured here as a stream coalescing into
 * one-per-minute jumps behind another window), while network callbacks keep
 * firing. When frames go stale the pacer degrades to the old chunk-driven
 * flush, throttled by TAIL_FLUSH_MS; each snap also re-arms a frame request,
 * so pacing resumes by itself once the window is visible again.
 * Reduced-motion users get the un-paced flush always.
 */
export function makeTailStream(
  assistantMsg: ChatMessage,
  patch: (p: Partial<ChatMessage>) => void
): { schedule: () => void; commit: () => void; finish: () => void } {
  let shown = 0
  let lastPublish = 0
  let lastFrame = Date.now()
  let raf = 0
  let ended = false
  let backstop: ReturnType<typeof setTimeout> | null = null
  const reduceMotion =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

  const publish = (): void =>
    useAppStore.getState().setStreamingTail({
      messageId: assistantMsg.id,
      text:
        shown >= assistantMsg.content.length
          ? assistantMsg.content
          : assistantMsg.content.slice(0, shown)
    })

  /** A newer message's stream owns the slice now; this one must go quiet. */
  const usurped = (): boolean => {
    const tail = useAppStore.getState().streamingTail
    return tail !== null && tail.messageId !== assistantMsg.id
  }

  const clear = (): void => {
    if (backstop) {
      clearTimeout(backstop)
      backstop = null
    }
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    if (!usurped()) useAppStore.getState().setStreamingTail(null)
  }

  const step = (): void => {
    raf = 0
    const now = Date.now()
    lastFrame = now
    if (usurped()) return
    const total = assistantMsg.content.length
    if (shown < total && now - lastPublish >= TAIL_FLUSH_MS) {
      const remaining = total - shown
      shown +=
        remaining > CATCH_UP_SNAP_CHARS
          ? remaining - CATCH_UP_SNAP_CHARS
          : Math.max(2, Math.ceil(remaining / 8))
      if (shown > total) shown = total
      // Never end the slice on a high surrogate — half an emoji renders as �.
      if (shown < total) {
        const edge = assistantMsg.content.charCodeAt(shown - 1)
        if (edge >= 0xd800 && edge <= 0xdbff) shown += 1
      }
      lastPublish = now
      publish()
    }
    if (ended && shown >= assistantMsg.content.length) {
      clear()
      return
    }
    // Keep ticking even when caught up: an idle-but-visible pane must keep
    // lastFrame fresh, or the next chunk after a model pause would be
    // misdiagnosed as occlusion and snapped.
    raf = requestAnimationFrame(step)
  }

  /** Flush everything at once — the occluded / reduced-motion / backstop path. */
  const snap = (): void => {
    shown = assistantMsg.content.length
    lastPublish = Date.now()
    if (!usurped()) publish()
    if (ended) clear()
    // Re-arm pacing: if this frame request ever fires, the window is visible
    // again and the glide takes over; if it never does, it costs nothing.
    else if (!raf) raf = requestAnimationFrame(step)
  }

  const paced = (): boolean => !reduceMotion && Date.now() - lastFrame <= OCCLUDED_AFTER_MS

  return {
    schedule(): void {
      if (paced()) {
        if (!raf) raf = requestAnimationFrame(step)
      } else if (Date.now() - lastPublish >= TAIL_FLUSH_MS) {
        snap()
      }
    },
    commit(): void {
      patch({ content: assistantMsg.content })
      if (paced()) {
        if (!raf) raf = requestAnimationFrame(step)
      } else {
        snap()
      }
    },
    finish(): void {
      patch({ content: assistantMsg.content })
      ended = true
      if (paced()) {
        if (!raf) raf = requestAnimationFrame(step)
        // If the window is occluded mid-drain, frames stop and the partial
        // tail would sit on screen indefinitely; a timer still fires, even
        // throttled, and clears it.
        backstop = setTimeout(snap, 1500)
      } else {
        snap()
      }
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

  // Armed before the request, reset by every chunk: one watchdog covers a POST
  // that is never answered and a stream that dies mid-answer.
  const watchdog = armWatchdog(signal)
  watchdog.touch(FIRST_BYTE_TIMEOUT_MS, NO_ANSWER)
  try {
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
      signal: watchdog.signal
    }).catch((err) => {
      // A watchdog abort looks exactly like a user abort from here; only the
      // watchdog knows which it was, and only it has something to say.
      throw watchdog.expired() ?? err
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
      const { done, value } = await reader.read().catch((err) => {
        throw watchdog.expired() ?? err
      })
      if (done) break
      watchdog.touch(STREAM_STALL_MS, STALLED)
      buffer += decoder.decode(value, { stream: true })

      // SSE events are separated by blank lines.
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        const line = event.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let json: SseFrame
        try {
          json = JSON.parse(payload) as SseFrame
        } catch {
          // Partial JSON chunk — the next SSE event completes it.
          continue
        }
        // Everything below is outside that catch, deliberately: through v1.12.1
        // the error-frame diagnosis was thrown from inside it and swallowed as
        // a partial chunk, so the one failure v1.6 built it for — a request
        // over the loaded context — still ended as an empty bubble.
        if (json.error) {
          const message = typeof json.error === 'string' ? json.error : json.error.message ?? JSON.stringify(json.error)
          // v1.17.2: whose words are these? The frame is LM Studio's, so the
          // app names LM Studio as the author and leads with its own reading.
          //
          // Measured, verbatim: `⚠️ Trying to keep the first 12000 tokens when
          // context the overflows.` — LM Studio's clause, garbled word order
          // and all, relayed as if the app had written it, with our diagnosis
          // trailing behind as an afterthought. Their text is evidence and is
          // never dropped; it is simply quoted rather than ventriloquised.
          throw new ExplainedError(
            explainFailure(message, { subject: 'The request', source: 'LM Studio' })
          )
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
  } finally {
    watchdog.stop()
  }
}
