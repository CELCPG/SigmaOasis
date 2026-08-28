/**
 * A round's verdicts, aggregated into columns.
 *
 * Rounds 1 to 9 produced ONE number per task — a winner, a loser or a tie — and
 * that number answered the task's own question. The question asked of every
 * task alongside it was answered too, on all eighteen tasks, and then folded
 * into the same line. A build that reduced how often the application
 * contradicted itself while tying the task's question therefore scored nothing,
 * and rounds 8 and 9 each recorded a real repair that vanished exactly that way.
 *
 * The repair is not a better task question. It is a second column.
 *
 *   task                the task's own `question` / `measure` / `decide`
 *   <cross-cutting>      one column per entry in `crossCutting.questions`
 *
 * Columns are reported side by side and NEVER added together. Two reasons, and
 * the second is the one that bites:
 *
 *   A round's headline stays the task column, because the six dimensions are
 *   what the app's own audit chose and a cross-cutting column is not one of
 *   them. Summing would let a build that moved nothing a task asks about report
 *   a task win.
 *
 *   The columns are not independent. The same repair can win two of them, so a
 *   sum double-counts one fix and hides that it did. `scoredInMoreThanOne`
 *   below is that overlap, reported rather than netted out: a cross-cutting
 *   column whose wins all land on tasks the task column already won has added
 *   no evidence, and the number says so.
 *
 * The figure this file exists to produce is `seenOnlyByACrossCuttingColumn` —
 * tasks the task column tied or voided where a cross-cutting column named a
 * winner. That is the class of result rounds 8 and 9 threw away. It is reported
 * in BOTH directions, because a column that can only add wins is a column that
 * flatters.
 *
 * Two guards against the cheapest way to pass any of these questions, which is
 * to print less:
 *
 *   `contested` — tasks where at least one run gave the question something to
 *   bite on. A column of ties over eighteen tasks that were contested on none
 *   of them says the property was never in play, which is not the same claim as
 *   two builds behaving alike, and the win/loss/tie line cannot tell them apart.
 *
 *   `quiet` — wins where the winning run said LESS than the loser, by the
 *   column's own volume figure (statements made, statements the record could
 *   settle). Flagged, never demoted: a build that removed one half of a
 *   contradiction has fewer statements and fewer contradictions and is right to
 *   win. A human reads the flag; the script does not decide it.
 *
 * Round 10 then showed that `contested` is itself two facts wearing one number.
 * Its record column was contested on four tasks of eighteen and tied on the
 * other fourteen, and those fourteen ties were three different results:
 *
 *   never in play      neither run said anything for the question to bite on
 *   unsettleable       both runs made statements and no artifact could settle
 *                      one of them — either because the record that would was
 *                      not kept (fixable by capture), or because the
 *                      application is the only witness to what it is claiming
 *                      (not fixable at all, and a different fact)
 *   settled            statements were settleable, were settled, and agreed.
 *                      The only one of the three that is an earned tie.
 *
 * A column whose ties are mostly the second kind is not reporting on the
 * application. It is reporting on how much of the run got written down. That
 * distinction is the difference between "these two builds behave alike" and
 * "this instrument cannot see", so the renderer below states it in words when
 * it is true rather than leaving it inside a ratio.
 *
 *   node docs/head-to-head/score-round.mjs docs/head-to-head/verdicts/round-9.json
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Verdicts a column entry may carry, and what each means for the tally. */
export const VERDICTS = {
  A: 'the first-named build was ahead on this question',
  B: 'the second-named build was ahead on this question',
  tie: 'neither was ahead — which is three different results; the round has to say which',
  void: 'the evidence does not settle it, for a reason that is not the change under test',
  unrecorded: 'the question was put and the answer was not kept',
  unasked: 'the question was not put on this round'
}

/**
 * The columns a round may have, read out of the task set rather than declared
 * here, so a column and the question it scores cannot drift apart.
 */
export function declaredColumns(taskSetPath = join(here, 'tasks.json')) {
  const set = JSON.parse(readFileSync(taskSetPath, 'utf8'))
  return {
    tasks: set.tasks.map((t) => t.id),
    columns: ['task', ...set.crossCutting.questions.map((q) => q.id)]
  }
}

