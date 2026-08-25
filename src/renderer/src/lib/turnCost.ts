/**
 * What a turn cost the reader, said honestly.
 *
 * The stat line under a reply has always ended in "Ns total", and N has always
 * been the token stream: `recordStats` stamps it on the last streaming round,
 * and the verification tail — claim check, code check, recomputation, revision
 * — runs after that with the composer still on Stop. Measured on recorded runs
 * (.h2h-runs/judge-r4): a footer of "25.7s total" over an 80.0 s wait, "51.9s"
 * over 162.8 s, "76.6s" over 213.0 s. The word was not a rounding error, it was
 * the wrong quantity, three to four times under, and it is the figure a reader
 * quotes when asked how long the app took.
 *
 * The stream figure stays — it is the thing tok/s is a rate of, and dropping it
 * would trade one missing number for another. It is now labelled as the answer,
 * the tail is named beside it, and "total" means the total.
 *
 * v1.12.6: and so is the wait BEFORE the model. Round 5 measured both ends from
 * `turnStartedAt`, which useLMStudio stamps AFTER the context providers have
 * run — so a factual turn's own web_search, a serial provider that holds the
 * turn open before the model is asked anything, was outside every figure on the
 * line. Measured against the recorded runs (.h2h-runs/judge-r5/TTU1): 40 286 ms
 * of wait under "31.5s total", 39 791 under "30.9s" — 8.8 s missing from each,
 * 22% of what the reader sat through, and exactly the search. Worse, round 5's
 * arithmetic charged that time to the wrong span: `turnMs - totalMs` counted
 * the pre-model gather as post-answer "checking".
 *
 * The turn now has one origin, `turnOpenedAt`, and three measured spans that
 * tile it: gathering, answer, checking. Each is a subtraction between stamps,
 * so no segment here is an estimate, and the line adds up.
 *
 * Pure, so the line is node-testable without a renderer (test/turnCost.test.ts).
 */

import type { ResponseStats } from '../types'

/**
 * Under this, a span is bookkeeping rather than a wait — the mechanical
 * grounding regex and a render at the tail, a registry walk with every provider
 * disabled at the front. Such a turn keeps the single "Ns total" it has always
 * shown, which for it was never a lie.
 */
export const SEGMENT_FLOOR_MS = 100

const secs = (ms: number, places = 1): string => `${(ms / 1000).toFixed(places)}s`

/** The pre-model wait this turn spent, or 0 when it was not measured. */
export function gatherMs(stats: ResponseStats): number {
  return Math.max(0, stats.gatherMs ?? 0)
}

/**
 * The post-answer wait this turn hid, or 0 when the turn was not measured end
 * to end. What is left of the turn once the gather and the stream are taken
 * out — so time spent before the model was asked is never billed to the checks.
 */
export function tailMs(stats: ResponseStats): number {
  if (stats.turnMs === undefined) return 0
  return Math.max(0, stats.turnMs - gatherMs(stats) - stats.totalMs)
}

/**
 * The performance readout under a reply. Token figures appear only when the
 * server reported them — timing is always measured, token counts never
 * estimated, so nothing here is a guess dressed up as a measurement.
 */
export function formatTurnCost(stats: ResponseStats): string {
  const parts: string[] = []
  if (stats.completionTokens) parts.push(`${stats.completionTokens.toLocaleString()} tok`)
  if (stats.tokensPerSecond) parts.push(`${stats.tokensPerSecond.toFixed(1)} tok/s`)
  if (stats.ttftMs) parts.push(`${secs(stats.ttftMs, 2)} to first token`)
  const gather = gatherMs(stats)
  const tail = tailMs(stats)
  const gathered = gather >= SEGMENT_FLOOR_MS
  const checked = tail >= SEGMENT_FLOOR_MS
  // Without an end-to-end measurement there is no total to break up — a turn
  // stopped before its tail ran keeps the one figure it can stand behind.
  if (stats.turnMs === undefined || (!gathered && !checked)) {
    parts.push(`${secs(stats.totalMs)} total`)
    return parts.join(' · ')
  }
  // Chronological, so the reader can add them up in the order they lived them.
  if (gathered) parts.push(`${secs(gather)} gathering`)
  parts.push(`${secs(stats.totalMs)} answer`)
  if (checked) parts.push(`${secs(tail)} checking`)
  parts.push(`${secs(stats.turnMs)} total`)
  return parts.join(' · ')
}
