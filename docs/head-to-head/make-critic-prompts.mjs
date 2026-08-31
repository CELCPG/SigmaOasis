/**
 * Generate the blind-critic prompt documents from tasks.json.
 *
 * Round 8's three batch documents (r8-critic-*.txt) were written by hand, and
 * the per-task question / measurements / weighing in them were then distilled
 * back into tasks.json as `question`, `measure` and `decide` — which left two
 * copies of every question, and two copies drift. This script makes tasks.json
 * the single source: the framing (rules, blindness, evidence, output shape) is
 * the template below, and everything task-specific is read from the fields the
 * task-set neutrality test already holds to be true of any build.
 *
 * The critic still never reads tasks.json itself — the generated documents and
 * tasks-for-critics.json remain the only task material in front of it.
 *
 *   node docs/head-to-head/make-critic-prompts.mjs <judge-base-dir> <prefix>
 *
 * e.g.  node docs/head-to-head/make-critic-prompts.mjs \
 *         /abs/path/.h2h-runs/judge-r9 r9
 *
 * writes docs/head-to-head/r9-critic-1.txt … -3.txt, batched by dimension the
 * way round 8 batched them, with the timing trap included only in the batch
 * that carries the timing tasks.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [baseDir, prefix] = process.argv.slice(2)
if (!baseDir || !prefix || !isAbsolute(baseDir)) {
  console.error('usage: make-critic-prompts.mjs <absolute-judge-base-dir> <prefix, e.g. r9>')
  process.exit(2)
}

const src = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'))

// Batched as round 8 batched them: the two timing-adjacent dimensions travel
// together so the token-length trap is stated exactly where it applies.
const BATCHES = [
  { dimensions: ['verifiability', 'tool-honesty'], timing: false },
  { dimensions: ['plan-transparency', 'failure-recovery'], timing: false },
  { dimensions: ['time-to-useful', 'visual-craft'], timing: true }
]

// Refuse to generate from a task set that lost the fields this document is
// made of — a schema regression should fail here, not produce empty prompts.
for (const t of src.tasks) {
  for (const f of ['question', 'decide']) {
    if (typeof t[f] !== 'string' || t[f].length === 0) {
      console.error(`refusing to write: task ${t.id} has no ${f}`)
      process.exit(1)
    }
  }
  if (!Array.isArray(t.measure) || t.measure.length === 0) {
    console.error(`refusing to write: task ${t.id} has no measure list`)
    process.exit(1)
  }
}

const bar = '================================================================'
const thin = '----------------------------------------------------------------'

/** Wrap prose at 80 columns, preserving an optional hanging indent. */
function wrap(text, indent = '') {
  const words = text.split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const w of words) {
    const candidate = line === '' ? indent + w : `${line} ${w}`
    if (candidate.length > 80 && line !== '') {
      lines.push(line)
      line = indent + w
    } else {
      line = candidate
    }
  }
  if (line !== '') lines.push(line)
  return lines.join('\n')
}

function section(title, body) {
  return `${bar}\n${title}\n${bar}\n\n${body}`
}

function taskBlock(t) {
  const measures = t.measure
    .map((m, i) => wrap(`${i + 1}. ${m}`, '   ').replace(/^ {3}/, ''))
    .join('\n')
  return [
    thin,
    `## ${t.id}`,
    thin,
    '',
    wrap(`THE QUESTION: ${t.question}`),
    '',
    'MEASURE AND REPORT FOR BOTH RUNS:',
    '',
    measures,
    '',
    wrap(`HOW TO DECIDE: ${t.decide}`)
  ].join('\n')
}

const TIMING_TRAP = wrap(
  'This batch contains timing tasks, so one specific trap needs naming: a run ' +
    'whose model emitted FEWER TOKENS will finish sooner, and that is not the ' +
    'application being faster. Before you use any total-completion number, ' +
    'compare the length of reply.md in the two runs. If one reply is materially ' +
    'longer, say so and do not decide the task on completion time.'
)

