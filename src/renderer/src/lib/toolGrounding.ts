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
  /** Countries the reply names that contradict the geography the sources gave. */
  origins?: string[]
  /** Street addresses in the reply that appear in no tool output. */
  addresses?: string[]
  /** Phone numbers and email addresses that appear in no tool output. */
  contacts?: string[]
  /** Tools whose output was used as the corpus, for the disclosure text. */
  checkedAgainst: string[]
}

/**
 * Below this many money figures, a reply is mentioning a number, not building a
 * pricing table out of thin air. The distinction is what lets the figure check
 * run on turns where no pricing tool fired without commenting on every passing
 * "about $20" in ordinary conversation.
 */
const MIN_UNPROMPTED_FIGURES = 2

// ---- figures -----------------------------------------------------------------

/**
 * Currency amounts, with or without cents and with optional `~`/`about`.
 * Deliberately money-only: bare integers appear constantly in prose ("2017
 * models", "60 months") and flagging those would bury the signal.
 */
const CURRENCY = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g

/**
 * Money amounts in a blob of text — the only legitimate bases for arithmetic.
 *
 * Deriving from every bare number instead was a hole big enough to drive the
 * whole check through: a conversation containing the message "1" (a menu pick)
 * put 1 in the base set, and 1 multiplied by the permitted factors certifies
 * every integer from 2 to 24 as "supported". A fabricated "$5.00/bottle" came
 * back clean on exactly that. Prices derive from prices; counts are the
 * multipliers, not the source.
 */
function moneyIn(text: string): number[] {
  const found: number[] = []
  for (const m of text.matchAll(CURRENCY)) {
    const value = Number(m[1].replace(/,/g, ''))
    if (Number.isFinite(value)) found.push(value)
  }
  return found
}

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
 * Multipliers a legitimate derivation reaches for: pack sizes, case counts,
 * bottles per pallet. Bounded so the search stays cheap and, more importantly,
 * so the check keeps its teeth — permit enough arithmetic and every invented
 * number becomes "derivable" from something.
 */
const MAX_DERIVATION_FACTOR = 24
/** Corpus numbers considered for derivation, newest first. */
const MAX_DERIVATION_BASES = 300

/**
 * Is `value` simple arithmetic on something already known?
 *
 * v1.4.5. The check flagged its own correct work: told "$2.51 per bottle", the
 * model wrote "$15.06 per 6-bottle case" and the badge reported $15.06 as
 * unsourced, because multiplication is not quotation. Every per-case and
 * per-unit figure in a pricing conversation tripped it, which is precisely the
 * kind of noise that teaches someone to ignore the badge on the turn it
 * matters. Integer multiples and divisions only — the derivations a pack size
 * or a case count produces, not a free hand with the numbers.
 */
function isDerivable(value: number, decimals: number, known: number[]): boolean {
  for (const k of known) {
    if (!k) continue
    for (let n = 2; n <= MAX_DERIVATION_FACTOR; n++) {
      if (roundTo(k * n, decimals) === value) return true
      if (roundTo(k / n, decimals) === value) return true
    }
  }
  return false
}

/**
 * Money figures in `answer` that nothing in `corpus` supports.
 *
 * A figure counts as supported when some corpus number rounds to it at the
 * precision the answer used — so "about $396" is backed by a computed
 * $396.02, while $293.50 is backed by nothing and is reported — or when it is
 * simple arithmetic on a corpus number (see `isDerivable`).
 */
export function unsourcedFigures(answer: string, corpus: string): string[] {
  const known = numbersIn(corpus)
  const bases = [...new Set(moneyIn(corpus))].slice(0, MAX_DERIVATION_BASES)
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const match of answer.matchAll(CURRENCY)) {
    const raw = match[1]
    const value = Number(raw.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    const decimals = precisionOf(raw)
    const supported =
      known.some((k) => roundTo(k, decimals) === value) || isDerivable(value, decimals, bases)
    if (supported) continue
    const label = `$${raw}`
    if (seen.has(label)) continue
    seen.add(label)
    flagged.push(label)
  }
  return flagged
}

// ---- contact details ----------------------------------------------------------

/**
 * Phone numbers, including vanity spellings, and email addresses.
 *
 * The measured case: member-facing email copy closing with "call Member
 * Services at 1-800-SAM'S-CUB". That number is not Sam's Club's, is not a
 * number at all, and appeared in no tool result — it was assembled from the
 * shape of the brand name. A wrong price is embarrassing; a wrong phone number
 * in a mailshot sends real people somewhere real.
 */
