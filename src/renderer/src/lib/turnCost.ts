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
 * the tail is named beside it, and "total" means the total. Both ends are
 * measured from the same `turnStartedAt`, so the middle figure is their
 * difference rather than an estimate.
 *
 * Pure, so the line is node-testable without a renderer (test/turnCost.test.ts).
 */

import type { ResponseStats } from '../types'

/**
 * Under this, the tail is the mechanical grounding regex and a render — not a
 * wait, and not worth spending three figures on. Such a turn keeps the single
 * "Ns total" it has always shown, which for it was never a lie.
 */
export const TAIL_FLOOR_MS = 100

const secs = (ms: number, places = 1): string => `${(ms / 1000).toFixed(places)}s`

/** The post-answer wait this turn hid, or 0 when the turn was not measured end to end. */
export function tailMs(stats: ResponseStats): number {
  if (stats.turnMs === undefined) return 0
  return Math.max(0, stats.turnMs - stats.totalMs)
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
  const tail = tailMs(stats)
  if (tail < TAIL_FLOOR_MS) {
    parts.push(`${secs(stats.totalMs)} total`)
    return parts.join(' · ')
  }
  parts.push(
    `${secs(stats.totalMs)} answer`,
    `${secs(tail)} checking`,
    `${secs(stats.turnMs as number)} total`
  )
  return parts.join(' · ')
}
