/**
 * The task set a blind critic is allowed to see.
 *
 * `tasks.json` carries three fields written for the people BUILDING against it:
 * `probes` (why the task exposes something), `mechanicalChecks` (what to compute)
 * and `criticQuestion` (the question as originally phrased). All three are a
 * liability in front of a critic, and two of them are worse than leading.
 *
 * They are a defect inventory. Every `probes` field is present tense, names a
 * source file, function or CSS class, and asserts a live bug. A critic reading
 * one is told what at least one build is known to get wrong before it opens a
 * single artifact.
 *
 * Four of them can DE-BLIND a pair outright, because they quote constants that
 * only one build can produce:
 *
 *   VC3  "rgba(23,23,23,0.32) … roughly 2.05:1 … 33 places … 83 places"
 *   VC2  "33 occurrences of 'outline-none' … zero occurrences of 'focus-visible'"
 *   PT2  the exact strings "▶ Run this plan", "Cancel", "awaiting approval"
 *   PT3  the glyphs and classes "'✗' in text-red-500", "'○ text-neutral-400'"
 *
 * A critic that measures 2.46:1 in one arm and 9.48:1 in the other, having read
 * that the value to beat is 2.05:1, is not judging blind — it is recognising an
 * arm. That was true for every round judged before this file existed, which is
 * recorded in docs/evals.md rather than quietly fixed.
 *
 * A critic needs what the user sent and how the app was set up. Nothing else in
 * this file is evidence about the run in front of it.
 *
 *   node docs/head-to-head/make-critic-tasks.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'))

const KEEP = ['id', 'dimension', 'prompt', 'setup', 'offlineSafe']
const DROP = ['probes', 'mechanicalChecks', 'criticQuestion']

const out = {
  note:
    'The blind-critic view of the task set. `probes`, `mechanicalChecks` and ' +
    '`criticQuestion` are removed: they describe known defects, and four of them ' +
    'quote constants that identify which build produced a run. See ' +
    'make-critic-tasks.mjs for why.',
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