// Case-sensitive, and the groups after the area code are joined by punctuation
// rather than a space, because both relaxations turn ordinary prose into a
// phone number: with neither, "$5,000 down you stay under $400" matched as
// "000 down you". Lowercase vanity numbers exist and are not worth the noise.
const PHONE =
  /(?:\+?\d{1,2}[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]?[A-Z0-9']{2,5}[-.][A-Z0-9']{3,5}\b/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

/** Comparison form: letters and digits only, so punctuation cannot hide a match. */
function normalizeContact(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/**
 * Contact details the reply states that appear in no tool output and in
 * nothing the user said.
 *
 * Unlike links this is not gated on a source tool having run. A link with no
 * search behind it is often just the model recalling a homepage, but a support
 * line quoted to a customer is a specific, dialable claim, and there is no
 * version of inventing one that is acceptable.
 */
export function unsourcedContacts(answer: string, corpus: string): string[] {
  const known = new Set(
    [...(corpus.match(PHONE) ?? []), ...(corpus.match(EMAIL) ?? [])].map(normalizeContact)
  )
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const raw of [...(answer.match(PHONE) ?? []), ...(answer.match(EMAIL) ?? [])]) {
    const key = normalizeContact(raw)
    // A bare year range or "2026-2027" is not a phone number; require enough
    // characters that the match is a real contact rather than punctuation.
    if (key.length < 10) continue
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    flagged.push(raw.trim())
  }
  return flagged
}

// ---- street addresses ----------------------------------------------------------

/**
 * A US street address: number, then street words, then a street type.
 *
 * The measured case: a sales route where three of seven stops carried
 * addresses that appeared in none of the search results the same turn had
 * collected — "Gristedes, 800 3rd Ave" on a turn where every Gristedes search
 * had failed on budget, and two Whole Foods addresses invented outright. The
 * three that were real came from the results verbatim, so the model was
 * perfectly capable of quoting; it filled the gaps rather than leaving them.
 *
 * An address is the same kind of claim as a link — specific, checkable, and
 * acted on by driving there.
 */
// Spaces and tabs between the words, never a newline. With `\s` the scanner
// glued a phone number to the address on the line below it — "212-308-6922\n
// 1031 First Avenue" matched as a single address, so the real one never
// entered the known set and was then reported as invented. An address does not
// wrap across lines in any output this reads.
const STREET_ADDRESS =
  /\b\d{1,5}[ \t]+(?:[A-Z0-9][A-Za-z0-9'.-]*[ \t]+){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Place|Pl|Plaza|Square|Sq|Parkway|Pkwy|Terrace|Broadway|Way)\b\.?/g

/**
 * Comparison form: case-folded, punctuation dropped, and the common street
 * types spelled out, so "800 3rd Ave" matches "800 Third Avenue" only when it
 * genuinely is the same string — abbreviation is normalized, wording is not.
 */
function normalizeAddress(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\bst\b/, 'street')
    .replace(/\bave\b/, 'avenue')
    .replace(/\brd\b/, 'road')
    .replace(/\bblvd\b/, 'boulevard')
    .replace(/\bdr\b/, 'drive')
    .replace(/\bln\b/, 'lane')
    .replace(/\bpl\b/, 'place')
    .replace(/\bsq\b/, 'square')
    .replace(/\bpkwy\b/, 'parkway')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Street addresses the reply states that appear in no tool output and in
 * nothing the user said.
 *
 * Gated on a source tool having run, like links: with no retrieval behind it an
 * address is the model answering from memory, which the `unverified` badge
 * already covers. The failure this catches is narrower and worse — sources
 * *were* consulted, some addresses came from them, and others were filled in
 * to complete the list.
 */
export function unsourcedAddresses(answer: string, corpus: string): string[] {
  const known = new Set((corpus.match(STREET_ADDRESS) ?? []).map(normalizeAddress))
  if (known.size === 0 && !corpus.trim()) return []
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const raw of answer.match(STREET_ADDRESS) ?? []) {
    const key = normalizeAddress(raw)
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    flagged.push(raw.trim())
  }
  return flagged
}

// ---- origin ------------------------------------------------------------------

/**
 * Countries and their demonyms, for the one factual contradiction this app can
 * catch without a model: the reply relocating something the sources placed.
 *
 * The measured failure: a session researching Vichy Catalan, whose search
 * results said "Spain" or "Spanish" in ten separate snippets, produced a buyer
 * pitch deck describing "French spa water" and an outreach email promising
 * "direct import from France". Nothing flagged it. Of every error in that
 * conversation it is the one that would have cost the user the meeting.
 */
const ORIGINS: [country: string, pattern: RegExp][] = [
  ['Spain', /\b(spain|spanish)\b/i],
  ['France', /\b(france|french)\b/i],
  ['Italy', /\b(italy|italian)\b/i],
  ['Germany', /\b(germany|german)\b/i],
  ['Portugal', /\b(portugal|portuguese)\b/i],
  ['Switzerland', /\b(switzerland|swiss)\b/i],
  ['Japan', /\b(japan|japanese)\b/i],
  ['China', /\b(china|chinese)\b/i],
  ['Mexico', /\b(mexico|mexican)\b/i],
  ['Norway', /\b(norway|norwegian)\b/i],
  ['Iceland', /\b(iceland|icelandic)\b/i],
  // Fiji is deliberately absent. In this app's most common commercial domain
  // it is a water brand far more often than a country, and reporting the
  // competitor named in a comparison table as a geography error is the kind of
  // false positive that costs the badge its credibility. Measured: it fired on
  // "Fiji: ~$1.25/bottle @ club" in a competitor list.
  ['Greece', /\b(greece|greek)\b/i],
  ['Austria', /\b(austria|austrian)\b/i],
  ['Belgium', /\b(belgium|belgian)\b/i],
  ['Ireland', /\b(ireland|irish)\b/i],
  ['Scotland', /\b(scotland|scottish)\b/i],
  ['Canada', /\b(canada|canadian)\b/i],
  ['Brazil', /\b(brazil|brazilian)\b/i],
  ['India', /\b(india|indian)\b/i]
]

/**
 * Countries the answer names that appear nowhere in what the tools returned.
 *
 * Only speaks when the corpus establishes a geography of its own — if the
 * sources never mention a country, the reply naming one is ordinary knowledge
 * and none of this check's business. When they do, and the reply names a
 * different one, that is a contradiction worth showing the user.
 */
export function contradictedOrigins(answer: string, corpus: string): string[] {
  const inCorpus = ORIGINS.filter(([, p]) => p.test(corpus)).map(([c]) => c)
  if (inCorpus.length === 0) return []
  return ORIGINS.filter(([country, p]) => p.test(answer) && !inCorpus.includes(country)).map(
    ([country]) => country
  )
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

  // v1.4.5: a reply that states several prices is checked whether or not a
  // pricing tool ran. The gate used to be the shopping heuristic, so a turn it
  // did not recognize as commerce — "email campaign copy", in a measured
  // session — could put a whole table of invented per-bottle prices in front of
  // the user with nothing said about it. What a figure is checked against is
  // unchanged; only whether the check runs at all.
  const figureCorpus = `${outputOf(records, (n) => NUMERIC_TOOLS.has(n))}\n${userText}`
  const stated = unsourcedFigures(answer, figureCorpus)
  const checkFigures =
    numericRecords.length > 0 ||
    options.expectPricingTool === true ||
    stated.length >= MIN_UNPROMPTED_FIGURES
  const figures = checkFigures ? stated : []

  const sourceCorpus = outputOf(records, (n) => SOURCE_TOOLS.has(n))
  const links = sourceRecords.length > 0 ? unsourcedLinks(answer, sourceCorpus) : []
  const origins = sourceRecords.length > 0 ? contradictedOrigins(answer, sourceCorpus) : []
  // The user's own words join the corpus: an address they gave is theirs.
  const addresses =
    sourceRecords.length > 0 ? unsourcedAddresses(answer, `${sourceCorpus}\n${userText}`) : []
  // Every tool's output, plus the user's own words — a number they gave is
  // theirs to repeat. Ungated, unlike links: see `unsourcedContacts`.
  const contacts = unsourcedContacts(answer, `${outputOf(records, () => true)}\n${userText}`)

  if (
    figures.length === 0 &&
    links.length === 0 &&
    origins.length === 0 &&
    contacts.length === 0 &&
    addresses.length === 0
  ) {
    return null
  }

  const used = [...new Set([...numericRecords, ...sourceRecords].map((r) => r.name))].sort()
  const checkedAgainst = used.length > 0 ? used : ['no tool output — nothing ran this turn']

  return {
    figures: figures.slice(0, MAX_REPORTED),
    links: links.slice(0, MAX_REPORTED),
    ...(origins.length > 0 ? { origins: origins.slice(0, MAX_REPORTED) } : {}),
    ...(contacts.length > 0 ? { contacts: contacts.slice(0, MAX_REPORTED) } : {}),
    ...(addresses.length > 0 ? { addresses: addresses.slice(0, MAX_REPORTED) } : {}),
    checkedAgainst
  }
}