function fail(message) {
  const err = new Error(message)
  err.incoherent = true
  throw err
}

/**
 * One side's `unsettleable` split, checked rather than trusted.
 *
 * A statement is unsettleable for one of two reasons and they are not the same
 * fact, so they are counted apart:
 *
 *   absent    an artifact could settle it and this run does not have one — an
 *             audit the task never asked the app to keep, a fixture that was
 *             not stood up. A capture problem, and therefore fixable.
 *   byNature  no artifact can settle it, because the application is the only
 *             witness to what it is claiming. A duration it timed with its own
 *             clock is the type case: a record of that number is the app
 *             writing the same number down twice, which agrees by construction
 *             and so settles nothing.
 *
 * The arithmetic is checked because the failure it prevents is silent: more
 * unsettleable statements than statements is not a column with a bad number in
 * it, it is a column whose two halves were counted from different lists.
 */
function unsettleableOf(side, where) {
  const u = side.unsettleable
  if (u === undefined) return null
  if (!u || typeof u !== 'object') fail(`${where}: "unsettleable" is present and is not a pair of counts`)
  for (const k of ['absent', 'byNature']) {
    if (!Number.isInteger(u[k]) || u[k] < 0) fail(`${where}: unsettleable.${k} is not a count`)
  }
  if (typeof side.volume !== 'number') {
    fail(`${where}: unsettleable statements were counted and the statements they came from were not`)
  }
  if (u.absent + u.byNature > side.volume) {
    fail(
      `${where}: ${u.absent + u.byNature} unsettleable statements out of ${side.volume} made — ` +
        'the two halves were counted from different lists'
    )
  }
  return { absent: u.absent, byNature: u.byNature, total: u.absent + u.byNature }
}

/**
 * One column's tally.
 *
 * `contested` and `quiet` are null rather than zero when the column carries no
 * counts to compute them from. Zero is a measurement; null is the absence of
 * one, and a round that reports the first when it has the second is making a
 * claim it cannot support — which is the failure this whole document is about.
 *
 * `uncontested` splits the ties the same way, and keeps `unknown` for the case
 * a round supplies counts without the unsettleable breakdown. Folding those
 * into `settled` would report an earned tie the round never established, which
 * is the same failure one level down.
 */
function tallyColumn(column, taskIds) {
  const counts = { A: 0, B: 0, tie: 0, void: 0, unrecorded: 0, unasked: 0 }
  let contested = 0
  let measurable = 0
  let quiet = 0
  let reconstructed = 0
  const unsettleable = { absent: 0, byNature: 0 }
  const uncontested = { settled: 0, recordAbsent: 0, byNature: 0, neverInPlay: 0, unknown: 0 }
  let accounted = 0

  for (const id of taskIds) {
    const entry = column.verdicts?.[id]
    if (!entry) fail(`column "${column.id}" has no verdict for ${id} — a column covers every task or it is not a column`)
    if (!(entry.verdict in counts)) fail(`column "${column.id}", ${id}: unknown verdict "${entry.verdict}"`)
    counts[entry.verdict] += 1
    if (entry.recorded === false) reconstructed += 1

    const a = entry.A
    const b = entry.B
    if (a && b && typeof a.count === 'number' && typeof b.count === 'number') {
      measurable += 1
      const inPlay = a.count > 0 || b.count > 0
      if (inPlay) contested += 1
      const ua = unsettleableOf(a, `column "${column.id}", ${id}, first run`)
      const ub = unsettleableOf(b, `column "${column.id}", ${id}, second run`)
      if (ua) unsettleable.absent += ua.absent
      if (ub) unsettleable.absent += ub.absent
      if (ua) unsettleable.byNature += ua.byNature
      if (ub) unsettleable.byNature += ub.byNature
      if (ua || ub) accounted += 1

      if (!inPlay) {
        const volumed = typeof a.volume === 'number' && typeof b.volume === 'number'
        const said = volumed ? a.volume + b.volume : null
        if (said === 0) uncontested.neverInPlay += 1
        else if (!ua || !ub || !volumed) uncontested.unknown += 1
        else if (ua.total + ub.total === said) {
          if (ua.absent + ub.absent >= ua.byNature + ub.byNature) uncontested.recordAbsent += 1
          else uncontested.byNature += 1
        } else uncontested.settled += 1
      }

      const winner = entry.verdict === 'A' ? a : entry.verdict === 'B' ? b : null
      const loser = entry.verdict === 'A' ? b : entry.verdict === 'B' ? a : null
      if (winner && loser && typeof winner.volume === 'number' && typeof loser.volume === 'number') {
        if (winner.volume < loser.volume) quiet += 1
      }
    }
  }

  const unattributed = { A: 0, B: 0, tie: 0, void: 0 }
  for (const u of column.unattributed ?? []) {
    if (!(u.verdict in unattributed)) fail(`column "${column.id}": unattributed verdict "${u.verdict}" cannot be tallied`)
    unattributed[u.verdict] += 1
    if (u.recorded === false) reconstructed += 1
  }

  // A column is "measuring the record's coverage" when more of its ties come
  // from a record that was never kept than from anything it actually settled.
  // That is a statement about the instrument, not about either build, and it is
  // the reason a column can look calm while seeing nothing.
  const measuringCoverage = uncontested.recordAbsent > uncontested.settled + contested

  return {
    id: column.id,
    asked: column.asked !== false,
    note: column.note ?? null,
    counts,
    contested: measurable ? contested : null,
    measurable,
    quiet: measurable ? quiet : null,
    reconstructed,
    unsettleable: accounted ? unsettleable : null,
    uncontested: measurable ? uncontested : null,
    measuringCoverage: accounted ? measuringCoverage : false,
    unattributed: (column.unattributed ?? []).length ? unattributed : null
  }
}

