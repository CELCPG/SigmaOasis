import { useAppStore } from '../stores/appStore'
import { createSseFrameReader, createToolCallAssembler, frameError, frameText, parseChatFrame } from '../../../shared/sse'
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
 * How long the tail may still be painting after the stream has ended.
 *
 * While tokens are arriving the glide above is time-free: it eats a fraction of
 * the backlog per frame, and the stream keeps refilling it. Once the stream
 * ends there is nothing left to smooth against, and that same fraction turns
 * into an open-ended typewriter — a 65-character backlog took ~560 ms to
 * finish, which is how a reply reached a screenshot reading
 * `…household's unique needs (pet` against a model that wrote `(pets, seniors,
 * infants).`
 *
 * So the drain gets a deadline instead of a rate: each frame moves the share of
 * what is left that the elapsed time is of the time remaining, which lands the
 * last character on the deadline whether five characters are outstanding or
 * twelve hundred. 0.4s is the length of the .stream-edge fade, so the final
 * word gets exactly one of them.
 */
export const TAIL_DRAIN_MS = 400

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

/**
 * v1.17.4: one silence was two events, and the suite pinned the wrong one.
 *
 * Through v1.17.3 a single constant covered the whole first-byte ceiling —
 * `LM Studio accepted the request and then sent nothing for 300s.` — and
 * test/llmTimeouts.test.ts asserted it against a `fetch` that never resolves:
 * a request whose response headers never arrived, i.e. one LM Studio had NOT
 * accepted. The test's own name says so ("a POST that is never answered")
 * while the sentence it pinned says the opposite.
 *
 * That is round 9's defect living inside the module built to end it — the app
 * stating as its own finding something it had not established — and the fact
 * that settles it was already being recorded three lines away. `accepted` is
 * read when the timer FIRES rather than when it is armed, because `accepted`
 * is precisely the thing that may change in between.
 */
const NEVER_ANSWERED = `LM Studio never answered the request — no reply headers came back for ${FIRST_BYTE_TIMEOUT_MS / 1000}s. Check that LM Studio is running with its server started, then try again.`
const ACCEPTED_THEN_SILENT = `LM Studio accepted the request and then sent nothing for ${FIRST_BYTE_TIMEOUT_MS / 1000}s. The server took the request, so the address is right — check that the model is still loaded in LM Studio, then try again.`
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
  /**
   * Restart the clock. Called before the request, then on every chunk.
   *
   * `message` may be a thunk, and the first-byte ceiling passes one: which of
   * the two silences this is depends on whether response headers arrived,
   * which is unknown when the timer is armed and settled by the time it fires.
   * A string that had to be chosen up front could only ever name one of them.
   */
  touch: (ms: number, message: string | (() => string)) => void
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
        expired = new Error(typeof message === 'function' ? message() : message)
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
 * What the transport saw, for a caller that has to say who fell silent.
 *
 * v1.17.3. On a server that accepted the POST and then wrote nothing for 90
 * seconds until the user pressed Stop, the bubble read `⚠️ Empty reply —
 * nothing came back from the model.` Every fact needed to name the right party
 * passed through this function and was discarded at the return statement — and
 * on the measured case the function did not even reach its return, because a
 * user abort leaves by the throw.
 *
 * So the record is a mutable object the CALLER owns and this function fills in.
 * A return value cannot carry it out of an abort; this can, and the caller
 * still has it in the `finally` that ends the turn.
 *
 * `accepted`, `streamed` and `completed` are the discriminating facts, and they
 * are one layer apart each: a response arriving says the server is there and
 * took the request, a body byte arriving says a reply had begun, and the body
 * reaching its end says the reply finished of its own accord.
 *
 * ## v1.17.5: `completed`, because "ran to its end" was never recorded
 *
 * Round 10 read `streamed && !produced` as *the reply ran to its end and was
 * simply empty*. `streamed` says no such thing — it says one byte arrived. On
 * the recorded context-overflow turn a byte did arrive, it was an
 * `{"error": …}` frame, the transport threw on it, and the screen carried both
 * sentences at once: `the reply ran to its end — it was simply empty`, two
 * lines above the refusal it had thrown. Both blind critics counted it, in both
 * arms.
 *
 * The fact that settles it is the one the loop already had and discarded:
 * whether the reader ever reported end-of-stream. It is recorded here, at the
 * same layer as the other two, so the reading stays in shared/failure.ts.
 */
