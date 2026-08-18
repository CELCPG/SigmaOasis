import type { ChatMessage, ToolCallRecord } from '../types'

/**
 * The conversation ledger (v1.9): a mechanical running record of what a
 * conversation has *established* — figures that were computed, files that
 * were attached, session variables that exist, constraints the user stated —
 * rebuilt from the message list every turn with no model call, and handed
 * to the model as turn context once a conversation is long enough for a
 * small model to have lost the thread.
 *
 * Why this and not the carry-forward summary that already exists: that
 * summary is written by a model, only when history is dropped, and it
 * *paraphrases*. A 9B reading "the total was around $139k" four turns later
 * will state $139,000 with confidence, and the grounding check will pass
 * it, because a summary is not a tool output. The ledger keeps the exact
 * strings the app can vouch for — a `run_python` stdout line, a
 * `finance_calculator` result, an attachment name — and refuses to record
 * anything it would have to interpret. It is the app's own memory of the
 * conversation, not the model's.
 *
 * What is recorded, and from where (never from an assistant's prose):
 *   - computed facts     `label: value` lines from run_python / calculator
 *                        stdout, and single-line calculator results
 *   - files              attachments, with the turn they arrived on
 *   - session state      the newest "Session variables:" list a run reported
 *   - user constraints   short imperative sentences from the user's own
 *                        messages that carry a figure or a hard word
 *                        ("budget is $2,000", "must be under 5 kg",
 *                        "no dairy") — the user's words, verbatim
 *
 * What is deliberately NOT recorded: anything the assistant said. Its
 * figures already pass through the grounding ladder; repeating them into
 * the ledger would launder an unverified number into a "fact".
 */

export interface LedgerFact {
  /** Human label, as the tool printed it. */
  label: string
  /** The value string exactly as printed — never reformatted. */
  value: string
  /** 1-based user-turn number the fact was established on. */
  turn: number
  /** Which tool established it. */
  via: string
}

export interface LedgerFile {
  name: string
  turn: number
}

export interface LedgerConstraint {
  /** The user's sentence, verbatim (trimmed, capped). */
  text: string
  turn: number
}

export interface Ledger {
  facts: LedgerFact[]
  files: LedgerFile[]
  sessionVars: string[]
  constraints: LedgerConstraint[]
  /** How many user turns the conversation has. */
  turns: number
}

/** Tools whose output the ledger trusts as established. Same family as consultedSources. */
const FACT_TOOLS = new Set(['run_python', 'finance_calculator', 'date_calculator', 'unit_converter', 'calculator'])

/** Turn context is added from this many user turns onward — below it the model can still see everything. */
export const LEDGER_MIN_TURNS = 4
export const LEDGER_MAX_FACTS = 24
export const LEDGER_MAX_CONSTRAINTS = 8
const CONSTRAINT_MAX_CHARS = 140

/** A `label: value` line where the value is a number (with unit/currency), a date, or a short token. */
const FACT_LINE = /^\s*([A-Za-z][A-Za-z0-9 _()%/.\-]{1,60}?)\s*[:=]\s*((?:[$€£]?\s?-?\d[\d,]*(?:\.\d+)?%?(?:\s?[A-Za-z%/]{1,12})?)|\d{4}-\d{2}-\d{2})\s*$/
/** Lines that are noise even when they look like label: value. */
const FACT_LINE_SKIP = /^(?:session variables|files available|note|python ran|stdout|stderr|error|traceback|warning|result)\b/i

/**
 * A user sentence that reads as a standing constraint: short, and carrying a
 * figure or a hard word. Verbatim capture — the ledger does not rephrase.
 */
const CONSTRAINT_HARD = /\b(?:must|never|only|no more than|at most|at least|under|below|above|over|budget|limit|maximum|minimum|max|min|deadline|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of|next)|allerg\w*|can't|cannot|don't|do not|avoid|exclude|without)\b/i
const HAS_FIGURE = /\d/
const QUESTION_LIKE = /\?\s*$|^\s*(?:what|how|why|when|where|which|who|can you|could you|would you|is|are|do|does)\b/i

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!])\s+(?=[A-Z0-9"'(])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Facts printed by one tool result. */
export function factsFromToolOutput(output: string, via: string, turn: number): LedgerFact[] {
  const out: LedgerFact[] = []
  const seen = new Set<string>()
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line || FACT_LINE_SKIP.test(line)) continue
    const m = FACT_LINE.exec(line)
    if (!m) continue
    const label = m[1].trim()
    const value = m[2].trim()
    // Two lines with the same label in one output: the last one wins (a
    // program that prints a running total prints the final one last).
    const key = label.toLowerCase()
    if (seen.has(key)) {
      const idx = out.findIndex((f) => f.label.toLowerCase() === key)
      if (idx >= 0) out.splice(idx, 1)
    }
    seen.add(key)
    out.push({ label, value, turn, via })
  }
  return out
}

/** The newest "Session variables (...): a, b, c." list in a run_python result, if any. */
export function sessionVarsFrom(output: string): string[] | null {
  const m = /Session variables[^:]*:\s*([^\n.]+)/.exec(output)
  if (!m) return null
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
}

