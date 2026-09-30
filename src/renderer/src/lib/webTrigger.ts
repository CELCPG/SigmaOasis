/**
 * v4.2 (C2): does this turn need the web — and is it about the live world?
 *
 * A measured classifier in place of the word lists that grew one miss at a
 * time (4.0.1 missed "weather for righmond va today", "s&p futures", "next
 * miami heat game"). Multinomial logistic regression over hashed word and
 * character n-grams (lib/webTriggerFeatures.ts), trained offline by
 * scripts/train-web-trigger.ts on test/fixtures/webTrigger/labelled.jsonl and
 * committed as webTrigger.model.json. Its held-out numbers, beside the rules
 * it joins, are in docs/web-trigger.md and re-measured by
 * test/webTrigger.test.ts.
 *
 * Pure and deterministic: no model call, no network, the same answer for the
 * same text on every machine. A few hundred multiply-adds per message.
 *
 * It is not the whole decision. lib/grounding.ts keeps the rules as overrides
 * — a rule hit still forces the web, creative and coding intent still vetoes
 * — and asks this only when the rules have said nothing.
 */
import modelFile from './webTrigger.model.json'
import { WEB_NEED_LABELS, featurize, softmax, type WebNeed, type WebTriggerModelFile } from './webTriggerFeatures'

export type { WebNeed } from './webTriggerFeatures'

export interface WebNeedResult {
  /** The most probable class. */
  label: WebNeed
  /** Its probability. */
  p: number
  /** Every class's probability. */
  probs: Record<WebNeed, number>
}

const MODEL = modelFile as WebTriggerModelFile

/** Bucket → per-class weights, unpacked once on first use. */
let table: Map<number, number[]> | null = null

function weights(): Map<number, number[]> {
  if (table) return table
  const k = MODEL.labels.length
  const t = new Map<number, number[]>()
  MODEL.index.forEach((idx, i) => {
    t.set(
      idx,
      MODEL.weights.slice(i * k, i * k + k).map((v) => v / MODEL.scale)
    )
  })
  table = t
  return t
}

/** One turn's text is read several times (looksLive, looksFactual, webToolsForTurn); the last answer is kept. */
let last: { text: string; result: WebNeedResult } | null = null

/** The classifier's reading of one message. */
export function classifyWebNeed(text: string): WebNeedResult {
  if (last && last.text === text) return last.result
  const w = weights()
  const z = MODEL.bias.map((v) => v / MODEL.scale)
  for (const [idx, v] of featurize(text)) {
    const row = w.get(idx)
    if (row) for (let k = 0; k < z.length; k++) z[k] += row[k] * v
  }
  const p = softmax(z)
  const probs = { none: 0, web: 0, live: 0 } as Record<WebNeed, number>
  MODEL.labels.forEach((label, k) => {
    probs[label] = p[k]
  })
  let best = 0
  for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k
  const result: WebNeedResult = { label: MODEL.labels[best] ?? WEB_NEED_LABELS[0], p: p[best], probs }
  last = { text, result }
  return result
}

/**
 * The thresholds the app acts on, picked by the trainer on cross-validated
 * train-split predictions against a false-alarm target (a false alarm is a
 * search the user waits for), not on the held-out split.
 */
export const WEB_TRIGGER_THRESHOLDS: Readonly<{ live: number; web: number }> = MODEL.thresholds

/** Confident that the answer changes by the hour or the day. */
export function modelSaysLive(text: string): boolean {
  return classifyWebNeed(text).probs.live >= WEB_TRIGGER_THRESHOLDS.live
}

/** Confident that the answer needs the web at all — live or a checkable fact. */
export function modelSaysWeb(text: string): boolean {
  const { probs } = classifyWebNeed(text)
  return probs.web + probs.live >= WEB_TRIGGER_THRESHOLDS.web
}
