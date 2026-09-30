/**
 * v4.2 (C2): train the web-trigger classifier from the labelled prompts.
 *
 *   bash scripts/train-web-trigger.sh
 *
 * Reads test/fixtures/webTrigger/labelled.jsonl, trains on the `train` split
 * only — the `test` split is what test/webTrigger.test.ts measures, and a
 * model that had seen it would measure itself — and writes
 * src/renderer/src/lib/webTrigger.model.json. No network, no dependencies,
 * no randomness: the same file trains the same bytes, which is what lets the
 * test demand that the committed model is the current file's.
 *
 * The model is multinomial logistic regression over the hashed features in
 * lib/webTriggerFeatures.ts, full-batch Adam, class-balanced, L2. The L2
 * strength is picked by 5-fold cross-validation on the train split (lowest
 * out-of-fold log loss), and so are the two thresholds the app applies,
 * against a false-alarm target — chosen before the held-out split is looked
 * at, so the number the test prints is not tuned to it.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  FEATURE_BITS,
  WEB_NEED_LABELS,
  featurize,
  labelledDigest,
  parseLabelled,
  predictDense,
  type DenseWeights,
  type WebTriggerModelFile
} from '../src/renderer/src/lib/webTriggerFeatures'

// Compiled to <out>/scripts/, two levels below the repository.
const REPO = join(__dirname, '..', '..')
const LABELLED = join(REPO, 'test', 'fixtures', 'webTrigger', 'labelled.jsonl')
const MODEL = join(REPO, 'src', 'renderer', 'src', 'lib', 'webTrigger.model.json')

const DIM = 1 << FEATURE_BITS
const K = WEB_NEED_LABELS.length
const EPOCHS = 300
const LEARNING_RATE = 0.05
// With 300 full-batch steps the step count regularises too, which is why the
// cross-validation keeps choosing the weakest L2 on offer.
const LAMBDAS = [3e-6, 1e-5, 3e-5, 1e-4, 3e-4]
const FOLDS = 5
/**
 * The thresholds' targets, on out-of-fold predictions. A false alarm costs a
 * web search the user waits for (and a query leaving the machine), so the
 * classifier, live and web readings together, may flag at most 5% of chat
 * turns by itself (some of them the rules flag anyway). A web turn read as live
 * costs little (it gets the web either way), so the live reading may take up
 * to 5% of everything not live, but no more than 3% of chat.
 */
const WEB_FALSE_ALARM_TARGET = 0.05
const LIVE_FALSE_ALARM_TARGET = 0.05
const LIVE_CHAT_FALSE_ALARM_TARGET = 0.03
const SCALE = 1000

interface Example {
  x: Map<number, number>
  y: number
}

function train(examples: Example[], lambda: number): DenseWeights {
  const w = Array.from({ length: K }, () => new Float64Array(DIM))
  const b = new Array<number>(K).fill(0)
  const counts = new Array<number>(K).fill(0)
  for (const e of examples) counts[e.y]++
  // Class-balanced: each class weighs the same in the loss however many examples it has.
  const cw = counts.map((c) => (c ? examples.length / (K * c) : 0))
  const mW = Array.from({ length: K }, () => new Float64Array(DIM))
  const vW = Array.from({ length: K }, () => new Float64Array(DIM))
  const mB = new Array<number>(K).fill(0)
  const vB = new Array<number>(K).fill(0)
  const b1 = 0.9
  const b2 = 0.999
  const eps = 1e-8
  // Only buckets some example touches get a gradient; the rest stay zero and are not stored.
  const touched = new Set<number>()
  for (const e of examples) for (const idx of e.x.keys()) touched.add(idx)
  const active = [...touched].sort((p, q) => p - q)
  const gW = Array.from({ length: K }, () => new Float64Array(DIM))
  for (let epoch = 1; epoch <= EPOCHS; epoch++) {
    for (let k = 0; k < K; k++) for (const idx of active) gW[k][idx] = lambda * w[k][idx]
    const gB = new Array<number>(K).fill(0)
    for (const e of examples) {
      const p = predictDense({ w, b }, e.x)
      for (let k = 0; k < K; k++) {
        const d = (cw[e.y] * (p[k] - (k === e.y ? 1 : 0))) / examples.length
        gB[k] += d
        for (const [idx, v] of e.x) gW[k][idx] += d * v
      }
    }
    const c1 = 1 - b1 ** epoch
    const c2 = 1 - b2 ** epoch
    for (let k = 0; k < K; k++) {
      for (const idx of active) {
        const g = gW[k][idx]
        mW[k][idx] = b1 * mW[k][idx] + (1 - b1) * g
        vW[k][idx] = b2 * vW[k][idx] + (1 - b2) * g * g
        w[k][idx] -= (LEARNING_RATE * (mW[k][idx] / c1)) / (Math.sqrt(vW[k][idx] / c2) + eps)
      }
      mB[k] = b1 * mB[k] + (1 - b1) * gB[k]
      vB[k] = b2 * vB[k] + (1 - b2) * gB[k] * gB[k]
      b[k] -= (LEARNING_RATE * (mB[k] / c1)) / (Math.sqrt(vB[k] / c2) + eps)
    }
  }
  return { w, b }
}

