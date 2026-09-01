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
 * Round 11 then ran the whole scheme and none of it fired. Both cross-cutting
 * columns came back 0-0-18 and printed `contested unknown — no counts kept`,
 * because a verdict file stores one word per task per column and every critic's
 * counts stayed in the prose of a report nobody kept. The three results above
 * were spelled the same way again, one level up: the vocabulary existed and the
 * data never reached it.
 *
 * So a column now has to say what kind of evidence stands behind it, and the
 * three answers are the three that were being confused:
 *
 *   counted      the numbers are in this file, task by task and run by run
 *   unrecorded   the critics counted and the round did not write it down. The
 *                verdicts are a record; the evidence for them is not, and the
 *                ties may not be read as agreement
 *   unasked      the question was not put this round
 *
 * A cross-cutting column that says none of the three is refused. That is the
 * only way a schema stops being one nobody fills: `unrecorded` is cheap to
 * write and says exactly what round 11 had, so the file can always be honest,
 * and it can no longer be silent.
 *
 * `settleable` is required beside `volume` for the same reason one level down.
 * Both cross-cutting questions order the critic to report it — a run that says
 * less is not thereby more consistent — and without it a zero disagreement
 * count is two facts again: the column looked and found none, or the column
 * could not look. Derived arithmetic would hide a miscount; a stated number
 * that has to add up does not.
 *
 * `corrections` is the same demand made of the round's own second thoughts. A
 * file may carry `columnsAsReported` beside `columns`, and every verdict that
 * differs between them must be named, with the rule it was overruled under.
 * Prose cannot be counted; a reader of a printout can now see how often a
 * verdict was overturned after the fact, and on what ground.
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
 * What stands behind a cross-cutting column's verdicts, declared by the column.
 *
 * The words are the verdict words one level up, deliberately: a round that lost
 * a verdict already writes `unrecorded`, and a round that lost only the numbers
 * behind a verdict now writes the same word in the same sense. Reusing them
 * keeps one vocabulary for one idea instead of two that drift.
 */
