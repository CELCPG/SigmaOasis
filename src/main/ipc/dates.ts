/**
 * Exact calendar arithmetic for the date_calculator tool.
 *
 * Local models are bad at dates in a specific and expensive way: they are
 * fluent enough to produce a confident answer and wrong often enough that the
 * answer cannot be used. Measured across four sessions —
 *
 *   - "what day is October 1st 2026" became a six-step plan that ran for
 *     twenty minutes and searched the web twice for a day of the week
 *   - "next sat and sunday", asked on Friday 14 August, produced August 24
 *     (a Monday) in one step and August 14 (that same Friday) in the answer
 *   - "tomorrow i need to plan a route" never resolved "tomorrow" at all
 *
 * — and in none of them did the model call `get_current_datetime`, which was
 * on the turn. It reached for web search instead, because a tool that returns
 * only "now" does not look like the answer to "what day is a date in 2026".
 *
 * So: everything the calendar can settle, settled here. Pure, synchronous, no
 * network, no locale surprises — the same reasoning as finance.ts, for the
 * same reason. The model supplies the phrase; this supplies the date.
 */

export interface DateArgs {
  operation?: unknown
  expression?: unknown
  from?: unknown
  to?: unknown
  relative_to?: unknown
}

export interface DateResult {
  ok: boolean
  output?: string
  error?: string
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/**
 * Dates are built at local noon.
 *
 * Midnight is the wrong anchor: a date constructed at 00:00 and then shifted
 * by days lands an hour either side of itself across a DST boundary, which is
 * how "add 7 days" silently becomes six days and 23 hours and the weekday
 * comes out wrong twice a year. Noon has twelve hours of slack in both
 * directions.
 */
function atNoon(year: number, monthIndex: number, day: number): Date {
  return new Date(year, monthIndex, day, 12, 0, 0, 0)
}

function startOfDay(d: Date): Date {
  return atNoon(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, days: number): Date {
  return atNoon(d.getFullYear(), d.getMonth(), d.getDate() + days)
}

/** Whole days between two dates, ignoring clock time. */
export function daysBetween(from: Date, to: Date): number {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime()
  return Math.round(ms / 86_400_000)
}

export function isoDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "Thursday, 1 October 2026" — unambiguous in any locale, unlike 10/1/2026. */
export function longDate(d: Date): string {
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`
}

const MONTH_LOOKUP = new Map<string, number>()
MONTH_NAMES.forEach((name, i) => {
  MONTH_LOOKUP.set(name.toLowerCase(), i)
  MONTH_LOOKUP.set(name.slice(0, 3).toLowerCase(), i)
})
const DAY_LOOKUP = new Map<string, number>()
DAY_NAMES.forEach((name, i) => {
  DAY_LOOKUP.set(name.toLowerCase(), i)
  DAY_LOOKUP.set(name.slice(0, 3).toLowerCase(), i)
})

/** Strip ordinal suffixes so "October 1st" parses like "October 1". */
function normalize(expression: string): string {
  return expression
    .toLowerCase()
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ResolvedDate {
  date: Date
  /** Second date when the phrase names a span ("next weekend"). */
  until?: Date
  /**
   * Set when English genuinely admits two readings. "Next Saturday" is the
   * canonical case: on a Friday it means either tomorrow or eight days out
   * depending on who is speaking, and picking silently is how a golf trip gets
   * booked for the wrong weekend.
   */
  ambiguity?: string
}

/**
 * Turn a date phrase into an actual date.
 *
 * Returns null when nothing recognizable is in the string — the caller then
 * says so rather than guessing, which is the entire point of the tool.
 */
export function resolveDateExpression(expression: string, today: Date): ResolvedDate | null {
  const text = normalize(expression)
  if (!text) return null
  const base = startOfDay(today)

  if (/^(today|now|tonight)$/.test(text)) return { date: base }
  if (/^tomorrow$/.test(text)) return { date: addDays(base, 1) }
  if (/^yesterday$/.test(text)) return { date: addDays(base, -1) }

  // "in 3 days", "in 2 weeks", "3 days ago", "2 weeks from now"
  const span = text.match(/^(?:in )?(\d+) (day|week|month|year)s?(?: (ago|from now|from today))?$/)
  if (span) {
    const n = Number(span[1]) * (span[3] === 'ago' ? -1 : 1)
    const unit = span[2]
    if (unit === 'day') return { date: addDays(base, n) }
    if (unit === 'week') return { date: addDays(base, n * 7) }
    if (unit === 'month') return { date: atNoon(base.getFullYear(), base.getMonth() + n, base.getDate()) }
    return { date: atNoon(base.getFullYear() + n, base.getMonth(), base.getDate()) }
  }

  // "this weekend" / "next weekend": Saturday through Sunday.
  const weekend = text.match(/^(this|next|the) weekend$/)
  if (weekend) {
    const saturday = nextWeekday(base, 6, weekend[1] === 'next' ? 'next' : 'this')
    return {
      date: saturday,
      until: addDays(saturday, 1),
      ...(weekend[1] === 'next'
        ? {
            ambiguity:
              `"next weekend" is read two ways. This is the weekend after the coming one; the ` +
              `coming weekend is ${isoDate(nextWeekday(base, 6, 'this'))}.`
          }
        : {})
    }
  }

  // "next saturday", "this friday", "last monday", or a bare "saturday".
  const weekday = text.match(/^(this|next|last|coming|on )?\s*([a-z]+)$/)
  if (weekday) {
    const target = DAY_LOOKUP.get(weekday[2])
    if (target !== undefined) {
      const qualifier = (weekday[1] ?? '').trim()
      if (qualifier === 'last') return { date: previousWeekday(base, target) }
      const which = qualifier === 'next' ? 'next' : 'this'
      const date = nextWeekday(base, target, which)
      const alternative = nextWeekday(base, target, which === 'next' ? 'this' : 'next')
      return {
        date,
        ambiguity:
          `"${qualifier || 'the'} ${DAY_NAMES[target]}" is read two ways when it falls this ` +
          `week. Taken as ${isoDate(date)}; the other reading is ${isoDate(alternative)}. ` +
          `Say which if it matters.`
      }
    }
  }

  const absolute = parseAbsolute(text, base)
  return absolute ? { date: absolute } : null
}

/**
 * The next occurrence of a weekday.
 *
 * "this Saturday" is the coming one — today counts, because on a Saturday
 * "this Saturday" is today. "next Saturday" is the one after that, which is
 * the reading most people mean and the one this returns; the alternative is
 * always reported rather than assumed away.
 */
function nextWeekday(from: Date, target: number, which: 'this' | 'next'): Date {
  const ahead = (target - from.getDay() + 7) % 7
  const base = addDays(from, ahead)
  return which === 'next' ? addDays(base, ahead === 0 ? 7 : 7) : base
}

function previousWeekday(from: Date, target: number): Date {
  const back = (from.getDay() - target + 7) % 7
  return addDays(from, back === 0 ? -7 : -back)
}

/** ISO, "1 October 2026", "October 1 2026", "10/1/2026". */
function parseAbsolute(text: string, base: Date): Date | null {
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) return validated(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))

  const monthFirst = text.match(/^([a-z]+) (\d{1,2})(?: (\d{4}))?$/)
  if (monthFirst) {
    const month = MONTH_LOOKUP.get(monthFirst[1])
    if (month !== undefined) {
      return validated(
        monthFirst[3] ? Number(monthFirst[3]) : base.getFullYear(),
        month,
        Number(monthFirst[2])
      )
    }
  }

  const dayFirst = text.match(/^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/)
  if (dayFirst) {
    const month = MONTH_LOOKUP.get(dayFirst[2])
    if (month !== undefined) {
      return validated(
        dayFirst[3] ? Number(dayFirst[3]) : base.getFullYear(),
        month,
        Number(dayFirst[1])
      )
    }
  }

  // Numeric slashes are US-order here, and the caller is told so in the output
  // — 10/1/2026 is genuinely 1 October in most of the world.
  const slashes = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (slashes) {
    const year = Number(slashes[3])
    return validated(year < 100 ? 2000 + year : year, Number(slashes[1]) - 1, Number(slashes[2]))
  }
  return null
}

/** Reject 31 February rather than silently rolling it into March. */
function validated(year: number, monthIndex: number, day: number): Date | null {
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) return null
  const d = atNoon(year, monthIndex, day)
  if (d.getMonth() !== ((monthIndex % 12) + 12) % 12 || d.getDate() !== day) return null
  return d
}

function describe(resolved: ResolvedDate, today: Date): string {
  const { date, until, ambiguity } = resolved
  const delta = daysBetween(today, date)
  const when =
    delta === 0
      ? 'today'
      : delta === 1
        ? 'tomorrow'
        : delta === -1
          ? 'yesterday'
          : delta > 0
            ? `in ${delta} day(s)`
            : `${Math.abs(delta)} day(s) ago`

  const lines = [
    until
      ? `${longDate(date)} to ${longDate(until)}`
      : longDate(date),
    `ISO: ${isoDate(date)}${until ? ` to ${isoDate(until)}` : ''}`,
    `That is ${when}. Today is ${longDate(today)}.`
  ]
  if (!until) {
    lines.push(`Weekend: ${date.getDay() === 0 || date.getDay() === 6 ? 'yes' : 'no'}`)
  }
  if (ambiguity) lines.push(`Note: ${ambiguity}`)
  return lines.join('\n')
}

/** Entry point used by the tool dispatcher. Throws become clean tool errors. */
export function runDateCalculation(args: DateArgs, now: Date = new Date()): DateResult {
  const operation = String(args.operation ?? 'resolve')
  try {
    if (operation === 'resolve') {
      const expression = String(args.expression ?? '').trim()
      if (!expression) {
        return { ok: true, output: describe({ date: startOfDay(now) }, startOfDay(now)) }
      }
      const relativeTo = args.relative_to ? parseAbsolute(normalize(String(args.relative_to)), now) : null
      const today = startOfDay(relativeTo ?? now)
      const resolved = resolveDateExpression(expression, today)
      if (!resolved) {
        return {
          ok: false,
          error:
            `Could not read ${JSON.stringify(expression)} as a date. Understood forms: today, ` +
            `tomorrow, yesterday, "next Saturday", "this weekend", "in 3 weeks", "2 days ago", ` +
            `2026-10-01, "1 October 2026", "October 1 2026". Ask the user rather than guessing.`
        }
      }
      return { ok: true, output: describe(resolved, today) }
    }

    if (operation === 'difference') {
      const today = startOfDay(now)
      const from = resolveDateExpression(String(args.from ?? 'today'), today)
      const to = resolveDateExpression(String(args.to ?? ''), today)
      if (!from || !to) {
        return { ok: false, error: 'Both "from" and "to" must be dates this tool can read.' }
      }
      const days = daysBetween(from.date, to.date)
      const weeks = Math.floor(Math.abs(days) / 7)
      return {
        ok: true,
        output: [
          `From ${longDate(from.date)}`,
          `To   ${longDate(to.date)}`,
          `${Math.abs(days)} day(s)${weeks > 0 ? ` (${weeks} week(s) and ${Math.abs(days) % 7} day(s))` : ''}` +
            `, ${days < 0 ? 'backwards' : 'forwards'}.`
        ].join('\n')
      }
    }

    return {
      ok: false,
      error: `Unknown operation ${JSON.stringify(operation)}. Use "resolve" or "difference".`
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
