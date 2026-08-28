/**
 * The numbers a critic already produces, in a form a verdict file can hold.
 *
 * Round 9's critics answered the self-consistency question on all eighteen
 * tasks with a statement count and a disagreeing-pair count for both runs, and
 * the round kept none of it. Round 10 built the vocabulary that needs those
 * numbers — contested, never in play, unsettleable, settled and agreed. Round
 * 11's critics produced them again, in lines like *"run-1: 11 application
 * statements, 1 disagreeing pair; run-2: 9 statements, 0"*, and round 11 kept
 * none of it either, so both its cross-cutting columns printed eighteen ties
 * that could not be told from eighteen tasks nobody tested.
 *
 * Three ways out of that, and this file is two of them.
 *
 *   Parse the prose.        Rejected. Round 9's reports are not in the
 *                           repository and round 11's are a task notification;
 *                           a parser for prose that no longer exists is a
 *                           parser tested against nothing. Worse, prose that
 *                           nearly parses is the failure mode that produces a
 *                           number rather than a refusal.
 *   Refuse a file with      Taken, in `score-round.mjs`: a cross-cutting column
 *   no counts.              must now declare `counted`, `unrecorded` or
 *                           `unasked`. That makes silence visible. On its own
 *                           it does not make the counts easier to keep, and a
 *                           schema nobody can fill is worse than no schema.
 *   Ask for a block.        Taken, here. The critic writes one line per run per
 *                           question per task, beside the prose rather than
 *                           instead of it. This file prints the block for the
 *                           prompt document, and reads filled blocks back into
 *                           the shape `verdicts/round-N.json` wants.
 *
 * What it costs, stated rather than buried: a critic now emits a structure as
 * well as an argument, which is one more thing to get wrong; a malformed block
 * is refused rather than guessed at, so a bad report costs a human re-read; and
 * none of this recovers a number from a round already judged. It also puts a
 * fixed vocabulary in front of a critic, which is a mild pull toward counting
 * what the block asks for rather than what the question asks for — the prose
 * stays mandatory for exactly that reason, and the block is checked against
 * itself, not against the prose.
 *
 * The field list is derived from the task set's own cross-cutting questions, so
 * a question added there gets a block without anyone remembering to add one.
 *
 * The blind rule is kept: a critic writes `run-1` and `run-2`, which is all a
 * critic knows. Turning those into `A` and `B` needs the staging key, which is
 * withheld from critics and passed here explicitly.
 *
 *   node docs/head-to-head/critic-counts.mjs block
 *   node docs/head-to-head/critic-counts.mjs read <report.txt...> [--key <_key.json>]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The block's fields, and the verdict-file field each becomes.
 *
 * `statements` and `settleable` are what both questions' `decide` already
 * orders a critic to report beside the count — a run that says less is not
 * thereby more consistent, and a zero with nothing settleable beside it is not
 * an agreement. `found` is the figure the column is scored on, which is
 * disagreeing pairs for one question and contradictions for the other; one word
 * covers both and the prompt says which is meant.
 *
 * The two unsettleable fields are optional together. A critic who cannot say
 * which kind of unsettleable a statement is may leave both out, and the scorer
 * reports the tie as unsettleable with the kind not stated rather than as an
 * agreement. Leaving out one of the pair is refused: half a split is a number
 * that looks like a measurement and is not one.
 */
const FIELDS = [
  { key: 'statements', to: 'volume', required: true, means: 'statements the application made about its own behaviour' },
  { key: 'settleable', to: 'settleable', required: true, means: 'how many of those this question could actually decide' },
  { key: 'found', to: 'count', required: true, means: 'the figure this question is scored on, in this run' },
  { key: 'unsettleable-absent', to: 'absent', required: false, means: 'an artifact could settle it and this run has none' },
  { key: 'unsettleable-by-nature', to: 'byNature', required: false, means: 'no artifact can settle it; the app is the only witness' }
]

const RUNS = ['run-1', 'run-2']

