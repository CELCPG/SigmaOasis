import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { load, resetState, state } from './harness'

/**
 * v4.2: library ranking — the model re-rank (L2) for the high-stakes
 * domains. Scripted completions and the harness's fake loopback embedder
 * only; nothing here reaches a real model.
 */

const lib = load<typeof import('../src/main/ipc/library')>('library')
const assist = load<typeof import('../src/main/ipc/library/modelAssist')>('library/modelAssist')
const handlers = load<typeof import('../src/main/ipc/toolHandlers/library')>('toolHandlers/library')

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