export interface StreamWitness {
  /**
   * `fetch` returned a Response — LM Studio answered.
   *
   * v1.17.5: this is deliberately weaker than *response headers arrived*, which
   * is what it claimed to be for two versions. What is recorded is that OUR
   * `fetch` call resolved. Measured, against a real server on both counts: a
   * `103 Early Hints` block and a `302` block each put a complete reply header
   * block on the wire without resolving `fetch`, because a 1xx is not a
   * response and a redirect is followed internally. So `!accepted` cannot be
   * read as "no headers came back" — only as "nothing the app can read has".
   */
  accepted: boolean
  /** At least one byte of the response body arrived. */
  streamed: boolean
  /**
   * The response body reached its end — the reader reported done.
   *
   * The difference between a reply that finished and a reply that was cut off
   * by a throw, which is what the two sentences above conflated. False also
   * before the body starts, so it separates an empty 200 that closed cleanly
   * from a non-2xx that never had a body to read.
   */
  completed: boolean
  /**
   * The same two facts about the request that is open RIGHT NOW — v1.17.4.
   *
   * The pair above is turn-scoped and answers a question asked once, at the
   * end: who fell silent on the turn as a whole. The reader staring at a
   * motionless disc is asking a different question — *what is happening to the
   * request I am waiting on* — and a tool loop makes the two disagree. Round
   * two of a loop arms the first-byte ceiling afresh, so `streamed` being true
   * of round one says nothing about the silence the reader is in now.
   *
   * MessageBubble used to guess this from the message instead (`reasoning !==
   * '' || toolCalls.length > 0`), and that guess is wrong in exactly the case
   * it matters: after any tool call it declared the stream started for the
   * rest of the turn, so the wait line promised `gives up at 1:00` while the
   * transport was in fact five minutes into a fresh first-byte ceiling.
   */
  round: StreamPhase
  /** When the last byte arrived — or, before any did, when the request went out. */
  lastActivityAt: number
  /**
   * Called when `round` changes — at the request, at the headers, at the first
   * body byte. How the screen learns what the transport has seen while it is
   * still seeing it, rather than only in the post-mortem.
   */
  onChange?: () => void
}

/**
 * What is known about the request in flight — as much of the witness as a
 * reader waiting on it needs. `completed` is not here on purpose: a round that
 * has ended is not a round anyone is still waiting on.
 */
export interface StreamPhase {
  /** `fetch` returned a Response — LM Studio answered. See StreamWitness. */
  accepted: boolean
  /** At least one byte of the response body arrived. */
  streamed: boolean
}

