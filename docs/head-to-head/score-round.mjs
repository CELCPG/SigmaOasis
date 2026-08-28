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
 * One column's tally.
 *
 * `contested` and `quiet` are null rather than zero when the column carries no
 * counts to compute them from. Zero is a measurement; null is the absence of
 * one, and a round that reports the first when it has the second is making a
 * claim it cannot support — which is the failure this whole document is about.
 */
function tallyColumn(column, taskIds) {
  const counts = { A: 0, B: 0, tie: 0, void: 0, unrecorded: 0, unasked: 0 }
  let contested = 0
  let measurable = 0
  let quiet = 0
  let reconstructed = 0

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
      if (a.count > 0 || b.count > 0) contested += 1
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

  return {
    id: column.id,
    asked: column.asked !== false,
    note: column.note ?? null,
    counts,
    contested: measurable ? contested : null,
    measurable,
    quiet: measurable ? quiet : null,
    reconstructed,
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
    anyReconstructed: tallies.some((t) => t.reconstructed > 0)
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
    for (const line of wrap(c.note, 96 - width)) lines.push(`  ${pad('', width)}${line}`)
  }
  lines.push('')
  const only = result.seenOnlyByACrossCuttingColumn
  lines.push(`  seen only by a cross-cutting column   B ${only.B.length} · A ${only.A.length}`)
  for (const w of [...only.B, ...only.A]) lines.push(`      ${w}`)
  lines.push(`  scored in more than one column        ${result.scoredInMoreThanOne.length} of ${result.tasks}`)
  lines.push('')
  lines.push('  columns are reported side by side and are not added together.')
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
