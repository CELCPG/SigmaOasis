import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The head-to-head task set is judged blind, and it was not always written to
 * be. Through round 8 the tasks' `probes` fields were a defect inventory —
 * present tense, naming source files, functions and CSS classes — and four of
 * them quoted constants only one build could produce, so a critic that had
 * read the task set could recognise an arm instead of judging it (recorded in
 * docs/evals.md). The v2 rewrite made `probes`, `question`, `measure` and
 * `decide` neutral: they name what the task makes happen and what to measure,
 * never what a build does with it, and they carry no source path, class name,
 * glyph or measured constant.
 *
 * tasks.json says that rule "is enforced by the task-set neutrality test in
 * the suite, not by convention". This is that test. It also pins the critic
 * view: tasks-for-critics.json must be exactly the KEEP-projection of
 * tasks.json, because the two files drifting apart is how a leak survives a
 * regeneration — the generator refuses dropped fields on its output, but only
 * this suite notices a critic file that was hand-edited and never regenerated.
 *
 * `setup` and `mechanicalChecks` are deliberately not held to the full rule:
 * setup legitimately names docs paths and settings screens for the driver, and
 * mechanicalChecks quote the exact strings the scoring script greps for. The
 * glyph rule alone extends to `setup`, because setup reaches the critic.
 */

const H2H = join(__dirname, '..', '..', 'docs', 'head-to-head')

interface Task {
  id: string
  dimension: string
  prompt: string
  probes: string
  setup: string
  mechanicalChecks: string[]
  question: string
  measure: string[]
  decide: string
  offlineSafe: boolean
  [key: string]: unknown
}

const src = JSON.parse(readFileSync(join(H2H, 'tasks.json'), 'utf-8')) as {
  version: number
  name: string
  dimensions: string[]
  tasks: Task[]
}
const critic = JSON.parse(readFileSync(join(H2H, 'tasks-for-critics.json'), 'utf-8')) as {
  version: number
  name: string
  dimensions: string[]
  tasks: Record<string, unknown>[]
}

/** The fields a critic may see, in the order the generator writes them. */
const KEEP = ['id', 'dimension', 'prompt', 'setup', 'offlineSafe']
/** The fields written for builders, which must never reach the critic. */
const DROP = ['probes', 'mechanicalChecks', 'question', 'measure', 'decide', 'criticQuestion']

/**
 * What "neutral" means, mechanically. Each rule names the leak it refuses,
 * with the round-8 offender as the example.
 */
const RULES: [RegExp, string][] = [
  // '✗' in text-red-500, '○ text-neutral-400', 📋, ◌ — a glyph is a rendering
  // choice, and quoting one tells the critic what one build paints. Arrows and
  // punctuation stay legal: "Settings → General" is prose, not a glyph quote.
  [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}]/u, 'glyph or emoji'],
  // "33 occurrences of 'outline-none'" — a class name is an implementation.
  [/\b(?:text|bg|border|ring|shadow|outline|focus)-[a-z]+(?:-\d{2,3})?\b/, 'CSS class name'],
  // "MessageBubble renders … through MemoryContextLine" — source geography.
  [/\bsrc\/|\bpacks\/[a-z]|\.tsx?\b|\.mjs\b|\.css\b/, 'source path'],
  // "rgba(23,23,23,0.32)" — a constant only one build can produce.
  [/rgba?\(|#[0-9a-fA-F]{6}\b/, 'color constant'],
  // "roughly 2.05:1" — a measured ratio de-blinds the arm that measures it.
  [/\d\.\d+:1\b/, 'measured contrast ratio'],
  // "split view (v1.11)" — a version reference dates the build.
  [/\bv\d+\.\d+/, 'version reference'],
  // "looksFactual() is FALSE", "runPlanStep calls runAgentLoop" — function
  // names. camelCase words do not occur in prose about behaviour.
  [/\b[a-z]+[A-Z][a-zA-Z]+\b/, 'camelCase identifier'],
]

function violations(text: string): string[] {
  const hits: string[] = []
  for (const [re, label] of RULES) {
    const m = text.match(re)
    if (m) hits.push(`${label} (${JSON.stringify(m[0])})`)
  }
  return hits
}

describe('task-set schema', () => {
  test('every task carries the v2 fields, and none the v1 spelling', () => {
    assert.equal(src.tasks.length, 18)
    for (const t of src.tasks) {
      for (const field of ['probes', 'question', 'decide', 'setup', 'prompt']) {
        assert.equal(typeof t[field], 'string', `${t.id}.${field} must be a string`)
        assert.ok((t[field] as string).length > 0, `${t.id}.${field} must not be empty`)
      }
      assert.ok(Array.isArray(t.measure) && t.measure.length > 0, `${t.id}.measure`)
      assert.ok(Array.isArray(t.mechanicalChecks) && t.mechanicalChecks.length > 0, `${t.id}.mechanicalChecks`)
      assert.ok(!('criticQuestion' in t), `${t.id} carries the retired criticQuestion field`)
    }
  })

  test('every field is either kept for the critic or filed as dropped', () => {
    // A field on neither list is a field nobody decided about; the generator
    // refuses it too, but the suite runs on every push and the generator only
    // when someone remembers to.
    for (const t of src.tasks) {
      for (const k of Object.keys(t)) {
        assert.ok(KEEP.includes(k) || DROP.includes(k), `${t.id}.${k} is on neither KEEP nor DROP`)
      }
    }
  })
})

describe('task-set neutrality — probes, question, measure and decide are true of any build', () => {
  for (const t of src.tasks) {
    test(`${t.id} carries no build-identifying content`, () => {
      const fields: [string, string][] = [
        ['probes', t.probes],
        ['question', t.question],
        ['decide', t.decide],
        ...t.measure.map((m, i): [string, string] => [`measure[${i}]`, m]),
      ]
      for (const [name, text] of fields) {
        const hits = violations(text)
        assert.deepEqual(hits, [], `${t.id}.${name}: ${hits.join('; ')}`)
      }
    })
  }

  test('setup reaches the critic, so the glyph rule extends to it', () => {
    const glyph = RULES[0][0]
    for (const t of src.tasks) {
      const m = t.setup.match(glyph)
      assert.equal(m, null, `${t.id}.setup contains glyph ${JSON.stringify(m?.[0])}`)
    }
  })
})

describe('critic view is the projection it claims to be', () => {
  test('tasks-for-critics.json is exactly the KEEP-projection of tasks.json', () => {
    assert.equal(critic.version, src.version)
    assert.equal(critic.name, src.name)
    assert.deepEqual(critic.dimensions, src.dimensions)
    const expected = src.tasks.map((t) =>
      Object.fromEntries(KEEP.filter((k) => k in t).map((k) => [k, t[k]]))
    )
    // deepEqual on the parsed values, so key order and formatting stay the
    // generator's business — drift in *content* is what this refuses.
    assert.deepEqual(critic.tasks, expected)
  })

  test('no dropped field survives into the critic file under any spelling', () => {
    const serialized = readFileSync(join(H2H, 'tasks-for-critics.json'), 'utf-8')
    for (const field of DROP) {
      assert.ok(!serialized.includes(`"${field}"`), `"${field}" reached the critic view`)
    }
  })
})
