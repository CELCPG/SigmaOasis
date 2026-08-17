/**
 * v1.6 answer-quality evals — the scoring, headless and shared by the shells
 * (scripts/eval-answers.ts today; an in-app button later), exactly as
 * evalRunner.ts is shared for tool choice.
 *
 * Three suites, from STRATEGY-depth-and-reasoning.md's "Measuring it":
 *
 *   library       does the model answer an offline reference question from the
 *                 retrieved passages, cite them, and state no measurement the
 *                 passages do not contain?
 *   quantitative  does it get the number right — with and without the
 *                 Workbench? The delta is the point: it is what "the app made
 *                 a 9B model smarter" means as a number.
 *   deliberation  the same questions with think-harder on, reported as a
 *                 delta and a cost in seconds.
 *
 * Every judgement here is mechanical. No model grades another model's answer:
 * a quantitative case knows its own answer, and a library case is scored
 * against the passages the app actually retrieved.
 */

// ---- numbers in an answer -------------------------------------------------------

/** Numbers as written, normalized: "1,249.99" and "$1249.99" both → 1249.99. */
export function numbersIn(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/**
 * Does the reply state this value? A figure counts when it matches to the
 * tolerance, or when it matches after rounding to the tolerance's precision —
 * "1,436.05" and "1436.0483" are the same answer stated differently, and an
 * eval that failed the second would be measuring formatting, not arithmetic.
 */
/**
 * Binary floating point makes `|31997.13 - 31997.12| <= 0.01` false by 2e-12.
 * Measured: it failed a model that had answered correctly, which is the one
 * thing an eval must never do.
 */
const FLOAT_SLOP = 1e-9

export function statesValue(reply: string, value: number, tolerance = 0.01): boolean {
  const found = numbersIn(reply)
  if (found.some((n) => Math.abs(n - value) <= tolerance + FLOAT_SLOP)) return true
  // Percentages written as "25.6%" against an expected 25.6 already match
  // above; this covers a reply that rounded harder than the tolerance allows
  // only when the expectation itself is a round number.
  const decimals = Math.max(0, Math.ceil(-Math.log10(tolerance)) - 0)
  const target = Number(value.toFixed(Math.min(6, decimals)))
  return found.some((n) => Number(n.toFixed(Math.min(6, decimals))) === target)
}

export interface QuantExpectation {
  label: string
  value: number
  tolerance?: number
}

export interface QuantScore {
  /** Every expected value appears in the reply. */
  hit: boolean
  missing: string[]
}

export function scoreQuantitative(reply: string, expect: QuantExpectation[]): QuantScore {
  const missing = expect.filter((e) => !statesValue(reply, e.value, e.tolerance ?? 0.01)).map((e) => e.label)
  return { hit: missing.length === 0, missing }
}

// ---- measurements, for the library suite ---------------------------------------

/**
 * Numbers that carry a unit — the class where inventing one is dangerous:
 * a duration, a temperature, a dose, a distance. Matched with its unit so
 * "20 minutes" and "20 people" are not the same claim.
 */
const MEASUREMENT =
  /(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s*(°\s?[cf]\b|degrees?\b|%|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|weeks?\b|months?\b|years?\b|seconds?\b|secs?\b|mg\b|ml\b|grams?\b|g\b|kg\b|litres?\b|liters?\b|l\b|gallons?\b|ounces?\b|oz\b|pounds?\b|lbs?\b|cm\b|mm\b|metres?\b|meters?\b|m\b|inches?\b|feet\b|ft\b|miles?\b|km\b)/gi

export interface Measurement {
  raw: string
  value: number
  unit: string
}

export function measurementsIn(text: string): Measurement[] {
  const out: Measurement[] = []
  for (const m of text.matchAll(MEASUREMENT)) {
    const value = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    out.push({ raw: m[0].trim(), value, unit: m[2].toLowerCase().replace(/\s+/g, '') })
  }
  return out
}

/**
 * Measurements the reply states that the retrieved passages do not contain.
 *
 * The corpus is matched on the *number*, not the exact phrasing: a passage
 * saying "15 to 30 minutes" supports "15 minutes" and "30 minutes" but not
 * "45 minutes". Deliberately lenient about units on the corpus side — the
 * question is whether the figure came from somewhere, and a false alarm here
 * would make the suite measure phrasing.
 */
export function unsupportedMeasurements(reply: string, corpus: string): string[] {
  const known = new Set(numbersIn(corpus).map((n) => String(n)))
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const m of measurementsIn(reply)) {
    if (known.has(String(m.value))) continue
    // A rounded restatement of a known figure ("about 30 minutes" for 29.5).
    if ([...known].some((k) => Math.abs(Number(k) - m.value) < 0.5)) continue
    if (seen.has(m.raw)) continue
    seen.add(m.raw)
    flagged.push(m.raw)
  }
  return flagged
}

/**
 * Did the reply point at the source? Either a bracketed citation the tool
 * output used, or a document/pack title from the passages it was given. Title
 * matching uses the longest word of the title so "FM 4-25.11 First Aid" is
 * matched by "First Aid" but a reply that merely says "the manual" is not.
 */
export function citesSource(reply: string, titles: string[]): boolean {
  if (/\[\d+\]/.test(reply)) return true
  const lower = reply.toLowerCase()
  return titles.some((t) => {
    const words = t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 5)
    return words.length > 0 && words.every((w) => lower.includes(w))
  })
}

