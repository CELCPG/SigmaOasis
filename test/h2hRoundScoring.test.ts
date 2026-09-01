import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

/**
 * A round is scored in COLUMNS, and the columns are not added together.
 *
 * Rounds 1 to 9 emitted one verdict per task. The question asked of every task
 * alongside the task's own — does anything the application says on this screen
 * contradict anything else it says on the same screen — was answered on all
 * eighteen tasks in round 9 and folded into that same verdict, so a build that
 * reduced how often the app contradicted itself while tying the task's question
 * scored nothing. Rounds 8 and 9 each recorded a real repair lost exactly there.
 *
 * `score-round.mjs` is the aggregator. This is what it may not do:
 *
 *   - invent a column the task set does not ask of every task
 *   - report a column that does not cover every task
 *   - let anything in a cross-cutting column move the task column
 *   - report a contested denominator it has no counts to compute
 *   - decide, on its own, that a win by the quieter run is not a win
 *
 * Round 11 then produced two columns of eighteen ties apiece and the scorer
 * printed `contested unknown — no counts kept` for both, which is honest and
 * useless: a column nobody put in play looks exactly like a column both builds
 * passed. So a cross-cutting column must now say what stands behind it, and
 * these are the further things the scorer may not do:
 *
 *   - score a cross-cutting column that says nothing about its evidence
 *   - let a column claim it counted and carry no counts, or the reverse
 *   - report a tie as settled without a count of what could be settled
 *   - carry a corrected reading beside a reported one and say nothing about
 *     which verdicts moved, or claim a correction that moved none
 *
 * The scorer is an ES module and the suite compiles to CommonJS, so it is driven
 * as the command it actually is. That also puts its exit codes under test, which
 * is the half of a refusal that matters: a script that prints a complaint and
 * exits 0 has not refused anything.
 */

const ROOT = join(__dirname, '..', '..')
const SCORER = join(ROOT, 'docs', 'head-to-head', 'score-round.mjs')
const VERDICTS = join(ROOT, 'docs', 'head-to-head', 'verdicts')
const TASKS = join(ROOT, 'docs', 'head-to-head', 'tasks.json')
const ROUNDS = join(ROOT, 'docs', 'head-to-head', 'rounds.json')

type Entry = { verdict: string; recorded?: boolean; A?: Counted; B?: Counted }
type Counted = {
  volume: number
  settleable: number
  count: number
  unsettleable?: { absent: number; byNature: number }
}
type Correction = { task: string; columns: string[]; from: string; to: string; rule: string }
type Column = {
  id: string
  asked?: boolean
  evidence?: string
  note?: string
  verdicts: Record<string, Entry>
  unattributed?: Entry[]
}
type Round = {
  round: number
  pair?: { A: string; B: string }
  columns: Column[]
  columnsAsReported?: Column[]
  corrections?: Correction[]
}

const taskIds: string[] = (JSON.parse(readFileSync(TASKS, 'utf-8')) as { tasks: { id: string }[] }).tasks.map(
  (t) => t.id
)
const questionIds: string[] = (
  JSON.parse(readFileSync(TASKS, 'utf-8')) as { crossCutting: { questions: { id: string }[] } }
).crossCutting.questions.map((q) => q.id)

const scratch = mkdtempSync(join(tmpdir(), 'h2h-score-'))

