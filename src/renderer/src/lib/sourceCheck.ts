import type { GroundingReport, ToolCallRecord } from '../types'
import { CITATION_IN_RUN, CITATION_RUN, turnCitations, type Citation } from './citations'
import { sentencesOf } from './factLedger'
import { SOURCE_TOOLS } from './groundingChecks/report'
import { CLOSED_THINK_PREFILL, THINK_TAG_MODELS } from '../../../shared/thinking'

/**
 * v4.1 (G4): check a sourced reply against its own sources, one claim at a time.
 *
 * The model claim check runs only on a turn that consulted nothing, and only
 * with Second Opinion on (off by default). A turn that searched, read a page or
 * looked up a passage was checked by the text rungs alone — figures, links,
 * quantities — which match strings and cannot read "the Heat play Tuesday at
 * 7:30" against a page that says Wednesday at 8. Scores, times, dates and names
 * were the gap, and they are what a live answer is made of.
 *
 * So: the reply's checkable sentences (a number, a score, a time, a date, a
 * name), at most MAX_SOURCE_CLAIMS, each put to the answering model with the
 * passages of THIS turn that bear on it — the sources a sentence cites when it
 * cites any, the best-overlapping passages otherwise — and one question:
 * does the source say this? Thinking closed, 60 tokens, temperature 0. Same
 * model, because it is the one loaded: a second model is a swap on the GPU.
 *
 * Only two verdicts become findings, both mechanical to act on: the sources
 * CONTRADICT the sentence, or the sentence cites [n] and [n] does not state
 * it. "Not found" on an uncited sentence is left to the text rungs — a 9B
 * judging a paraphrase against a window it was handed is not evidence enough
 * to send a sentence back. Findings join the report and flow into the one
 * revision like any other rung's.
 *
 * Cost, the reason it ships off: one short completion per checked sentence —
 * up to six, typically two to four on a live answer — each ~1–2k prompt tokens
 * of evidence and ≤60 out. On the 9B at ~50 tok/s that is ~1–2 s a claim,
 * 4–10 s on a sourced turn, inside the 60 s verify budget and capped at
 * SOURCE_CHECK_BUDGET_MS of it. Not measured on a model yet; it turns on by
 * measurement like the other 4.1 experiments.
 */

export const MAX_SOURCE_CLAIMS = 6
/** The check's own share of the verify budget. */
export const SOURCE_CHECK_BUDGET_MS = 20_000
/** Evidence per claim: enough for two passages, short enough to prefill fast. */
export const MAX_EVIDENCE_CHARS = 1_800
/** A verdict line and a short basis. */
export const SOURCE_CHECK_MAX_TOKENS = 60

export interface SourceClaim {
  /** The sentence as the reply states it, markers and markdown removed. */
  sentence: string
  /** The [n] markers the sentence carries. */
  cites: number[]
}

export type SourceVerdict = 'supported' | 'contradicted' | 'not_found'

