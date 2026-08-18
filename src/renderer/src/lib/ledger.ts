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

/**
 * v1.8.1: a decision — the user selecting among alternatives ("use the
 * median", "go with West", "let's do option 2"). Verbatim, like a constraint,
 * but a decision can be superseded: a later decision on the same subject
 * replaces the earlier one, because "actually, use the mean" is what the
 * user now wants and a ledger that still says "median" is worse than none.
 */
export interface LedgerDecision {
  text: string
  turn: number
}

export interface Ledger {
  facts: LedgerFact[]
  files: LedgerFile[]
  sessionVars: string[]
  constraints: LedgerConstraint[]
  decisions: LedgerDecision[]
  /** How many user turns the conversation has. */
  turns: number
}

/** Tools whose output the ledger trusts as established. Same family as consultedSources. */
const FACT_TOOLS = new Set(['run_python', 'finance_calculator', 'date_calculator', 'unit_converter', 'calculator', 'analyze_file'])

/**
 * analyze_file's profile is not `label: value` lines; its per-column stats are
 * ("- amount: number · 180 non-null · min 14.41 · max 897.61 · mean 468.2479 ·
 * median 501.32 · sum 84,284.63"). Measured (ledger eval, case 05): a 9B read
 * the total straight off the profile, never ran Python, and the ledger — which
 * only read run_python — recorded no fact; on the recall turn it then said,
 * truthfully about its own ledger, "nothing computed". The profile's stats are
 * exactly the computed facts worth remembering, so they are read here as
 * `<column> <stat>: <value>`.
 */
const PROFILE_COLUMN_LINE = /^-\s+([A-Za-z_][\w .()/-]{0,60}?):\s+number\s*·\s*(.+)$/
const PROFILE_STAT = /\b(min|max|mean|median|sum)\s+(-?[$€£]?\d[\d,]*(?:\.\d+)?)/g

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
  const push = (label: string, value: string): void => {
    const key = label.toLowerCase()
    if (seen.has(key)) {
      const idx = out.findIndex((f) => f.label.toLowerCase() === key)
      if (idx >= 0) out.splice(idx, 1)
    }
    seen.add(key)
    out.push({ label, value, turn, via })
  }
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line || FACT_LINE_SKIP.test(line)) continue
    if (via === 'analyze_file') {
      const col = PROFILE_COLUMN_LINE.exec(line)
      if (col) {
        for (const st of col[2].matchAll(PROFILE_STAT)) push(`${col[1].trim()} ${st[1]}`, st[2])
      }
      continue
    }
    const m = FACT_LINE.exec(line)
    if (!m) continue
    // Two lines with the same label in one output: the last one wins (a
    // program that prints a running total prints the final one last).
    push(m[1].trim(), m[2].trim())
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

export const LEDGER_MAX_DECISIONS = 8

/**
 * A user sentence that reads as a choice: a selecting verb ("use", "go with",
 * "pick", "let's do", "stick with", "switch to") or an explicit choice frame
 * ("option 2", "the second one", "instead"). Not a question, not a request
 * for information — a decision states what to do. Verbatim capture.
 */
const DECISION_VERB =
  /\b(?:use|go with|pick|choose|let'?s (?:do|use|go with|take)|stick with|switch to|prefer|we'?ll (?:use|go with|take)|i'?ll (?:take|go with))\b/i
const DECISION_FRAME = /\b(?:option \d|the (?:first|second|third|last) (?:one|option)|instead(?: of)?|rather than|not the)\b/i
const REQUEST_LIKE = /^\s*(?:please\s+)?(?:can|could|would|will|should|show|tell|give|explain|compute|calculate|find|list|what|how|why|is|are|do|does)\b/i

export function decisionsFrom(text: string, turn: number): LedgerDecision[] {
  const out: LedgerDecision[] = []
  for (const s of splitSentences(text)) {
    if (s.length > CONSTRAINT_MAX_CHARS || s.length < 6) continue
    if (QUESTION_LIKE.test(s) || REQUEST_LIKE.test(s)) continue
    if (!DECISION_VERB.test(s) && !DECISION_FRAME.test(s)) continue
    out.push({ text: s, turn })
  }
  return out
}

/**
 * Two decisions are "about the same subject" when they share a content word
 * (≥ 4 letters, not a decision verb). Coarse on purpose: the cost of a false
 * supersede is dropping an older decision the user may still hold; the cost
 * of no supersede is a stale one standing. Both are shown with their turn,
 * so the model and the user can see the order either way.
 */
const DECISION_STOP = new Set(['with', 'that', 'this', 'then', 'them', 'they', 'from', 'into', 'just', 'lets', 'will', 'shall', 'should', 'would', 'could', 'instead', 'rather', 'than', 'option', 'first', 'second', 'third', 'last', 'please', 'actually'])
function decisionSubject(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !DECISION_STOP.has(w) && !DECISION_VERB.test(w))
  )
}

