import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The head-to-head task set must describe TASKS, not BUILDS.
 *
 * Round 8 found that every `probes` field was a defect report of one specific
 * build — present tense, naming a source file, a function or a CSS class — and
 * that four of them quoted constants only one build could produce. A critic
 * that reads the value it is looking for before it measures is recognising an
 * arm, not judging one. The mitigation shipped that round was a generated view
 * with those fields stripped out.
 *
 * A filter is not the same as not having the leak. `make-critic-tasks.mjs`
 * decides what a critic may READ; this decides what may be WRITTEN. The
 * question-writer, the reviewer arguing that a task is unfair, and anyone
 * adding a task all read the unfiltered file, and round 8's own prompt-writing
 * agent disclosed that reading it had contaminated it.
 *
 * So the rule is enforced on the source. A descriptive field may not carry a
 * source path, a CSS class or custom property, a code identifier, a number with
 * a unit, a ratio, a version, a viewport size, an interface glyph, or a quoted
 * string lifted off the screen. Each of those is a fingerprint: it is a fact
 * about an implementation, and a task that states one has stopped describing an
 * experiment and started describing a result.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER, and why:
 *
 *   `prompt` and `setup` are the experiment. Eight rounds of recorded runs are
 *   comparable only because they have not moved, so they are frozen rather than
 *   cleaned — and `setup` reaches the critic view, so the constants still in it
 *   are pinned below as an inventory that cannot grow.
 *
 *   `mechanicalChecks` is a script's assertion list. It has to name concrete DOM
 *   facts to be decidable at all, so it remains a defect inventory in machine
 *   form. Nothing but the scoring script may read it.
 */

const ROOT = join(__dirname, '..', '..')
const TASKS = join(ROOT, 'docs', 'head-to-head', 'tasks.json')
const CRITIC_VIEW = join(ROOT, 'docs', 'head-to-head', 'tasks-for-critics.json')
const GENERATOR = join(ROOT, 'docs', 'head-to-head', 'make-critic-tasks.mjs')

type Task = {
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
}

type TaskSet = {
  dimensions: string[]
  tasksPerDimension: number
  notes: string
  selfConsistency: { appliesTo: string; question: string; measure: string[]; decide: string }
  tasks: Task[]
}

const set = JSON.parse(readFileSync(TASKS, 'utf-8')) as TaskSet
const generatorSrc = readFileSync(GENERATOR, 'utf-8')

/**
 * One class of build fingerprint each, with the reason it is a fingerprint.
 *
 * These are classes, not a blocklist of the strings round 8 happened to find.
 * The recurring lesson in docs/evals.md is that a check whose vocabulary is
 * narrower than the class it guards stops catching things the moment the
 * wording moves, so nothing here matches a specific known leak.
 */
