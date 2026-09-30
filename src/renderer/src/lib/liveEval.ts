import { rate, type Rate } from './answerEval'

/**
 * v4.1 (M5): the live-world suite's pages and scoring — `EVAL_SUITES=live`
 * in `eval:answers` (runner: scripts/evalSuites/live.ts).
 *
 * The question the suite answers is the 4.1 gate's: asked about the weather,
 * a score or a futures quote, does the app put the web tools on the wire, run
 * the search, read the page, and answer with the page's figure for the day
 * asked — never a ledger entry, never another day's row? 4.0.1's measured
 * session failed every one of those on live questions (lib/grounding.ts,
 * `LIVE_DOMAINS`).
 *
 * Every place and market is fictional, so the only way to the figure is the
 * page. Each page is a small dated table, dated from the clock when the suite
 * runs, with a distinct figure per day: the day asked about answers, the
 * others are the wrong date. Mechanical throughout; no model grades a model.
 */

export type LiveKind = 'weather' | 'score' | 'futures'

export interface LiveFixture {
  file: string
  question: string
  kind: LiveKind
  /** The page the search finds: its title and file name on the loopback server. */
  title: string
  page: string
  /** One row per day, `day` counted from today (−1 yesterday). */
  rows: { day: number; text: string }[]
  /** The row that answers the question. */
  answerDay: number
  /** Patterns the answer row's figure matches; every one must be in the reply. */
  mustInclude: string[]
  /** Patterns only the other rows match: the wrong date's figure. */
  otherDays: string[]
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function dayOf(now: Date, offset: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12)
}

/** "Wednesday, September 30, 2026" — local time, as the grounding block dates the turn. */
export function longDate(d: Date): string {
  return `${d.toLocaleDateString('en-US', { weekday: 'long' })}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

/** The fixture's page, dated from `now`. Rows run oldest first, as a forecast or a results page lists them. */
export function renderLivePage(fx: LiveFixture, now: Date): string {
  const rows = [...fx.rows].sort((a, b) => a.day - b.day)
  const body = rows.map((r) => `<tr><th>${longDate(dayOf(now, r.day))}</th><td>${r.text}</td></tr>`).join('\n')
  return (
    `<!doctype html><html><head><title>${fx.title}</title></head><body>\n<h1>${fx.title}</h1>\n` +
    `<p>Updated ${longDate(dayOf(now, 0))}, 7:00 AM.</p>\n<table>\n${body}\n</table>\n</body></html>\n`
  )
}

/** "September 30" or "Sep 30" or "9/30", in a reply. */
function namedDates(text: string): { month: number; day: number }[] {
  const out: { month: number; day: number }[] = []
  const long = new RegExp(String.raw`\b(Sept\.?|${MONTHS.map((m) => `${m}|${m.slice(0, 3)}\\.?`).join('|')})\s+(\d{1,2})(?:st|nd|rd|th)?\b`, 'gi')
  for (const m of text.matchAll(long)) {
    const month = MONTHS.findIndex((x) => x.slice(0, 3).toLowerCase() === m[1]!.slice(0, 3).toLowerCase())
    out.push({ month, day: Number(m[2]) })
  }
  for (const m of text.matchAll(/\b(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])\b/g)) out.push({ month: Number(m[1]) - 1, day: Number(m[2]) })
  return out
}

export interface LiveAsk {
  reply: string
  /** The tool names the turn put on the wire. */
  wireTools: string[]
  /** web_search runs, the app's and the model's. */
  searches: number
  fetches: number
  /** The ledger rode the turn (it must not, on a live question). */
  ledgerServed: boolean
}

export interface LiveScore {
  webToolsOnWire: boolean
  searched: boolean
  fetched: boolean
  /** Every pattern for the day asked is in the reply. */
  answered: boolean
  /** Another day's figure, and not the day asked: the wrong row. */
  wrongDay: boolean
  /** Answered, no wrong row, and any date the reply names is the day asked. */
  dateCorrect: boolean
  noLedger: boolean
  /** Every line above held: the gate's "answered from a fetched page". */
  pass: boolean
}

export function scoreLiveAnswer(fx: LiveFixture, ask: LiveAsk, now: Date): LiveScore {
  const has = (p: string): boolean => new RegExp(p, 'i').test(ask.reply)
  const answered = fx.mustInclude.every(has)
  const wrongDay = !answered && fx.otherDays.some(has)
  const want = dayOf(now, fx.answerDay)
  const dates = namedDates(ask.reply)
  const dateCorrect = answered && (dates.length === 0 || dates.some((d) => d.month === want.getMonth() && d.day === want.getDate()))
  const webToolsOnWire = ask.wireTools.includes('web_search') && ask.wireTools.includes('fetch_webpage')
  const searched = ask.searches > 0
  const fetched = ask.fetches > 0
  const noLedger = !ask.ledgerServed
  return { webToolsOnWire, searched, fetched, answered, wrongDay, dateCorrect, noLedger, pass: webToolsOnWire && searched && fetched && dateCorrect && noLedger }
}

export interface LiveCaseResult {
  file: string
  kind: LiveKind
  question: string
  score?: LiveScore
  ask?: Omit<LiveAsk, 'reply'> & { reply: string; ms: number }
  error?: string
}

export interface LiveSummary {
  ran: Rate
  webToolsOnWire: Rate
  searched: Rate
  fetched: Rate
  answered: Rate
  wrongDay: Rate
  dateCorrect: Rate
  ledgerAnswers: Rate
  pass: Rate
  seconds: number
}

export function summarizeLive(results: LiveCaseResult[]): LiveSummary {
  const ok = results.filter((r) => r.score && !r.error)
  const n = (f: (s: LiveScore) => boolean): Rate => rate(ok.filter((r) => f(r.score!)).length, ok.length)
  const ms = ok.map((r) => r.ask?.ms ?? 0)
  return {
    ran: rate(ok.length, results.length),
    webToolsOnWire: n((s) => s.webToolsOnWire),
    searched: n((s) => s.searched),
    fetched: n((s) => s.fetched),
    answered: n((s) => s.answered),
    wrongDay: n((s) => s.wrongDay),
    dateCorrect: n((s) => s.dateCorrect),
    ledgerAnswers: n((s) => !s.noLedger),
    pass: n((s) => s.pass),
    seconds: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length / 1000 : 0
  }
}
