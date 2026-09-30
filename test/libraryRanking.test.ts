import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { load, resetState, state } from './harness'

/**
 * v4.2: library ranking — the model re-rank (L2) and the hypothetical-answer
 * expansion (L3) for the high-stakes domains, and the wrong-section guard (L4)
 * for every lookup. Scripted completions and the harness's fake loopback embedder
 * only; nothing here reaches a real model.
 */

const lib = load<typeof import('../src/main/ipc/library')>('library')
const assist = load<typeof import('../src/main/ipc/library/modelAssist')>('library/modelAssist')
const handlers = load<typeof import('../src/main/ipc/toolHandlers/library')>('toolHandlers/library')
const hyde = load<typeof import('../src/main/ipc/library/hyde')>('library/hyde')
const guard = load<typeof import('../src/main/ipc/library/sectionGuard')>('library/sectionGuard')

const root = mkdtempSync(join(tmpdir(), 'sigma-library-ranking-'))
let counter = 0

function writePack(id: string, docs: { id: string; title: string; text: string }[], kind = 'curated'): string {
  const dir = join(root, `src-${id}-${counter++}`)
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      formatVersion: 1,
      id,
      name: `Pack ${id}`,
      description: 'test pack',
      version: '1',
      license: 'Public domain',
      kind,
      docs: docs.map((d) => ({ id: d.id, title: d.title, file: `${d.id}.md` }))
    })
  )
  for (const d of docs) writeFileSync(join(dir, 'docs', `${d.id}.md`), d.text)
  return dir
}

/**
 * Three sections that share the question's words. "Insect stings" leads on
 * keywords — it says sting, allergic and reaction more often — but it is
 * about removing a stinger; the answer to "what are the signs" is the
 * shorter "Anaphylaxis" section.
 */
const STINGS = `# Stings and allergies

## Insect stings

After a bee sting, scrape the sting out sideways with a fingernail. A sting that leaves an allergic reaction
at the site — a red, itchy allergic reaction — is common after a bee sting and is not an emergency. Wash the
sting and apply a cold compress to the allergic reaction.

## Anaphylaxis

Signs of a severe allergic reaction: swelling of the throat or tongue, difficulty breathing, wheezing,
a rapid heartbeat, and feeling faint. Call emergency services and use an adrenaline auto-injector.

## Hay fever

Seasonal allergic rhinitis is an allergic reaction to pollen: sneezing and itchy eyes; antihistamines help.
`

const QUESTION = 'what are the signs of a severe allergic reaction to a bee sting'

const rerankOn = (): void => {
  state.settings = { ...state.settings, grounding: { libraryRerank: true } }
}

beforeEach(() => {
  resetState()
  hyde.clearHydeCacheForTests()
  rmSync(join(root, 'lib'), { recursive: true, force: true })
  lib.setLibraryDirForTests(join(root, 'lib'))
})

describe('which lookups a re-rank may touch (v4.2 L2)', () => {
  test('health, first aid, finance and building questions; not the rest', () => {
    assert.ok(assist.stakesDomain(QUESTION))
    assert.ok(assist.stakesDomain('how much should I keep in an emergency fund for retirement'))
    assert.ok(assist.stakesDomain('what span tables apply to deck joists'))
    assert.equal(assist.stakesDomain('rolling boil water minute'), null)
    assert.equal(assist.stakesDomain('write a poem about bees'), null)
  })

  test('off by default: a health lookup makes no model call', async () => {
    await lib.installPackFromDirectory(writePack('health', [{ id: 'stings', title: 'Stings', text: STINGS }]))
    const out = await lib.lookupLibrary({ query: QUESTION, topK: 3 })
    assert.ok(out.passages.length >= 2)
    assert.equal(state.completionPrompts.length, 0)
    assert.equal(out.rerank, undefined)
  })

  test('on, a question outside the high-stakes domains still makes no call', async () => {
    rerankOn()
    await lib.installPackFromDirectory(
      writePack('prep', [{ id: 'water', title: 'Water', text: '# Water\n\n## Boiling\n\nBring water to a rolling boil for one minute.\n\n## Storage\n\nStore water in clean containers for a rolling supply.' }])
    )
    const out = await lib.lookupLibrary({ query: 'rolling boil water minute', topK: 2 })
    assert.ok(out.passages.length > 0)
    assert.equal(state.completionPrompts.length, 0)
  })

  test('on, the app\'s own ledger pack is never re-ranked', async () => {
    rerankOn()
    await lib.installPackFromDirectory(writePack('ledger', [{ id: 'stings', title: 'Stings', text: STINGS }], 'app'))
    await lib.lookupLibrary({ query: QUESTION, packId: 'ledger', topK: 3 })
    assert.equal(state.completionPrompts.length, 0)
  })
})

