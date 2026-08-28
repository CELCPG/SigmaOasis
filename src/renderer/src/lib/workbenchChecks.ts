import type { ModelConfig } from '../types'
import type { FailureDetail } from '../../../shared/failure'

/**
 * v1.6 Workbench verification hooks — the headless rules.
 *
 * Two mechanical checks the app can run on a finished reply, because the
 * sandbox makes them cheap and exact:
 *
 * 1. Recompute. A reply that states figures with no computation behind them
 *    (no run_python or calculator ran this turn) is asked — the answerer, not
 *    a critic — for *only* a Python program that recomputes each stated figure
 *    from the question's inputs. The program runs as a real run_python record,
 *    and the existing tool-grounding pass then judges the reply's figures
 *    against that stdout, exactly as it judges them against a calculator. An
 *    arithmetic slip becomes an unsupported figure and goes through the same
 *    one-revision gate. Nothing new is invented for numbers.
 *
 * 2. Code check. A reply containing a self-contained Python block is run. A
 *    failure of the kinds a small model produces (syntax, a name it never
 *    defined, a wrong attribute, its own assertion) becomes a grounding
 *    finding; the revision's code is run again and the revision is kept only
 *    if it now runs. Environmental failures (a file the sandbox has not got,
 *    a missing third-party module) are not the model's error and are not
 *    findings.
 *
 * Both are disclosed on the reply. Neither runs on tool-loop rounds — only on
 * the finished answer.
 */

/** A number worth checking: not a year, not a list index. */
const FIGURE = /(?<![\w.])(?:\$|€|£)?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])(?:\$|€|£)\d+(?:\.\d+)?|(?<![\w.])\d+\.\d+|(?<![\w.])\d{4,}(?![\w.])/g
const YEAR = /^(19|20)\d{2}$/

export function figuresIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.match(FIGURE) ?? []) {
    const bare = m.replace(/[$€£,]/g, '')
    if (YEAR.test(bare)) continue
    out.push(m)
  }
  return out
}

/**
 * Does this exchange look like arithmetic over stated inputs? The answer
 * states at least one real figure, and either the question supplied two or
 * more numbers to work from, or the answer itself carries several.
 */
export function looksArithmetic(userText: string, answer: string): boolean {
  const stated = figuresIn(answer)
  if (stated.length === 0) return false
  const inputs = (userText.match(/(?<![\w.])\d+(?:[.,]\d+)?%?/g) ?? []).filter((n) => !YEAR.test(n))
  return inputs.length >= 2 || stated.length >= 3
}

export const RECOMPUTE_INSTRUCTION =
  'Check the arithmetic in the answer you just gave. Reply with ONE Python code block and nothing ' +
  'else. The program must recompute every number the answer states, from the inputs given in the ' +
  'question, and print each on its own line as "label: value" with the same units and rounding ' +
  'the answer used (e.g. "monthly payment: 1436.05"). Standard library only; no comments needed; do ' +
  'not restate the answer.'

export function buildRecomputeMessages(
  slot: ModelConfig,
  question: string,
  answer: string
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  return [
    { role: 'system', content: slot.systemPrompt },
    { role: 'user', content: question.slice(0, 3000) },
    { role: 'assistant', content: answer.slice(0, 6000) },
    { role: 'user', content: RECOMPUTE_INSTRUCTION }
  ]
}

/** The first fenced Python block in a reply, or the first fence of any language when `any`. */
export function extractPythonFence(text: string, any = false): string | null {
  const re = any ? /```(?:python|py|python3)?[^\n]*\n([\s\S]*?)```/ : /```(?:python|py|python3)[^\n]*\n([\s\S]*?)```/
  const m = text.match(re)
  return m ? m[1].trim() : null
}

/**
 * A recompute reply, tolerantly. Asked for "one code block and nothing else",
 * a small model often replies with raw unfenced code (measured on the first
 * live run). Fence wins; otherwise the whole reply counts when it parses as
 * code by shape — a line that assigns or imports, and a print().
 */
