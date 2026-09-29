/**
 * v2.6: the fact ledger — verification that compounds.
 *
 * A claim that survived the turn's grounding is worth keeping: the next time
 * the user asks, the app can answer from what it verified, with the date,
 * and skip the search — or, when the entry has passed its freshness window,
 * re-check and say what changed. The ledger is a library pack the app
 * writes (`verified-claims`), so retrieval, citation and the Library panel
 * are the ones the reader already knows.
 *
 * Pure data and pure functions, shared by main (the pack writer), the
 * renderer (the capture and the provider) and the evals.
 */

export const LEDGER_PACK_ID = 'verified-claims'
export const LEDGER_PACK_NAME = 'Verified claims'

export type ClaimClass = 'money' | 'measurement' | 'address' | 'contact' | 'url' | 'date' | 'historical'

/** What the capture found in a reply and bound to a source this turn. */
export interface LedgerEntryDraft {
  /** The supersession key: the claim class and the question's content words. */
  key: string
  claimClass: ClaimClass
  /** The span as the reply wrote it, normalized for comparison. */
  value: string
  /** The reply sentence that carries it — what the ledger stores and recalls. */
  sentence: string
  /** The source whose own text states the value. */
  url: string
  question: string
}

export interface LedgerHit {
  key: string
  claimClass: ClaimClass
  value: string
  sentence: string
  url: string
  checkedAt: number
  /** null = never expires (a historical fact). */
  expiresAt: number | null
  expired: boolean
  score: number
}

export interface LedgerUpsertResult {
  /** Keys written for the first time. */
  written: string[]
  /** Keys whose value was unchanged and whose check date moved forward. */
  refreshed: string[]
  /** Keys whose value changed: the contradiction, surfaced. */
  superseded: { key: string; previous: string; next: string; sentence: string }[]
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * Typed freshness. A price is stale by tomorrow; an address or a phone number
 * holds for months; a measurement, a release date or a manual's URL for a
 * couple of years; a founding year never.
 */
export const FRESHNESS_MS: Record<ClaimClass, number | null> = {
  money: DAY,
  contact: 180 * DAY,
  address: 180 * DAY,
  measurement: 730 * DAY,
  url: 730 * DAY,
  date: 730 * DAY,
  historical: null
}

const STOPWORDS = new Set(
  (
    'a an the of for to in on at by with from and or is are was were be been what which who whom whose when where why how ' +
    'does do did can could would should much many long far deep hot cold big tall old new this that these those it its their ' +
    'there here about into over under per each any some than then also just not no yes please tell me my your our i you we they ' +
    'get got have has had will shall may might must'
  ).split(' ')
)

/** The question's content words, sorted — the same question in other words keys the same. */
export function contentWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/['’]s\b/g, '')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    )
  ].sort()
}

export function claimKey(claimClass: ClaimClass, question: string): string {
  return `${claimClass}|${contentWords(question).join(' ')}`
}

export function expiresAtFor(claimClass: ClaimClass, checkedAt: number): number | null {
  const ttl = FRESHNESS_MS[claimClass]
  return ttl === null ? null : checkedAt + ttl
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/**
 * A written date as YYYY-MM-DD, or null when the text is not one: "29 September
 * 2026", "September 29, 2026" and "2026-09-29" are the three shapes the capture
 * recognizes as a date claim, in any casing.
 */
export function isoDateOf(span: string): string | null {
  const t = span.trim().toLowerCase()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const dayFirst = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/.exec(t)
  const monthFirst = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(t)
  const [day, month, year] = dayFirst
    ? [dayFirst[1], dayFirst[2], dayFirst[3]]
    : monthFirst
      ? [monthFirst[2], monthFirst[1], monthFirst[3]]
      : []
  const m = MONTH_NAMES.indexOf(month ?? '')
  if (m < 0) return null
  return `${year}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The calendar day of `at`, as the machine's own clock reads it. */
export function localIsoDate(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * v4.0.1: is this "claim" only the date it was checked on?
 *
 * Every turn is told today's date and a reply to a question about today
 * repeats it; any page published today states it too. So the capture bound
 * "September 29, 2026" to a prediction-market page and filed it as a verified
 * claim, twice in one conversation, where `reference_lookup` then found it for
 * a question about the weather. The clock is not a claim: nothing was looked
 * up to learn it, and a day later it is wrong.
 *
 * Read from the stored entry alone, so entries 4.0.0 wrote can be recognized
 * and removed. Both the local and the UTC day count, because `checkedAt` is an
 * instant and the reply wrote a calendar date.
 */
export function isClockClaim(claimClass: string, value: string, checkedAt: number): boolean {
  if (claimClass !== 'date') return false
  const stated = isoDateOf(value)
  if (!stated) return false
  return stated === localIsoDate(checkedAt) || stated === new Date(checkedAt).toISOString().slice(0, 10)
}
