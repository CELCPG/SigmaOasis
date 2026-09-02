/**
 * The task column, read from critics' reports.
 *
 * critic-counts.mjs reads the COUNTS blocks — the cross-cutting columns — and
 * refuses to attribute run-1 / run-2 to arms without the withheld key. The task
 * column has no block: it is the `WINNER:` line under each `## <TASK>` heading
 * in the same report, and until round 14 it was transcribed by hand. Hand
 * transcription is where a run label becomes an arm letter by memory, which is
 * the one step in judging that has no artifact to check it against. This reads
 * the lines and attributes them through _key.json, the same way, and refuses
 * the same things: a task judged twice, a task in the key that no report
 * judged, a WINNER word outside the vocabulary.
 *
 *   node docs/head-to-head/critic-verdicts.mjs <report.txt...> --key <staging>/_key.json
 *
 * Prints the task column as score-round.mjs wants it:
 *   { "id": "task", "asked": true, "verdicts": { "V1": { "verdict": "B" }, … } }
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const RUNS = ['run-1', 'run-2']
const WORDS = [...RUNS, 'tie', 'void']

function fail(msg) {
  console.error(`critic-verdicts: ${msg}`)
  process.exit(2)
}

export function readWinners(text, where = 'report') {
  const out = []
  let task = null
  let line = 0
  for (const raw of text.split('\n')) {
    line += 1
    const heading = raw.match(/^##\s+([A-Z]+\d+)\s*$/)
    if (heading) {
      task = heading[1]
      continue
    }
    const winner = raw.match(/^WINNER:\s*(\S+)/)
    if (!winner) continue
    if (!task) fail(`${where}:${line}: WINNER before any "## <TASK>" heading`)
    const word = winner[1].replace(/[`*]/g, '')
    if (!WORDS.includes(word)) fail(`${where}:${line}: "${word}" is not one of ${WORDS.join(', ')}`)
    if (out.some((o) => o.task === task)) fail(`${where}:${line}: ${task} judged twice`)
    out.push({ task, word })
    task = null
  }
  return out
}

/** _key.json maps <task> → { "run-1": "A" | "B", "run-2": "A" | "B" }, as make-blind-pairs.mjs writes it. */
export function toTaskColumn(winners, key) {
  const verdicts = {}
  for (const { task, word } of winners) {
    if (!key[task]) fail(`${task}: judged, but not in the key`)
    let verdict = word
    if (RUNS.includes(word)) {
      verdict = key[task][word]
      if (verdict !== 'A' && verdict !== 'B') fail(`${task}: key maps ${word} to "${verdict}", not A or B`)
    }
    verdicts[task] = { verdict }
  }
  for (const task of Object.keys(key)) {
    if (!verdicts[task]) fail(`${task}: staged in the key, judged by no report`)
  }
  return { id: 'task', asked: true, verdicts }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const keyAt = args.indexOf('--key')
  if (keyAt < 0 || !args[keyAt + 1]) {
    console.error('usage: critic-verdicts.mjs <report.txt...> --key <staging>/_key.json')
    process.exit(2)
  }
  const files = args.filter((a, i) => i !== keyAt && i !== keyAt + 1)
  if (!files.length) fail('no report to read')
  const key = JSON.parse(readFileSync(args[keyAt + 1], 'utf8'))
  const winners = files.flatMap((f) => readWinners(readFileSync(f, 'utf8'), f))
  process.stdout.write(`${JSON.stringify(toTaskColumn(winners, key), null, 2)}\n`)
}