describe('the re-rank (v4.2 L2)', () => {
  test('the model\'s pick leads, the fused order tops it up to three, and the call is capped and thinking-closed', async () => {
    await lib.installPackFromDirectory(writePack('health', [{ id: 'stings', title: 'Stings', text: STINGS }]))
    const fused = await lib.lookupLibrary({ query: QUESTION, topK: 3 })
    assert.equal(fused.passages[0].section, 'Insect stings', 'the fixture must fail without the re-rank')
    assert.equal(fused.passages.length, 3)

    rerankOn()
    const anaphylaxis = (): number => {
      // The prompt lists one passage per section; find the number it gave Anaphylaxis.
      const prompt = state.completionPrompts[0] ?? ''
      return Number(/\[(\d+)\] \(Stings › Anaphylaxis\)/.exec(prompt)?.[1])
    }
    // The stub answers before the prompt can be read, so learn the numbering first…
    state.completions = ['{"answering": []}']
    await lib.lookupLibrary({ query: QUESTION, topK: 3 })
    const n = anaphylaxis()
    assert.ok(n >= 1, 'every candidate section is shown with its label')
    // …then answer with it.
    state.completionPrompts = []
    state.completionBodies = []
    state.completions = [`{"answering": [${n}]}`]
    const out = await lib.lookupLibrary({ query: QUESTION, topK: 3, modelId: 'answer-model' })
    assert.equal(out.rerank, 'applied')
    assert.equal(out.passages[0].section, 'Anaphylaxis')
    assert.equal(out.passages[0].score, 1)
    // RERANK_MIN_KEEP tops a one-pick answer up from the fused order.
    assert.equal(out.passages.length, 3)
    assert.match(state.completionPrompts[0], /Question: what are the signs of a severe allergic reaction/)
    const body = state.completionBodies[0] as Record<string, unknown>
    assert.equal(body.model, 'answer-model', 'the answering model is asked, not whichever loads first')
    assert.equal(body.max_tokens, 80)
    assert.equal(body.temperature, 0)
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
    assert.equal((body.response_format as { type?: string } | undefined)?.type, 'json_schema')
  })

  test('with topK 1, the model\'s pick is the whole answer', async () => {
    rerankOn()
    await lib.installPackFromDirectory(writePack('health', [{ id: 'stings', title: 'Stings', text: STINGS }]))
    state.completions = ['{"answering": [2, 2, 99, "x"]}']
    const out = await lib.lookupLibrary({ query: QUESTION, topK: 1 })
    assert.equal(out.rerank, 'applied')
    assert.equal(out.passages.length, 1)
    const prompt = state.completionPrompts[0]
    const second = /\[2\] \(Stings › ([^)]+)\)/.exec(prompt)?.[1]
    assert.equal(out.passages[0].section, second, 'repeats and numbers off the list are ignored')
  })

  test('a failed, empty or unparseable answer leaves the fused order exactly as it was', async () => {
    await lib.installPackFromDirectory(writePack('health', [{ id: 'stings', title: 'Stings', text: STINGS }]))
    const fused = await lib.lookupLibrary({ query: QUESTION, topK: 3 })
    rerankOn()
    for (const setup of [
      () => (state.failCompletions = true),
      () => (state.completions = ['{"answering": []}']),
      () => (state.completions = ['I think the second one.'])
    ]) {
      state.failCompletions = false
      state.completions = []
      setup()
      const out = await lib.lookupLibrary({ query: QUESTION, topK: 3 })
      assert.equal(out.rerank, 'fallback')
      assert.deepEqual(out.passages, fused.passages)
    }
  })

  test('the reference_lookup tool passes the calling slot\'s model', async () => {
    rerankOn()
    await lib.installPackFromDirectory(writePack('health', [{ id: 'stings', title: 'Stings', text: STINGS }]))
    state.completions = ['{"answering": [1]}']
    const res = await handlers.libraryHandlers.reference_lookup({ query: QUESTION }, { modelId: 'slot-model' } as never)
    assert.equal(res.ok, true)
    assert.equal((state.completionBodies[0] as { model?: string }).model, 'slot-model')
  })
})

describe('the deadline (v4.2 L2)', () => {
  test('a call that never answers is abandoned at the deadline, and its request aborted', async () => {
    let aborted = false
    const started = Date.now()
    const out = await assist.withDeadline(
      (signal) =>
        new Promise<string>(() => {
          signal.addEventListener('abort', () => (aborted = true))
        }),
      50
    )
    assert.equal(out, null)
    assert.ok(aborted)
    assert.ok(Date.now() - started < 1_000)
  })

  test('a call that throws is a null, not a throw', async () => {
    assert.equal(await assist.withDeadline(async () => { throw new Error('boom') }, 1_000), null)
    assert.equal(await assist.withDeadline(async () => 'ok', 1_000), 'ok')
  })
})