/** Run the scorer over a round object, returning what a caller would get. */
function run(round: Round | string): { status: number; out: string; err: string } {
  const file = typeof round === 'string' ? round : join(scratch, `r-${Math.random().toString(36).slice(2)}.json`)
  if (typeof round !== 'string') writeFileSync(file, JSON.stringify(round))
  const res = spawnSync(process.execPath, [SCORER, file], {
    encoding: 'utf-8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  return { status: res.status ?? -1, out: res.stdout ?? '', err: res.stderr ?? '' }
}

const fill = (verdict: string, overrides: Record<string, Entry> = {}): Record<string, Entry> =>
  Object.fromEntries(taskIds.map((id) => [id, overrides[id] ?? { verdict }]))

/**
 * A minimal coherent round: everything ties, in every column, and every
 * cross-cutting column says its numbers were lost. That is round 11 exactly,
 * and it is the cheapest honest thing a round can write.
 */
function baseRound(overrides: Partial<Round> = {}): Round {
  return {
    round: 99,
    pair: { A: 'the earlier build', B: 'the later build' },
    columns: [
      { id: 'task', verdicts: fill('tie') },
      ...questionIds.map((id) => ({ id, evidence: 'unrecorded', verdicts: fill('tie') }))
    ],
    ...overrides
  }
}

/** The same round with one cross-cutting column declaring it kept its numbers. */
function counting(round: Round, id = questionIds[0]): Column {
  const col = round.columns.find((c) => c.id === id)!
  col.evidence = 'counted'
  return col
}

/**
 * The line the rendered headline gives a column, without its wrapped note and
 * with runs of spaces collapsed — the column names are padded to the widest one,
 * so dropping a column moves the whitespace on every line that is left.
 */
function columnLine(out: string, id: string): string {
  const line = out.split('\n').find((l) => l.trim().startsWith(`${id} `) || l.trim() === id)
  assert.ok(line, `no line for column ${id} in:\n${out}`)
  return line!.trim().replace(/ {2,}/g, ' ')
}

describe('a round is scored in columns', () => {
  test('a coherent round scores, and names both builds', () => {
    const r = run(baseRound())
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /the earlier build \(A\) against the later build \(B\)/)
    assert.match(r.out, new RegExp(`${taskIds.length} tasks`))
  })

  test('the columns a round may have come from the task set, not from the round', () => {
    const round = baseRound()
    round.columns.push({ id: 'looks-good-to-me', verdicts: fill('B') })
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /looks-good-to-me/)
    assert.match(r.err, /question the task set asks of every task/)
  })

  test('every question the task set asks of every task can be a column', () => {
    for (const id of questionIds) {
      const r = run(
        baseRound({
          columns: [{ id: 'task', verdicts: fill('tie') }, { id, evidence: 'unrecorded', verdicts: fill('tie') }]
        })
      )
      assert.equal(r.status, 0, `${id} was refused as a column: ${r.err}`)
    }
  })

  test('a column that does not cover every task is refused, by name', () => {
    const round = baseRound()
    const missing = taskIds[5]
    delete round.columns[1].verdicts[missing]
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, new RegExp(missing))
    assert.match(r.err, /covers every task or it is not a column/)
  })

  test('a verdict the tally has no meaning for is refused', () => {
    const round = baseRound()
    round.columns[1].verdicts[taskIds[0]] = { verdict: 'probably fine' }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /probably fine/)
  })

  test('a round with no task column has nothing to report a column beside', () => {
    const r = run(baseRound({ columns: [{ id: questionIds[0], verdicts: fill('tie') }] }))
    assert.equal(r.status, 2)
    assert.match(r.err, /without a task column/)
  })

  test('the same column twice is refused', () => {
    const round = baseRound()
    round.columns.push({ id: questionIds[0], verdicts: fill('B') })
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /appears twice/)
  })
})

describe('the task column does not move', () => {
  /**
   * The property the whole scheme rests on. A cross-cutting column can swing
   * from every task to none of them and the number a round leads with is the
   * same, because they are two facts and not one verdict.
   */
  test('a clean sweep in a cross-cutting column changes nothing in the task column', () => {
    const tied = baseRound()
    const swept = baseRound()
    for (const id of questionIds) {
      swept.columns.find((c) => c.id === id)!.verdicts = fill('B')
    }
    assert.equal(columnLine(run(tied).out, 'task'), columnLine(run(swept).out, 'task'))
  })

  test('and dropping the cross-cutting columns entirely changes nothing in the task column', () => {
    const full = baseRound()
    const bare = baseRound({ columns: [{ id: 'task', verdicts: fill('tie', { V1: { verdict: 'B' } }) }] })
    full.columns[0].verdicts = fill('tie', { V1: { verdict: 'B' } })
    assert.equal(columnLine(run(full).out, 'task'), columnLine(run(bare).out, 'task'))
  })

  test('the headline says the columns are not added together', () => {
    assert.match(run(baseRound()).out, /not added together/)
  })
})

describe('what a second column is for', () => {
  test('a win on a task the task column tied is reported as seen only by that column', () => {
    const round = baseRound()
    round.columns[1].verdicts[taskIds[0]] = { verdict: 'B' }
    const out = run(round).out
    assert.match(out, /seen only by a cross-cutting column\s+B 1 · A 0/)
    assert.match(out, new RegExp(`${taskIds[0]} \\(${questionIds[0]}\\)`))
  })

  test('a loss is reported in the same place — a column that can only add wins flatters', () => {
    const round = baseRound()
    round.columns[1].verdicts[taskIds[0]] = { verdict: 'A' }
    assert.match(run(round).out, /seen only by a cross-cutting column\s+B 0 · A 1/)
  })

  test('a win on a task the task column already won is overlap, not new evidence', () => {
    const round = baseRound()
    round.columns[0].verdicts[taskIds[0]] = { verdict: 'B' }
    round.columns[1].verdicts[taskIds[0]] = { verdict: 'B' }
    const out = run(round).out
    assert.match(out, /seen only by a cross-cutting column\s+B 0 · A 0/)
    assert.match(out, /scored in more than one column\s+1 of/)
  })

  test('a voided task is one the task column did not score, so a column can still see it', () => {
    const round = baseRound()
    round.columns[0].verdicts[taskIds[0]] = { verdict: 'void' }
    round.columns[1].verdicts[taskIds[0]] = { verdict: 'B' }
    assert.match(run(round).out, /seen only by a cross-cutting column\s+B 1 · A 0/)
  })
})

