// Split out of lib/toolGrounding.ts (v2.4): the "arguments" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import type { ToolCallRecord } from '../../types'
import { TOOL_DEFS } from '../../../../shared/tools'
import { RETRIEVAL_TOOLS, SOURCE_TOOLS } from './report'
import { ELISION, flattenQuote } from './quotations'
import { DISCLOSURE_HEADING, bareToolPattern } from './claimedTools'



// ---- stated arguments ------------------------------------------------------------

/**
 * v1.17: the reply's account of what it *passed* a tool, against what went.
 *
 * `unrunToolClaims` checks the tool's name and `undisclosedToolRuns` checks
 * that the account names every call. Both stop at the name. Measured, task
 * TH1: the user asked, in as many words, "tell me exactly which tools you used
 * to get that and what each one gave back", and the reply named the right tool
 * and gave this argument —
 *
 *     query: "ground beef safe internal temperature"
 *
 * — where `trace/audit.jsonl` and the tool block both show that what was sent
 * was the user's entire prompt, second clause and all. The name was correct, so
 * every rung above passed it; a blind critic scored the task a tie precisely
 * because neither build was ever put to the test on it.
 *
 * The difference is not cosmetic. A reader told the query was narrow and
 * targeted reads the passages under it as responsive to that query. What
 * actually happened is that a 151-character sentence went to a keyword-ranked
 * local library, which ranks on whichever words dominate it — a materially
 * different retrieval, and the stated argument is how the reader judges
 * whether the results answer the question at all.
 *
 * **Where the line falls.** A reply that paraphrases its call — "I looked up
 * the safe temperature for ground beef" — is describing its own work in its
 * own words and is making no checkable claim; this rung says nothing about it,
 * and must not, because a badge that fires on an honest paraphrase teaches the
 * reader to dismiss the badge (round 4, recorded). A reply that puts a string
 * in quotation marks and hands it to a named parameter has quoted the call.
 * So: **an argument in quotes is a quotation**, and it is judged exactly as
 * `misquotedSpans` judges one — against the string the call actually carried,
 * with an explicit ellipsis the only permitted cut.
 *
 * What makes that robust to the forms nobody has seen yet is the direction of
 * the vocabulary, which is round 5's lesson applied twice. The parameter names
 * come from the shared tool table rather than a list written here, and the
 * known-good set is *what the turn actually sent* — never an enumeration of
 * the shapes a fabrication takes. A phrasing this scanner does not recognise
 * costs a miss; it cannot manufacture a finding.
 */

/** The calls whose arguments decide what came back, hence what a reader acts on. */
const ARGUMENT_TOOLS = new Set([...SOURCE_TOOLS, ...RETRIEVAL_TOOLS])

/**
 * String parameters of those tools, read off the shipped schemas — rename a
 * parameter and this follows it, instead of going quietly blind on the new name.
 *
 * The restriction to source and retrieval tools is an argument, not a
 * convenience. Those arguments decide what the tool went and got; they are
 * short human-readable text a reader can compare by eye; and for a reader who
 * does not open the call block, the reply is the only place they appear. A
 * `run_python` body or a note's text is a different animal — long, structured,
 * rendered verbatim in its own block — and a reply quoting a fragment of one is
 * not making a claim about what was retrieved. Numbers are out for the same
 * reason plus a sharper one: `max_passages: 6` is not something a reader reads
 * the results through.
 */
const ARGUMENT_PARAMS: readonly string[] = [
  ...new Set(
    TOOL_DEFS.filter((d) => ARGUMENT_TOOLS.has(d.name)).flatMap((d) => {
      const props = (d.parameters as unknown as { properties?: Record<string, { type?: string }> })
        .properties
      return Object.entries(props ?? {})
        .filter(([, schema]) => schema?.type === 'string')
        .map(([name]) => name)
    })
  )
]

/**
 * Whatever markdown the reply wrapped the parameter name in before its value:
 * `query: "…"`, `**Query:** "…"`, `"query": "…"`, `| query | "…" |`,
 * `query ("…")`. Bounded, so the name and the value have to be adjacent.
 *
 * The quote glyphs are in here because the JSON form — which is how a model
 * that has just made a call most often writes one — closes the *name* with a
 * quote: `{"query": "…"}`. Without them the scanner read `": "` as a two-
 * character value and walked past the real one.
 */
const ARG_FURNITURE = '[\\s:=*_`|>()\\[\\]"“”–—-]{0,6}'

/**
 * The value as a reply writes it — straight quotes, curly quotes, or a code
 * span. Deliberately not the unquoted form: an unquoted value has no end a
 * scanner can find, and it is the quoting that turns a description of the call
 * into a claim about its exact text.
 */
const ARG_VALUE = '"([^"\\n]{2,240})"|“([^”\\n]{2,240})”|`([^`\\n]{2,240})`'

function statedArgumentPattern(param: string): RegExp {
  return new RegExp(`\\b${param.split('_').join('[ _-]')}\\b${ARG_FURNITURE}(?:${ARG_VALUE})`, 'gi')
}

