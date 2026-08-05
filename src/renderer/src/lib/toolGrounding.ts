import type { ToolCallRecord } from '../types'

/**
 * v1.3 tool grounding: did the answer actually use what the tools returned?
 *
 * The v1.1 `unverified` flag catches the easy case — a factual turn where no
 * source was consulted at all. This catches the harder and more damaging one:
 * a tool ran, returned a number or a link, and the reply contains a *different*
 * number or link instead.
 *
 * That is not hypothetical. Measured in a v1.3 session: the user asked for a
 * car payment with $5,000 down, `finance_calculator` was called (with the wrong
 * principal — the sticker price rather than the amount financed) and returned
 * $396.02/mo, and the reply told the user **$293.50/mo**. Every figure in that
 * answer — payment, interest, totals — was written by the model, and all of
 * them were wrong. The same session produced a product URL that appeared in no
 * search result.
 *
 * The check is deliberately mechanical: string and number extraction, no model
 * call, no network. It cannot judge whether a figure is *right* — only whether
 * anything the app actually retrieved or computed supports it. A figure the
 * model derived itself is reported as exactly that, and the user decides.
 */

/** Tools whose output is the authoritative source for numbers in a reply. */
const NUMERIC_TOOLS = new Set(['finance_calculator', 'shop_compare', 'price_watch'])

/** Tools whose output is the authoritative source for links in a reply. */
const SOURCE_TOOLS = new Set([
  'web_search',
  'image_search',
  'fetch_webpage',
  'deep_research',
  'shop_compare',
  'shop_requirements',
  'price_watch'
])

/** Beyond this many findings the badge stops enumerating and just counts. */
const MAX_REPORTED = 6

export interface GroundingReport {
  /** Money figures in the reply that no tool output or user message contains. */
  figures: string[]
  /** Links in the reply that appear in no tool output. */
  links: string[]
  /** Tools whose output was used as the corpus, for the disclosure text. */
  checkedAgainst: string[]
}

// ---- figures -----------------------------------------------------------------

/**
 * Currency amounts, with or without cents and with optional `~`/`about`.
 * Deliberately money-only: bare integers appear constantly in prose ("2017
 * models", "60 months") and flagging those would bury the signal.
 */
const CURRENCY = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g

/** Every number in a blob of text, as numeric values. */
function numbersIn(text: string): number[] {
  const found: number[] = []
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)) {
    const value = Number(m[1].replace(/,/g, ''))
    if (Number.isFinite(value)) found.push(value)
  }
  return found
}

/** Decimal places written in the source text, so rounding is judged at its precision. */
function precisionOf(raw: string): number {
  const dot = raw.indexOf('.')
  return dot === -1 ? 0 : raw.length - dot - 1
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Money figures in `answer` that nothing in `corpus` supports.
 *
 * A figure counts as supported when some corpus number rounds to it at the
 * precision the answer used — so "about $396" is backed by a computed
 * $396.02, while $293.50 is backed by nothing and is reported.
 */
export function unsourcedFigures(answer: string, corpus: string): string[] {
  const known = numbersIn(corpus)
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const match of answer.matchAll(CURRENCY)) {
    const raw = match[1]
    const value = Number(raw.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    const decimals = precisionOf(raw)
    const supported = known.some((k) => roundTo(k, decimals) === value)
    if (supported) continue
    const label = `$${raw}`
    if (seen.has(label)) continue
    seen.add(label)
    flagged.push(label)
  }
  return flagged
}

// ---- links -------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g

/** Trailing punctuation from prose is not part of the URL. */
function normalizeUrl(url: string): string {
  return url
    .replace(/[.,;:!?]+$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Links in `answer` that appear in no tool output.
 *
 * Exact match after normalization, on purpose: a model that takes a real
 * collection URL and appends a plausible-looking path has invented a page, and
 * treating "same origin" as good enough would let exactly that through.
 */
export function unsourcedLinks(answer: string, corpus: string): string[] {
  const known = new Set((corpus.match(URL_PATTERN) ?? []).map(normalizeUrl))
  if (known.size === 0 && !corpus.trim()) return []
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const raw of answer.match(URL_PATTERN) ?? []) {
    const url = normalizeUrl(raw)
    if (known.has(url) || seen.has(url)) continue
    seen.add(url)
    flagged.push(url)
  }
  return flagged
}

// ---- the pass ----------------------------------------------------------------

/** Successful output of the records whose names pass `include`. */
function outputOf(records: ToolCallRecord[], include: (name: string) => boolean): string {
  return records
    .filter((r) => r.status === 'done' && include(r.name))
    .map((r) => r.result ?? '')
    .join('\n')
}

/**
 * Compare a finished reply against the turn's tool output.
 *
 * Returns null when there is nothing to say — which is the common case, and
 * must stay cheap: no badge unless something in the answer genuinely has no
 * backing.
 *
 * `userText` joins the corpus for figures because the user's own numbers (a
 * budget, a down payment) are theirs to restate, and flagging those would be
 * noise. It is deliberately *not* part of the link corpus: a URL the user
 * pasted is fine to echo, but the app has still not verified it, and the
 * pasted-link case is rare enough not to be worth the false-negative.
 *
 * v1.5: it must be *every* user message, not just the latest one. Passing only
 * the current turn produced the badge's worst false positive — a v1.4 session
 * where the user said "$5,000 to invest, $500 a month" four turns earlier and
 * every figure in the resulting plan was flagged as unsourced, including the
 * app's own arithmetic on those numbers. A badge that cries wolf on the user's
 * own budget is a badge they learn to ignore, which costs exactly the cases it
 * exists for.
 */
export function checkToolGrounding(
  answer: string,
  records: ToolCallRecord[],
  userText: string,
  options: {
    /**
     * The turn was a purchase decision, so prices needed a pricing tool. Set
     * by `looksLikeShopping`, and it makes the figure check run even when no
     * such tool ran — because on a shopping turn that is the *worse* case, not
     * a reason to skip: every price in the reply then came from memory.
     */
    expectPricingTool?: boolean
  } = {}
): GroundingReport | null {
  if (!answer.trim()) return null

  const numericRecords = records.filter((r) => r.status === 'done' && NUMERIC_TOOLS.has(r.name))
  const sourceRecords = records.filter((r) => r.status === 'done' && SOURCE_TOOLS.has(r.name))

  const checkFigures = numericRecords.length > 0 || options.expectPricingTool === true
  const figures = checkFigures
    ? unsourcedFigures(answer, `${outputOf(records, (n) => NUMERIC_TOOLS.has(n))}\n${userText}`)
    : []
  const links =
    sourceRecords.length > 0
      ? unsourcedLinks(answer, outputOf(records, (n) => SOURCE_TOOLS.has(n)))
      : []

  if (figures.length === 0 && links.length === 0) return null

  const used = [...new Set([...numericRecords, ...sourceRecords].map((r) => r.name))].sort()
  const checkedAgainst = used.length > 0 ? used : ['no tool output — nothing ran this turn']

  return {
    figures: figures.slice(0, MAX_REPORTED),
    links: links.slice(0, MAX_REPORTED),
    checkedAgainst
  }
}