describe('the guards against winning by saying less', () => {
  test('contested counts the tasks where at least one run gave the question something to bite on', () => {
    const round = baseRound()
    const col = counting(round)
    col.verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 9, settleable: 9, count: 2 },
      B: { volume: 9, settleable: 9, count: 0 }
    }
    col.verdicts[taskIds[1]] = {
      verdict: 'tie',
      A: { volume: 9, settleable: 9, count: 0 },
      B: { volume: 9, settleable: 9, count: 0 }
    }
    assert.match(run(round).out, /contested 1\/2/)
  })

  /**
   * The denominator of `contested` is the tasks that carry counts, not the
   * tasks in the round. Sixteen uncounted tasks behind a `contested 1/2` is the
   * round-11 failure inside the figure that was supposed to expose it.
   */
  test('a contested figure says how many tasks it did not count', () => {
    const round = baseRound()
    const col = counting(round)
    col.verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 9, settleable: 9, count: 2 },
      B: { volume: 9, settleable: 9, count: 0 }
    }
    assert.match(columnLine(run(round).out, questionIds[0]), new RegExp(`uncounted ${taskIds.length - 1}`))
  })

  test('a column that kept no counts says which of the three that is, not nothing', () => {
    const out = run(baseRound()).out
    const line = columnLine(out, questionIds[0])
    assert.match(line, /contested unrecorded — the critics counted and the round did not keep it/)
    assert.doesNotMatch(line, /contested 0\//)
    assert.match(out, /cannot be read as agreement/)
  })

  test('a win by the run that said less is flagged, and is still a win', () => {
    const round = baseRound()
    counting(round).verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 12, settleable: 12, count: 3 },
      B: { volume: 4, settleable: 4, count: 0 }
    }
    const line = columnLine(run(round).out, questionIds[0])
    assert.match(line, /quiet wins 1/)
    assert.match(line, /B 1/)
  })

  test('a win by the run that said MORE is not flagged', () => {
    const round = baseRound()
    counting(round).verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 4, settleable: 4, count: 3 },
      B: { volume: 12, settleable: 12, count: 0 }
    }
    assert.doesNotMatch(columnLine(run(round).out, questionIds[0]), /quiet/)
  })

  test('the task column is never annotated with a contested denominator it does not have', () => {
    assert.doesNotMatch(columnLine(run(baseRound()).out, 'task'), /contested/)
  })
})

/**
 * Round 10's record column was contested on four tasks of eighteen. The other
 * fourteen were reported as ties, and they were three different results wearing
 * one word: a tie nothing could settle because the artifact that would was
 * never kept, a tie nothing can ever settle because the app is the only witness
 * to what it claimed, and a tie that was actually settled and actually agreed.
 *
 * Only the last is a fact about the two builds. The first is a fact about the
 * capture. The second is a fact about the claim. A column made mostly of the
 * first is reporting on how much of the run got written down, and the round
 * cannot tell that from equivalence unless the scorer says so.
 */