function makeDoc(batch, n, total) {
  const tasks = src.tasks.filter((t) => batch.dimensions.includes(t.dimension))
  const ids = tasks.map((t) => t.id)
  const criticView = join(here, 'tasks-for-critics.json')
  const fullSet = join(here, 'tasks.json')

  const doing = section(
    'WHAT YOU ARE DOING',
    [
      wrap(
        'You are judging two captured runs of a desktop AI chat application, blind. ' +
          'Two builds of the same application were given identical prompts, identical ' +
          'fixtures, the same machine, and the same local model. You are not told which ' +
          'build produced which run. There is no order guarantee: `run-1` may be either ' +
          'build, and it may be a different build from one task to the next. Treat every ' +
          'task independently.'
      )
    ].join('\n')
  )

  const rule = section(
    'THE RULE THAT MATTERS MOST',
    [
      wrap(
        'Both runs used the SAME local model with the SAME prompt. Any difference in how ' +
          'knowledgeable, complete, accurate, or well-written the ANSWER is, is model ' +
          'sampling variance. It is not a property of the application and it is never a ' +
          'reason to pick a winner.'
      ),
      '',
      wrap(
        'You are judging the APPLICATION: what it displays, what it records, what ' +
          'controls it offers, how long it takes, how it lays out, and what it says about ' +
          'its own behaviour.'
      ),
      '',
      wrap(
        'Before writing any WINNER, ask yourself: "would this difference still be here if ' +
          'the model had emitted identical tokens in both runs?" If the answer is no — if ' +
          'the difference is only in the model\'s wording, its choice of facts, or how much ' +
          'it happened to say — the answer is `tie`.'
      ),
      '',
      wrap(
        'Never reward the run whose answer is more knowledgeable, more detailed, better ' +
          'written, or more correct about the world. A run whose answer is factually wrong ' +
          'can win. A run whose answer is excellent can lose.'
      ),
      ...(batch.timing ? ['', TIMING_TRAP] : [])
    ].join('\n')
  )

  const ties = section(
    'TIES ARE REAL',
    [
      '`tie` is a real answer and is often the correct one. Score `tie` when:',
      '',
      '- both runs behave the same way on the task\'s question, even if both behave badly;',
      wrap(
        '- neither run was actually put to the test — the situation the task sets up did ' +
          'not arise, the model did not emit the thing the task measures, or the driver ' +
          'action the task depends on did not land. A task where neither build was tested ' +
          'is a TIE, not a coin flip;',
        '  '
      ),
      '- the only differences you can find are in the model\'s wording;',
      '- the artifacts you need are missing or empty in one or both runs.',
      '',
      wrap(
        'Do NOT break a tie on something incidental: response length, a nicer sentence, ' +
          'one run being marginally faster on a quantity this task does not ask about.'
      )
    ].join('\n')
  )

  const where = section(
    'WHERE THE RUNS ARE',
    [
      `Base directory: ${baseDir}/`,
      `Each task:      <base>/<TASK>/run-1   and   <base>/<TASK>/run-2`,
      `For example:    <base>/${ids[0]}/run-1`,
      '',
      'Read the task\'s own entry in',
      `${criticView} FIRST.`,
      '',
      wrap(
        'Use its `prompt` (the exact text typed into the app) and its `setup` (the ' +
          'fixtures, settings and driver actions staged for the task) as your facts about ' +
          'what was run. That file is the only task description you may read. Do NOT open ' +
          `${fullSet} — it carries fields written for the people building against the ` +
          'task set, and the questions you answer are the ones written in THIS document.'
      )
    ].join('\n')
  )

  const blindness = section(
    'BLINDNESS — DO NOT BREAK IT',
    [
      wrap(
        '- NEVER open any file whose name begins with `_`. Those files are excluded from ' +
          'the blind staging and identify the arms. If you open one by accident, stop and ' +
          'say so in your output.',
        '  '
      ),
      wrap(
        '- If you come across anything in an artifact that looks like a build identity — ' +
          'a version string, a commit hash, a branch name, a changelog, a path fragment ' +
          'naming a build — ignore it and keep it out of your reasoning. Note in EVIDENCE ' +
          'that you saw it and set it aside.',
        '  '
      ),
      wrap(
        '- Do not go looking for the application\'s source code, its git history, its ' +
          'documentation beyond tasks-for-critics.json, or any other run directory. Judge ' +
          'these two run directories only.',
        '  '
      )
    ].join('\n')
  )

  const contents = section(
    'WHAT IS IN A RUN DIRECTORY',
    [
      '- transcript.json    every message and every tool-call record (name, args,',
      '                     result, status), plus the turn\'s trace export.',
      '- reply.md           the final assistant message as RAW MARKDOWN — exactly what',
      '                     the model emitted, before rendering.',
      '- reply.txt          the rendered innerText — WHAT THE READER ACTUALLY SAW on',
      '                     screen. A collapsed block contributes only its header here.',
      '                     Diffing reply.md against reply.txt is how you separate',
      '                     "the model wrote it that way" from "the app drew it that',
      '                     way": a character present in reply.md and absent from',
      '                     reply.txt was lost by the renderer.',
      '- messages-raw.json  { index, role, content, reasoning } per message.',
      '- dom/               outerHTML of the assistant message and of any plan block,',
      '                     captured at the moments the task names.',
      '- snapshots/         DOM captured at named moments, plus keyboard-traversal',
      '                     records where a task collected them.',
      '- timings.json       t0 (the Enter keydown) and every marked timestamp.',
      '- styles.json        computed styles for the nodes the visual tasks measure, in',
      '                     both themes.',
      '- fixtures/ or fixture.log   every request each loopback fixture served.',
      '- trace/audit.jsonl  the exported session audit log, for tasks that enable it.',
      '- shots/             screenshots, taken only after any timed window closed.',
      '- run.json           driverActions, turns, setup.seededSettingsVerified,',
      '                     preconditions, validity, auditExport.',
      '',
      wrap(
        'Not every run has every file. An empty reply.md with `run.json → ' +
          'rawMarkdown.error` set is a known artifact gap, not a defect of the build.'
      ),
      '',
      wrap(
        'Check `run.json → validity` and `run.json → preconditions` before concluding ' +
          'anything. If a run is invalid or a precondition did not hold, say so and score ' +
          'the task `tie` unless the other run\'s evidence stands entirely on its own.'
      )
    ].join('\n')
  )

  const evidence = section(
    'EVIDENCE RULES',
    [
      wrap(
        '- Every claim must be grounded in a quoted string from a named artifact file, ' +
          'written as:  file.ext: "the exact text".  No claim from memory, from how such ' +
          'applications usually work, or from any file other than the run\'s own artifacts.',
        '  '
      ),
      wrap(
        '- Where a task asks for a count, give the number for BOTH runs — even when the ' +
          'two numbers are equal, even when both are zero. "Both 0" is a result.',
        '  '
      ),
      wrap(
        '- If an artifact you need does not exist, name the file you looked for and the ' +
          'run it was missing from. Absence of evidence is not evidence.',
        '  '
      ),
      '- Quote exactly and verbatim, enough characters to be checkable.'
    ].join('\n')
  )

  const shape = section(
    'OUTPUT SHAPE — exactly this, one block per task, nothing else',
    [
      '## <TASK>',
      'WINNER: run-1 | run-2 | tie',
      'CONFIDENCE: high | medium | low',
      'WHAT I SAW: <concrete difference, quoting real text with file names>',
      'WHY: <why that decides the task\'s question>',
      'BIGGEST REMAINING GAP: <the single biggest thing the WINNING run still gets wrong>',
      'EVIDENCE: <files opened, with the values that mattered>',
      '',
      wrap(
        'If the WINNER is `tie`, BIGGEST REMAINING GAP is the biggest thing BOTH runs get ' +
          `wrong. Produce the ${ids.length} blocks in the order below and nothing else.`
      )
    ].join('\n')
  )

  return [
    `BLIND A/B JUDGING — BATCH ${n} of ${total}`,
    `Tasks: ${ids.join(', ')}`,
    '',
    doing,
    '',
    rule,
    '',
    ties,
    '',
    where,
    '',
    blindness,
    '',
    contents,
    '',
    evidence,
    '',
    shape,
    '',
    section('THE TASKS', tasks.map(taskBlock).join('\n\n')),
    ''
  ].join('\n')
}

const covered = BATCHES.flatMap((b) => b.dimensions)
for (const d of src.dimensions) {
  if (!covered.includes(d)) {
    console.error(`refusing to write: dimension "${d}" is in no batch`)
    process.exit(1)
  }
}

BATCHES.forEach((batch, i) => {
  const doc = makeDoc(batch, i + 1, BATCHES.length)
  const dest = join(here, `${prefix}-critic-${i + 1}.txt`)
  writeFileSync(dest, doc)
  const count = src.tasks.filter((t) => batch.dimensions.includes(t.dimension)).length
  console.log(`wrote ${dest} — ${count} tasks (${batch.dimensions.join(' + ')})`)
})