/**
 * The harness embedder folds a fixed vocabulary (car, doctor, salary …) onto
 * dimensions. "Fever in the car" says *fever* four times — BM25's favourite —
 * and lives on the car dimension; the answer ("see a doctor") says fever once
 * and lives on the doctor dimension; the question has neither. Only an
 * expansion that mentions a doctor can reach it.
 */
const FEVER = `# Fevers

## Fever in the car

Never leave a child with a fever in a parked car: a fever climbs fast in a closed vehicle. Treat such a fever
by opening the windows, and a fever that follows by cooling the child.

## When to get help

If a fever lasts more than three days, see a doctor; a physician or clinician can look for an infection, and a
doctor can prescribe.

## Clinics

A clinician or doctor at a walk-in clinic sees patients without an appointment.

## Sunburn

Cool sunburnt skin with a damp cloth and keep out of the sun.
`

const FEVER_Q = 'what should I do about a fever'
const HYPOTHESIS = 'Rest and drink fluids, and see a doctor or physician if the fever lasts more than three days.'

async function embeddedFeverPack(): Promise<void> {
  await lib.installPackFromDirectory(writePack('health', [{ id: 'fevers', title: 'Fevers', text: FEVER }]))
  const job = await lib.embedPack('health')
  assert.equal(job.ok, true, job.error)
}

const hydeOn = (): void => {
  state.settings = { ...state.settings, grounding: { libraryHyde: true } }
}

describe('the hypothetical-answer expansion (v4.2 L3)', () => {
  test('without it the wrong section leads; with it the answering section does', async () => {
    await embeddedFeverPack()
    const plain = await lib.lookupLibrary({ query: FEVER_Q, topK: 2 })
    assert.equal(plain.mode, 'hybrid')
    assert.equal(plain.passages[0].section, 'Fever in the car', 'the fixture must fail without the expansion')
    assert.equal(state.completionPrompts.length, 0, 'off by default: no model call')

    hydeOn()
    state.completions = [HYPOTHESIS]
    const out = await lib.lookupLibrary({ query: FEVER_Q, topK: 2, modelId: 'answer-model' })
    assert.equal(out.expanded, true)
    assert.equal(out.passages[0].section, 'When to get help')
    assert.match(state.completionPrompts[0], /what should I do about a fever/)
    const body = state.completionBodies[0] as Record<string, unknown>
    assert.equal(body.model, 'answer-model')
    assert.equal(body.max_tokens, 120)
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
  })

  test('the expansion is embedding-side only: it reaches no URL, no passage, no note and not the formatted text', async () => {
    await embeddedFeverPack()
    hydeOn()
    state.fetchLog = []
    state.completions = [HYPOTHESIS]
    const out = await lib.lookupLibrary({ query: FEVER_Q, topK: 3 })
    assert.equal(out.expanded, true)
    const formatted = lib.formatLookup(out, FEVER_Q)
    for (const text of [formatted, JSON.stringify(out), ...state.fetchLog.map((f) => f.url)]) {
      assert.ok(!text.includes('fluids'), 'the hypothetical answer leaked')
    }
    assert.ok(state.fetchLog.every((f) => f.purpose === 'lmstudio'), 'nothing but the local model server is contacted')
  })

  test('cached per question: a second lookup of the same question makes no second call', async () => {
    await embeddedFeverPack()
    hydeOn()
    state.completions = [HYPOTHESIS, HYPOTHESIS]
    await lib.lookupLibrary({ query: FEVER_Q, topK: 2 })
    const again = await lib.lookupLibrary({ query: '  What should I do about a FEVER ', topK: 2 })
    assert.equal(again.expanded, true)
    assert.equal(state.completionPrompts.length, 1)
  })

  test('no vectors, no expansion: a keyword-only library never pays for one', async () => {
    await lib.installPackFromDirectory(writePack('health', [{ id: 'fevers', title: 'Fevers', text: FEVER }]))
    hydeOn()
    state.completions = [HYPOTHESIS]
    const out = await lib.lookupLibrary({ query: FEVER_Q, topK: 2 })
    assert.equal(out.mode, 'keyword')
    assert.equal(out.expanded, undefined)
    assert.equal(state.completionPrompts.length, 0)
  })

  test('a failed expansion leaves the lookup exactly as it would have been', async () => {
    await embeddedFeverPack()
    const plain = await lib.lookupLibrary({ query: FEVER_Q, topK: 2 })
    hydeOn()
    state.failCompletions = true
    const out = await lib.lookupLibrary({ query: FEVER_Q, topK: 2 })
    assert.equal(out.expanded, undefined)
    assert.deepEqual(out.passages, plain.passages)
  })
})

