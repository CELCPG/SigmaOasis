/**
 * v4.2 (C2): what the web-trigger classifier reads — shared by the runtime
 * (lib/webTrigger.ts) and the offline trainer (scripts/train-web-trigger.ts),
 * so a feature the trainer weighed is the feature the app computes. Nothing
 * here imports the model: the trainer has to run before there is one.
 *
 * Why hashed n-grams and not the word lists they replace: through 4.1 each
 * miss was one more alternative in a regex ("weather for righmond va today",
 * "s&p futures", "next miami heat game" in 4.0.1). Word unigrams and bigrams
 * carry the phrasing ("next game", "right now", "who won"); character 3-grams
 * inside each word carry the typing ("righmond", "tmrw", "londn" share most of
 * their trigrams with the word meant), which no word list can enumerate.
 */

export type WebNeed = 'none' | 'web' | 'live'

/** Class order in the model's weight rows. */
export const WEB_NEED_LABELS: readonly WebNeed[] = ['none', 'web', 'live']

/** 2^14 buckets: few collisions for a few thousand distinct n-grams, and only the ones seen are stored. */
export const FEATURE_BITS = 14
const MASK = (1 << FEATURE_BITS) - 1

/**
 * Per-group weights before the vector is normalised. Character grams outnumber
 * words about five to one; unscaled, spelling would drown out phrasing.
 */
const GROUP_WEIGHT = { word: 1, bigram: 0.8, char: 0.35, lead: 0.8, shape: 0.5 } as const

/** 32-bit FNV-1a: deterministic across runs and platforms, which Math.random or a JS Map order is not. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The held-out split, fixed by id rather than by position: the labelled file
 * is written in runs of similar prompts, so "every fourth line" would put
 * near-twins on both sides and flatter the measurement. About one id in four.
 */
export function isHeldOut(id: string): boolean {
  return fnv1a(`split:${id}`) % 4 === 0
}

/** Word characters as people type them in a chat box: "s&p", "o'hare", "$200", "15%". */
const NON_WORD = /[^a-z0-9&$%']+/
const YEAR = /^(?:19|20)\d\d$/
const HAS_DIGIT = /\d/

/** Lowercased tokens, apostrophes trimmed from the ends ("'til", "players'"). */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().replace(/[‘’]/g, "'").split(NON_WORD)) {
    let a = 0
    let b = raw.length
    while (a < b && raw[a] === "'") a++
    while (b > a && raw[b - 1] === "'") b--
    if (b > a) out.push(raw.slice(a, b))
  }
  return out
}

/** A digit-bearing token also counts as its shape: "ua 523" and "aa 1234" are one thing. */
function shapeOf(token: string): string | null {
  if (YEAR.test(token)) return '<year>'
  return HAS_DIGIT.test(token) ? '<num>' : null
}

/**
 * The sparse, L2-normalised feature vector of a message: bucket index → value.
 * Pure and allocation-light; a chat message is a few hundred features.
 */
export function featurize(text: string): Map<number, number> {
  const raw = new Map<string, number>()
  const add = (key: string, w: number): void => {
    raw.set(key, (raw.get(key) ?? 0) + w)
  }
  const words = tokenize(text)
  // Bigrams read the shape of a numbered token; unigrams keep its spelling too,
  // since "2026" and "5090" say different things.
  const toks = words.map((t) => shapeOf(t) ?? t)
  for (const w of words) add(`w:${w}`, GROUP_WEIGHT.word)
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== words[i]) add(`w:${toks[i]}`, GROUP_WEIGHT.word)
  }
  const padded = ['^', ...toks, '$']
  for (let i = 0; i + 1 < padded.length; i++) add(`b:${padded[i]} ${padded[i + 1]}`, GROUP_WEIGHT.bigram)
  // The first two words carry the question's shape: "who won", "is it", "write a".
  if (toks.length > 0) add(`f:${toks[0]}`, GROUP_WEIGHT.lead)
  if (toks.length > 1) add(`f:${toks[0]} ${toks[1]}`, GROUP_WEIGHT.lead)
  for (const w of words) {
    if (w.length < 3 || HAS_DIGIT.test(w)) continue
    const p = `<${w}>`
    for (let i = 0; i + 3 <= p.length; i++) add(`c:${p.slice(i, i + 3)}`, GROUP_WEIGHT.char)
  }
  if (text.includes('?')) add('s:?', GROUP_WEIGHT.shape)
  add(`s:len${Math.min(words.length, 12) >> 2}`, GROUP_WEIGHT.shape)

  const out = new Map<number, number>()
  for (const [key, v] of raw) {
    const idx = fnv1a(key) & MASK
    out.set(idx, (out.get(idx) ?? 0) + v)
  }
  let norm = 0
  for (const v of out.values()) norm += v * v
  norm = Math.sqrt(norm) || 1
  for (const [k, v] of out) out.set(k, v / norm)
  return out
}

/** Numerically stable softmax. */
export function softmax(z: number[]): number[] {
  const m = Math.max(...z)
  const e = z.map((x) => Math.exp(x - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map((x) => x / s)
}

/** Weights as the trainer holds them: one dense row per class, and a bias. */
export interface DenseWeights {
  w: Float64Array[]
  b: number[]
}

/** Class probabilities, in WEB_NEED_LABELS order. */
export function predictDense(model: DenseWeights, x: Map<number, number>): number[] {
  const z = model.b.slice()
  for (const [idx, v] of x) for (let k = 0; k < z.length; k++) z[k] += model.w[k][idx] * v
  return softmax(z)
}

/** The committed model, as JSON: only the buckets training saw, weights as integers over `scale`. */
export interface WebTriggerModelFile {
  version: 1
  featureBits: number
  labels: WebNeed[]
  /** fnv1a of the labelled file (LF line endings) the model was trained on — the test that it is current reads this. */
  trainedOn: string
  trainExamples: number
  /** Chosen on the train split's cross-validated predictions; see the trainer. */
  thresholds: { live: number; web: number }
  scale: number
  bias: number[]
  /** Sorted bucket indices. */
  index: number[]
  /** labels.length integers per index, class-major within each bucket. */
  weights: number[]
}

/** Labelled example, one line of test/fixtures/webTrigger/labelled.jsonl. */
export interface LabelledPrompt {
  id: string
  text: string
  label: WebNeed
  split: 'train' | 'test'
}

/** Parse the labelled JSONL; blank lines are skipped. */
export function parseLabelled(jsonl: string): LabelledPrompt[] {
  return jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LabelledPrompt)
}

/** The hash `trainedOn` records: of the file's text with LF endings, so a Windows checkout agrees. */
export function labelledDigest(jsonl: string): string {
  return fnv1a(jsonl.replace(/\r\n/g, '\n')).toString(16).padStart(8, '0')
}
