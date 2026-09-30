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

// ---- Before the first reply: does it fit the card? (v4.0, E1) ---------------

/** Bytes per weight for a GGUF quantization name, near enough to say fits or does not. */
export function bytesPerWeight(quantization: string | undefined): number {
  const q = (quantization ?? '').toUpperCase()
  if (/F32/.test(q)) return 4
  if (/F16|BF16/.test(q)) return 2
  const m = /Q(\d)/.exec(q) ?? /IQ(\d)/.exec(q)
  if (!m) return 0.6 // unknown: a mid quant, so the verdict errs towards "tight"
  const bits = Number(m[1])
  return { 1: 0.22, 2: 0.36, 3: 0.48, 4: 0.6, 5: 0.72, 6: 0.85, 8: 1.07 }[bits] ?? 0.6
}

/** Billions of parameters, read from the model id: "9b", "27b", "35b-a3b" (the total, not the active). */
export function paramsFromId(id: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i.exec(id.replace(/-a\d+b/i, ''))
  return m ? Number(m[1]) : null
}

export interface FitVerdict {
  kind: 'fits' | 'tight' | 'no'
  /** What the estimate was, for the sentence. */
  weightsGb: number
  cacheGb: number
  gpuGb: number
  /** A context window that would fit, when the loaded one does not; null when the weights alone do not fit. */
  windowThatFits: number | null
  /** v4.2 (S8): the draft model's weights and cache, already inside the two figures above; absent without one. */
  draftGb?: number
}

/**
 * A rough estimate, stated as one: the weights at the quant's bytes per
 * weight, plus the KV cache at about 0.05 GB per thousand tokens per ten
 * billion parameters. It errs towards "tight" on purpose — the bench's own
 * slow replies (test/modelFit.test.ts) are the fixture it must call right.
 */
export function fitVerdict(
  model: { id: string; quantization?: string; loadedContextLength?: number; maxContextLength?: number },
  gpuBytes: number,
  /**
   * v4.2 (S8): a draft model loaded beside it. Its weights sit on the same
   * card and it keeps its own cache at the same window, so both are added; a
   * draft whose size the id does not say is left out rather than guessed.
   */
  draft?: { id: string; quantization?: string }
): FitVerdict | null {
  const params = paramsFromId(model.id)
  if (!params || gpuBytes <= 0) return null
  const gpuGb = gpuBytes / 1024 ** 3
  const draftParams = draft ? paramsFromId(draft.id) : null
  const draftWeightsGb = draftParams ? draftParams * bytesPerWeight(draft?.quantization) : 0
  const weightsGb = params * bytesPerWeight(model.quantization) + draftWeightsGb
  const ctx = model.loadedContextLength ?? model.maxContextLength ?? 8192
  const cachePerK = 0.05 * ((params + (draftParams ?? 0)) / 10)
  const cacheGb = (ctx / 1024) * cachePerK
  const total = weightsGb + cacheGb
  const room = gpuGb * 0.9
  let windowThatFits: number | null = null
  if (weightsGb < room) {
    const kTokens = Math.floor((room - weightsGb) / cachePerK)
    windowThatFits = Math.max(2048, Math.min(ctx, Math.pow(2, Math.floor(Math.log2(Math.max(1, kTokens)))) * 1024))
  }
  const kind = total <= room * 0.85 ? 'fits' : total <= room ? 'tight' : 'no'
  const draftGb = draftParams ? draftWeightsGb + (ctx / 1024) * 0.05 * (draftParams / 10) : undefined
  return { kind, weightsGb, cacheGb, gpuGb, windowThatFits, ...(draftGb !== undefined ? { draftGb } : {}) }
}

/** The verdict as a sentence for the row under LM Studio, with the `lms` line that would fix it. */
export function fitSentence(v: FitVerdict, id: string): string {
  const gb = (n: number): string => `${n.toFixed(1)} GB`
  // v4.2 (S8): the draft's share named first, so a verdict that changed with it says why
  // and an `lms load` line stays last, where it can be copied.
  if (v.draftGb !== undefined) return `With its draft model (${gb(v.draftGb)} of the total) — ${fitSentence({ ...v, draftGb: undefined }, id)}`
  if (v.kind === 'fits') return `Fits: about ${gb(v.weightsGb)} of weights and ${gb(v.cacheGb)} of cache on a ${gb(v.gpuGb)} card.`
  if (v.kind === 'tight') return `Tight: about ${gb(v.weightsGb + v.cacheGb)} on a ${gb(v.gpuGb)} card — expect the first word to wait.`
  if (v.windowThatFits === null) return `Does not fit: about ${gb(v.weightsGb)} of weights on a ${gb(v.gpuGb)} card — a smaller model or quant.`
  return `Does not fit at this window: about ${gb(v.weightsGb + v.cacheGb)} on a ${gb(v.gpuGb)} card. A ${(v.windowThatFits / 1024).toFixed(0)}K window would: lms load ${id} --context-length ${v.windowThatFits}`
}