describe('why a column was uncontested', () => {
  /** A column carrying counts on the first two tasks and nothing on the rest. */
  function withEntries(a: Entry, b: Entry): Round {
    const round = baseRound()
    const col = counting(round)
    col.verdicts[taskIds[0]] = a
    col.verdicts[taskIds[1]] = b
    return round
  }

  const uncontestedLine = (out: string): string => {
    const line = out.split('\n').find((l) => l.trim().startsWith('uncontested:'))
    assert.ok(line, `no uncontested breakdown in:\n${out}`)
    return line!.trim().replace(/ {2,}/g, ' ')
  }

  const nothing = { volume: 0, settleable: 0, count: 0 }

  test('a tie where neither run said anything is never in play, not agreement', () => {
    const out = run(
      withEntries({ verdict: 'tie', A: nothing, B: nothing }, { verdict: 'tie', A: nothing, B: nothing })
    ).out
    assert.match(uncontestedLine(out), /never in play 2/)
    assert.doesNotMatch(uncontestedLine(out), /settled and agreed/)
  })

  test('a tie where every statement wanted an absent record is reported as that, not as a tie', () => {
    const absent = { volume: 6, settleable: 0, count: 0, unsettleable: { absent: 6, byNature: 0 } }
    const out = run(
      withEntries({ verdict: 'tie', A: absent, B: absent }, { verdict: 'tie', A: absent, B: absent })
    ).out
    assert.match(uncontestedLine(out), /unsettleable, record not kept 2/)
    assert.doesNotMatch(uncontestedLine(out), /settled and agreed/)
  })

  test('a tie on statements nothing can ever settle is a different fact, and counted apart', () => {
    const byNature = { volume: 4, settleable: 0, count: 0, unsettleable: { absent: 0, byNature: 4 } }
    const out = run(
      withEntries({ verdict: 'tie', A: byNature, B: byNature }, { verdict: 'tie', A: byNature, B: byNature })
    ).out
    assert.match(uncontestedLine(out), /unsettleable by nature 2/)
    assert.doesNotMatch(uncontestedLine(out), /record not kept/)
  })

  test('a tie where the record settled every statement and they agreed is the earned one', () => {
    const settled = { volume: 5, settleable: 5, count: 0, unsettleable: { absent: 0, byNature: 0 } }
    const out = run(
      withEntries({ verdict: 'tie', A: settled, B: settled }, { verdict: 'tie', A: settled, B: settled })
    ).out
    assert.match(uncontestedLine(out), /settled and agreed 2/)
  })

  /**
   * The three ties are told apart by two numbers, and the second of them is
   * what round 11 did not have. Statements alone cannot separate a run that was
   * checked and agreed from one nothing could check, so the count of what could
   * be settled is required beside the statements rather than derived from the
   * unsettleable split — a derived number cannot catch the miscount that the
   * whole "different lists" family of refusals exists to catch.
   */
  test('a count of statements with no count of what could be settled is refused', () => {
    const round = baseRound()
    counting(round).verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { volume: 5, count: 0 } as unknown as Counted,
      B: { volume: 5, count: 0 } as unknown as Counted
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /the statements this column could settle were not counted/)
  })

  /**
   * And with that number present but the split absent, the tie is unsettleable
   * with the kind unstated. Folding it into `settled` would report an earned
   * tie the round never established; folding it into `record not kept` would
   * blame the capture for something that may be nobody's fault.
   */
  test('nothing settleable and no split is unsettleable with the kind unstated, not settled', () => {
    const opaque = { volume: 5, settleable: 0, count: 0 }
    const out = run(
      withEntries({ verdict: 'tie', A: opaque, B: opaque }, { verdict: 'tie', A: opaque, B: opaque })
    ).out
    assert.match(uncontestedLine(out), /unsettleable, kind not stated 2/)
    assert.doesNotMatch(uncontestedLine(out), /settled and agreed/)
  })

  test('the unsettleable statement totals are reported, split by which kind', () => {
    const mixed = { volume: 10, settleable: 3, count: 0, unsettleable: { absent: 4, byNature: 3 } }
    const out = run(
      withEntries({ verdict: 'tie', A: mixed, B: mixed }, { verdict: 'tie', A: mixed, B: mixed })
    ).out
    assert.match(out, /unsettleable statements, both runs: 16 for want of a record · 12 by nature/)
  })

  test('a column whose ties are mostly an absent record is named as measuring coverage', () => {
    const round = baseRound()
    const col = counting(round)
    const absent = { volume: 6, settleable: 0, count: 0, unsettleable: { absent: 6, byNature: 0 } }
    for (const id of taskIds) col.verdicts[id] = { verdict: 'tie', A: absent, B: absent }
    col.verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 6, settleable: 5, count: 2, unsettleable: { absent: 1, byNature: 0 } },
      B: { volume: 6, settleable: 5, count: 0, unsettleable: { absent: 1, byNature: 0 } }
    }
    const out = run(round).out
    assert.match(out, /only because the record/)
    assert.match(out, /Read its ties as coverage/)
    assert.match(out, new RegExp(`uncontested on ${taskIds.length - 1} tasks`))
  })

  test('a column that mostly settled what it looked at is not', () => {
    const round = baseRound()
    const col = counting(round)
    const settled = { volume: 6, settleable: 6, count: 0, unsettleable: { absent: 0, byNature: 0 } }
    for (const id of taskIds) col.verdicts[id] = { verdict: 'tie', A: settled, B: settled }
    assert.doesNotMatch(run(round).out, /Read its ties as coverage/)
  })

  /**
   * The figure this whole round was for. A column of eighteen ties where
   * neither run ever said anything is not two builds agreeing, and the
   * win/loss/tie line above it spells the two identically.
   */
  test('a column contested nowhere and silent everywhere is named as never put in play', () => {
    const round = baseRound()
    const col = counting(round)
    for (const id of taskIds) col.verdicts[id] = { verdict: 'tie', A: nothing, B: nothing }
    const out = run(round).out
    assert.match(out, new RegExp(`${questionIds[0]} was never put in play on ${taskIds.length} tasks`))
    assert.match(out, /not evidence that the two builds behave alike/)
  })

  test('a column that bit on something is not named that, however quiet the rest', () => {
    const round = baseRound()
    const col = counting(round)
    for (const id of taskIds) col.verdicts[id] = { verdict: 'tie', A: nothing, B: nothing }
    col.verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 4, settleable: 4, count: 1 },
      B: { volume: 4, settleable: 4, count: 0 }
    }
    assert.doesNotMatch(run(round).out, /was never put in play/)
  })

  test('more unsettleable statements than statements made is refused', () => {
    const round = baseRound()
    counting(round).verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { volume: 3, settleable: 3, count: 0, unsettleable: { absent: 2, byNature: 2 } },
      B: { volume: 3, settleable: 3, count: 0, unsettleable: { absent: 0, byNature: 0 } }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /counted from different lists/)
  })

  test('more settleable statements than statements made is refused the same way', () => {
    const round = baseRound()
    counting(round).verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { volume: 3, settleable: 4, count: 0 },
      B: { volume: 3, settleable: 3, count: 0 }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /counted from different lists/)
  })

  test('disagreements found among nothing settleable is refused', () => {
    const round = baseRound()
    counting(round).verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 5, settleable: 0, count: 2 },
      B: { volume: 5, settleable: 5, count: 0 }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /counted from different lists/)
  })

  test('unsettleable statements counted without counting the statements is refused', () => {
    const round = baseRound()
    counting(round).verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { count: 0, unsettleable: { absent: 1, byNature: 0 } } as unknown as Counted,
      B: { volume: 3, settleable: 3, count: 0 }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /the statements they came from were not/)
  })

  test('an unsettleable split that is not a pair of counts is refused', () => {
    const round = baseRound()
    counting(round).verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { volume: 3, settleable: 3, count: 0, unsettleable: { absent: -1, byNature: 0 } },
      B: { volume: 3, settleable: 3, count: 0 }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /is not a count/)
  })

  /** A verdict rests on a comparison, and one run's numbers are not one. */
  test('counts kept for one run and not the other is refused', () => {
    const round = baseRound()
    counting(round).verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { volume: 3, settleable: 3, count: 0 }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /half a comparison is not one/)
  })

  test('the task column carries no uncontested breakdown', () => {
    const round = baseRound()
    const settled = { volume: 5, settleable: 5, count: 0, unsettleable: { absent: 0, byNature: 0 } }
    for (const id of taskIds) round.columns[0].verdicts[id] = { verdict: 'tie', A: settled, B: settled }
    const out = run(round).out
    const taskIndex = out.split('\n').findIndex((l) => l.trim().startsWith('task '))
    const next = out.split('\n')[taskIndex + 1] ?? ''
    assert.doesNotMatch(next, /uncontested:/)
  })
})

