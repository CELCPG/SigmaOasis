/**
 * The task set a blind critic is allowed to see.
 *
 * `tasks.json` carries five fields written for the people BUILDING against
 * it: `probes` (why the task earns its place), `mechanicalChecks` (what the
 * scoring script computes), and `question` / `measure` / `decide` (what the
 * critic is asked, what it must report, how it must weigh). None of them
 * belong in front of a critic:
 *
 *   - `probes` and `mechanicalChecks` stay behind because they are about the
 *     scoring, not the run — and because history earned the caution: their
 *     pre-v2 ancestors were a defect inventory whose quoted constants could
 *     de-blind a pair outright (recorded in docs/evals.md rather than quietly
 *     fixed). The fields are neutral now, and the task-set neutrality test in
 *     the suite keeps them that way, but the critic still has no use for them.
 *   - `question`, `measure` and `decide` stay behind because the critic is
 *     asked them by the prompt document instead, and two copies of a question
 *     drift.
 *
 * A critic needs what the user sent and how the app was set up. Nothing else
 * in this file is evidence about the run in front of it.
 *
 *   node docs/head-to-head/make-critic-tasks.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'))

const KEEP = ['id', 'dimension', 'prompt', 'setup', 'offlineSafe']
// criticQuestion is the pre-v2 name of `question`; it stays on the list so a
// reintroduction under the old spelling is refused like the new one.
const DROP = ['probes', 'mechanicalChecks', 'question', 'measure', 'decide', 'criticQuestion']

// A field that is neither kept nor dropped is a field nobody decided about,
// and the pick list would silently drop it. New fields must be filed.
for (const t of src.tasks) {
  for (const k of Object.keys(t)) {
    if (!KEEP.includes(k) && !DROP.includes(k)) {
      console.error(`refusing to write: task ${t.id} has undecided field "${k}"`)
      process.exit(1)
    }
  }
}

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