/**
 * The chlorination section says *boil* and *water* in passing and says water
 * twice; the boiling section is a little longer. BM25 puts chlorination a
 * hair ahead — the eval's wrong-section shape, and the reply then quotes its
 * "30 minutes" for a boiling question.
 */
const waterDoc = (first: string, second: string): string => `# Water

## ${first}

If you cannot boil water, disinfect the water with household bleach: add eight drops per gallon, stir, and let it stand for 30 minutes.

## ${second}

Bring water to a rolling boil for one full minute, then let it cool in a covered pot and pour it into clean bottles with lids.

## Storage

Store drinking water in clean containers.

## Wells

Have a flooded well tested before using its water. ${'Wells need care over the years, and a well cap, a casing and a pump all wear out; look after them. '.repeat(4)}
`

const BOIL_Q = 'how long should I boil water'

describe('the wrong-section guard (v4.2 L4)', () => {
  test('the failure: with headings that say nothing, the chlorination passage edges out the boiling one', async () => {
    await lib.installPackFromDirectory(writePack('prep', [{ id: 'water', title: 'Water', text: waterDoc('Method A', 'Method B') }]))
    const out = await lib.lookupLibrary({ query: BOIL_Q, topK: 2 })
    assert.equal(out.passages[0].section, 'Method A')
    assert.match(out.passages[0].text, /30 minutes/)
    assert.ok(out.passages[0].score - out.passages[1].score <= guard.SECTION_TIE, 'a near-tie, which is what the guard breaks')
  })

  test('the fix: the section whose heading names the question leads, on the same scores', async () => {
    await lib.installPackFromDirectory(writePack('prep', [{ id: 'water', title: 'Water', text: waterDoc('Chlorination', 'Boiling') }]))
    const out = await lib.lookupLibrary({ query: BOIL_Q, topK: 2 })
    assert.equal(out.passages[0].section, 'Boiling')
    assert.match(out.passages[0].text, /rolling boil for one full minute/)
    assert.equal(out.passages[1].section, 'Chlorination')
    assert.equal(out.passages[0].score, 1, 'scores stay with positions')
    assert.equal(state.completionPrompts.length, 0, 'no model involved')
  })

  test('only a near-tie is broken, comparing original scores, and the order is otherwise stable', () => {
    const ranked = [
      { id: 'a', relevance: 1 },
      { id: 'b', relevance: 0.97 },
      { id: 'c', relevance: 0.96 },
      { id: 'd', relevance: 0.5 },
      { id: 'e', relevance: 0.49 }
    ]
    const match = (ids: string[]) => (id: string): boolean => ids.includes(id)
    // c is within the tie of b and of a: it climbs to the top.
    assert.deepEqual(guard.preferMatchingSections(ranked, match(['c'])).map((r) => r.id), ['c', 'a', 'b', 'd', 'e'])
    // Positions keep their scores.
    assert.deepEqual(guard.preferMatchingSections(ranked, match(['c'])).map((r) => r.relevance), [1, 0.97, 0.96, 0.5, 0.49])
    // d is nowhere near c: a clearly better passage keeps its place.
    assert.deepEqual(guard.preferMatchingSections(ranked, match(['d'])).map((r) => r.id), ['a', 'b', 'c', 'd', 'e'])
    // e ties d only.
    assert.deepEqual(guard.preferMatchingSections(ranked, match(['e'])).map((r) => r.id), ['a', 'b', 'c', 'e', 'd'])
    // Two matches keep their own order.
    assert.deepEqual(guard.preferMatchingSections(ranked, match(['b', 'c'])).map((r) => r.id), ['b', 'c', 'a', 'd', 'e'])
    // Nothing matches, or everything does: unchanged.
    assert.deepEqual(guard.preferMatchingSections(ranked, match([])).map((r) => r.id), ['a', 'b', 'c', 'd', 'e'])
    assert.deepEqual(guard.preferMatchingSections(ranked, match(['a', 'b', 'c', 'd', 'e'])).map((r) => r.id), ['a', 'b', 'c', 'd', 'e'])
  })

  test('headings match by stem, and an empty heading never matches', () => {
    const q = new Set(['boil', 'water'].map(guard.stem))
    assert.ok(guard.headingMatches('Boiling', q))
    assert.ok(guard.headingMatches('Storing Water', q))
    assert.ok(!guard.headingMatches('Chlorination', q))
    assert.ok(!guard.headingMatches('', q))
    assert.equal(guard.stem('burns'), 'burn')
    assert.equal(guard.stem('gas'), 'gas')
    assert.equal(guard.stem('bleeding'), 'bleed')
  })
})
