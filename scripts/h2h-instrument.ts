/**
 * What the measuring instrument is, and whether it is the right one.
 *
 * The arms of a head-to-head are two builds, named by `--app <dir>`. The
 * harness that measures them is a third checkout entirely — whichever one
 * `scripts/h2h-capture.sh` was invoked from — and until this module nothing
 * related the two. Round 10 built paint-settling instrumentation
 * (`textSettledMs`, `textGrewAfterTurnEndChars`, `streamEdgeAtTurnEnd`) into
 * the harness, then ran the sweep from a repo root sitting on `main`. All 36
 * run.json files came out without those fields. The comparison survived —
 * both arms were measured by the same instrument, so it was fair — but the
 * round's instrument work was never exercised, and nothing objected. A critic
 * found it, and only by reporting a question as unanswerable rather than
 * inventing a reading.
 *
 * Two different failures live here and they need different guards.
 *
 *   ASYMMETRY — the arms were measured by different instruments. This corrupts
 *   the comparison itself. Caught by recording provenance in every run and
 *   asserting the two agree (`make-blind-pairs.mjs`, `assertSameInstrument`).
 *
 *   STALENESS — both arms were measured by the same instrument, and it was the
 *   wrong one: older than the build under test, missing the very measurements
 *   the round added. Asserting the arms agree cannot see this, because they do
 *   agree; they agree on being wrong. This is round 10, and it is what
 *   `compareInstruments` below is for.
 *
 * The reference for staleness is the build under test. A build's checkout
 * carries its own copy of the harness, so `<appRoot>/scripts/h2h-capture.ts`
 * is what the harness *should have been* when measuring that build. The
 * comparison is a SUBSET test, not an equality test, and the direction is the
 * whole design:
 *
 *   - The invoked harness may measure MORE than the app's copy. That is arm A,
 *     always and by construction: the baseline is an old commit whose harness
 *     predates the round. Pinning the harness to the app would make every
 *     baseline capture impossible, or would silently measure arm A with a
 *     weaker instrument than arm B. Subset-passing is the arm-A exemption, and
 *     because it is structural there is no flag anyone can set wrongly.
 *
 *   - The invoked harness may not measure LESS. If the build under test ships a
 *     harness that knows a measurement the running harness cannot emit, the
 *     running harness is behind the thing it is measuring. That is the failure,
 *     and it is refused.
 *
 * The measurement vocabulary is read STRUCTURALLY out of each harness's own
 * source, not from a manifest either checkout had to opt into. That matters:
 * round 10's checkouts predate this file, so a manifest would have read as
 * "declares nothing" on both sides and the guard would have passed the very
 * sweep it exists to stop. `interface TurnRecord` and the `definitions:` block
 * are where a harness has always declared what it can measure, and they are
 * present in every checkout back through the baseline.
 */

import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/* --------------------------------------------------------------- sources */

/**
 * The harness, as a set of files. `h2h-capture.ts` is the instrument proper;
 * the rest are the modules it measures through, and a change in any of them
 * changes what a run records. Listed relative to a checkout root so the same
 * fingerprint can be taken of another checkout.
 *
 * A file that is absent contributes nothing and is reported absent. An older
 * checkout legitimately has fewer of these.
 */
export const HARNESS_SOURCES = [
  'scripts/h2h-capture.ts',
  'scripts/h2h-capture.sh',
  'scripts/h2h-fixtures.ts',
  'scripts/h2h-instrument.ts',
  'scripts/h2h-preconditions.ts',
  'scripts/h2h-traversal.ts'
] as const

/** The one file the measurement vocabulary is read out of. */
export const CAPTURE_SOURCE = 'scripts/h2h-capture.ts'

/* ---------------------------------------------------------- the extractor */

/**
 * Blank the inside of every string, template literal and comment, keeping the
 * source's length and line structure intact.
 *
 * Brace counting is how the blocks below are found, and prose is full of
 * braces that are not code. Masking first is cheaper and far more reliable
 * than trying to teach the counter about quoting as it goes.
 *
 * Regular-expression literals are NOT masked — telling `/` division from `/`
 * regex needs a real lexer. Braces inside a regex are quantifiers (`\d{8}`)
 * and therefore balanced, so counting survives them. `readMeasures` is pinned
 * against the repo's actual harness in the test suite, so if this assumption
 * ever stops holding for real source, the suite says so rather than the guard
 * quietly reading the wrong set.
 */