export function newWitness(): StreamWitness {
  return {
    accepted: false,
    streamed: false,
    completed: false,
    round: { accepted: false, streamed: false },
    lastActivityAt: Date.now()
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
 *
 * v2.2: `finish()` is awaitable, and awaiting it is what makes "the turn is
 * over" true. v2.1 shipped it as a fire-and-forget — it set `ended` and
 * returned, leaving up to CATCH_UP_SNAP_CHARS still to paint while the caller
 * went on to clear `streaming`, release the composer and turn Stop back into
 * Send. The turn reported itself finished while the answer was still arriving,
 * on both recorded arms: a `stream-edge` span was still on screen 263 ms after
 * the harness stamped turn-end, with the message 65 characters short.
 *
 * `finish(immediate)` is the answer to "what should Stop mean while the tail is
 * still painting": with `immediate` the remaining text lands in one publish and
 * the promise resolves now, because a user who pressed Stop asked for the turn
 * to be over, not to watch the rest of it type itself out. Without it the glide
 * finishes on the TAIL_DRAIN_MS deadline and the promise resolves on the last
 * publish. Either way it resolves exactly once, including when a newer
 * message's stream has usurped the slice and when the window is occluded and
 * the backstop is the only thing still running.
 */
export function makeTailStream(
  assistantMsg: ChatMessage,
  patch: (p: Partial<ChatMessage>) => void
): {
  schedule: () => void
  commit: () => void
  /** Resolves when the last character has been published — see above. */
  finish: (immediate?: boolean) => Promise<void>
} {
  let shown = 0
  let lastPublish = 0
  let lastFrame = Date.now()
  let raf = 0
  let ended = false
  /** Wall-clock instant the drain must be complete by; set in finish(). */
  let drainBy = 0
  let backstop: ReturnType<typeof setTimeout> | null = null
  let settle: (() => void) | null = null
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  /** Idempotent: every path out of the drain calls it, and only the first counts. */
  const done = (): void => {
    const resolve = settle
    settle = null
    resolve?.()
  }
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
    done()
  }

  /**
   * Characters to advance this frame. While the stream is live that is a
   * fraction of the backlog — the smoothing the pacer exists for. Once it has
   * ended it is whatever lands the last character on `drainBy`, so the turn's
   * text is complete within TAIL_DRAIN_MS of the stream stopping no matter how
   * big the backlog was.
   */
  const advance = (remaining: number, now: number): number => {
    if (ended) {
      // Publishes are TAIL_FLUSH_MS apart, so this many are left before the
      // deadline; spread the backlog evenly over them. Derived from the clock
      // rather than from the gap since the last publish, which goes stale
      // whenever the pacer was caught up when the last chunk arrived — and a
      // stale gap would hand the whole tail to one frame, which is the pop.
      const left = drainBy - now
      if (left <= TAIL_FLUSH_MS) return remaining
      return Math.max(2, Math.ceil((remaining * TAIL_FLUSH_MS) / left))
    }
    return remaining > CATCH_UP_SNAP_CHARS
      ? remaining - CATCH_UP_SNAP_CHARS
      : Math.max(2, Math.ceil(remaining / 8))
  }

  const step = (): void => {
    raf = 0
    const now = Date.now()
    lastFrame = now
    // A newer message owns the slice; this drain will never publish again, so
    // the turn waiting on it must not wait forever.
    if (usurped()) {
      done()
      return
    }
    const total = assistantMsg.content.length
    if (shown < total && now - lastPublish >= TAIL_FLUSH_MS) {
      const remaining = total - shown
      shown += advance(remaining, now)
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

  /** Flush everything at once — the occluded / reduced-motion / Stop / backstop path. */
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
    finish(immediate = false): Promise<void> {
      patch({ content: assistantMsg.content })
      ended = true
      drainBy = Date.now() + TAIL_DRAIN_MS
      if (paced() && !immediate) {
        if (!raf) raf = requestAnimationFrame(step)
        // If the window is occluded mid-drain, frames stop and the partial
        // tail would sit on screen indefinitely; a timer still fires, even
        // throttled, and clears it. It is also the only thing that resolves
        // `settled` on that path, so the caller cannot be stranded either.
        backstop = setTimeout(snap, 1500)
      } else {
        snap()
      }
      return settled
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
  cacheable = false,
  /** Filled in as the stream progresses; survives an abort, unlike the return. */
  witness: StreamWitness = newWitness()
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
  watchdog.touch(FIRST_BYTE_TIMEOUT_MS, () =>
    witness.round.accepted ? ACCEPTED_THEN_SILENT : NEVER_ANSWERED
  )
  witness.lastActivityAt = Date.now()
  // A fresh request: whatever a previous round of this turn saw is not what
  // this one has seen. Published immediately, so the screen's account of the
  // silence starts when the silence does.
  witness.round = { accepted: false, streamed: false }
  // Unlike `accepted` and `streamed`, this one does not accumulate over a turn.
  // Those two answer "did this turn ever get that far"; this answers "did the
  // round that ended the turn end by itself", and round one having finished
  // cleanly says nothing about the round that threw.
  witness.completed = false
  witness.onChange?.()
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

    // Headers are here: the server exists, is listening, and took the request.
    // Everything after this point that goes wrong is the server's or the
    // model's, and the difference between those two is `streamed` below.
    witness.accepted = true
    witness.round = { ...witness.round, accepted: true }
    witness.onChange?.()

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LM Studio returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    if (!res.body) throw new Error('LM Studio returned an empty response body.')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    // v2.4: frames come from the shared core (src/shared/sse.ts), the same
    // parser the main process reads with. The contract lives there.
    const frames = createSseFrameReader()
    const assembler = createToolCallAssembler(() => `call_${uid()}`)
    let finishReason: string | null = null
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
      if (done) {
        // The one place a reply is known to have finished rather than been cut
        // off. Every other way out of this loop is a throw.
        witness.completed = true
        break
      }
      watchdog.touch(STREAM_STALL_MS, STALLED)
      witness.streamed = true
      // Published once, on the transition: this runs per chunk, and a store
      // commit per chunk is the cost the streaming tail exists to avoid.
      if (!witness.round.streamed) {
        witness.round = { ...witness.round, streamed: true }
        witness.onChange?.()
      }
      witness.lastActivityAt = Date.now()
      const handleFrame = (payload: string): void => {
        const json = parseChatFrame(payload)
        // A payload that is not JSON is skipped. Everything below is outside
        // that decision, deliberately: through v1.12.1 the error-frame
        // diagnosis was thrown from inside a JSON catch and swallowed as a
        // partial chunk, so the one failure v1.6 built it for — a request
        // over the loaded context — still ended as an empty bubble.
        if (!json) return
        const error = frameError(json)
        if (error !== null) {
          // v1.17.2: whose words are these? The frame is LM Studio's, so the
          // app names LM Studio as the author and leads with its own reading.
          //
          // Measured, verbatim: `⚠️ Trying to keep the first 12000 tokens when
          // context the overflows.` — LM Studio's clause, garbled word order
          // and all, relayed as if the app had written it, with our diagnosis
          // trailing behind as an afterthought. Their text is evidence and is
          // never dropped; it is simply quoted rather than ventriloquised.
          //
          // v1.17.3: the ingredients travel too. The turn that catches this
          // knows what the request costs by the app's own arithmetic; the
          // transport, one layer down, does not — and the refusal that most
          // needs that number is exactly this one.
          const frame = { subject: 'The request', source: 'LM Studio' }
          throw new ExplainedError(explainFailure(error, frame), { raw: error, context: frame })
        }
        // The usage block rides a final chunk whose `choices` is empty.
        if (json.usage) usage = json.usage
        const choice = json.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (choice?.finish_reason === 'length') truncated = true
        const text = frameText(json)
        if (text.reasoning) emit({ answer: '', reasoning: text.reasoning })
        if (text.content) emit(splitter.push(text.content))
        assembler.push(choice?.delta?.tool_calls)
      }

      for (const payload of frames.push(decoder.decode(value, { stream: true }))) handleFrame(payload)
    }
    for (const payload of frames.flush()) {
      // A final frame with no trailing newline — read it the same way.
      const json = parseChatFrame(payload)
      if (!json) continue
      if (json.usage) usage = json.usage
      const text = frameText(json)
      if (text.reasoning) emit({ answer: '', reasoning: text.reasoning })
      if (text.content) emit(splitter.push(text.content))
      assembler.push(json.choices?.[0]?.delta?.tool_calls)
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

    // A reply cut off at its token budget drops the calls it was still writing
    // (the core's contract): running a call whose JSON the model never finished
    // is worse than running none, and `truncated` already says what happened.
    const { calls: assembled, droppedAsTruncated } = assembler.finish(finishReason)
    const toolCalls: ApiToolCall[] = [...assembled]
    if (droppedAsTruncated > 0) truncated = true
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