const LEAK_CLASSES: { name: string; why: string; pattern: RegExp }[] = [
  {
    name: 'source path',
    why: 'names a file in one implementation; a build that renamed it would falsify the task',
    pattern: /\b[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|json|html|md)\b/gi
  },
  {
    name: 'tree path',
    why: 'names a directory layout, which is an implementation fact and not an observable',
    pattern: /\b(?:src|packs|resources|out|test|scripts|docs|node_modules)\/[\w./-]+/g
  },
  {
    name: 'utility class',
    why: 'a class name is how one build spells a presentation, not what a reader sees',
    pattern: /\b[a-z]+(?:-[a-z]+)*-\d{2,4}\b/g
  },
  {
    name: 'css token',
    why: 'a custom property, colour literal or utility keyword is a value only one build produces',
    pattern: /--[a-z][\w-]*|\brgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\b(?:outline|focus)-(?:none|visible)\b/g
  },
  {
    name: 'code identifier',
    why: 'a function, component or constant name is internal; readers and critics see neither',
    pattern: /\b(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g
  },
  {
    name: 'dimensioned number',
    why: 'a measured quantity is a result. Stating it tells a critic the value to beat',
    pattern:
      /\b\d+(?:[.,]\d+)?\s*(?:ms|s|sec|secs|seconds?|minutes?|px|pt|em|rem|%|characters?|chars?|bytes?|tokens?|occurrences?|places?|instances?|times)\b/gi
  },
  {
    name: 'ratio',
    why: 'a ratio is a measured result, and a threshold stated as one turns a measurement into a yes/no',
    pattern: /\b\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\b/g
  },
  {
    name: 'version',
    why: 'the most direct de-blinder there is: it names which build the sentence is about',
    pattern: /\bv?\d+\.\d+(?:\.\d+)*\b/g
  },
  {
    name: 'viewport size',
    why: 'a captured geometry is a result of a run, not a property of the task',
    pattern: /\b\d{3,4}\s?[x×]\s?\d{3,4}\b/g
  },
  {
    name: 'interface glyph',
    why: 'a status glyph is a string one build renders; a build that changed it is identified by its absence',
    pattern:
      /[←-⇿⌀-⏿■-◿①-➿⬀-⯿️]|[\u{1F300}-\u{1FAFF}]/gu
  },
  {
    name: 'quoted screen string',
    why: 'a label quoted off the screen is a fingerprint — the arm that prints it is the arm that has it',
    pattern: /["“”]/g
  },
  {
    name: 'quoted screen string',
    why: 'same, for single quotes; possessives and contractions are excluded by the boundaries',
    pattern: /(?<![A-Za-z])['‘][^'’]{2,}['’](?![A-Za-z])/g
  }
]

function leaks(text: string): string[] {
  const found: string[] = []
  for (const cls of LEAK_CLASSES) {
    for (const m of text.matchAll(cls.pattern)) found.push(`${cls.name}: ${JSON.stringify(m[0])} — ${cls.why}`)
  }
  return found
}

/** Every prose field a human reads to judge a run or to justify a task. */
function guardedFields(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [{ where: 'notes', text: set.notes }]
  const sc = set.selfConsistency
  out.push({ where: 'selfConsistency.appliesTo', text: sc.appliesTo })
  out.push({ where: 'selfConsistency.question', text: sc.question })
  out.push({ where: 'selfConsistency.decide', text: sc.decide })
  sc.measure.forEach((m, i) => out.push({ where: `selfConsistency.measure[${i}]`, text: m }))
  for (const t of set.tasks) {
    out.push({ where: `${t.id}.probes`, text: t.probes })
    out.push({ where: `${t.id}.question`, text: t.question })
    out.push({ where: `${t.id}.decide`, text: t.decide })
    t.measure.forEach((m, i) => out.push({ where: `${t.id}.measure[${i}]`, text: m }))
  }
  return out
}

describe('the task set describes tasks, not builds', () => {
  test('no descriptive field carries a build fingerprint', () => {
    const offences: string[] = []
    for (const { where, text } of guardedFields()) {
      for (const leak of leaks(text)) offences.push(`${where} — ${leak}`)
    }
    assert.deepEqual(
      offences,
      [],
      `A task description states a fact about an implementation. Rewrite it as a ` +
        `property of the task — what the prompt and the fixtures make happen, and ` +
        `what a reader could measure — with no value in it that only one build ` +
        `could produce.\n\n${offences.join('\n')}`
    )
  })

  /**
   * A guard that has never fired proves nothing. These are the SHAPES round 8
   * recorded, not the strings: if the classes above are ever narrowed to the
   * literals somebody once wrote, this fails first.
   */
  test('the classes fire on the shapes round 8 found in the field', () => {
    const shapes = [
      'MessageBubble renders it through a bare span',
      'src/renderer/src/assets/index.css sets no wrap rule',
      'the ink measures roughly 2.05:1 against the background',
      '33 occurrences of the utility, and zero replacements',
      'rendered in text-neutral-400, the same as a queued row',
      'the colour is rgba(23,23,23,0.32) in light theme',
      'the button still reads ▶ Run this plan',
      "the label 'awaiting approval' is still on screen",
      'the transport waits 15 s before giving up',
      'this landed in v1.6 and has not moved since',
      'the bubble holds at 1280x800 and not below',
      'FOOD_DOMAINS matches, so the provider fires'
    ]
    for (const shape of shapes) {
      assert.ok(leaks(shape).length > 0, `the leak classes let this through: ${shape}`)
    }
  })

  test('the guard does not fire on prose that describes an experiment', () => {
    const fine = [
      'The prompt asks for two quantities in a domain the installed library covers.',
      'Report the count for both runs, even when the two are identical.',
      'The reader’s own interruption is a fact the block either carries or does not.',
      'Quote the line verbatim, or write none.'
    ]
    for (const text of fine) assert.deepEqual(leaks(text), [], `false positive on: ${text}`)
  })

  test('a question that names a run has a verdict in it already', () => {
    for (const t of set.tasks) {
      assert.ok(
        !/\bwhich (?:run|one|build)\b/i.test(t.question),
        `${t.id}.question asks which run rather than what to measure, which presupposes ` +
          `that one of them is worse. Ask how much, how many, or what the reader gets.`
      )
    }
  })
})

describe('the task set is shaped for judging in both directions', () => {
  test('every task carries a probe, a question, a measurement plan and a rule for weighing it', () => {
    assert.equal(set.tasks.length, set.dimensions.length * set.tasksPerDimension)
    for (const t of set.tasks) {
      assert.ok(t.probes && t.probes.length > 80, `${t.id}: probes is missing or too thin`)
      assert.ok(t.question && t.question.length > 20, `${t.id}: question is missing`)
      assert.ok(Array.isArray(t.measure) && t.measure.length >= 3, `${t.id}: measure needs real steps`)
      assert.ok(t.decide && t.decide.length > 80, `${t.id}: decide is missing`)
      assert.ok(!('criticQuestion' in t), `${t.id}: criticQuestion was replaced, not renamed`)
    }
  })

  test('the self-consistency question is asked of every task', () => {
    assert.match(set.selfConsistency.appliesTo, /every task/)
    assert.match(set.selfConsistency.question, /contradict/)
  })

  test('every dimension has its three tasks', () => {
    for (const d of set.dimensions) {
      assert.equal(
        set.tasks.filter((t) => t.dimension === d).length,
        set.tasksPerDimension,
        `${d} does not have ${set.tasksPerDimension} tasks`
      )
    }
  })
})

/** KEEP and DROP as the generator itself spells them, so a rename cannot drift. */
function generatorList(name: string): string[] {
  const m = generatorSrc.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
  assert.ok(m, `make-critic-tasks.mjs no longer declares ${name}`)
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

describe('the generated critic view', () => {
  test('every field in a task is either kept or explicitly dropped', () => {
    const keep = generatorList('KEEP')
    const drop = generatorList('DROP')
    for (const t of set.tasks) {
      for (const field of Object.keys(t)) {
        assert.ok(
          keep.includes(field) || drop.includes(field),
          `${t.id} carries "${field}", which make-critic-tasks.mjs neither keeps nor drops. ` +
            `A field the generator has no opinion about is a leak waiting for a rename.`
        )
      }
    }
  })

  test('the field round 8 found leading is still named as dropped, so reintroducing it is caught', () => {
    assert.ok(generatorList('DROP').includes('criticQuestion'))
  })

  test('tasks-for-critics.json is the current projection of tasks.json', () => {
    const keep = generatorList('KEEP')
    const view = JSON.parse(readFileSync(CRITIC_VIEW, 'utf-8')) as { tasks: Record<string, unknown>[] }
    const projected = set.tasks.map((t) =>
      Object.fromEntries(keep.filter((k) => k in t).map((k) => [k, (t as unknown as Record<string, unknown>)[k]]))
    )
    assert.deepEqual(
      view.tasks,
      projected,
      'tasks.json changed without regenerating the critic view: node docs/head-to-head/make-critic-tasks.mjs'
    )
  })

  test('no dropped field survives into the critic view under any name', () => {
    const serialized = readFileSync(CRITIC_VIEW, 'utf-8')
    for (const field of generatorList('DROP')) {
      assert.ok(!serialized.includes(`"${field}"`), `"${field}" reached the critic view`)
    }
  })
})

/**
 * `setup` is frozen: it is what the run was staged as, and eight rounds of
 * recorded runs are comparable only because it has not moved. It is also the
 * one descriptive field the critic view keeps, so the constants left in it are
 * a live leak surface that the round-8 mitigation does not cover.
 *
 * They are pinned rather than removed. Adding one fails here; removing one is a
 * deliberate change to the staging and should be recorded as such.
 *
 * Round 9 removed eight, in PT2, VC1 and FR3. The freeze on `setup` was written
 * to protect the EXPERIMENT, and this field is not the experiment: the harness
 * executes `task-setup.json`, and nothing reads this prose. Rewording it changes
 * what a critic may infer and nothing about what was run — verified by diffing
 * `prompt`, `setup`'s machine twin and `mechanicalChecks` against the previous
 * commit. The three constants that mattered were `'awaiting approval'` and
 * `'Cancel'` (two of the four de-blinders round 8 found and then left in the one
 * descriptive field its mitigation KEPT), a version string, and two function
 * names. Round 8's fix stripped the field it knew leaked and kept one that also
 * leaked, which is this project's own recurring failure committed inside the
 * repair for the previous instance of it.
 */
describe('the frozen surface', () => {
  test('the constants reaching a critic through setup are exactly these', () => {
    const inventory = [
      ...new Set(set.tasks.flatMap((t) => leaks(t.setup).map((l) => `${t.id}: ${l.split(' — ')[0]}`)))
    ].sort()
    assert.deepEqual(inventory, [
      'FR1: dimensioned number: "12000 tokens"',
      'FR1: dimensioned number: "8192 tokens"',
      'FR1: quoted screen string: "\\""',
      'FR1: version: "127.0.0.1"',
      'FR2: dimensioned number: "120 s"',
      'FR2: version: "127.0.0.1"',
      'PT1: interface glyph: "→"',
      'PT1: interface glyph: "📋"',
      'PT1: source path: "trace-export.md"',
      'PT1: tree path: "docs/trace-export.md"',
      'PT2: code identifier: "outerHTML"',
      'PT2: dimensioned number: "1000 ms"',
      'PT3: dimensioned number: "1500 ms"',
      'PT3: interface glyph: "◌"',
      'PT3: interface glyph: "📋"',
      'TH2: code identifier: "SearXNG"',
      'TTU1: code identifier: "SearXNG"',
      'TTU1: dimensioned number: "8000 ms"',
      'TTU2: code identifier: "userData"',
      'TTU2: tree path: "resources/pyodide"',
      'TTU3: interface glyph: "→"',
      'VC1: viewport size: "1280x800"',
      'VC1: viewport size: "900x800"',
      'VC2: code identifier: "activeElement"'
    ])
  })
})