export function extractRecomputeProgram(text: string): string | null {
  const fenced = extractPythonFence(text, true)
  if (fenced) return fenced
  const t = text.trim()
  if (!t) return null
  const lines = t.split('\n')
  const codeish = /^(import |from |[A-Za-z_][\w.]*\s*=[^=]|print\s*\(|def |for |if |    )/
  const codeLines = lines.filter((l) => !l.trim() || codeish.test(l)).length
  if (codeLines / lines.length >= 0.8 && /print\s*\(/.test(t)) return t
  return null
}

/** Longest fenced Python block — the one most likely to be "the code" in a coding reply. */
export function longestPythonFence(text: string): string | null {
  const blocks = [...text.matchAll(/```(?:python|py|python3)[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].trim())
  if (blocks.length === 0) return null
  return blocks.sort((a, b) => b.length - a.length)[0]
}

const MAX_CODE_LINES = 300
/** Code that needs the outside world is not a fair check inside the sandbox. */
const NEEDS_WORLD = /\binput\s*\(|sys\.argv|\bopen\s*\(|\brequests\b|\burllib\b|\bsocket\b|\bsubprocess\b|\bos\.system\b|\bargparse\b|\bflask\b|\bdjango\b|\btkinter\b|\bpygame\b|\basyncio\.run\s*\(\s*main|\bwhile\s+True\b/

/** Is a code block a self-contained candidate for running? */
export function isSelfContained(code: string): boolean {
  if (!code.trim()) return false
  if (code.split('\n').length > MAX_CODE_LINES) return false
  return !NEEDS_WORLD.test(code)
}

/** Failure kinds that are the author's error, not the sandbox's. */
const AUTHOR_ERRORS = /(SyntaxError|IndentationError|TabError|NameError|UnboundLocalError|TypeError|AttributeError|AssertionError|ZeroDivisionError|IndexError|KeyError|ValueError|RecursionError)\b[^\n]*/

/**
 * Turn a run failure into a finding line, or null when the failure is
 * environmental. The last matching line of the traceback is what the model
 * needs; the whole trace would be noise in a revision prompt.
 */
export function codeFailureFinding(error: string): string | null {
  const lines = error.split('\n').filter((l) => AUTHOR_ERRORS.test(l))
  if (lines.length === 0) return null
  const last = lines[lines.length - 1].trim()
  // A missing module or file is not the model's mistake in a sandbox.
  if (/ModuleNotFoundError|FileNotFoundError|PermissionError|EOFError/.test(error) && !/(SyntaxError|NameError|AssertionError|TypeError|AttributeError)/.test(last)) return null
  return `- The Python code in the answer fails when run: ${last.slice(0, 300)}. Fix the code so it runs; do not describe the fix instead of making it.`
}

export interface WorkbenchCheck {
  kind: 'recompute' | 'code'
  ok: boolean
  /**
   * v2.3: did this pass actually do its work — the fact the summary states in
   * prose, in a field the deadline notice can read.
   *
   * The turn used to answer this by asking the clock: `if
   * (!budget.signal.aborted) budget.ran('recompute')`. A recomputation's
   * `run_python` is not wired to that signal, so a program that started inside
   * the budget and printed its output two seconds after it expired was recorded
   * as never having run — and the expiry line said `Not run: the recomputation`
   * directly beneath this check's own `🧮 Recomputed the stated figures in
   * Python`, output and all (FR3, `.h2h-runs/B10/FR3-20260827-224622`, 62.2 s of
   * checking against a 60 s budget). The clock knows when the deadline passed.
   * Only the pass knows what it got done.
   */
  ran: boolean
  summary: string
  /**
   * The runtime's own words, when this line exists because something broke.
   *
   * Measured: `🧮 Recompute skipped — BodyStreamBuffer was aborted`. The whole
   * line was an internal string, and the reader had no disclosure to open. Now
   * the summary says what happened and this carries the evidence, so the text
   * is neither printed at a reader nor thrown away.
   */
  detail?: FailureDetail
}

/**
 * The marker workbenchFormat appends when every number a run printed is
 * already a literal in the code (HARDCODED_NUMBERS_NOTE). toolGrounding keys
 * on it too — one string, so the checks cannot drift apart.
 */
export const LAUNDERED_OUTPUT_MARKER = 'appears as a literal in the code'

/** Numeric literals of a blob, as values (commas stripped). */
function numbersIn(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

/** Unit conversions and format widths: present in any program, from nowhere. */
const CONVERSIONS = new Set([0, 1, 2, 3, 4, 7, 10, 12, 24, 30, 31, 52, 60, 100, 365, 1000, 3600, 86400])

/**
 * v1.12.2: is a recomputation circular — does it re-derive the answer from
 * constants the model wrote, rather than from the question? RECOMPUTE_INSTRUCTION
 * asks for "the inputs given in the question"; when not one literal in the
 * program appears there, nothing outside the answer constrained the result and
 * the run proves only that the model can multiply its own assumptions.
 * Measured (faucet drip, V3): `gallons_per_day = 20  # EPA standard estimate`
 * and `cost_per_1000_gallons = 5.0` → "600 gallons, $3.00" — the answer's own
 * figures, returned as if checked. A program built only from conversions is
 * not circular: it is arithmetic on what the question said in words.
 */
export function recomputeIsCircular(code: string, question: string): boolean {
  const asked = new Set(numbersIn(question))
  const literals = numbersIn(code)
  if (literals.every((n) => CONVERSIONS.has(n))) return false
  return !literals.some((n) => asked.has(n))
}

export function describeRecompute(input: {
  ran: boolean
  ok: boolean
  circular?: boolean
  /**
   * A clause a reader can act on — never a runtime string. Callers that hold a
   * thrown value pass `explainFailure(err).headline` and hand the raw text
   * through `detail`, which is where `BodyStreamBuffer was aborted` went.
   */
  note?: string
  detail?: FailureDetail
}): WorkbenchCheck {
  if (!input.ran)
    return {
      kind: 'recompute',
      ok: false,
      ran: false,
      summary: `🧮 Recompute skipped${input.note ? ` — ${input.note}` : ''}`,
      ...(input.detail ? { detail: input.detail } : {})
    }
  if (!input.ok) return { kind: 'recompute', ok: false, ran: true, summary: `🧮 Recomputation ran but failed${input.note ? ` — ${input.note}` : ''}; figures could not be checked this way.` }
  // The headline reports the weaker of the two states: a program fed by the
  // model's own constants ran, but it checked nothing.
  if (input.circular)
    return {
      kind: 'recompute',
      ok: false,
      ran: true,
      summary:
        '🧮 Recomputation ran, but its inputs are constants the model wrote rather than figures from your question — ' +
        'it re-derives the answer from itself and checks nothing. Treat these figures as unverified.'
    }
  // v1.17.1: what the pass that follows actually reads. `checkToolGrounding`
  // takes the NUMBERS out of the reply — figures, percentages, measurements —
  // and judges them against this stdout. Not one of its rungs compares a word
  // the reply copied out of the run.
  //
  // Measured, VC1 run 2 (round 6): the reply pasted back
  // `sign-my-as-is-head-to-head-layout-probe-…` where the program had decoded
  // `sigma-oasis-head-to-head-layout-probe-…`, and this line printed inches
  // above the run that disagreed with it. Re-run against the recorded turn,
  // `unsourcedFigures` returns [] and `checkToolGrounding` returns null: all
  // thirteen digit groups in that token WERE compared and did agree. The four
  // characters that were wrong were letters. So the old sentence — "the checker
  // compared the reply against that output" — was true of the one dimension
  // that was right and false of the only one that was wrong.
  //
  // Widening rather than narrowing was considered and rejected on the same
  // recording: the program printed its decoding one character per line, so the
  // token appears contiguously in that stdout in neither form, and there is no
  // `label: <string>` line for a string-valued comparison to read at all. A
  // blunter rule — every long token in the reply must occur in the output —
  // fires identically on the CORRECT answer, which is round 4's cry-wolf in a
  // new costume. The check that would catch this does not exist yet; until it
  // does the sentence says what the app did.
  return {
    kind: 'recompute',
    ok: true,
    ran: true,
    summary:
      '🧮 Recomputed the stated figures in Python; the reply’s numbers were compared against that ' +
      'output. Numbers only — text it copies from the run, such as a decoded string or an ' +
      'identifier, was not checked.'
  }
}

/** A figure the reply states where the run printed a different one under the same label. */
export interface OutputMismatch {
  label: string
  printed: string
  stated: string
}

export interface OutputComparison {
  /** Printed labels the reply restates with the value that was printed. */
  agreed: number
  mismatches: OutputMismatch[]
}

/** `Sum of the first 500 prime numbers: 824693` — a printed line stating one plain number. */
const PRINTED_LINE = /^(.{1,60}?):[ \t]*(-?\d[\d,]*(?:\.\d+)?)[ \t]*$/
/** Words carrying no identity — a label match on "of" would mean nothing. */
const LABEL_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'in', 'on', 'at', 'to', 'from', 'with', 'by', 'is', 'are', 'was', 'were'])
const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g
const tokens = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? []
const labelWords = (label: string): string[] => tokens(label).filter((w) => !LABEL_STOPWORDS.has(w))
const asNumber = (s: string): number => Number(s.replace(/,/g, ''))

/**
 * v1.15: what the reply says the numbers are, against what its own block printed.
 *
 * Measured (task TTU2): the executed block printed
 * `Sum of the first 500 prime numbers: 824693` — correct — while the prose
 * directly above it said 854,405 and the reply's own pasted "Output:" said the
 * same, and the check underneath reported "it runs without error" with a tick.
 * The chip fired hardest exactly where the answer was wrong, because "no
 * exception was raised" was all it had ever meant. The comparison that catches
 * it costs nothing: both numbers are in the same message.
 *
 * Every `label: number` line the run printed is matched against the lines of
 * the reply that use all of that label's words. A line repeating the printed
 * value agrees; a line carrying some other number in its place disagrees. Only
 * numbers the label does not itself contain count as a restatement, so "the
 * first 500 primes" is not read as a claim about 500.
 *
 * The reply's Python is excluded — a program is not a claim about a value, and
 * `primes[499]` would otherwise "contradict" the 3571 it prints. Its pasted
 * output is not excluded: a block that shows output the code does not produce
 * is the same lie told earlier.
 */
export function compareToOutput(answer: string, stdout: string): OutputComparison {
  const printed = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(PRINTED_LINE)
    if (!m) continue
    const label = m[1].trim()
    if (labelWords(label).length < 2) continue
    if (printed.has(label) && printed.get(label) !== m[2]) ambiguous.add(label)
    printed.set(label, m[2])
  }
  // Tokenised once: every label is matched against the same lines.
  const lines = answer
    .replace(/```(?:python|py|python3)[^\n]*\n[\s\S]*?```/g, ' ')
    .split('\n')
    .map((line) => ({ have: new Set(tokens(line)), numbers: line.match(NUMBER) ?? [] }))
  const mismatches: OutputMismatch[] = []
  const seen = new Set<string>()
  let agreed = 0
  for (const [label, value] of printed) {
    if (ambiguous.has(label)) continue
    const words = labelWords(label)
    const own = new Set((label.match(NUMBER) ?? []).map(asNumber))
    let matched = false
    for (const line of lines) {
      if (!words.every((w) => line.have.has(w))) continue
      const stated = line.numbers.filter((n) => !own.has(asNumber(n)))
      if (stated.length === 0) continue
      if (stated.some((n) => asNumber(n) === asNumber(value))) {
        matched = true
        continue
      }
      const key = `${label}|${asNumber(stated[0])}`
      if (seen.has(key)) continue
      seen.add(key)
      mismatches.push({ label, printed: value, stated: stated[0] })
    }
    if (matched) agreed += 1
  }
  return { agreed, mismatches }
}

export function describeCodeCheck(input: {
  ran: boolean
  ok: boolean
  finding?: string | null
  note?: string
  revisedRuns?: boolean
  compared?: OutputComparison
}): WorkbenchCheck {
  if (!input.ran) return { kind: 'code', ok: false, ran: false, summary: `🧪 Code check skipped${input.note ? ` — ${input.note}` : ''}` }
  const bad = input.compared?.mismatches ?? []
  // The run succeeding is the weaker fact, so the disagreement is the headline:
  // a tick over a figure the block itself contradicts is the reassurance this
  // check has not earned.
  if (bad.length > 0) {
    const first = bad[0]
    const rest = bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''
    return {
      kind: 'code',
      ok: false,
      ran: true,
      summary:
        `🧪 Ran the Python in this reply — it runs, but its output disagrees with the answer: it printed ` +
        `“${first.label}: ${first.printed}” where the reply says ${first.stated}${rest}. ` +
        'The printed value is the one that was computed.'
    }
  }
  if (input.ok) {
    const agreed = input.compared?.agreed ?? 0
    // Say which of the two things was checked. "Runs without error" over a
    // reply whose figures nothing compared is a tick the reader over-reads.
    return {
      kind: 'code',
      ok: true,
      ran: true,
      summary:
        agreed > 0
          ? `🧪 Ran the Python in this reply in the sandbox — it runs, and the ${agreed === 1 ? 'figure it prints is the one' : `${agreed} figures it prints are the ones`} the reply states.`
          : '🧪 Ran the Python in this reply in the sandbox — it runs without error. Nothing in the reply restated a figure it printed, so no figure was checked.'
    }
  }
  if (input.revisedRuns) return { kind: 'code', ok: true, ran: true, summary: '🧪 The Python in the first draft failed when run; the revised code runs.' }
  return { kind: 'code', ok: false, ran: true, summary: `🧪 Ran the Python in this reply — it fails${input.finding ? `: ${input.finding.replace(/^- The Python code in the answer fails when run: /, '').replace(/\. Fix the code.*$/, '')}` : ''}.` }
}

/**
 * A revision that answers a quantitative question by deleting every figure is
 * a non-answer, whatever its length (measured: a wrong-but-fixable total
 * replaced by "I can\'t verify any of those numbers"). The original stands,
 * flagged — the badge plus the visible recomputation is strictly more useful.
 */
export function revisionDropsAllFigures(original: string, revised: string): boolean {
  return figuresIn(original).length > 0 && figuresIn(revised).length === 0
}

/**
 * The reference block a revision gets when the app has recomputed, and the
 * echo guard that rejects a revision which pasted the scaffolding into the
 * answer (measured: the model opened with the instruction sentence and the
 * raw tool output). One source for both, so prompt and guard cannot drift.
 */
export const RECOMPUTE_REFERENCE_HEADER = 'Correct values, recomputed by running Python (already verified):'
export const RECOMPUTE_REFERENCE_FOOTER =
  'Rewrite your answer using these exact values where the flagged figures were. Reply with the ' +
  'corrected answer text only — no preamble, and do not mention the recomputation, the app, or ' +
  'these instructions.'

export function buildRecomputeReference(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[^:]{1,60}: ?\S/.test(l))
    .slice(0, 20)
  const body = lines.length > 0 ? lines.join('\n') : stdout.trim().slice(0, 800)
  return `${RECOMPUTE_REFERENCE_HEADER}\n${body}\n\n${RECOMPUTE_REFERENCE_FOOTER}`
}

const SCAFFOLD_MARKERS = [
  RECOMPUTE_REFERENCE_HEADER,
  RECOMPUTE_REFERENCE_FOOTER.slice(0, 40),
  'Python ran in',
  'stdout:',
  'The answer you just gave:'
]

/** True when a revision contains the checker's own scaffolding rather than an answer. */
export function revisionEchoesScaffolding(revised: string): boolean {
  return SCAFFOLD_MARKERS.some((m) => revised.includes(m))
}