export function score(round, { tasks, columns } = declaredColumns()) {
  if (!Array.isArray(round.columns) || !round.columns.length) fail('a round with no columns is not a round')
  const seen = new Set()
  for (const c of round.columns) {
    if (!columns.includes(c.id)) {
      fail(`column "${c.id}" is not the task column and is not a question the task set asks of every task`)
    }
    if (seen.has(c.id)) fail(`column "${c.id}" appears twice`)
    seen.add(c.id)
  }
  if (!seen.has('task')) fail('a round without a task column has nothing to report a cross-cutting column beside')

  const tallies = round.columns.map((c) => tallyColumn(c, tasks))
  const byId = new Map(round.columns.map((c) => [c.id, c]))
  const taskColumn = byId.get('task')

  // The figure the second column exists to produce, in both directions.
  const seenOnly = { A: [], B: [] }
  const scoredInMoreThanOne = []
  for (const id of tasks) {
    const taskVerdict = taskColumn.verdicts[id].verdict
    const winners = round.columns
      .filter((c) => c.id !== 'task')
      .filter((c) => c.verdicts[id].verdict === 'A' || c.verdicts[id].verdict === 'B')
    if (taskVerdict === 'tie' || taskVerdict === 'void') {
      for (const c of winners) seenOnly[c.verdicts[id].verdict].push(`${id} (${c.id})`)
    }
    const named = (taskVerdict === 'A' || taskVerdict === 'B' ? 1 : 0) + winners.length
    if (named > 1) scoredInMoreThanOne.push(id)
  }

  return {
    round: round.round,
    pair: round.pair ?? null,
    tasks: tasks.length,
    columns: tallies,
    seenOnlyByACrossCuttingColumn: seenOnly,
    scoredInMoreThanOne,
    anyReconstructed: tallies.some((t) => t.reconstructed > 0),
    // Columns whose quiet is the instrument's rather than the builds'. Named
    // here so a reader of the object, and not only a reader of the printout,
    // has to walk past it.
    columnsMeasuringRecordCoverage: tallies.filter((t) => t.measuringCoverage).map((t) => t.id)
  }
}

const pad = (s, n) => String(s).padEnd(n)

