#!/usr/bin/env node
/**
 * Stage captured runs for blind judging.
 *
 * Takes two arm directories, and for every task present in both, copies the
 * pair into <out>/<task>/run-1 and run-2 in an order decided by a hash of the
 * task id and a caller-supplied salt — so the assignment is deterministic and
 * reproducible, but not guessable from the task order, and not the same for
 * every task in a round.
 *
 * Files whose names start with "_" are the identifying sidecars and are NOT
 * copied: the critic cannot read the arm even by accident. The mapping is
 * written to <out>/_key.json, which the critic is never given.
 *
 *   node docs/head-to-head/make-blind-pairs.mjs <armA-dir> <armB-dir> <out-dir> <salt>
 */
import { readdirSync, mkdirSync, copyFileSync, statSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'

const [armADir, armBDir, outDir, salt = 'round'] = process.argv.slice(2)
if (!armADir || !armBDir || !outDir) {
  console.error('usage: make-blind-pairs.mjs <armA-dir> <armB-dir> <out-dir> [salt]')
  process.exit(2)
}

/** Run directories are named "<taskId>-<timestamp>"; index them by task id. */
function indexRuns(dir) {
  const out = new Map()
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (name.startsWith('.') || !statSync(full).isDirectory()) continue
    const taskId = name.replace(/-\d{8}-\d{6}$/, '')
    // Keep the most recent run for a task if a task was captured twice.
    const prev = out.get(taskId)
    if (!prev || name > basename(prev)) out.set(taskId, full)
  }
  return out
}

/**
 * Text artifacts can carry the run's own absolute path — the app renders
 * sandbox and workbench paths, and those sit under <out>/<arm>/<task>-<stamp>/.
 * That would hand the critic the arm label inside the very transcript it is
 * meant to read blind. Both arms get the same neutral placeholder, so nothing
 * about the comparison changes except that the tell is gone.
 */
const SCRUBBABLE = /\.(txt|json|jsonl|md|html)$/i

function scrub(text, runRoot, armDir) {
  return text
    .split(runRoot)
    .join('/RUN')
    .split(`/${armDir}/`)
    .join('/ARM/')
}

function copyVisible(from, to, runRoot, armDir) {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    if (name.startsWith('_')) continue // identifying sidecars stay behind
    const src = join(from, name)
    const dst = join(to, name)
    if (statSync(src).isDirectory()) copyVisible(src, dst, runRoot, armDir)
    else if (SCRUBBABLE.test(name)) writeFileSync(dst, scrub(readFileSync(src, 'utf8'), runRoot, armDir))
    else copyFileSync(src, dst)
  }
}

const a = indexRuns(armADir)
const b = indexRuns(armBDir)
const tasks = [...a.keys()].filter((t) => b.has(t)).sort()

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const key = {}
for (const task of tasks) {
  // Deterministic but unguessable: A goes first only when the digest is even.
  const digest = createHash('sha256').update(`${salt}:${task}`).digest()
  const aFirst = digest[0] % 2 === 0
  const first = aFirst ? a.get(task) : b.get(task)
  const second = aFirst ? b.get(task) : a.get(task)
  copyVisible(first, join(outDir, task, 'run-1'), first, basename(aFirst ? armADir : armBDir))
  copyVisible(second, join(outDir, task, 'run-2'), second, basename(aFirst ? armBDir : armADir))
  key[task] = { 'run-1': aFirst ? 'A' : 'B', 'run-2': aFirst ? 'B' : 'A' }
}

writeFileSync(join(outDir, '_key.json'), `${JSON.stringify(key, null, 2)}\n`)
console.log(`staged ${tasks.length} blind pairs in ${outDir}`)
for (const t of tasks) console.log(`  ${t}: run-1=${key[t]['run-1']} run-2=${key[t]['run-2']} (key withheld from critics)`)