/**
 * The verdict rides in the header, so the word and the numbers behind it come
 * out of one line written at one moment. Round 11's word survived and its
 * numbers did not precisely because they were written in two places.
 */
const VERDICTS = [...RUNS, 'tie', 'void']

function fail(message) {
  console.error(`refusing: ${message}`)
  process.exit(2)
}

function taskSet(path = join(here, 'tasks.json')) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The block a critic appends, as the prompt document should carry it. */
export function blockSpec(set = taskSet()) {
  const lines = []
  lines.push('COUNTS BLOCK — required, once per task, beside the prose and not instead of it.')
  lines.push('')
  lines.push('For each question below, append one header line and one line per run, exactly:')
  lines.push('')
  lines.push(`  COUNTS <TASK> <question> <${VERDICTS.join(' | ')}>`)
  lines.push(`  run-1 ${FIELDS.filter((f) => f.required).map((f) => `${f.key} <n>`).join(' ')}`)
  lines.push(`  run-2 ${FIELDS.filter((f) => f.required).map((f) => `${f.key} <n>`).join(' ')}`)
  lines.push('')
  lines.push('Optionally, on the same run line, the split of what could not be settled:')
  lines.push('')
  lines.push(`  ${FIELDS.filter((f) => !f.required).map((f) => `${f.key} <n>`).join(' ')}`)
  lines.push('')
  lines.push('Give both of those or neither. With both, they must account exactly for the')
  lines.push('statements: settleable + the two unsettleable figures = statements.')
  lines.push('')
  for (const f of FIELDS) {
    lines.push(`  ${f.key.padEnd(24)}${f.means}`)
  }
  lines.push('')
  lines.push('A zero is an answer and is written down. The questions, and what each counts:')
  lines.push('')
  for (const q of set.crossCutting.questions) {
    lines.push(`  ${q.id} — ${q.about}`)
    lines.push(`      ${q.question}`)
    lines.push(`      found = ${scoredThing(q)}`)
    lines.push('')
  }
  lines.push('Write run-1 and run-2, never A and B: which arm is which is not yours to know.')
  return lines.join('\n')
}

/**
 * What this question's `found` counts, taken from the question's own `decide`
 * rather than from a list here, so a question whose scoring changes cannot go
 * on describing itself the old way.
 */
function scoredThing(question) {
  const m = question.decide.match(/^Fewer ([a-z ]+?) is better/i)
  return m ? m[1] : 'the disagreements this question names'
}

const HEADER = /^\s*COUNTS\s+([A-Za-z0-9]+)\s+([a-z][a-z-]*)\s+(\S+)\s*$/
const RUN_LINE = /^\s*(run-[12])\s+(.+?)\s*$/

/**
 * Read filled blocks out of one or more critic reports.
 *
 * Everything that is not a block is ignored — a report is mostly prose and the
 * prose is the point. Everything that looks like a block and is not one is
 * refused, because the alternative is a number nobody counted.
 */
export function readBlocks(text, where = 'report') {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(HEADER)
    if (!head) continue
    const [, task, question, verdict] = head
    const at = `${where}:${i + 1} (${task} ${question})`
    if (!VERDICTS.includes(verdict)) fail(`${at}: "${verdict}" is not one of ${VERDICTS.join(', ')}`)
    const runs = {}
    for (const expected of RUNS) {
      const line = lines[i + 1 + RUNS.indexOf(expected)]
      const m = line?.match(RUN_LINE)
      if (!m) fail(`${at}: the header is not followed by a ${expected} line`)
      if (m[1] !== expected) fail(`${at}: expected ${expected} and found ${m[1]}`)
      runs[expected] = parseRun(m[2], `${at} ${expected}`)
    }
    i += RUNS.length
    out.push({ task, question, verdict, runs })
  }
  return out
}