/**
 * Round 11 scored 0-0-18 in both cross-cutting columns and the round could not
 * say whether that was two clean builds or two questions nobody put in play.
 * The critics knew: every report carried a statement count and a disagreeing-
 * pair count per task per run. The verdict file stored one word.
 *
 * So a cross-cutting column now declares what stands behind it, in the same
 * three words the verdicts themselves use. `unrecorded` is deliberately cheap
 * to write — a round that lost its numbers can always say so — because a schema
 * that can only be satisfied by data nobody has is a schema nobody fills.
 */
describe('a column says what stands behind it', () => {
  test('a cross-cutting column that says nothing about its evidence is refused', () => {
    const round = baseRound()
    delete round.columns[1].evidence
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, new RegExp(questionIds[0]))
    assert.match(r.err, /never put in play/)
  })

  test('a word that is not one of the three is refused', () => {
    const round = baseRound()
    round.columns[1].evidence = 'probably somewhere'
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /probably somewhere/)
  })

  test('a column that says it counted and carries no counts is refused', () => {
    const round = baseRound()
    counting(round)
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /says its numbers were kept and carries none/)
  })

  /**
   * The refusal in the other direction, and the less obvious one. A real
   * measurement labelled as an absence would be read as a column that cannot be
   * trusted, which throws away the evidence just as thoroughly.
   */
  test('a column that says its counts were lost and carries some is refused', () => {
    const round = baseRound()
    round.columns[1].verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { volume: 3, settleable: 3, count: 0 },
      B: { volume: 3, settleable: 3, count: 0 }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /says its numbers were not kept and carries 1 of them/)
  })

  test('a column that was not asked needs no evidence, and may say so', () => {
    const round = baseRound()
    round.columns[1] = { id: questionIds[0], asked: false, verdicts: fill('unasked') }
    assert.equal(run(round).status, 0)
    round.columns[1].evidence = 'unasked'
    assert.equal(run(round).status, 0)
  })

  test('a column marked asked cannot claim the question was not put', () => {
    const round = baseRound()
    round.columns[1].evidence = 'unasked'
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /says the question was not put and is marked as asked/)
  })

  /** The task column's numbers are named per task and are not comparable. */
  test('the task column is not asked to declare evidence', () => {
    const round = baseRound()
    assert.equal(round.columns[0].evidence, undefined)
    assert.equal(run(round).status, 0)
  })
})