/** Standing constraints stated in one user message, verbatim. */
export function constraintsFrom(text: string, turn: number): LedgerConstraint[] {
  const out: LedgerConstraint[] = []
  for (const s of splitSentences(text)) {
    if (s.length > CONSTRAINT_MAX_CHARS || s.length < 8) continue
    if (QUESTION_LIKE.test(s)) continue
    if (!CONSTRAINT_HARD.test(s)) continue
    if (!HAS_FIGURE.test(s) && !/\b(?:never|no|not|allerg\w*|avoid|exclude|without|only|must)\b/i.test(s)) continue
    out.push({ text: s, turn })
  }
  return out
}

/**
 * Rebuild the ledger from the conversation as it stands. Pure: the same
 * messages always give the same ledger, and nothing here reads the store.
 */
export function buildLedger(messages: readonly ChatMessage[]): Ledger {
  const facts: LedgerFact[] = []
  const files: LedgerFile[] = []
  const constraints: LedgerConstraint[] = []
  let sessionVars: string[] = []
  let turn = 0

  for (const m of messages) {
    if (m.role === 'user') {
      turn += 1
      for (const a of m.attachments ?? []) {
        if (a.name && !files.some((f) => f.name === a.name)) files.push({ name: a.name, turn })
      }
      constraints.push(...constraintsFrom(m.content, turn))
      continue
    }
    for (const rec of m.toolCalls ?? []) {
      if (rec.status !== 'done' || !rec.result) continue
      if (rec.name === 'run_python') {
        const vars = sessionVarsFrom(rec.result)
        if (vars) sessionVars = vars
      }
      if (!FACT_TOOLS.has(rec.name)) continue
      for (const f of factsFromToolOutput(rec.result, rec.name, turn)) {
        // A later fact with the same label supersedes: the ledger is a
        // current-state record, and "total: 139306.12" recomputed on turn 5
        // is the one that stands.
        const idx = facts.findIndex((x) => x.label.toLowerCase() === f.label.toLowerCase())
        if (idx >= 0) facts.splice(idx, 1)
        facts.push(f)
      }
    }
  }
  return {
    facts: facts.slice(-LEDGER_MAX_FACTS),
    files,
    sessionVars,
    constraints: dedupeConstraints(constraints).slice(-LEDGER_MAX_CONSTRAINTS),
    turns: turn
  }
}

function dedupeConstraints(items: LedgerConstraint[]): LedgerConstraint[] {
  const seen = new Set<string>()
  const out: LedgerConstraint[] = []
  for (const c of items) {
    const key = c.text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/** Nothing worth saying: no facts, no files, no constraints, no session. */
export function ledgerIsEmpty(l: Ledger): boolean {
  return l.facts.length === 0 && l.files.length === 0 && l.constraints.length === 0 && l.sessionVars.length === 0
}

/**
 * Should the ledger ride this turn? Long enough that a small model may have
 * lost track, and with something to record. Below the floor the model can
 * still see the whole conversation and the block would be dead weight.
 */
export function shouldInjectLedger(l: Ledger): boolean {
  return l.turns >= LEDGER_MIN_TURNS && !ledgerIsEmpty(l)
}

/**
 * The turn-context block. Facts carry the turn they were established on and
 * the tool that established them, so the model can cite "computed on turn 2"
 * rather than restate from memory — and so a user reading the disclosure can
 * check it. Rendered mechanically; the wording is stable turn to turn.
 */
export function buildLedgerContext(l: Ledger): string {
  const lines: string[] = [
    'Conversation ledger — what this conversation has established so far, recorded by the app ' +
      'from tool results and the user\'s own words (not from earlier replies). Use these exact ' +
      'values when a question refers back to them; do not recompute or restate them from memory, ' +
      'and if a new question needs a figure that is not here, compute it.'
  ]
  if (l.constraints.length > 0) {
    lines.push('', 'Constraints the user stated:')
    for (const c of l.constraints) lines.push(`- (turn ${c.turn}) ${c.text}`)
  }
  if (l.files.length > 0) {
    lines.push('', 'Files attached:')
    for (const f of l.files) lines.push(`- ${f.name} (turn ${f.turn}; available at /work/${f.name})`)
  }
  if (l.facts.length > 0) {
    lines.push('', 'Computed facts (label: value — tool, turn):')
    for (const f of l.facts) lines.push(`- ${f.label}: ${f.value} — ${f.via}, turn ${f.turn}`)
  }
  if (l.sessionVars.length > 0) {
    lines.push('', `Python session variables still defined: ${l.sessionVars.join(', ')}`)
  }
  return lines.join('\n')
}

/** What the bubble discloses under the reply: one line, mechanical. */
export function describeLedger(l: Ledger): string {
  const parts: string[] = []
  if (l.facts.length) parts.push(`${l.facts.length} computed fact${l.facts.length === 1 ? '' : 's'}`)
  if (l.files.length) parts.push(`${l.files.length} file${l.files.length === 1 ? '' : 's'}`)
  if (l.constraints.length) parts.push(`${l.constraints.length} constraint${l.constraints.length === 1 ? '' : 's'}`)
  if (l.sessionVars.length) parts.push(`${l.sessionVars.length} session variable${l.sessionVars.length === 1 ? '' : 's'}`)
  return `📒 Ledger: ${parts.join(', ')} from ${l.turns} turns`
}

/** Test seam / display helper: the records that would contribute, for a message. */
export function factRecordsOf(m: ChatMessage): ToolCallRecord[] {
  return (m.toolCalls ?? []).filter((r) => r.status === 'done' && !!r.result && FACT_TOOLS.has(r.name))
}