function wrap(text, width) {
  if (!text) return []
  const out = []
  let line = ''
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

export function render(result) {
  const lines = []
  const pair = result.pair ? ` — ${result.pair.A} (A) against ${result.pair.B} (B)` : ''
  lines.push(`round ${result.round}${pair}, ${result.tasks} tasks`)
  lines.push('')
  const width = Math.max(...result.columns.map((c) => c.id.length)) + 2
  for (const c of result.columns) {
    const parts = []
    if (!c.asked) parts.push('NOT ASKED')
    const { A, B, tie } = c.counts
    parts.push(`A ${A} · B ${B} · tie ${tie}`)
    if (c.counts.void) parts.push(`void ${c.counts.void}`)
    if (c.counts.unrecorded) parts.push(`unrecorded ${c.counts.unrecorded}`)
    if (c.counts.unasked) parts.push(`unasked ${c.counts.unasked}`)
    // Only a cross-cutting column has one count per run to be contested on. The
    // task column's numbers are named per task and are not comparable across them.
    if (c.id !== 'task') {
      if (c.contested !== null) parts.push(`contested ${c.contested}/${c.measurable}`)
      else if (c.asked) parts.push('contested unknown — no counts kept')
    }
    if (c.quiet) parts.push(`quiet wins ${c.quiet}`)
    if (c.unattributed) {
      const u = c.unattributed
      parts.push(`unattributed A ${u.A} · B ${u.B} · tie ${u.tie}`)
    }
    lines.push(`  ${pad(c.id, width)}${parts.join('  ·  ')}`)
    // Why the column was uncontested, on its own line: a tie that settled, a
    // tie nothing could settle, and a tie with nothing to settle are three
    // results, and the win/loss/tie line spells all three the same way.
    if (c.id !== 'task' && c.uncontested) {
      const u = c.uncontested
      const bits = []
      if (u.settled) bits.push(`settled and agreed ${u.settled}`)
      if (u.recordAbsent) bits.push(`unsettleable, record not kept ${u.recordAbsent}`)
      if (u.byNature) bits.push(`unsettleable by nature ${u.byNature}`)
      if (u.neverInPlay) bits.push(`never in play ${u.neverInPlay}`)
      if (u.unknown) bits.push(`unaccounted ${u.unknown}`)
      if (bits.length) lines.push(`  ${pad('', width)}uncontested: ${bits.join(' · ')}`)
    }
    if (c.unsettleable && (c.unsettleable.absent || c.unsettleable.byNature)) {
      const u = c.unsettleable
      // Statements, not tasks, and summed over both runs — the line above this
      // one counts tasks, so the unit is said out loud rather than inferred.
      lines.push(
        `  ${pad('', width)}unsettleable statements, both runs: ${u.absent} for want of a record · ${u.byNature} by nature`
      )
    }
    for (const line of wrap(c.note, 96 - width)) lines.push(`  ${pad('', width)}${line}`)
  }
  lines.push('')
  const only = result.seenOnlyByACrossCuttingColumn
  lines.push(`  seen only by a cross-cutting column   B ${only.B.length} · A ${only.A.length}`)
  for (const w of [...only.B, ...only.A]) lines.push(`      ${w}`)
  lines.push(`  scored in more than one column        ${result.scoredInMoreThanOne.length} of ${result.tasks}`)
  lines.push('')
  lines.push('  columns are reported side by side and are not added together.')
  for (const id of result.columnsMeasuringRecordCoverage ?? []) {
    const c = result.columns.find((x) => x.id === id)
    lines.push('')
    lines.push(`  ${id} was uncontested on ${c.uncontested.recordAbsent} tasks only because the record`)
    lines.push('  that would settle them was not kept. On those tasks the column reported on how')
    lines.push('  much of the run was written down, not on either build. Read its ties as coverage.')
  }
  if (result.anyReconstructed) {
    lines.push('  some verdicts above were reconstructed from a round write-up rather than')
    lines.push('  recomputed from a critic report. They are not a record; they are an estimate.')
  }
  return lines.join('\n')
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: score-round.mjs <verdicts-file.json>')
    process.exit(2)
  }
  try {
    console.log(render(score(JSON.parse(readFileSync(file, 'utf8')))))
  } catch (err) {
    console.error(err.incoherent ? `refusing to score: ${err.message}` : String(err))
    process.exit(2)
  }
}
