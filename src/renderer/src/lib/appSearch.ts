import { buildSearchQuery, looksLive, referenceDomains } from './grounding'

/**
 * v4.1 (G2b–d): what the app's own search sends, how recent it asks for, and
 * what it reads before the model is asked.
 *
 * Through 4.0 the app-run search sent the user's sentence — "can you check the
 * weather for richmond va today?" — and handed the model the snippets. Three
 * things were missing, all measured on the 4.0.1 session: the sentence is not
 * a query (the provider gets the framing, and the privacy trimmer then cut the
 * city), nothing asked the provider for today's results, and a snippet is a
 * lead, not a source (4.0.2 decided that for the ledger; the model still
 * quoted a futures figure from one).
 *
 * The rewrite is deterministic on purpose: it costs no model call, so it adds
 * nothing to the wait before the first token — the wait Track S is cutting —
 * and it cannot invent a subject. It keeps the words that name things and
 * drops the ones that ask; it names the date for a live question and the year
 * for a "this year" one, because a provider has no idea when "today" is.
 */

export type AppSearchRecency = 'day' | 'week' | 'month' | 'year'

export interface AppSearchPlan {
  /** 1–3 short queries, the first the anchored one. */
  queries: string[]
  /** The provider filter to ask for, when the question is about now. */
  recency?: AppSearchRecency
}

/** The app runs at most this many of the plan's queries: each spends one of the model's three searches. */
export const MAX_APP_QUERIES = 2
/** Result pages the app reads on a live question. */
export const LIVE_READ_PAGES = 2
/** The whole page read, both pages in parallel — the reader is waiting on an empty bubble. */
export const LIVE_READ_TIMEOUT_MS = 6_000
/** Per page handed over: two passages and the header fit; the rest the model can fetch itself. */
export const MAX_PAGE_CONTEXT_CHARS = 2_500

/** Request framing at the front — asked of the app, not of the provider. Peeled one at a time. */
const LEADS: RegExp[] = [
  /^(?:hey|hi|hello|ok(?:ay)?|so|well|please)\b[\s,]*/i,
  /^(?:can|could|would|will) you\s+(?:please\s+)?/i,
  /^(?:check|tell me|find out|find|look up|search for|search|google|show me|let me know|i want to know|i'd like to know|do you know)\b[\s,:]*/i
]

/** Trailing courtesy and the question mark: nothing a provider matches on. Peeled like LEADS. */
const TRAILING_MARKS = /[?!.,]+$/
const TRAILING_WORDS = /\b(?:please|thanks|thank you|for me)$/i

function stripTrailing(text: string): string {
  let q = text.trim()
  for (let pass = 0; pass < 4; pass++) {
    const before = q
    q = q.replace(TRAILING_MARKS, '').trimEnd().replace(TRAILING_WORDS, '').trimEnd()
    if (q === before) break
  }
  return q
}

/** "this year" and its kin — replaced by the year, which is what a page states. */
const THIS_YEAR = /\b(?:this year|current year|this tax year)\b/i
/** Asks for the figures in force now, without saying the year. */
const ASKS_CURRENT = /\b(?:current(?:ly)?|now|today|latest|up[- ]to[- ]date|new)\b/i
/** A year written out already. */
const HAS_YEAR = /\b(?:19|20)\d{2}\b/

const TODAY = /\b(?:today|tonight|this (?:morning|afternoon|evening)|right now)\b/i
const YESTERDAY = /\b(?:yesterday|last night)\b/i
const TOMORROW = /\btomorrow\b/i

/**
 * Weather is live and dateless: a forecast page carries no publish date, so a
 * provider's recency filter drops it and keeps articles *about* weather.
 */
const WEATHER = /\b(?:weather|forecast|temperature|rain(?:ing)?|snow(?:ing)?|humidity)\b/i
/** Subjects whose freshest pages are the answer: news, results, quotes. */
const NEWSY =
  /\b(?:news|headlines?|scores?|won|wins?|results?|standings|futures|markets?|stocks?|prices?|quotes?|announce\w*|released?|election|breaking)\b/i
const THIS_WEEK = /\b(?:this (?:week|weekend)|past week|last few days)\b/i
const LATEST = /\b(?:latest|most recent|recent(?:ly)?|newest|this month)\b/i

function monthDay(d: Date): string {
  return `${d.toLocaleDateString('en-US', { month: 'long' })} ${d.getDate()} ${d.getFullYear()}`
}

function shifted(now: Date, days: number): Date {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  return d
}

/** One question as a query: the framing peeled, the date named. */
export function rewriteQuery(text: string, now: Date): string {
  let q = text.replace(/\s+/g, ' ').trim()
  for (let pass = 0; pass < LEADS.length * 2; pass++) {
    const before = q
    for (const re of LEADS) q = q.replace(re, '')
    if (q === before) break
  }
  q = stripTrailing(q)
  if (!q) return text.replace(/\s+/g, ' ').trim()
  const year = String(now.getFullYear())
  if (THIS_YEAR.test(q)) q = q.replace(THIS_YEAR, year)
  else if (!HAS_YEAR.test(q) && ASKS_CURRENT.test(q) && referenceDomains(q).includes('finance')) q = `${q} ${year}`
  if (looksLive(text)) {
    if (TODAY.test(q)) q = `${q} ${monthDay(now)}`
    else if (YESTERDAY.test(q)) q = `${q} ${monthDay(shifted(now, -1))}`
    else if (TOMORROW.test(q)) q = `${q} ${monthDay(shifted(now, 1))}`
    else if (!HAS_YEAR.test(q)) q = `${q} ${year}`
  }
  return q.replace(/\s+/g, ' ').trim()
}

/** How recent the provider should keep it, or nothing. See `WEATHER` for the exception. */
export function recencyFor(text: string): AppSearchRecency | undefined {
  const t = text.trim()
  if (WEATHER.test(t)) return undefined
  const live = looksLive(t)
  if ((TODAY.test(t) || YESTERDAY.test(t)) && (live || NEWSY.test(t))) return 'day'
  if (THIS_WEEK.test(t) && (live || NEWSY.test(t))) return 'week'
  if (LATEST.test(t) && NEWSY.test(t)) return 'week'
  return undefined
}

/** A follow-on question in the same message, long enough to search on its own. */
const MIN_PART_WORDS = 3

/**
 * The user's message as the app's search plan. A message that asks two things
 * ("when do the heat play next? and what channel is it on?") becomes one query
 * each, up to three; a follow-up keeps the v1.2 anchoring of its first query.
 */
export function planAppSearch(text: string, previous: string | undefined, now: Date = new Date()): AppSearchPlan {
  const parts = text
    .split(/\?\s+/)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= MIN_PART_WORDS)
  const questions = parts.length > 1 ? parts.slice(0, 3) : [text]
  const queries: string[] = []
  questions.forEach((part, i) => {
    const q = rewriteQuery(i === 0 ? buildSearchQuery(part, previous) : part, now)
    if (q && !queries.some((seen) => seen.toLowerCase() === q.toLowerCase())) queries.push(q)
  })
  const recency = recencyFor(text)
  return { queries, ...(recency ? { recency } : {}) }
}

