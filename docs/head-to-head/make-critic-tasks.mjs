/**
 * The task set a blind critic is allowed to see.
 *
 * A critic needs what the user sent and how the app was staged. Everything else
 * in `tasks.json` is written for the people building and judging against it, and
 * in front of a critic it is either noise or evidence about the run:
 *
 *   `probes`             why the task earns its place
 *   `mechanicalChecks`   what the scoring script computes
 *   `question`           the question the critic is asked, in its own words
 *   `measure` `decide`   what to report, and how to weigh it
 *   `crossCutting`       the questions asked of every task, and how a round
 *                        aggregates the answers into columns
 *
 * The last three reach the critic anyway — through the prompt document, written
 * separately and by someone who did not build the changes. Handing them over
 * twice is how two copies drift, and a critic holding the measurement plan and
 * the artifacts at once starts fitting one to the other.
 *
 * Round 8 stripped these because they were a defect inventory: every `probes`
 * field named a source file, a function or a CSS class and asserted a live bug,
 * and four quoted constants only one build could produce. Round 9 rewrote them
 * so that is no longer true, and put the rule under test — a descriptive field
 * that carries a path, a class, an identifier, a measured constant, a version or
 * a glyph now fails the suite. What remains here is defence in depth rather than
 * the only defence: the reason to keep a field out of this view is now that a
 * critic has no use for it, not that reading it would tell them the answer.
 *
 * `setup` is the exception in the other direction. It stays, because a critic
 * cannot judge a run without knowing how it was staged, and it is frozen,
 * because eight rounds of recorded runs are comparable only if it does not move.
 * It is therefore the one place a constant still reaches a critic; the inventory
 * of what is in there is pinned in test/h2hTaskNeutrality.test.ts so it cannot
 * grow unnoticed.
 *
 *   node docs/head-to-head/make-critic-tasks.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'))

const KEEP = ['id', 'dimension', 'prompt', 'setup', 'offlineSafe']
// `criticQuestion` and `selfConsistency` no longer exist. They are named so that
// reintroducing the field round 8 found leading, or reverting the one question
// asked of every task back to a lone top-level key, is caught here rather than
// shipped to a critic. `crossCutting` is where that question lives now, beside
// the second one; both reach the critic through the prompt document, once.
const DROP = [
  'probes',
  'mechanicalChecks',
  'criticQuestion',
  'question',
  'measure',
  'decide',
  'selfConsistency',
  'crossCutting'
]

const out = {
  note:
    'The blind-critic view of the task set. Everything but the prompt and the ' +
    'staging is removed: why the task earns its place, what the scoring script ' +
    'computes, and the question, the measurements and the weighing — the last ' +
    'three because the critic is asked them by the prompt document instead, and ' +
    'two copies of a question drift. See make-critic-tasks.mjs for why.',
  version: src.version,
  name: src.name,
  dimensions: src.dimensions,
  tasks: src.tasks.map((t) => Object.fromEntries(KEEP.filter((k) => k in t).map((k) => [k, t[k]])))
}

// A dropped field that reappears under a new name is the same leak with a new
// spelling, so this asserts on the OUTPUT rather than trusting the pick list.
const serialized = JSON.stringify(out, null, 2)
for (const field of DROP) {
  if (serialized.includes(`"${field}"`)) {
    console.error(`refusing to write: "${field}" survived into the critic view`)
    process.exit(1)
  }
}

const dest = join(here, 'tasks-for-critics.json')
writeFileSync(dest, `${serialized}\n`)
console.log(`wrote ${dest} — ${out.tasks.length} tasks, ${DROP.join(', ')} removed`)