/**
 * Round 11's file carried the critics' raw verdicts, the reading the round
 * stood behind, and a paragraph explaining the difference. A paragraph
 * explaining one correction reads exactly like a paragraph explaining nine, and
 * the printout showed a corrected column with no sign anything had been
 * corrected.
 */
describe('a round that overrules its critics says so, and how often', () => {
  /** A round whose reported reading differs from its corrected one on one task. */
  function corrected(overrides: Partial<Round> = {}): Round {
    const round = baseRound()
    const asReported = JSON.parse(JSON.stringify(round.columns)) as Column[]
    asReported.find((c) => c.id === questionIds[0])!.verdicts[taskIds[0]] = { verdict: 'B' }
    return {
      ...round,
      columnsAsReported: asReported,
      corrections: [
        {
          task: taskIds[0],
          columns: [questionIds[0]],
          from: 'B',
          to: 'tie',
          rule: 'a difference that would vanish under identical tokens is not a difference'
        }
      ],
      ...overrides
    }
  }

  test('a correction that matches the difference scores, and is counted in the printout', () => {
    const r = run(corrected())
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /verdicts overruled after reporting\s+1 of/)
    assert.match(r.out, new RegExp(`${taskIds[0]} in ${questionIds[0]}: B → tie`))
    assert.match(r.out, /vanish under identical tokens/)
  })

  test('a verdict that moved with no correction naming it is refused', () => {
    const r = run(corrected({ corrections: [] }))
    assert.equal(r.status, 2)
    assert.match(r.err, /and no correction says why/)
  })

  test('a correction that moved nothing is refused — rigour over no verdict is not rigour', () => {
    const round = corrected()
    round.corrections!.push({ ...round.corrections![0], task: taskIds[1] })
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /the two readings agree there/)
  })

  test('a correction with no reported reading beside it is refused', () => {
    const round = corrected()
    delete round.columnsAsReported
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /a claim, not a record/)
  })

  test('a correction that does not state the rule it was made under is refused', () => {
    const round = corrected()
    round.corrections![0].rule = 'felt wrong'
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /states the rule it was made under/)
  })

  test('a round with no second reading reports no correction line at all', () => {
    assert.doesNotMatch(run(baseRound()).out, /overruled/)
  })
})