export interface LibraryScore {
  /** Every required fact appears in the reply. */
  answered: boolean
  missing: string[]
  cited: boolean
  /** Measurements the retrieved passages do not support. */
  unsupported: string[]
  /** The reply said something the case forbids (e.g. a wrong figure). */
  forbidden: string[]
}

export function scoreLibrary(
  reply: string,
  input: { mustInclude: string[]; mustNotInclude?: string[]; passages: string; titles: string[] }
): LibraryScore {
  const missing = input.mustInclude.filter((p) => !new RegExp(p, 'i').test(reply))
  const forbidden = (input.mustNotInclude ?? []).filter((p) => new RegExp(p, 'i').test(reply))
  return {
    answered: missing.length === 0,
    missing,
    cited: citesSource(reply, input.titles),
    unsupported: unsupportedMeasurements(reply, input.passages),
    forbidden
  }
}

// ---- suite summaries -------------------------------------------------------------

export interface Rate {
  hit: number
  of: number
}

export function rate(hit: number, of: number): Rate {
  return { hit, of }
}

export function pct(r: Rate): string {
  return r.of === 0 ? '—' : `${Math.round((r.hit / r.of) * 100)}%`
}

export interface QuantCaseResult {
  file: string
  prompt: string
  /** Replies per arm, kept so a failed case can be read rather than guessed at. */
  replies?: { bare?: string; workbench?: string; deliberated?: string }
  /** Without the Workbench: no tools at all. */
  bare: { hit: boolean; missing: string[]; ms: number; error?: string }
  /** With run_python / analyze_file available and really executed. */
  workbench?: { hit: boolean; missing: string[]; ms: number; toolCalls: number; error?: string }
  /** What the model actually ran, so a miss can be read rather than re-run. */
  tools?: { name: string; code?: string; result?: string }[]
  /** The bare draft after one think-harder pass. */
  deliberated?: { hit: boolean; missing: string[]; ms: number; revised: boolean; error?: string }
}

export interface QuantSummary {
  bare: Rate
  workbench: Rate
  deliberated: Rate
  /** Mean seconds per case, per arm. */
  seconds: { bare: number; workbench: number; deliberated: number }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

export function summarizeQuant(results: QuantCaseResult[]): QuantSummary {
  const bare = results.filter((r) => !r.bare.error)
  const wb = results.filter((r) => r.workbench && !r.workbench.error)
  const del = results.filter((r) => r.deliberated && !r.deliberated.error)
  return {
    bare: rate(bare.filter((r) => r.bare.hit).length, bare.length),
    workbench: rate(wb.filter((r) => r.workbench!.hit).length, wb.length),
    deliberated: rate(del.filter((r) => r.deliberated!.hit).length, del.length),
    seconds: {
      bare: mean(bare.map((r) => r.bare.ms / 1000)),
      workbench: mean(wb.map((r) => r.workbench!.ms / 1000)),
      deliberated: mean(del.map((r) => r.deliberated!.ms / 1000))
    }
  }
}

export interface LibraryCaseResult {
  file: string
  prompt: string
  pack?: string
  passagesFound: number
  score?: LibraryScore
  ms: number
  error?: string
  /** The reply, kept so a failed case can be read rather than guessed at. */
  reply?: string
  /** Which passages the app retrieved, and how they were ranked. */
  retrieved?: string[]
  mode?: 'hybrid' | 'keyword'
}

export interface LibrarySummary {
  retrieved: Rate
  answered: Rate
  cited: Rate
  /** Cases whose reply stated a measurement the passages do not support. */
  unsupported: Rate
  seconds: number
}

export function summarizeLibrary(results: LibraryCaseResult[]): LibrarySummary {
  const ok = results.filter((r) => !r.error)
  const scored = ok.filter((r) => r.score)
  return {
    retrieved: rate(ok.filter((r) => r.passagesFound > 0).length, ok.length),
    answered: rate(scored.filter((r) => r.score!.answered).length, scored.length),
    cited: rate(scored.filter((r) => r.score!.cited).length, scored.length),
    unsupported: rate(scored.filter((r) => r.score!.unsupported.length > 0).length, scored.length),
    seconds: mean(ok.map((r) => r.ms / 1000))
  }
}
