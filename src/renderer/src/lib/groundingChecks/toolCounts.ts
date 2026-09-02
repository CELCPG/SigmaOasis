// Split out of lib/toolGrounding.ts (v2.4): the "toolCounts" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import type { ToolCallRecord } from '../../types'
import { DISCLOSURE_HEADING, bareToolPattern } from './claimedTools'



// ---- how many times it ran (v2.2) ----------------------------------------------

/**
 * v2.2: the reply's account of **how many times** a tool ran.
 *
 * Measured, blind, round 9, task TH1 — the task whose prompt is, in as many
 * words, "tell me exactly which tools you used to get that and what each one
 * gave back". The reply answered with a table giving `reference_lookup` two
 * rows, each with its own query and its own results. One call ran. The
 * transcript holds one tool block and `trace/audit.jsonl` holds one entry, so
 * the app knew the true number the whole time and said nothing: every rung it
 * had stops at identity. `unrunToolClaims` asks whether a *named* tool ran at
 * all — it did. `undisclosedToolRuns` asks whether the account names the calls
 * that ran — it does. v1.17's rung asks whether the *arguments* are the ones
 * that went, and reads the two stated queries against the one that went, so
 * whichever row quotes the real query clears itself and the other is one
 * unmatched string rather than an invented call. None of them counts.
 *
 * A count is the same species as an argument and it is read the same way. Two
 * rows say two retrievals happened, so a reader takes the second row's
 * passages to be evidence the first did not have, and takes the coverage of
 * the question to be twice what it was.
 *
 * **Only overstatement speaks.** An account that lists fewer entries than the
 * turn ran is an account with a gap in it — `undisclosedToolRuns`' territory,
 * and that check deliberately stays quiet unless a section names *none* of the
 * calls. Claiming work that did not happen is the direction that misleads, and
 * it is the measured one.
 */

/** A line that offers one entry of a list: a table row, a bullet, a numbered item. */
const ENUMERATED_LINE = /^[ \t]{0,3}(?:\||[-*+][ \t]|\d{1,2}[.)][ \t])/

/**
 * The first unbroken run of entry lines after the disclosure heading — the
 * table or list the account is written as.
 *
 * Bounded to one run on purpose. `undisclosedToolRuns` takes the section as
 * the whole rest of the answer, which is right for asking whether a name
 * appears anywhere and wrong for counting: prose further down that mentions
 * the tool twice more would become two more calls. A run of adjacent rows is
 * what a reader counts, and stopping at the first blank or prose line is the
 * lenient direction — a second table for a second tool goes uncounted, which
 * costs a miss and cannot manufacture a finding.
 */
function firstEnumeration(section: string): string[] {
  const block: string[] = []
  for (const line of section.split('\n')) {
    if (ENUMERATED_LINE.test(line)) {
      block.push(line)
      continue
    }
    if (block.length > 0) break
  }
  return block
}

/**
 * Entries that name the tool. One line is one entry however many times it says
 * the name — a row with the tool in its "Tool" cell and again in its notes is
 * one row, and counting the occurrences instead would invent a call out of the
 * reply's own prose.
 */
function enumeratedEntries(section: string, name: string): number {
  const bare = bareToolPattern(name)
  return firstEnumeration(section).filter((line) => bare.test(line)).length
}

/** Written-out counts, up to the point where a reply starts using digits. */
const COUNT_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6
}

/**
 * The count said out loud rather than laid out in rows: "2 calls to
 * reference_lookup", "two reference_lookup lookups".
 *
 * The noun is the gate, and it has to be a word for *a call* — that is what
 * separates an account of the turn's work from "3 reference_lookup passages",
 * which counts something else entirely. Needs no heading above it, because the
 * tool's own name inside the phrase is what makes it a claim about that tool.
 *
 * v2.5: `N calls WERE MADE TO the reference_lookup tool` is the same claim in
 * the passive, and it is how the recorded corpus actually writes it
 * (`.h2h-runs/judge-r12/VC3/run-2`, where the number happens to be right).
 * Only the two words between the noun and `to`, and an article before the tool
 * name, are admitted: this is a detector, and every character of slack in it is
 * a way to read some other sentence as a count.
 */
const CALL_NOUNS = 'calls?|lookups?|queries|searches|invocations?|runs?'
/** The passive's own verb, and the only thing allowed to sit inside the phrase. */
const CALLS_WERE = '(?:(?:was|were)[ \\t]+(?:made|sent|issued|placed)[ \\t]+)?'

function statedCallCountPattern(name: string): RegExp {
  const written = Object.keys(COUNT_WORDS).join('|')
  const tool = `(?:the[ \\t]+)?\`?(?:${name}|${name.split('_').join('[ -]')})\`?`
  const qualifier = '(?:separate[ \\t]+|distinct[ \\t]+|different[ \\t]+)?'
  return new RegExp(
    `\\b(\\d{1,2}|${written})[ \\t]+${qualifier}` +
      `(?:(?:${CALL_NOUNS})[ \\t]+${CALLS_WERE}to[ \\t]+${tool}|${tool}[ \\t]+(?:${CALL_NOUNS}))\\b`,
    'gi'
  )
}

/** One tool, the number of calls the reply accounts for, and the number that ran. */
export interface OverstatedToolCount {
  name: string
  /** Entries the reply's account gives it, or the number it states outright. */
  claimed: number
  /** Calls the turn actually made, errored ones included — an errored call ran. */
  ran: number
}

/**
 * Tools the reply's own account credits with more calls than the turn made.
 *
 * Both readings of "how many" are taken, and the larger is reported: a table
 * with three rows and a sentence saying two are two accounts of one turn, and
 * the one a reader is more likely to carry away is the bigger. Neither reading
 * can speak about a tool that did not run — that is `unrunToolClaims`' finding,
 * not a miscount — and neither can speak when the account is short, which is
 * the lenient direction argued for above.
 */
export function overstatedToolCounts(
  answer: string,
  records: ToolCallRecord[]
): OverstatedToolCount[] {
  const ranByName = new Map<string, number>()
  for (const r of records) ranByName.set(r.name, (ranByName.get(r.name) ?? 0) + 1)
  if (ranByName.size === 0) return []
  const heading = DISCLOSURE_HEADING.exec(answer)
  const section = heading ? answer.slice(heading.index + heading[0].length) : ''
  const flagged: OverstatedToolCount[] = []
  for (const [name, ran] of ranByName) {
    let claimed = section === '' ? 0 : enumeratedEntries(section, name)
    for (const m of answer.matchAll(statedCallCountPattern(name))) {
      const written = m[1]!.toLowerCase()
      const stated = COUNT_WORDS[written] ?? Number(written)
      if (Number.isFinite(stated) && stated > claimed) claimed = stated
    }
    if (claimed > ran) flagged.push({ name, claimed, ran })
  }
  return flagged.sort((a, b) => a.name.localeCompare(b.name))
}

/** One finding, as the badge and the correction prompt both print it. */
export function describeToolCount(finding: OverstatedToolCount): string {
  return `${finding.name}: ${finding.claimed} calls accounted for, ${finding.ran} ran`
}

export function overstatedToolCountLines(answer: string, records: ToolCallRecord[]): string[] {
  return overstatedToolCounts(answer, records).map(describeToolCount)
}
