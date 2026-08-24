/**
 * v1.6: parse a run_python tool result (workbenchFormat.ts's text) back into
 * its sections for the "Ran code" block. Text is what crosses IPC and is what
 * gets persisted with the conversation, so the block reads that rather than
 * a second structured field that could drift from it. Headless, pinned by
 * test/ranCode.test.ts against the formatter's exact shape.
 */

export interface RanCodeOutput {
  ok: boolean
  durationMs: number | null
  /**
   * v1.12.4: the one-time runtime start this call paid for, when it did. Null
   * on a warm run. Kept apart from durationMs because it is a session cost the
   * caller waited on, not a property of this snippet — but it is never dropped,
   * which is what made a 6 ms cold run look faster than a 20 ms warm one.
   */
  bootMs: number | null
  stdout: string
  /** repr() of the last expression, when the run ended in one. */
  result: string
  stderr: string
  /** Traceback / error message on failure. */
  error: string
  /** Lines from the "files written under /work" section, cleaned. */
  files: string[]
  /** Notes (staged files, package notes, restart) — small print. */
  notes: string[]
}

const RULES = [
  /^Numbers above were computed, not recalled/,
  /^Fix the code and run again/,
  /^\(no output — print\(\)/
]

/** Split on the formatter's blank-line-separated sections and label each. */
export function parseRanCode(text: string, ok: boolean): RanCodeOutput {
  const out: RanCodeOutput = { ok, durationMs: null, bootMs: null, stdout: '', result: '', stderr: '', error: '', files: [], notes: [] }
  const sections = text.replace(/\r\n/g, '\n').split(/\n\n(?=\S)/)
  for (const raw of sections) {
    const s = raw.trim()
    if (!s) continue
    let m: RegExpMatchArray | null
    if ((m = s.match(/^Python (?:ran in|run failed after) (\d+) ms\.?$/))) {
      out.durationMs = Number(m[1])
      continue
    }
    if ((m = s.match(/^The sandbox started for this run: (\d+) ms/))) {
      out.bootMs = Number(m[1])
      continue
    }
    if ((m = s.match(/^stdout(?: before the error)?:\n([\s\S]*)$/))) {
      out.stdout = m[1]
      continue
    }
    if ((m = s.match(/^result \(last expression\): ([\s\S]*)$/))) {
      out.result = m[1]
      continue
    }
    if ((m = s.match(/^stderr:\n([\s\S]*)$/))) {
      out.stderr = m[1]
      continue
    }
    if ((m = s.match(/^error:\n([\s\S]*)$/))) {
      out.error = m[1]
      continue
    }
    if ((m = s.match(/^files written under \/work:\n([\s\S]*)$/))) {
      out.files = m[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
      continue
    }
    if (RULES.some((r) => r.test(s))) continue
    if (/^Files available under \/work:/.test(s) || /^Note:/.test(s) || /^The sandbox (?:was restarted|is offline)/.test(s) || /^Package load:/.test(s)) {
      out.notes.push(...s.split('\n').filter(Boolean))
      continue
    }
    // Anything unrecognised is kept visible rather than dropped.
    out.notes.push(s)
  }
  return out
}

/** ms as the header states them: "3 ms" under a second, "1.9 s" over. */
function span(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}

/**
 * "ran in 3 ms" / "failed after 1.9 s" for the header — and, on the run that
 * paid for the runtime, "started the sandbox in 8.6 s, then ran in 6 ms".
 *
 * The boot is named rather than added in. Adding it would say this snippet took
 * 8.6 s, which is false and would make the identical code look a thousand times
 * slower on its first run than its second; dropping it said the cold run took
 * 6 ms against the warm run's 20 ms, which is worse — it inverted the order.
 * Stating both keeps every millisecond the caller waited on screen and charges
 * each to the thing that spent it. `totalWaitMs` is the one number for "how
 * long did I wait", and it is the boot plus the run, never the run alone.
 */
export function describeRun(o: RanCodeOutput): string {
  const t = o.durationMs === null ? '' : span(o.durationMs)
  const ran = o.ok ? (t ? `ran in ${t}` : 'ran') : t ? `failed after ${t}` : 'failed'
  return o.bootMs ? `started the sandbox in ${span(o.bootMs)}, then ${ran}` : ran
}

/**
 * Every millisecond between asking and having the answer: the one-time runtime
 * start plus the execution. Null when the text carried neither figure. This is
 * what may be compared between two runs — comparing `durationMs` alone ranks a
 * cold call above a warm one.
 */
export function totalWaitMs(o: RanCodeOutput): number | null {
  if (o.durationMs === null && o.bootMs === null) return null
  return (o.bootMs ?? 0) + (o.durationMs ?? 0)
}

/** The header's tooltip: where the wait went, in full. */
export function explainRun(o: RanCodeOutput | null): string {
  const total = o ? totalWaitMs(o) : null
  if (!o || total === null || !o.bootMs) return 'Python the model wrote and ran in the sandbox (no network, no access to your disk). Click to collapse.'
  return (
    `${span(total)} in all: ${span(o.bootMs)} starting the Python sandbox — a one-time cost this run happened to be first to pay — ` +
    `and ${span(o.durationMs ?? 0)} running this code. Later runs in this conversation pay only the second figure.`
  )
}