function maskLiterals(source: string): string {
  const out = source.split('')
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(source, i)
      for (let k = i + 1; k < end - 1 && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
      i = end
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      let end = source.indexOf('\n', i)
      if (end < 0) end = source.length
      for (let k = i; k < end; k++) out[k] = ' '
      i = end
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      const end = close < 0 ? source.length : close + 2
      for (let k = i; k < end; k++) if (out[k] !== '\n') out[k] = ' '
      i = end
      continue
    }
    i++
  }
  return out.join('')
}

/** Index just past the closing quote of the string opening at `at`. */
function skipString(source: string, at: number): number {
  const quote = source[at]
  let i = at + 1
  while (i < source.length) {
    const c = source[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    i++
  }
  return i
}

/**
 * The body of the brace-delimited block introduced by `opener`, which must end
 * in `{`. Returns null when the opener is absent or its block never closes —
 * both of which mean "this checkout does not declare it here", never "empty".
 */
function blockBody(masked: string, opener: string): string | null {
  const at = masked.indexOf(opener)
  if (at < 0) return null
  const start = at + opener.length
  let i = start
  let depth = 1
  while (i < masked.length && depth > 0) {
    const c = masked[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return depth === 0 ? masked.slice(start, i - 1) : null
}

/**
 * The keys declared directly in a block body — depth zero only, so a nested
 * object's keys do not leak into its parent's vocabulary.
 *
 * A key is an identifier in key position: at the start of the body, or after a
 * `,`, a `;`, an opening brace, or a line break. That last one is what lets the
 * same code read an object literal (comma-separated) and an interface
 * (newline-separated) without knowing which it is looking at.
 *
 * Deliberately NOT line-oriented, even though both blocks in the harness are
 * currently formatted one key per line. Reading the vocabulary correctly only
 * while the file is formatted a particular way would make the guard depend on
 * something no one is checking — which is the shape of the failure it exists to
 * prevent, one level down.
 */
function topLevelKeys(body: string): string[] {
  const keys: string[] = []
  let depth = 0
  let prev = ''
  let atLineStart = true
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (c === '\n') {
      atLineStart = true
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    const keyPosition = atLineStart || prev === '' || prev === ',' || prev === ';' || prev === '{'
    if (depth === 0 && keyPosition && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:/.exec(body.slice(i))
      if (m) {
        keys.push(m[1])
        i += m[0].length
        prev = ':'
        atLineStart = false
        continue
      }
    }
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    prev = c
    atLineStart = false
    i++
  }
  return keys
}

/**
 * Everything a harness source declares it can measure.
 *
 * Two declarations, unioned. `interface TurnRecord` is the per-turn record
 * written into run.json's `turns`; `definitions:` is the prose block in
 * `timings` that tells a reader what each figure means. A measurement lands in
 * one or both, and has since the baseline — which is what lets this read a
 * checkout that predates the guard.
 *
 * `null` means the source could not be read at all. That is not the same as an
 * empty vocabulary and must not be treated as one.
 */
export function readMeasures(source: string): string[] | null {
  if (!source) return null
  const masked = maskLiterals(source)
  const turnRecord = blockBody(masked, 'interface TurnRecord {')
  const definitions = blockBody(masked, 'definitions: {')
  if (turnRecord === null && definitions === null) return null
  const names = new Set<string>()
  for (const body of [turnRecord, definitions]) {
    if (body === null) continue
    for (const key of topLevelKeys(body)) names.add(key)
  }
  return [...names].sort()
}

/* -------------------------------------------------------------- reporting */

/**
 * Where the harness came from, in the terms a person uses to go and look at it.
 *
 * `sourceSha` is the identity that matters — it is what was actually read. The
 * commit is a convenience for finding it again, and it is only the truth when
 * `dirty` is false. Recording both, and saying which is which, is the point: a
 * commit alone would have described round 10's harness perfectly well and still
 * not told anyone it was the wrong one.
 */
export interface GitProvenance {
  commit: string | null
  branch: string | null
  /** True when the checkout had uncommitted changes; the commit is then approximate. */
  dirty: boolean | null
}

export function gitProvenance(root: string): GitProvenance {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch {
      return null
    }
  }
  const commit = git(['rev-parse', 'HEAD'])
  if (commit === null) return { commit: null, branch: null, dirty: null }
  const status = git(['status', '--porcelain'])
  return {
    commit,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: status === null ? null : status !== ''
  }
}

/** A harness checkout, described by reading it. */
export interface InstrumentReport {
  /** Root the harness was read from. */
  root: string
  /** Whether `scripts/h2h-capture.ts` was there to read. */
  sourceAvailable: boolean
  /** sha256/12 over every present file in HARNESS_SOURCES, or null. */
  sourceSha: string | null
  /** Which of HARNESS_SOURCES were present and hashed. */
  sources: string[]
  /** Measurement names the source declares, or null when unreadable. */
  measures: string[] | null
}

/**
 * Fingerprint and vocabulary of the harness in `root`.
 *
 * The fingerprint covers file names as well as contents, so a checkout that
 * has lost a harness module does not collide with one that still has it.
 */
export function describeInstrument(root: string): InstrumentReport {
  const hash = createHash('sha256')
  const present: string[] = []
  for (const rel of HARNESS_SOURCES) {
    const full = join(root, rel)
    if (!existsSync(full)) continue
    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    present.push(rel)
    hash.update(rel)
    hash.update('\0')
    hash.update(text)
    hash.update('\0')
  }
  let capture = ''
  const captureFull = join(root, CAPTURE_SOURCE)
  try {
    capture = existsSync(captureFull) ? readFileSync(captureFull, 'utf8') : ''
  } catch {
    capture = ''
  }
  return {
    root,
    sourceAvailable: capture !== '',
    sourceSha: present.length ? hash.digest('hex').slice(0, 12) : null,
    sources: present,
    measures: readMeasures(capture)
  }
}

/* ------------------------------------------------------------- the verdict */

export interface InstrumentVerdict {
  /** False only when the app's harness measures something this one cannot. */
  ok: boolean
  /**
   * Why no comparison was made, when none was. Stated rather than left as a
   * silent pass: "we could not check" and "we checked and it was fine" are
   * different answers and a reader is entitled to tell them apart.
   */
  skipped: string | null
  /** Measures the app's harness declares that the invoked harness lacks. */
  behind: string[]
  /** Measures the invoked harness has that the app's copy lacks. Normal: arm A. */
  ahead: string[]
}

/**
 * Is the invoked harness fit to measure this build?
 *
 * Fit means: it can emit everything the build's own copy of the harness knows
 * how to emit. More is fine. Less is the round-10 failure.
 */
export function compareInstruments(
  invoked: InstrumentReport,
  app: InstrumentReport
): InstrumentVerdict {
  if (invoked.measures === null) {
    return {
      ok: true,
      skipped:
        `the running harness's own source was not readable under ${invoked.root}, so there was ` +
        'nothing to compare the build against',
      behind: [],
      ahead: []
    }
  }
  if (app.measures === null) {
    return {
      ok: true,
      skipped:
        `the build under test carries no readable ${CAPTURE_SOURCE}, so it states no measurement ` +
        'vocabulary to check this harness against',
      behind: [],
      ahead: []
    }
  }
  const mine = new Set(invoked.measures)
  const theirs = new Set(app.measures)
  return {
    ok: app.measures.every((m) => mine.has(m)),
    skipped: null,
    behind: app.measures.filter((m) => !mine.has(m)),
    ahead: invoked.measures.filter((m) => !theirs.has(m))
  }
}

/**
 * The refusal, as the operator should read it.
 *
 * Kept here rather than inline so the test suite can pin the wording: a guard
 * whose message does not say which fields went missing sends the reader back
 * to diffing two checkouts by hand, which is the work the guard exists to do.
 */
export function staleInstrumentMessage(
  verdict: InstrumentVerdict,
  invoked: InstrumentReport,
  app: InstrumentReport
): string {
  return [
    'STALE HARNESS — this capture would not measure what the build under test expects.',
    '',
    `The build at ${app.root} ships a harness that measures ${verdict.behind.length} thing(s)`,
    'this harness cannot emit:',
    ...verdict.behind.map((m) => `  ${m}`),
    '',
    `running harness  ${invoked.root} (${invoked.sourceSha ?? 'no sources'})`,
    `build's harness  ${app.root} (${app.sourceSha ?? 'no sources'})`,
    '',
    'Every run.json this sweep produced would be silently missing those fields, and a critic',
    'reading one could not tell an absent measurement from one that came back zero. Round 10',
    'shipped 36 runs that way. Re-run the sweep from the checkout the build was made from.'
  ].join('\n')
}
