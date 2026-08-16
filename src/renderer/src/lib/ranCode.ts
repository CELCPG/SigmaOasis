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
  const out: RanCodeOutput = { ok, durationMs: null, stdout: '', result: '', stderr: '', error: '', files: [], notes: [] }
  const sections = text.replace(/\r\n/g, '\n').split(/\n\n(?=\S)/)
  for (const raw of sections) {
    const s = raw.trim()
    if (!s) continue
    let m: RegExpMatchArray | null
    if ((m = s.match(/^Python (?:ran in|run failed after) (\d+) ms\.?$/))) {
      out.durationMs = Number(m[1])
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

/** "ran in 3 ms" / "failed after 1.9 s" for the header. */
export function describeRun(o: RanCodeOutput): string {
  const t = o.durationMs === null ? '' : o.durationMs >= 1000 ? `${(o.durationMs / 1000).toFixed(1)} s` : `${o.durationMs} ms`
  return o.ok ? (t ? `ran in ${t}` : 'ran') : t ? `failed after ${t}` : 'failed'
}