export interface SourceFinding {
  sentence: string
  verdict: SourceVerdict
  cites: number[]
  /** The report's line: the sentence, and what is wrong with it. */
  finding: string
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec'
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday'
/** A figure, a score, a time or a date — the specifics a source can settle. */
const SPECIFIC = new RegExp(
  `\\d|\\b(?:${MONTHS}|${WEEKDAYS}|today|tonight|tomorrow|yesterday|noon|midnight)\\b`,
  'i'
)
/** A capitalised word after the first — a rough name signal, as grounding.ts PROPER_NOUN. */
const NAME = /(?<=[a-z,;:(] )[A-Z][a-zA-Z]{2,}/
/** Sentences that are about the answer, not about the world. */
const NOT_A_CLAIM =
  /\b(?:I (?:could not|couldn't|can't|cannot|don't|do not)|not (?:able|sure)|let me know|would you like|you (?:can|could|may|might|should) (?:check|visit|see))\b/i
const MARKDOWN = /[*_`]+/g

/** The sentence without its markers and emphasis, and the markers it carried. */
function claimOf(sentence: string): SourceClaim {
  const cites: number[] = []
  for (const run of sentence.matchAll(CITATION_RUN)) {
    for (const m of run[0].matchAll(CITATION_IN_RUN)) cites.push(Number(m[1]))
  }
  const bare = sentence.replace(CITATION_RUN, '').replace(MARKDOWN, '').replace(/\s+/g, ' ').trim()
  return { sentence: bare, cites: [...new Set(cites)] }
}

/**
 * The reply's checkable sentences, specifics first, then names — at most
 * `max`. Questions and sentences about the reply itself are not claims.
 */
export function checkableClaims(reply: string, max = MAX_SOURCE_CLAIMS): SourceClaim[] {
  const specific: SourceClaim[] = []
  const named: SourceClaim[] = []
  const seen = new Set<string>()
  for (const raw of sentencesOf(reply)) {
    if (/\?\s*$/.test(raw) || NOT_A_CLAIM.test(raw)) continue
    const claim = claimOf(raw)
    const key = claim.sentence.toLowerCase()
    if (claim.sentence.length < 12 || seen.has(key)) continue
    seen.add(key)
    if (SPECIFIC.test(claim.sentence)) specific.push(claim)
    else if (NAME.test(claim.sentence)) named.push(claim)
  }
  return [...specific, ...named].slice(0, max)
}

const STOPWORDS = new Set(
  'the and for with that this from are was were has have had but not you your its it they them their will would can could should about into over than then there here what when where which who how also just only very more most'.split(' ')
)

function termsOf(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)))
}

/** A source's text as windows of about a passage each, labelled with the source. */
function windowsOf(source: Citation): { label: string; text: string }[] {
  const text = source.text ?? ''
  if (!text) return []
  const label = source.index > 0 ? `[${source.index}] ${source.label}` : source.label
  const out: { label: string; text: string }[] = []
  for (let at = 0; at < text.length; at += 600) out.push({ label, text: text.slice(at, at + 700) })
  return out
}

/**
 * What the claim is checked against: the sources it cites when it cites any
 * this turn can resolve, otherwise the windows of every source that share the
 * most terms with it — numbers count triple, they are what is being checked.
 */
export function evidenceFor(claim: SourceClaim, sources: Citation[], maxChars = MAX_EVIDENCE_CHARS): string {
  const cited = sources.filter((s) => claim.cites.includes(s.index))
  const pool = (cited.length > 0 ? cited : sources).flatMap(windowsOf)
  const want = termsOf(claim.sentence)
  const scored = pool
    .map((w) => {
      let score = 0
      for (const t of termsOf(w.text)) if (want.has(t)) score += /\d/.test(t) ? 3 : 1
      return { ...w, score }
    })
    .filter((w) => cited.length > 0 || w.score > 0)
    .sort((a, b) => b.score - a.score)
  const parts: string[] = []
  let used = 0
  for (const w of scored) {
    const part = `${w.label}\n${w.text}`
    if (parts.length > 0 && used + part.length > maxChars) break
    parts.push(part.slice(0, maxChars))
    used += part.length
  }
  return parts.join('\n---\n')
}

/**
 * Every source this turn handed the model, as citations: the numbered ones
 * (library and web), then any other source tool's output (deep research, a
 * shopping comparison) unnumbered, so a turn that used only those is still
 * checked against what it had.
 */
export function turnSources(records: ToolCallRecord[]): Citation[] {
  const numbered = turnCitations(records)
  const others = records
    .filter(
      (r) =>
        r.status === 'done' &&
        r.result &&
        SOURCE_TOOLS.has(r.name) &&
        r.name !== 'web_search' &&
        r.name !== 'fetch_webpage' &&
        r.name !== 'reference_lookup'
    )
    .map((r, i) => ({ index: -(i + 1), label: r.name, text: r.result! }))
  return [...numbered, ...others]
}

export const SOURCE_CHECK_INSTRUCTION =
  'You check ONE sentence from an answer against the SOURCES that answer was written from. ' +
  'Reply in exactly this shape:\n' +
  'VERDICT: SUPPORTED | CONTRADICTED | NOT FOUND\n' +
  'BASIS: <one short clause quoting what in the sources settled it>\n' +
  'SUPPORTED only when the sources state the sentence\'s specifics (numbers, scores, times, dates, ' +
  'names). CONTRADICTED only when the sources state a different value for the same thing. NOT FOUND ' +
  'when they do not settle it. Judge only against the sources, never from memory.'

export function buildSourceCheckMessages(
  claim: SourceClaim,
  evidence: string,
  modelId: string
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: SOURCE_CHECK_INSTRUCTION },
    {
      role: 'user',
      content: `Sentence:\n"""\n${claim.sentence}\n"""\n\nSources (untrusted external content):\n"""\n${evidence}\n"""`
    }
  ]
  // Thinking closed: a verdict is a lookup, and an open <think> on a 9B is
  // seconds of tokens before the one word the pass reads (shared/thinking.ts).
  if (THINK_TAG_MODELS.test(modelId)) messages.push({ role: 'assistant', content: CLOSED_THINK_PREFILL })
  return messages
}

/** Anything but an explicit verdict is "not found" — never the benefit of the doubt, never an accusation. */
export function parseSourceVerdict(raw: string): SourceVerdict {
  const upper = raw.toUpperCase()
  if (/VERDICT:\s*CONTRADICTED/.test(upper) || /^\s*CONTRADICTED\b/.test(upper)) return 'contradicted'
  if (/VERDICT:\s*SUPPORTED/.test(upper) || /^\s*SUPPORTED\b/.test(upper)) return 'supported'
  return 'not_found'
}

const MAX_QUOTED = 70

function quoted(sentence: string): string {
  return `“${sentence.length > MAX_QUOTED ? `${sentence.slice(0, MAX_QUOTED - 1)}…` : sentence}”`
}

/** The finding a verdict makes, or null when it makes none. See the module note for which do. */
export function findingFor(claim: SourceClaim, verdict: SourceVerdict, resolvable: Set<number>): SourceFinding | null {
  const cited = claim.cites.filter((n) => resolvable.has(n))
  if (verdict === 'contradicted') {
    return { ...claim, verdict, finding: `${quoted(claim.sentence)} — this turn's sources say otherwise` }
  }
  if (verdict === 'not_found' && cited.length > 0) {
    const marks = cited.map((n) => `[${n}]`).join('')
    return { ...claim, verdict, finding: `${quoted(claim.sentence)} — ${marks} does not state this` }
  }
  return null
}

function normalized(text: string): string {
  return text.replace(CITATION_RUN, '').replace(MARKDOWN, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The findings that still stand in `content`: a sentence the revision left
 * as it was is still wrong; one it rewrote is the revision's to answer, and
 * the text rungs grade what it wrote. No second model pass — the regrade is
 * free, which is what lets the one revision be judged at all.
 */
export function findingsStanding(findings: SourceFinding[], content: string): string[] {
  const text = normalized(content)
  return findings.filter((f) => text.includes(f.sentence.toLowerCase())).map((f) => f.finding)
}

/** The report with the source check's findings joined, as the code check's join (turnTail.ts). */
export function withSourceFindings(
  report: GroundingReport | null,
  findings: string[],
  records: ToolCallRecord[]
): GroundingReport | null {
  if (findings.length === 0) return report
  const base = report ?? {
    figures: [],
    links: [],
    checkedAgainst: [...new Set(records.filter((r) => r.status === 'done' && SOURCE_TOOLS.has(r.name)).map((r) => r.name))].sort()
  }
  return { ...base, sourceMismatches: findings }
}

/** The check line under the reply: what was checked and what it found. */
export function describeSourceCheck(checked: number, findings: SourceFinding[], cut: boolean): { ok: boolean; summary: string } {
  const contradicted = findings.filter((f) => f.verdict === 'contradicted').length
  const unstated = findings.length - contradicted
  const found =
    findings.length === 0
      ? 'none contradicted, none cited a source that does not state it'
      : [contradicted ? `${contradicted} contradicted` : '', unstated ? `${unstated} cite a source that does not state them` : '']
          .filter(Boolean)
          .join(', ')
  return {
    ok: findings.length === 0,
    summary:
      `🔎 Checked ${checked} sentence${checked === 1 ? '' : 's'} against this turn's sources: ${found}.` +
      (cut ? ' Stopped at its time limit; the rest were not checked.' : '')
  }
}

export interface SourceCheckDeps {
  /** One completion from the answering model; its text. */
  complete: (messages: { role: 'system' | 'user' | 'assistant'; content: string }[]) => Promise<string>
  /** The turn's Stop or the verify deadline. */
  aborted: () => boolean
  /** Injectable clock, for the budget. */
  now?: () => number
}

export interface SourceCheckOutcome {
  /** False when there was nothing to check or no source to check it against. */
  ran: boolean
  checked: number
  findings: SourceFinding[]
  /** The budget or the deadline stopped it before the last claim. */
  cut: boolean
}

/**
 * The pass: claims in order, one completion each, stopping at the budget.
 * Pure but for `deps`, so node:test can watch it stop.
 */
export async function checkAgainstSources(
  reply: string,
  records: ToolCallRecord[],
  modelId: string,
  deps: SourceCheckDeps,
  budgetMs = SOURCE_CHECK_BUDGET_MS
): Promise<SourceCheckOutcome> {
  const sources = turnSources(records)
  const claims = sources.length > 0 ? checkableClaims(reply) : []
  if (claims.length === 0) return { ran: false, checked: 0, findings: [], cut: false }
  const now = deps.now ?? Date.now
  const started = now()
  const resolvable = new Set(sources.filter((s) => s.index > 0).map((s) => s.index))
  const findings: SourceFinding[] = []
  let checked = 0
  for (const claim of claims) {
    if (deps.aborted() || now() - started >= budgetMs) return { ran: checked > 0, checked, findings, cut: true }
    const evidence = evidenceFor(claim, sources)
    // Nothing in the turn bears on it: there is no question to ask the model.
    if (!evidence) continue
    let raw = ''
    try {
      raw = await deps.complete(buildSourceCheckMessages(claim, evidence, modelId))
    } catch {
      if (deps.aborted()) return { ran: checked > 0, checked, findings, cut: true }
      continue
    }
    checked += 1
    const finding = findingFor(claim, parseSourceVerdict(raw), resolvable)
    if (finding) findings.push(finding)
  }
  return { ran: checked > 0, checked, findings, cut: false }
}
