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
type Counted = { volume: number; count: number; unsettleable?: { absent: number; byNature: number } }
type Column = { id: string; asked?: boolean; note?: string; verdicts: Record<string, Entry>; unattributed?: Entry[] }
type Round = { round: number; pair?: { A: string; B: string }; columns: Column[] }

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

/** A minimal coherent round: everything ties, in every column. */
function baseRound(overrides: Partial<Round> = {}): Round {
  return {
    round: 99,
    pair: { A: 'the earlier build', B: 'the later build' },
    columns: [
      { id: 'task', verdicts: fill('tie') },
      ...questionIds.map((id) => ({ id, verdicts: fill('tie') }))
    ],
    ...overrides
  }
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
      const r = run(baseRound({ columns: [{ id: 'task', verdicts: fill('tie') }, { id, verdicts: fill('tie') }] }))
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
    const col = round.columns[1]
    col.verdicts[taskIds[0]] = { verdict: 'B', A: { volume: 9, count: 2 }, B: { volume: 9, count: 0 } }
    col.verdicts[taskIds[1]] = { verdict: 'tie', A: { volume: 9, count: 0 }, B: { volume: 9, count: 0 } }
    assert.match(run(round).out, /contested 1\/2/)
  })

  test('a column with no counts kept says so rather than reporting nothing contested', () => {
    const out = run(baseRound()).out
    assert.match(out, /contested unknown — no counts kept/)
    assert.doesNotMatch(columnLine(out, questionIds[0]), /contested 0\//)
  })

  test('a win by the run that said less is flagged, and is still a win', () => {
    const round = baseRound()
    round.columns[1].verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 12, count: 3 },
      B: { volume: 4, count: 0 }
    }
    const line = columnLine(run(round).out, questionIds[0])
    assert.match(line, /quiet wins 1/)
    assert.match(line, /B 1/)
  })

  test('a win by the run that said MORE is not flagged', () => {
    const round = baseRound()
    round.columns[1].verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 4, count: 3 },
      B: { volume: 12, count: 0 }
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
    const col = round.columns[1]
    col.verdicts[taskIds[0]] = a
    col.verdicts[taskIds[1]] = b
    return round
  }

  const uncontestedLine = (out: string): string => {
    const line = out.split('\n').find((l) => l.trim().startsWith('uncontested:'))
    assert.ok(line, `no uncontested breakdown in:\n${out}`)
    return line!.trim().replace(/ {2,}/g, ' ')
  }

  test('a tie where neither run said anything is never in play, not agreement', () => {
    const out = run(
      withEntries(
        { verdict: 'tie', A: { volume: 0, count: 0 }, B: { volume: 0, count: 0 } },
        { verdict: 'tie', A: { volume: 0, count: 0 }, B: { volume: 0, count: 0 } }
      )
    ).out
    assert.match(uncontestedLine(out), /never in play 2/)
    assert.doesNotMatch(uncontestedLine(out), /settled and agreed/)
  })

  test('a tie where every statement wanted an absent record is reported as that, not as a tie', () => {
    const absent = { volume: 6, count: 0, unsettleable: { absent: 6, byNature: 0 } }
    const out = run(
      withEntries({ verdict: 'tie', A: absent, B: absent }, { verdict: 'tie', A: absent, B: absent })
    ).out
    assert.match(uncontestedLine(out), /unsettleable, record not kept 2/)
    assert.doesNotMatch(uncontestedLine(out), /settled and agreed/)
  })

  test('a tie on statements nothing can ever settle is a different fact, and counted apart', () => {
    const byNature = { volume: 4, count: 0, unsettleable: { absent: 0, byNature: 4 } }
    const out = run(
      withEntries({ verdict: 'tie', A: byNature, B: byNature }, { verdict: 'tie', A: byNature, B: byNature })
    ).out
    assert.match(uncontestedLine(out), /unsettleable by nature 2/)
    assert.doesNotMatch(uncontestedLine(out), /record not kept/)
  })

  test('a tie where the record settled every statement and they agreed is the earned one', () => {
    const settled = { volume: 5, count: 0, unsettleable: { absent: 0, byNature: 0 } }
    const out = run(
      withEntries({ verdict: 'tie', A: settled, B: settled }, { verdict: 'tie', A: settled, B: settled })
    ).out
    assert.match(uncontestedLine(out), /settled and agreed 2/)
  })

  /**
   * The failure this split exists to prevent, one level down: a round that
   * supplies volumes and contradiction counts but never says how many of those
   * statements anything could settle has not established a settled tie, and
   * must not be reported as having one.
   */
  test('counts without the unsettleable split are unaccounted, not settled', () => {
    const out = run(
      withEntries(
        { verdict: 'tie', A: { volume: 5, count: 0 }, B: { volume: 5, count: 0 } },
        { verdict: 'tie', A: { volume: 5, count: 0 }, B: { volume: 5, count: 0 } }
      )
    ).out
    assert.match(uncontestedLine(out), /unaccounted 2/)
    assert.doesNotMatch(uncontestedLine(out), /settled and agreed/)
  })

  test('the unsettleable statement totals are reported, split by which kind', () => {
    const mixed = { volume: 10, count: 0, unsettleable: { absent: 4, byNature: 3 } }
    const out = run(
      withEntries({ verdict: 'tie', A: mixed, B: mixed }, { verdict: 'tie', A: mixed, B: mixed })
    ).out
    assert.match(out, /unsettleable statements, both runs: 16 for want of a record · 12 by nature/)
  })

  test('a column whose ties are mostly an absent record is named as measuring coverage', () => {
    const round = baseRound()
    const col = round.columns[1]
    const absent = { volume: 6, count: 0, unsettleable: { absent: 6, byNature: 0 } }
    for (const id of taskIds) col.verdicts[id] = { verdict: 'tie', A: absent, B: absent }
    col.verdicts[taskIds[0]] = {
      verdict: 'B',
      A: { volume: 6, count: 2, unsettleable: { absent: 1, byNature: 0 } },
      B: { volume: 6, count: 0, unsettleable: { absent: 1, byNature: 0 } }
    }
    const out = run(round).out
    assert.match(out, /only because the record/)
    assert.match(out, /Read its ties as coverage/)
    assert.match(out, new RegExp(`uncontested on ${taskIds.length - 1} tasks`))
  })

  test('a column that mostly settled what it looked at is not', () => {
    const round = baseRound()
    const col = round.columns[1]
    const settled = { volume: 6, count: 0, unsettleable: { absent: 0, byNature: 0 } }
    for (const id of taskIds) col.verdicts[id] = { verdict: 'tie', A: settled, B: settled }
    assert.doesNotMatch(run(round).out, /Read its ties as coverage/)
  })

  test('more unsettleable statements than statements made is refused', () => {
    const round = baseRound()
    round.columns[1].verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { volume: 3, count: 0, unsettleable: { absent: 2, byNature: 2 } },
      B: { volume: 3, count: 0, unsettleable: { absent: 0, byNature: 0 } }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /counted from different lists/)
  })

  test('unsettleable statements counted without counting the statements is refused', () => {
    const round = baseRound()
    round.columns[1].verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { count: 0, unsettleable: { absent: 1, byNature: 0 } } as unknown as Counted,
      B: { volume: 3, count: 0 }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /the statements they came from were not/)
  })

  test('an unsettleable split that is not a pair of counts is refused', () => {
    const round = baseRound()
    round.columns[1].verdicts[taskIds[0]] = {
      verdict: 'tie',
      A: { volume: 3, count: 0, unsettleable: { absent: -1, byNature: 0 } },
      B: { volume: 3, count: 0 }
    }
    const r = run(round)
    assert.equal(r.status, 2)
    assert.match(r.err, /is not a count/)
  })

  test('the task column carries no uncontested breakdown', () => {
    const round = baseRound()
    const settled = { volume: 5, count: 0, unsettleable: { absent: 0, byNature: 0 } }
    for (const id of taskIds) round.columns[0].verdicts[id] = { verdict: 'tie', A: settled, B: settled }
    const out = run(round).out
    const taskIndex = out.split('\n').findIndex((l) => l.trim().startsWith('task '))
    const next = out.split('\n')[taskIndex + 1] ?? ''
    assert.doesNotMatch(next, /uncontested:/)
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
})