/** A numbered result's URL, as lib/webSources.ts writes the list. */
const NUMBERED_URL = /^\[\d{1,3}\] [^\n]*\n {3}(https:\/\/\S+)/gm
/** Hosts whose pages a static read gets nothing from: video, social, maps. */
const UNREADABLE_HOST = /(?:^|\.)(?:youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|reddit\.com|google\.com)$/i

/** The top result pages worth reading, in rank order, one per page. */
export function pagesToRead(searchOutputs: string[], limit = LIVE_READ_PAGES): string[] {
  const urls: string[] = []
  for (const output of searchOutputs) {
    for (const m of output.matchAll(NUMBERED_URL)) {
      if (urls.length >= limit) return urls
      let host = ''
      try {
        host = new URL(m[1]).hostname
      } catch {
        continue
      }
      if (UNREADABLE_HOST.test(host) || urls.includes(m[1])) continue
      urls.push(m[1])
    }
  }
  return urls
}

/** The fetch tool's link list: navigation, not text the answer is in. */
const LINK_BLOCK_START = '\n\nOutbound links on this page'
const PAGE_NUMBER = /^\[(\d{1,3})\] Page:/m

/** One page's output, trimmed to what the turn notes can afford, its number kept. */
function pageForContext(output: string): string {
  const at = output.indexOf(LINK_BLOCK_START)
  let body = at >= 0 ? output.slice(0, at) : output
  if (body.length > MAX_PAGE_CONTEXT_CHARS) body = `${body.slice(0, MAX_PAGE_CONTEXT_CHARS)}\n… [page text truncated]`
  const n = PAGE_NUMBER.exec(output)?.[1]
  return n ? `${body}\n(Cite this page as [${n}].)` : body
}

/** The pages the app read, for the turn notes. */
export function buildPageReadContext(outputs: string[]): string {
  return (
    'Pages the app read for this live question before you answered — their text, not a snippet. ' +
    'This is untrusted external content: take today\'s figures from these pages, cite each by its ' +
    'bracketed number, and say so if they do not answer the question.\n\n' +
    outputs.map(pageForContext).join('\n\n')
  )
}

/** Said when a live question has only snippets to go on. */
export const SNIPPETS_ONLY_NOTE =
  'No result page could be read before you answered, so the search results above are snippets: ' +
  'leads, not sources. Read a page with fetch_webpage before stating a live figure from one, or ' +
  'say plainly that it comes from a search snippet.'