function parseRun(rest, at) {
  const words = rest.split(/\s+/)
  if (words.length % 2 !== 0) fail(`${at}: the line is not a list of name and number pairs`)
  const given = new Map()
  for (let i = 0; i < words.length; i += 2) {
    const name = words[i]
    const field = FIELDS.find((f) => f.key === name)
    if (!field) fail(`${at}: "${name}" is not one of ${FIELDS.map((f) => f.key).join(', ')}`)
    if (given.has(name)) fail(`${at}: "${name}" is given twice`)
    if (!/^\d+$/.test(words[i + 1])) fail(`${at}: ${name} is "${words[i + 1]}" and a count is a whole number`)
    given.set(name, Number(words[i + 1]))
  }
  for (const f of FIELDS.filter((x) => x.required)) {
    if (!given.has(f.key)) fail(`${at}: ${f.key} was not counted, and a question answered without it is not answered`)
  }
  const absent = given.get('unsettleable-absent')
  const byNature = given.get('unsettleable-by-nature')
  if ((absent === undefined) !== (byNature === undefined)) {
    fail(`${at}: one half of the unsettleable split was given and the other was not`)
  }

  const side = { volume: given.get('statements'), settleable: given.get('settleable'), count: given.get('found') }
  if (side.settleable > side.volume) {
    fail(`${at}: ${side.settleable} settleable out of ${side.volume} stated — counted from different lists`)
  }
  if (side.count > 0 && side.settleable === 0) {
    fail(`${at}: ${side.count} found among 0 settleable statements — counted from different lists`)
  }
  if (absent !== undefined) {
    if (side.settleable + absent + byNature !== side.volume) {
      fail(
        `${at}: ${side.settleable} settleable and ${absent + byNature} unsettleable do not account ` +
          `for ${side.volume} statements — counted from different lists`
      )
    }
    side.unsettleable = { absent, byNature }
  }
  return side
}

/**
 * Blocks, arranged as a verdict file's columns want them.
 *
 * Without the staging key this stops at `run-1` and `run-2` and says so. That
 * is not a limitation to work around: a critic's report cannot name an arm, and
 * a tool that guessed would be inventing the one fact the blinding exists to
 * withhold.
 */
export function toColumns(blocks, key = null) {
  const columns = new Map()
  for (const b of blocks) {
    if (key && !key[b.task]) fail(`the staging key has no entry for ${b.task}`)
    if (!columns.has(b.question)) columns.set(b.question, {})
    const verdicts = columns.get(b.question)
    if (verdicts[b.task]) fail(`${b.task} is counted twice for ${b.question}`)
    const arm = (run) => (key ? key[b.task][run] : run)
    verdicts[b.task] = {
      verdict: RUNS.includes(b.verdict) ? arm(b.verdict) : b.verdict,
      [arm('run-1')]: b.runs['run-1'],
      [arm('run-2')]: b.runs['run-2']
    }
  }
  return [...columns].map(([id, verdicts]) => ({ id, evidence: 'counted', verdicts }))
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode === 'block') {
    console.log(blockSpec())
  } else if (mode === 'read') {
    const keyAt = rest.indexOf('--key')
    const key = keyAt === -1 ? null : JSON.parse(readFileSync(rest[keyAt + 1], 'utf8'))
    const files = keyAt === -1 ? rest : [...rest.slice(0, keyAt), ...rest.slice(keyAt + 2)]
    if (!files.length) fail('no report to read')
    const blocks = files.flatMap((f) => readBlocks(readFileSync(f, 'utf8'), f))
    if (!blocks.length) fail('no counts block in any of those reports')
    const columns = toColumns(blocks, key)
    console.log(JSON.stringify(columns, null, 2))
    if (!key) {
      console.error('')
      console.error('These are run-1 and run-2, not A and B. Re-run with --key <staging>/_key.json')
      console.error('to attribute them; a verdict file may not carry a run label.')
    }
  } else {
    console.error('usage: critic-counts.mjs block')
    console.error('       critic-counts.mjs read <report.txt...> [--key <_key.json>]')
    process.exit(2)
  }
}