function supersede(decisions: LedgerDecision[]): LedgerDecision[] {
  const out: LedgerDecision[] = []
  for (const d of decisions) {
    const subj = decisionSubject(d.text)
    // Drop any earlier decision that shares a subject word with this one.
    for (let i = out.length - 1; i >= 0; i--) {
      const prev = decisionSubject(out[i].text)
      let shared = false
      for (const w of subj) if (prev.has(w)) { shared = true; break }
      if (shared || out[i].text.toLowerCase() === d.text.toLowerCase()) out.splice(i, 1)
    }
    out.push(d)
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
  const decisions: LedgerDecision[] = []
  let sessionVars: string[] = []
  let turn = 0

  for (const m of messages) {
    if (m.role === 'user') {
      turn += 1
      for (const a of m.attachments ?? []) {
        if (a.name && !files.some((f) => f.name === a.name)) files.push({ name: a.name, turn })
      }
      constraints.push(...constraintsFrom(m.content, turn))
      decisions.push(...decisionsFrom(m.content, turn))
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
    decisions: supersede(decisions).slice(-LEDGER_MAX_DECISIONS),
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
  return l.facts.length === 0 && l.files.length === 0 && l.constraints.length === 0 && l.sessionVars.length === 0 && l.decisions.length === 0
}

/**
 * Should the ledger ride this turn? Long enough that a small model may have
 * lost track, and with something to record. Below the floor the model can
 * still see the whole conversation and the block would be dead weight —
 *
 * — with one exception (v1.8.1, measured): a live Python session. The
 * multi-turn suite showed a 9B on turn 2 restating turn 1's computed total
 * as $139,356.00 (true: 139,306.12) while re-reading the file it already
 * held. Paraphrase drift and the re-read habit, both on the very next turn.
 * Session state is the one kind of established fact the model needs
 * *immediately* — "you have `df` and `total: 139306.12`" is worth a block
 * on turn 2. So with session variables present the ledger rides from the
 * second user turn.
 */
export const LEDGER_MIN_TURNS_WITH_SESSION = 2

export function shouldInjectLedger(l: Ledger): boolean {
  if (ledgerIsEmpty(l)) return false
  const floor = l.sessionVars.length > 0 ? LEDGER_MIN_TURNS_WITH_SESSION : LEDGER_MIN_TURNS
  return l.turns >= floor
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
  if (l.decisions.length > 0) {
    lines.push('', 'Decisions the user made (latest on a subject stands):')
    for (const d of l.decisions) lines.push(`- (turn ${d.turn}) ${d.text}`)
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
    lines.push(
      '',
      `Python session variables still defined: ${l.sessionVars.join(', ')}. ` +
        'They persist in run_python — use them directly for a follow-up; do not read the data file again unless a variable you need is missing from this list.'
    )
  }
  return lines.join('\n')
}

/** What the bubble discloses under the reply: one line, mechanical. */
export function describeLedger(l: Ledger): string {
  const parts: string[] = []
  if (l.facts.length) parts.push(`${l.facts.length} computed fact${l.facts.length === 1 ? '' : 's'}`)
  if (l.files.length) parts.push(`${l.files.length} file${l.files.length === 1 ? '' : 's'}`)
  if (l.constraints.length) parts.push(`${l.constraints.length} constraint${l.constraints.length === 1 ? '' : 's'}`)
  if (l.decisions.length) parts.push(`${l.decisions.length} decision${l.decisions.length === 1 ? '' : 's'}`)
  if (l.sessionVars.length) parts.push(`${l.sessionVars.length} session variable${l.sessionVars.length === 1 ? '' : 's'}`)
  return `📒 Ledger: ${parts.join(', ')} from ${l.turns} turns`
}

/** Test seam / display helper: the records that would contribute, for a message. */
export function factRecordsOf(m: ChatMessage): ToolCallRecord[] {
  return (m.toolCalls ?? []).filter((r) => r.status === 'done' && !!r.result && FACT_TOOLS.has(r.name))
}