/** How far back a stated argument may look for the call it is attributed to. */
const ARGUMENT_WINDOW = 200

/** Below this, a quoted fragment is a word in a sentence, not an account of a call. */
const MIN_STATED_ARG = 4

/** A value longer than this is elided in the finding, with the cut marked. */
const MAX_ARG_SHOWN = 72

/** At most this many actual values are named before the line stops enumerating. */
const MAX_ARG_SENT = 2

/**
 * A value as the badge shows it.
 *
 * Emphasis inside the value is the reply's own furniture, and leaking markdown
 * into a user-facing line is a defect this project has already recorded once
 * (round 6, task V2: a warning reading `rises to **$3…`). The ellipsis is the
 * app marking its own cut, which is the only honest way to shorten a string the
 * reader is being asked to compare.
 */
function showArgument(value: string): string {
  const flat = value.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ARG_SHOWN ? `${flat.slice(0, MAX_ARG_SHOWN - 1)}…` : flat
}

/**
 * Is the stated value the argument that went?
 *
 * Same standard as a quotation, and the same folding: whitespace, case and the
 * quote/dash glyphs a renderer introduces, plus the reply's own emphasis. A
 * stated value that is a contiguous part of what was sent is clean — the reply
 * quoted a fragment of its query rather than inventing one — and an explicit
 * ellipsis lets an honestly-shortened long query through, exactly as it does
 * for a passage.
 */
function argumentMatches(stated: string, passed: string[]): boolean {
  const flat = flattenQuote(stated.replace(/[*`]/g, ''))
  const parts = flat.split(ELISION).filter(Boolean)
  if (parts.length === 0) return true
  return passed.some((sent) => {
    const source = flattenQuote(sent)
    return parts.every((part) => source.includes(part))
  })
}

export interface StatedArgument {
  /** The parameter, as the tool table spells it. */
  param: string
  /** The value the reply put in quotes. */
  stated: string
  /** The distinct values calls this turn actually passed for that parameter. */
  passed: string[]
  /** Whether the call actually carried it — see `argumentMatches`. */
  matched: boolean
}

export interface MisstatedArgument {
  /** The parameter, as the tool table spells it. */
  param: string
  /** The value the reply put in quotes. */
  stated: string
  /** The distinct values calls this turn actually passed for that parameter. */
  passed: string[]
}

/**
 * Arguments the reply attributes to a call that the call never carried.
 *
 * Two gates keep this quiet, and both are the lenient direction. The reply has
 * to be talking about a call — a tool that ran this turn is named within reach,
 * or the statement sits under the reply's own tools-used heading — because the
 * word "query" beside a string in a code sample is not an account of anything.
 * And the parameter has to be one some call this turn actually passed: with
 * nothing sent there is nothing to contradict, and a reply describing a call
 * that never happened is `unrunToolClaims`' business, not this one.
 */
export function statedArgumentsIn(answer: string, records: ToolCallRecord[]): StatedArgument[] {
  const inScope = records.filter((r) => ARGUMENT_TOOLS.has(r.name))
  if (inScope.length === 0) return []
  const ranNames = [...new Set(inScope.map((r) => r.name))]
  const heading = DISCLOSURE_HEADING.exec(answer)
  const disclosureFrom = heading ? heading.index + heading[0].length : -1
  const found: StatedArgument[] = []
  const seen = new Set<string>()
  for (const param of ARGUMENT_PARAMS) {
    const passed = [
      ...new Set(
        inScope
          .map((r) => r.args?.[param])
          .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      )
    ]
    if (passed.length === 0) continue
    for (const m of answer.matchAll(statedArgumentPattern(param))) {
      const stated = (m[1] ?? m[2] ?? m[3] ?? '').trim()
      if (flattenQuote(stated).length < MIN_STATED_ARG) continue
      const at = m.index ?? 0
      const attributed =
        (disclosureFrom >= 0 && at >= disclosureFrom) ||
        ranNames.some((name) =>
          bareToolPattern(name).test(answer.slice(Math.max(0, at - ARGUMENT_WINDOW), at))
        )
      if (!attributed) continue
      const key = `${param}|${flattenQuote(stated)}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ param, stated, passed, matched: argumentMatches(stated, passed) })
    }
  }
  return found
}

export function misstatedArgumentsIn(
  answer: string,
  records: ToolCallRecord[]
): MisstatedArgument[] {
  return statedArgumentsIn(answer, records)
    .filter((a) => !a.matched)
    .map(({ param, stated, passed }) => ({ param, stated, passed }))
}

/** One finding, as the badge and the correction prompt both print it. */
export function describeMisstatedArgument(finding: MisstatedArgument): string {
  const sent = finding.passed
    .slice(0, MAX_ARG_SENT)
    .map((p) => `“${showArgument(p)}”`)
    .join(' / ')
  return `${finding.param}: “${showArgument(finding.stated)}” — the call sent ${sent}`
}

export function misstatedToolArguments(answer: string, records: ToolCallRecord[]): string[] {
  return misstatedArgumentsIn(answer, records).map(describeMisstatedArgument)
}