describe('the recorded rounds, rescored', () => {
  const recorded = (JSON.parse(readFileSync(ROUNDS, 'utf-8')) as { rounds: { n: number; verdict: string | null }[] })
    .rounds

  /** "Round-9 build 3 · round-8 build 0 · 14 ties · 1 void, over 18 tasks." */
  function parseVerdict(prose: string): { B: number; A: number; tie: number; void: number } {
    const m = prose.match(/build (\d+) · [\w-]+ build (\d+) · (\d+) ties(?: · (\d+) VOID| · (\d+) void)?/i)
    assert.ok(m, `cannot read the recorded verdict: ${prose}`)
    return { B: Number(m![1]), A: Number(m![2]), tie: Number(m![3]), void: Number(m![4] ?? m![5] ?? 0) }
  }

  for (const n of [8, 9]) {
    test(`round ${n}'s file scores, and its task column is round ${n}'s recorded verdict`, () => {
      const r = run(join(VERDICTS, `round-${n}.json`))
      assert.equal(r.status, 0, r.err)
      const want = parseVerdict(recorded.find((x) => x.n === n)!.verdict!)
      const line = columnLine(r.out, 'task')
      assert.match(line, new RegExp(`A ${want.A} · B ${want.B} · tie ${want.tie}`))
      if (want.void) assert.match(line, new RegExp(`void ${want.void}`))
    })
  }

  test('round 8 gains the repair its task column could not see', () => {
    const out = run(join(VERDICTS, 'round-8.json')).out
    assert.match(out, /seen only by a cross-cutting column\s+B 1 · A 0/)
  })

  /**
   * The negative result, pinned. Round 9's critics answered the self-consistency
   * question on all eighteen tasks and nobody kept the answers, so the column
   * cannot be recomputed. If a future edit quietly turns those eighteen
   * unrecorded entries into ties, the round starts claiming a measurement it
   * never had.
   */
  test('round 9 self-consistency is unrecorded, not tied', () => {
    const out = run(join(VERDICTS, 'round-9.json')).out
    const line = columnLine(out, 'self-consistency')
    assert.match(line, new RegExp(`unrecorded ${taskIds.length}`))
    assert.match(line, /tie 0/)
  })

  test('a reconstructed verdict is marked as one wherever it appears', () => {
    for (const n of [8, 9]) {
      const out = run(join(VERDICTS, `round-${n}.json`)).out
      assert.match(out, /reconstructed from a round write-up/)
    }
  })

  test('every recorded round still scores', () => {
    for (const n of [8, 9, 10, 11]) {
      const r = run(join(VERDICTS, `round-${n}.json`))
      assert.equal(r.status, 0, `round ${n}: ${r.err}`)
    }
  })

  /**
   * The result this round exists to make legible. Rounds 10 and 11 both wrote
   * eighteen-tie cross-cutting columns off critic reports full of counts, and
   * neither file kept one. Under the scheme they say so, in a sentence a reader
   * cannot mistake for two builds agreeing.
   */
  for (const n of [10, 11]) {
    test(`round ${n}'s cross-cutting columns are named as having kept no numbers`, () => {
      const out = run(join(VERDICTS, `round-${n}.json`)).out
      for (const id of questionIds) {
        assert.match(columnLine(out, id), /contested unrecorded/)
        assert.match(out, new RegExp(`${id} kept no numbers`))
      }
      assert.doesNotMatch(out, /contested \d+\//)
    })
  }

  /**
   * Round 11 recorded one task twice: as its critic scored it, and as the
   * protocol's own rule scores it. That was a paragraph. It is now two counted
   * corrections, and the count is what tells a reader whether a round overruled
   * its critics once or habitually.
   */
  test('round 11 reports its correction as a count and a rule, not a paragraph', () => {
    const out = run(join(VERDICTS, 'round-11.json')).out
    assert.match(out, /verdicts overruled after reporting\s+2 of 54/)
    for (const id of questionIds) assert.match(out, new RegExp(`V1 in ${id}: B → tie`))
    assert.match(out, /vanish under identical tokens/)
  })

  test('round 9 self-consistency is not described as ties that cannot be read as agreement', () => {
    // Its verdicts are unrecorded, so it has no ties to describe either way.
    const out = run(join(VERDICTS, 'round-9.json')).out
    assert.doesNotMatch(out, /self-consistency kept no numbers/)
  })
})

/**
 * A schema nobody can fill is worse than no schema, and the counts schema went
 * four rounds unfilled while every critic report was full of the numbers it
 * wanted. `critic-counts.mjs` is the path between the two: it prints the block a
 * critic appends beside the prose, and reads filled blocks back into the shape
 * a verdict file's columns take.
 *
 * The blind rule survives it. A critic writes `run-1` and `run-2`, which is all
 * a critic is allowed to know; turning those into `A` and `B` needs the staging
 * key, which is withheld from critics and supplied here on purpose.
 */
describe('the counts a critic already produces, in a form the file can hold', () => {
  const COUNTS = join(ROOT, 'docs', 'head-to-head', 'critic-counts.mjs')

  function counts(args: string[]): { status: number; out: string; err: string } {
    const res = spawnSync(process.execPath, [COUNTS, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    return { status: res.status ?? -1, out: res.stdout ?? '', err: res.stderr ?? '' }
  }

  /** Write a report and read it back, optionally through a staging key. */
  function transcribe(report: string, key?: Record<string, Record<string, string>>) {
    const file = join(scratch, `rep-${Math.random().toString(36).slice(2)}.txt`)
    writeFileSync(file, report)
    const args = [file]
    if (key) {
      const keyFile = join(scratch, `key-${Math.random().toString(36).slice(2)}.json`)
      writeFileSync(keyFile, JSON.stringify(key))
      args.push('--key', keyFile)
    }
    return counts(['read', ...args])
  }

  const block = (task: string, question: string, verdict: string, one: string, two: string) =>
    `COUNTS ${task} ${question} ${verdict}\n  run-1 ${one}\n  run-2 ${two}\n`

  const full = 'statements 9 settleable 6 found 0 unsettleable-absent 2 unsettleable-by-nature 1'

  test('the block a critic is asked for names every question the task set asks of every task', () => {
    const r = counts(['block'])
    assert.equal(r.status, 0, r.err)
    for (const id of questionIds) assert.match(r.out, new RegExp(id))
    assert.match(r.out, /run-1 and run-2, never A and B/)
  })

  test('a filled block becomes a column entry, with the verdict and the numbers from one line each', () => {
    const r = transcribe(
      `prose about the run\n\n${block(taskIds[0], questionIds[0], 'tie', full, full)}`,
      { [taskIds[0]]: { 'run-1': 'A', 'run-2': 'B' } }
    )
    assert.equal(r.status, 0, r.err)
    const columns = JSON.parse(r.out) as Column[]
    assert.equal(columns.length, 1)
    assert.equal(columns[0].id, questionIds[0])
    assert.equal(columns[0].evidence, 'counted')
    const entry = columns[0].verdicts[taskIds[0]]
    assert.equal(entry.verdict, 'tie')
    assert.deepEqual(entry.A, { volume: 9, settleable: 6, count: 0, unsettleable: { absent: 2, byNature: 1 } })
  })

  /** The whole point of the staging key: a run label is not an arm. */
  test('a winning run is attributed through the key, in whichever direction it points', () => {
    const report = block(taskIds[0], questionIds[0], 'run-1', full, full)
    const forward = JSON.parse(transcribe(report, { [taskIds[0]]: { 'run-1': 'A', 'run-2': 'B' } }).out) as Column[]
    const reversed = JSON.parse(transcribe(report, { [taskIds[0]]: { 'run-1': 'B', 'run-2': 'A' } }).out) as Column[]
    assert.equal(forward[0].verdicts[taskIds[0]].verdict, 'A')
    assert.equal(reversed[0].verdicts[taskIds[0]].verdict, 'B')
  })

  test('without the key it stops at run-1 and run-2 and says why', () => {
    const r = transcribe(block(taskIds[0], questionIds[0], 'tie', full, full))
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /"run-1"/)
    assert.doesNotMatch(r.out, /"A"/)
    assert.match(r.err, /a verdict file may not carry a run label/)
  })

  test('a report with no block at all is refused rather than read as zeroes', () => {
    const r = transcribe('The two runs behaved alike throughout. WINNER: tie\n')
    assert.equal(r.status, 2)
    assert.match(r.err, /no counts block/)
  })

  test('a block missing a number the question is scored on is refused', () => {
    const r = transcribe(block(taskIds[0], questionIds[0], 'tie', 'statements 9 settleable 6', full))
    assert.equal(r.status, 2)
    assert.match(r.err, /found was not counted/)
  })

  test('a block whose numbers do not add up is refused, in the scorer’s own words', () => {
    const bad = 'statements 9 settleable 6 found 0 unsettleable-absent 2 unsettleable-by-nature 4'
    const r = transcribe(block(taskIds[0], questionIds[0], 'tie', bad, full))
    assert.equal(r.status, 2)
    assert.match(r.err, /counted from different lists/)
  })

  test('half an unsettleable split is refused — half a split is not a measurement', () => {
    const half = 'statements 9 settleable 6 found 0 unsettleable-absent 3'
    const r = transcribe(block(taskIds[0], questionIds[0], 'tie', half, full))
    assert.equal(r.status, 2)
    assert.match(r.err, /one half of the unsettleable split/)
  })

  test('a header that names something other than a verdict is refused', () => {
    const r = transcribe(block(taskIds[0], questionIds[0], 'run-3', full, full))
    assert.equal(r.status, 2)
    assert.match(r.err, /run-3/)
  })

  test('a header with no run lines under it is refused', () => {
    const r = transcribe(`COUNTS ${taskIds[0]} ${questionIds[0]} tie\n\nand then some prose\n`)
    assert.equal(r.status, 2)
    assert.match(r.err, /not followed by a run-1 line/)
  })

  /**
   * The end of the path, walked once: blocks in, a verdict file out, and a
   * scorer that reads it. If this passes, the schema is one somebody can fill.
   */
  test('transcribed blocks make a column the scorer scores', () => {
    const key: Record<string, Record<string, string>> = {}
    let report = ''
    for (const [i, id] of taskIds.entries()) {
      key[id] = { 'run-1': 'A', 'run-2': 'B' }
      // One task in play and settled, the rest silent: the exact shape the
      // win/loss/tie line cannot show and the uncontested breakdown can.
      const said = i === 0 ? 'statements 6 settleable 6 found 1' : 'statements 0 settleable 0 found 0'
      const other = i === 0 ? 'statements 6 settleable 6 found 0' : 'statements 0 settleable 0 found 0'
      report += `${block(id, questionIds[0], i === 0 ? 'run-2' : 'tie', said, other)}\n`
    }
    const r = transcribe(report, key)
    assert.equal(r.status, 0, r.err)
    const round = baseRound({
      columns: [{ id: 'task', verdicts: fill('tie') }, ...(JSON.parse(r.out) as Column[])]
    })
    const scored = run(round)
    assert.equal(scored.status, 0, scored.err)
    const line = columnLine(scored.out, questionIds[0])
    assert.match(line, /B 1/)
    assert.match(line, new RegExp(`contested 1/${taskIds.length}`))
    assert.match(scored.out, new RegExp(`never in play ${taskIds.length - 1}`))
  })
})