/** Out-of-fold probabilities for every example: fold = position mod FOLDS, in file order. */
function crossValidate(examples: Example[], lambda: number): number[][] {
  const out: number[][] = new Array(examples.length)
  for (let f = 0; f < FOLDS; f++) {
    const fit = train(
      examples.filter((_, i) => i % FOLDS !== f),
      lambda
    )
    examples.forEach((e, i) => {
      if (i % FOLDS === f) out[i] = predictDense(fit, e.x)
    })
  }
  return out
}

const LIVE = WEB_NEED_LABELS.indexOf('live')
const WEB = WEB_NEED_LABELS.indexOf('web')
const NONE = WEB_NEED_LABELS.indexOf('none')

/** The lowest threshold on a 0.025 grid from 0.3 that passes. */
function lowestPassing(ok: (t: number) => boolean): number {
  for (let i = 12; i <= 39; i++) if (ok(i / 40)) return i / 40
  return 0.975
}

/** Share of the `negative` examples that `flagged` marks. */
function falseAlarm(n: number, negative: (i: number) => boolean, flagged: (i: number) => boolean): number {
  let neg = 0
  let fa = 0
  for (let i = 0; i < n; i++) {
    if (!negative(i)) continue
    neg++
    if (flagged(i)) fa++
  }
  return fa / Math.max(1, neg)
}

function main(): void {
  const text = readFileSync(LABELLED, 'utf8')
  const rows = parseLabelled(text).filter((r) => r.split === 'train')
  const examples: Example[] = rows.map((r) => ({ x: featurize(r.text), y: WEB_NEED_LABELS.indexOf(r.label) }))

  let best = { lambda: LAMBDAS[0], loss: Infinity, oof: [] as number[][] }
  for (const lambda of LAMBDAS) {
    const oof = crossValidate(examples, lambda)
    const loss = -oof.reduce((s, p, i) => s + Math.log(Math.max(p[examples[i].y], 1e-12)), 0) / examples.length
    const acc = oof.filter((p, i) => p.indexOf(Math.max(...p)) === examples[i].y).length / examples.length
    console.log(`lambda ${lambda}: out-of-fold log loss ${loss.toFixed(4)}, accuracy ${(acc * 100).toFixed(1)}%`)
    if (loss < best.loss) best = { lambda, loss, oof }
  }

  const pWebOrLive = (p: number[]): number => p[WEB] + p[LIVE]
  const pLive = best.oof.map((p) => p[LIVE])
  const n = examples.length
  const isNone = (i: number): boolean => examples[i].y === NONE
  const live = lowestPassing(
    (t) =>
      falseAlarm(n, (i) => examples[i].y !== LIVE, (i) => pLive[i] >= t) <= LIVE_FALSE_ALARM_TARGET &&
      falseAlarm(n, isNone, (i) => pLive[i] >= t) <= LIVE_CHAT_FALSE_ALARM_TARGET
  )
  // The app acts on either reading (lib/grounding.ts), so the web threshold is held to the union.
  const web = lowestPassing((t) => falseAlarm(n, isNone, (i) => pLive[i] >= live || pWebOrLive(best.oof[i]) >= t) <= WEB_FALSE_ALARM_TARGET)
  const recall = (scores: number[], pos: boolean[], t: number): string =>
    ((scores.filter((s, i) => pos[i] && s >= t).length / pos.filter(Boolean).length) * 100).toFixed(1)
  // `--errors`: the train-split prompts the cross-validated model gets wrong —
  // where new examples help most. Never the held-out split: that is the test.
  if (process.argv.includes('--errors')) {
    best.oof.forEach((p, i) => {
      const wrongWeb = (examples[i].y !== NONE) !== (pWebOrLive(p) >= 0.5)
      const wrongLive = (examples[i].y === LIVE) !== (p[LIVE] >= 0.5)
      if (wrongWeb || wrongLive) console.log(`  ${rows[i].label.padEnd(4)} none ${p[NONE].toFixed(2)} web ${p[WEB].toFixed(2)} live ${p[LIVE].toFixed(2)}  ${rows[i].text}`)
    })
  }
  console.log(`chosen lambda ${best.lambda}; thresholds web+live ${web} (out-of-fold recall ${recall(best.oof.map(pWebOrLive), examples.map((e) => e.y !== NONE), web)}%), live ${live} (recall ${recall(pLive, examples.map((e) => e.y === LIVE), live)}%)`)

  const fit = train(examples, best.lambda)
  const index: number[] = []
  const weights: number[] = []
  for (let idx = 0; idx < DIM; idx++) {
    const q = fit.w.map((row) => Math.round(row[idx] * SCALE))
    if (q.every((v) => v === 0)) continue
    index.push(idx)
    weights.push(...q)
  }
  const model: WebTriggerModelFile = {
    version: 1,
    featureBits: FEATURE_BITS,
    labels: [...WEB_NEED_LABELS],
    trainedOn: labelledDigest(text),
    trainExamples: examples.length,
    thresholds: { live, web },
    scale: SCALE,
    bias: fit.b.map((v) => Math.round(v * SCALE)),
    index,
    weights
  }
  const json = `${JSON.stringify(model)}\n`
  writeFileSync(MODEL, json)
  console.log(`wrote ${MODEL}: ${index.length} buckets, ${(json.length / 1024).toFixed(1)} KB`)
}

main()