export const EVIDENCE = {
  counted: 'the numbers are in this file, task by task and run by run',
  unrecorded: 'the critics counted and the round did not write the numbers down',
  unasked: 'the question was not put this round'
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
 * One run's counts for one column on one task, checked rather than trusted.
 *
 *   volume       statements the application made about its own behaviour on the
 *                turn. Zero means it said nothing about itself, and zero on
 *                both sides is the whole reason this block exists: the question
 *                had nothing to bite on and the tie is about the task.
 *   settleable   how many of those this column could actually decide — for the
 *                screen-against-itself question, statements that pair with
 *                another about the same fact; for the screen-against-the-record
 *                question, statements the record covers. Zero with a volume
 *                above it means the run talked and not a word of it could be
 *                checked, which is a fact about the capture.
 *   count        the figure the column is scored on: disagreeing pairs, or
 *                contradictions. Zero is only an earned agreement when
 *                `settleable` is above zero, and that is exactly the pair of
 *                readings a lone zero cannot tell apart.
 *
 * A statement that is not settleable is unsettleable for one of two reasons and
 * they are not the same fact, so they are counted apart:
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
 * The arithmetic is checked because the failure it prevents is silent: numbers
 * that do not add up to the statements they were drawn from are not a column
 * with a bad number in it, they are a column whose halves were counted from
 * different lists. The split is optional and the total is not — a round that
 * cannot say which kind of unsettleable it had still has to say how much of
 * what the app said it was able to check.
 */
function countedOf(side, where) {
  if (typeof side.count !== 'number') {
    fail(`${where}: a count block was kept and the figure the column is scored on is not in it`)
  }
  if (typeof side.volume !== 'number') {
    fail(`${where}: a disagreement count was kept and the statements they came from were not`)
  }
  if (!Number.isInteger(side.settleable) || side.settleable < 0) {
    fail(
      `${where}: the statements this column could settle were not counted — ` +
        'without that number a zero is either nothing found or nothing looked at'
    )
  }
  if (side.settleable > side.volume) {
    fail(
      `${where}: ${side.settleable} settleable statements out of ${side.volume} made — ` +
        'the two halves were counted from different lists'
    )
  }
  if (side.count > 0 && side.settleable === 0) {
    fail(
      `${where}: ${side.count} found among 0 settleable statements — ` +
        'the two halves were counted from different lists'
    )
  }

  const u = side.unsettleable
  if (u === undefined) {
    return { volume: side.volume, settleable: side.settleable, count: side.count, unsettleable: null }
  }
  if (!u || typeof u !== 'object') fail(`${where}: "unsettleable" is present and is not a pair of counts`)
  for (const k of ['absent', 'byNature']) {
    if (!Number.isInteger(u[k]) || u[k] < 0) fail(`${where}: unsettleable.${k} is not a count`)
  }
  if (side.settleable + u.absent + u.byNature !== side.volume) {
    fail(
      `${where}: ${side.settleable} settleable and ${u.absent + u.byNature} unsettleable do not account ` +
        `for the ${side.volume} statements made — the two halves were counted from different lists`
    )
  }
  return {
    volume: side.volume,
    settleable: side.settleable,
    count: side.count,
    unsettleable: { absent: u.absent, byNature: u.byNature, total: u.absent + u.byNature }
  }
}

/**
 * One column's tally.
 *
 * `contested` and `quiet` are null rather than zero when the column carries no
 * counts to compute them from. Zero is a measurement; null is the absence of
 * one, and a round that reports the first when it has the second is making a
 * claim it cannot support — which is the failure this whole document is about.
 *
 * `uncontested` splits the ties the same way, and keeps `kindUnstated` for the
 * case a round counts what it could settle and cannot say why the rest was
 * unsettleable. Folding those into `settled` would report an earned tie the
 * round never established, which is the same failure one level down.
 */
function tallyColumn(column, taskIds) {
  const counts = { A: 0, B: 0, tie: 0, void: 0, unrecorded: 0, unasked: 0 }
  let contested = 0
  let measurable = 0
  let quiet = 0
  let reconstructed = 0
  const unsettleable = { absent: 0, byNature: 0 }
  const uncontested = { settled: 0, recordAbsent: 0, byNature: 0, neverInPlay: 0, kindUnstated: 0 }
  let accounted = 0

  for (const id of taskIds) {
    const entry = column.verdicts?.[id]
    if (!entry) fail(`column "${column.id}" has no verdict for ${id} — a column covers every task or it is not a column`)
    if (!(entry.verdict in counts)) fail(`column "${column.id}", ${id}: unknown verdict "${entry.verdict}"`)
    counts[entry.verdict] += 1
    if (entry.recorded === false) reconstructed += 1

    const a = entry.A
    const b = entry.B
    if (a || b) {
      if (!a || !b) {
        fail(
          `column "${column.id}", ${id}: one run carries counts and the other does not — ` +
            'a verdict rests on a comparison, and half a comparison is not one'
        )
      }
      measurable += 1
      const ca = countedOf(a, `column "${column.id}", ${id}, first run`)
      const cb = countedOf(b, `column "${column.id}", ${id}, second run`)
      const inPlay = ca.count > 0 || cb.count > 0
      if (inPlay) contested += 1
      const ua = ca.unsettleable
      const ub = cb.unsettleable
      if (ua) unsettleable.absent += ua.absent
      if (ub) unsettleable.absent += ub.absent
      if (ua) unsettleable.byNature += ua.byNature
      if (ub) unsettleable.byNature += ub.byNature
      if (ua || ub) accounted += 1

      if (!inPlay) {
        // Three ties wearing one word, told apart by two numbers: how much the
        // application said about itself, and how much of that this column could
        // check. Nothing said is a fact about the task; nothing checkable is a
        // fact about the capture; something checked and agreeing is the only one
        // of the three that is a fact about the two builds.
        const said = ca.volume + cb.volume
        const couldSettle = ca.settleable + cb.settleable
        if (said === 0) uncontested.neverInPlay += 1
        else if (couldSettle > 0) uncontested.settled += 1
        else if (ua && ub) {
          if (ua.absent + ub.absent >= ua.byNature + ub.byNature) uncontested.recordAbsent += 1
          else uncontested.byNature += 1
        } else uncontested.kindUnstated += 1
      }

      if (entry.verdict === 'A' || entry.verdict === 'B') {
        const winner = entry.verdict === 'A' ? ca : cb
        const loser = entry.verdict === 'A' ? cb : ca
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

  // And a column was never put in play when it bit on nothing and most of what
  // it looked at was silence. Same shape, different subject: the first sentence
  // is about the capture, this one is about the tasks. Both are columns whose
  // win/loss/tie line reads exactly like two builds agreeing.
  const neverPutInPlay = contested === 0 && uncontested.neverInPlay * 2 > measurable

  const evidence = column.evidence ?? (column.asked === false ? 'unasked' : null)

  return {
    id: column.id,
    asked: column.asked !== false,
    evidence,
    note: column.note ?? null,
    counts,
    // Tasks this column actually answered. A column of `unrecorded` verdicts
    // has none, and saying its ties cannot be read as agreement would be
    // describing ties it does not have.
    decided: counts.A + counts.B + counts.tie + counts.void,
    contested: measurable ? contested : null,
    measurable,
    uncounted: taskIds.length - measurable,
    quiet: measurable ? quiet : null,
    reconstructed,
    unsettleable: accounted ? unsettleable : null,
    uncontested: measurable ? uncontested : null,
    measuringCoverage: accounted ? measuringCoverage : false,
    neverPutInPlay: measurable ? neverPutInPlay : false,
    unattributed: (column.unattributed ?? []).length ? unattributed : null
  }
}

/**
 * What a column claims stands behind it, checked against what it carries.
 *
 * The task column is exempt: its numbers are named per task by each task's own
 * `measure` and are not comparable across them, which is why the renderer has
 * never printed a contested figure for it either.
 *
 * The three refusals are the same refusal from three sides. A column that says
 * nothing about its evidence is the round-11 failure verbatim. A column that
 * says it counted and carries no numbers is that failure with a label on it. A
 * column that says its numbers were lost and then produces some has mislabelled
 * a record as an absence, which would let a real measurement be read as one that
 * cannot be trusted.
 */
function checkEvidence(column, tally) {
  if (column.id === 'task') return
  const declared = column.evidence
  if (declared === undefined) {
    if (column.asked === false) return
    fail(
      `column "${column.id}" does not say what stands behind its verdicts — ` +
        `one of ${Object.keys(EVIDENCE).join(', ')}. A column of ties with nothing said about ` +
        'its numbers cannot be told from a column that was never put in play'
    )
  }
  if (!(declared in EVIDENCE)) {
    fail(`column "${column.id}": "${declared}" is not something that can stand behind a column`)
  }
  if (declared === 'counted' && tally.measurable === 0) {
    fail(`column "${column.id}" says its numbers were kept and carries none`)
  }
  if (declared !== 'counted' && tally.measurable > 0) {
    fail(`column "${column.id}" says its numbers were not kept and carries ${tally.measurable} of them`)
  }
  if (declared === 'unasked' && column.asked !== false) {
    fail(`column "${column.id}" says the question was not put and is marked as asked`)
  }
}

/**
 * The round's own second thoughts, made countable.
 *
 * A file may carry `columnsAsReported` beside `columns`: the critics' raw
 * verdicts, and the reading the round stands behind. Round 11 carried both and
 * explained the difference in a paragraph, which meant the printout showed a
 * corrected column with no sign that anything had been corrected.
 *
 * The check runs in both directions, because each direction hides a different
 * thing. A difference nobody declared is a verdict quietly overruled. A
 * declaration matching no difference is a rule invoked over nothing — the
 * appearance of rigour with no verdict behind it.
 */
function reconcile(round, tasks) {
  const declared = round.corrections ?? []
  const asReported = round.columnsAsReported ?? null

  if (!Array.isArray(declared)) fail('"corrections" is present and is not a list')
  if (declared.length && !asReported) {
    fail('a correction with no reported reading beside it is a claim, not a record')
  }
  if (!asReported) return []

  const raw = new Map(asReported.map((c) => [c.id, c]))
  const differences = []
  for (const col of round.columns) {
    const before = raw.get(col.id)
    if (!before) fail(`column "${col.id}" has no reported reading beside its corrected one`)
    for (const id of tasks) {
      const was = before.verdicts?.[id]?.verdict
      if (was === undefined) fail(`the reported reading of column "${col.id}" has no verdict for ${id}`)
      const now = col.verdicts[id].verdict
      if (was !== now) differences.push({ task: id, column: col.id, from: was, to: now })
    }
  }

  const claimed = []
  for (const [i, c] of declared.entries()) {
    const where = `corrections[${i}]`
    if (!c || typeof c !== 'object') fail(`${where} is not a correction`)
    if (!tasks.includes(c.task)) fail(`${where}: ${c.task} is not a task in this set`)
    if (!Array.isArray(c.columns) || !c.columns.length) fail(`${where}: a correction names the columns it moved`)
    if (!c.rule || String(c.rule).length < 20) {
      fail(`${where}: a correction states the rule it was made under, or it is a preference`)
    }
    for (const column of c.columns) claimed.push({ task: c.task, column, from: c.from, to: c.to, rule: c.rule })
  }

  const key = (d) => `${d.task} ${d.column} ${d.from} ${d.to}`
  const claimedKeys = new Set(claimed.map(key))
  for (const d of differences) {
    if (!claimedKeys.has(key(d))) {
      fail(
        `${d.task} is ${d.from} as reported and ${d.to} in column "${d.column}", and no correction says why — ` +
          'a verdict overruled without a rule is not a correction'
      )
    }
  }
  const actual = new Set(differences.map(key))
  for (const c of claimed) {
    if (!actual.has(key(c))) {
      fail(`a correction moves ${c.task} in column "${c.column}" from ${c.from} to ${c.to} and the two readings agree there`)
    }
  }
  return claimed
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
  round.columns.forEach((c, i) => checkEvidence(c, tallies[i]))
  const corrections = reconcile(round, tasks)
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
    corrections,
    verdictsOverruled: corrections.length,
    verdictsReported: round.columnsAsReported ? tasks.length * round.columns.length : null,
    anyReconstructed: tallies.some((t) => t.reconstructed > 0),
    // Columns whose quiet is the instrument's rather than the builds'. Named
    // here so a reader of the object, and not only a reader of the printout,
    // has to walk past it.
    columnsMeasuringRecordCoverage: tallies.filter((t) => t.measuringCoverage).map((t) => t.id),
    // Columns whose quiet is the tasks'. Same reason for being here: an object a
    // reader walks is a place a silent column can hide just as easily.
    columnsNeverPutInPlay: tallies.filter((t) => t.neverPutInPlay).map((t) => t.id),
    // And columns with no numbers at all, which is what round 11 had on both of
    // them. Their verdicts stand; nothing in them may be read as agreement.
    columnsWithoutNumbers: tallies.filter((t) => t.evidence === 'unrecorded' && t.decided > 0).map((t) => t.id)
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
      if (c.contested !== null) {
        parts.push(`contested ${c.contested}/${c.measurable}`)
        // The denominator is the tasks that carry counts, not the tasks in the
        // round. A column counted on two of eighteen printing `contested 1/2`
        // reads like a column contested on half of what it saw.
        if (c.uncounted) parts.push(`uncounted ${c.uncounted}`)
      } else if (c.evidence === 'unrecorded') {
        parts.push('contested unrecorded — the critics counted and the round did not keep it')
      }
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
      if (u.kindUnstated) bits.push(`unsettleable, kind not stated ${u.kindUnstated}`)
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
  // How often the round overruled its own critics, and under what rule. A
  // paragraph explaining one correction reads the same as a paragraph
  // explaining nine; a count does not.
  if (result.verdictsReported !== null) {
    lines.push(
      `  verdicts overruled after reporting    ${result.verdictsOverruled} of ${result.verdictsReported}`
    )
    for (const c of result.corrections) {
      lines.push(`      ${c.task} in ${c.column}: ${c.from} → ${c.to} — ${c.rule}`)
    }
  }
  lines.push('')
  lines.push('  columns are reported side by side and are not added together.')
  for (const id of result.columnsMeasuringRecordCoverage ?? []) {
    const c = result.columns.find((x) => x.id === id)
    lines.push('')
    lines.push(`  ${id} was uncontested on ${c.uncontested.recordAbsent} tasks only because the record`)
    lines.push('  that would settle them was not kept. On those tasks the column reported on how')
    lines.push('  much of the run was written down, not on either build. Read its ties as coverage.')
  }
  for (const id of result.columnsNeverPutInPlay ?? []) {
    const c = result.columns.find((x) => x.id === id)
    lines.push('')
    lines.push(`  ${id} was never put in play on ${c.uncontested.neverInPlay} tasks — neither run said`)
    lines.push('  anything for the question to bite on, and it bit on nothing anywhere. Its ties are a')
    lines.push('  fact about the tasks. They are not evidence that the two builds behave alike.')
  }
  for (const id of result.columnsWithoutNumbers ?? []) {
    const c = result.columns.find((x) => x.id === id)
    const named = c.counts.A + c.counts.B
    lines.push('')
    lines.push(`  ${id} kept no numbers. The critics counted statements and disagreements for both`)
    lines.push('  runs and the round wrote down only the word.')
    // A column that named a winner was demonstrably in play on those tasks and
    // nowhere else that can be shown. Saying it was never in play at all would
    // be the same overstatement in the other direction.
    if (named) {
      lines.push(`  It named ${named} winners, so it bit on ${named} of ${result.tasks} tasks; on the`)
      lines.push('  rest nothing here says whether the question was in play, and those ties cannot be')
      lines.push('  read as agreement.')
    } else {
      lines.push('  Its verdicts stand; its ties cannot be read as agreement, because nothing here')
      lines.push('  says the question was ever put in play on any task.')
    }
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
