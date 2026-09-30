import { cachedTokens, createSseFrameReader, parseChatFrame, type ChatFrame } from '../../shared/sse'
import type { ChunkTransport } from './types'

/**
 * v4.1 (M3): what one round cost in time, read off the wire.
 *
 * A1 and A3 claim prefill wins and nothing recorded prefill, so every round
 * the eval sends is timed here, at the transport: the engine is not touched
 * and cannot disagree with what was measured. The wrapper reads the same SSE
 * frames the engine reads (src/shared/sse.ts) — a second, passive reader of
 * the bytes, never a filter on them.
 *
 * - TTFT: request sent to the first content, reasoning or tool-call byte.
 *   Reasoning counts: it is the model producing tokens, so prefill is over.
 * - prefill: the server's own figure when it reports one (llama.cpp's
 *   `timings.prompt_ms`); LM Studio's OpenAI endpoint reports none, so TTFT
 *   stands in for it, and the record says which it is.
 * - decode tok/s: completion tokens after the first, over the time from the
 *   first token to the last. Needs the usage frame; absent without one.
 * - cached tokens: `usage.prompt_tokens_details.cached_tokens`, when the
 *   server reports it. Absent, never zero, when it does not.
 */

export interface RoundLatency {
  /** The request went out, the stream ended with a 2xx. A failed round is kept, marked, and left out of the summaries. */
  ok: boolean
  ttftMs: number | null
  prefillMs: number | null
  prefillFrom: 'server' | 'ttft'
  promptTokens?: number
  cachedTokens?: number
  completionTokens?: number
  decodeTokPerSec?: number
  /** Request to the end of the body. */
  totalMs: number
}

/** llama.cpp's server appends this to its last frame; LM Studio's OpenAI endpoint does not. */
interface TimedFrame extends ChatFrame {
  timings?: { prompt_ms?: number }
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Wrap a transport so every request it carries reports a `RoundLatency`.
 * `now` is injectable so the tests can drive the clock.
 */
export function timedTransport(inner: ChunkTransport, onRound: (r: RoundLatency) => void, now: () => number = () => performance.now()): ChunkTransport {
  return async (url, init) => {
    const started = now()
    const frames = createSseFrameReader()
    const decoder = new TextDecoder()
    let first: number | null = null
    let last: number | null = null
    let usage: ChatFrame['usage'] | undefined
    let serverPrefill: number | undefined
    const read = (payload: string, at: number): void => {
      const f = parseChatFrame(payload) as TimedFrame | null
      if (!f) return
      if (f.usage) usage = f.usage
      if (typeof f.timings?.prompt_ms === 'number') serverPrefill = f.timings.prompt_ms
      const c = f.choices?.[0]
      const produced = Boolean(c?.delta?.content || c?.delta?.reasoning_content || c?.delta?.tool_calls?.length || c?.message?.content || c?.message?.reasoning_content)
      if (!produced) return
      if (first === null) first = at
      last = at
    }
    const report = (ok: boolean): void => {
      const end = now()
      const ttftMs = first === null ? null : round1(first - started)
      const completionTokens = usage?.completion_tokens
      const span = first !== null && last !== null ? last - first : 0
      const decodeTokPerSec = completionTokens !== undefined && completionTokens > 1 && span > 0 ? round1((completionTokens - 1) / (span / 1000)) : undefined
      const cached = cachedTokens(usage)
      onRound({
        ok,
        ttftMs,
        prefillMs: serverPrefill !== undefined ? round1(serverPrefill) : ttftMs,
        prefillFrom: serverPrefill !== undefined ? 'server' : 'ttft',
        ...(usage?.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
        ...(cached !== undefined ? { cachedTokens: cached } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(decodeTokPerSec !== undefined ? { decodeTokPerSec } : {}),
        totalMs: round1(end - started)
      })
    }
    try {
      const res = await inner(url, {
        ...init,
        onChunk: (chunk) => {
          const at = now()
          for (const p of frames.push(decoder.decode(chunk, { stream: true }))) read(p, at)
          init.onChunk(chunk)
        }
      })
      for (const p of frames.flush()) read(p, now())
      report(res.ok)
      return res
    } catch (err) {
      report(false)
      throw err
    }
  }
}

export interface LatencySummary {
  /** Rounds that completed; failed ones are not timed. */
  rounds: number
  ttftMedianMs: number | null
  ttftMaxMs: number | null
  prefillMedianMs: number | null
  prefillMaxMs: number | null
  prefillFrom: 'server' | 'ttft'
  decodeTokPerSecMedian: number | null
  promptTokensMax: number | null
  /** Cached over prompt tokens, across the rounds that reported a cache figure; null when none did. */
  cachedShare: number | null
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const nums = (xs: readonly (number | null | undefined)[]): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))

/** Median and max over the rounds that completed; null when none did. */
export function summarizeLatency(rounds: readonly RoundLatency[]): LatencySummary | null {
  const ok = rounds.filter((r) => r.ok)
  if (ok.length === 0) return null
  const ttft = nums(ok.map((r) => r.ttftMs))
  const prefill = nums(ok.map((r) => r.prefillMs))
  const decode = nums(ok.map((r) => r.decodeTokPerSec))
  const prompt = nums(ok.map((r) => r.promptTokens))
  const withCache = ok.filter((r) => r.cachedTokens !== undefined && r.promptTokens !== undefined && r.promptTokens > 0)
  const cachedSum = withCache.reduce((n, r) => n + r.cachedTokens!, 0)
  const promptSum = withCache.reduce((n, r) => n + r.promptTokens!, 0)
  return {
    rounds: ok.length,
    ttftMedianMs: ttft.length ? round1(median(ttft)) : null,
    ttftMaxMs: ttft.length ? Math.max(...ttft) : null,
    prefillMedianMs: prefill.length ? round1(median(prefill)) : null,
    prefillMaxMs: prefill.length ? Math.max(...prefill) : null,
    prefillFrom: ok.some((r) => r.prefillFrom === 'server') ? 'server' : 'ttft',
    decodeTokPerSecMedian: decode.length ? round1(median(decode)) : null,
    promptTokensMax: prompt.length ? Math.max(...prompt) : null,
    cachedShare: withCache.length ? Math.round((cachedSum / promptSum) * 1000) / 1000 : null
  }
}

/** "1.2 s" / "840 ms"; an em dash for nothing measured. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}
