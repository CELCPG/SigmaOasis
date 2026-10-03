import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load, resetState, state } from './harness'
import { describeModel, effectiveContextLength, knownToLackVision, serverName } from '../src/renderer/src/lib/modelInfo'
import type { ModelInfo } from '../src/renderer/src/types'

const { fetchModelCatalog } = load<typeof import('../src/main/ipc/modelCatalog')>('modelCatalog')

/**
 * 4.5 (H4a): the catalog reads a llama.cpp server, and reads LM Studio exactly
 * as before. Every payload here was recorded from this PC on 2026-10-03
 * (test/fixtures/catalog/README.md) — the point of the file is what the real
 * servers send, not what a mock would.
 */

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'catalog')
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'))

const GEMMA_MODELS = fixture('llamacpp-gemma-4-26b-a4b.v1-models.json')
const GEMMA_PROPS = fixture('llamacpp-gemma-4-26b-a4b.props.json')
const QWEN_MODELS = fixture('llamacpp-qwen3.8-35b-a3b.v1-models.json')
const QWEN_PROPS = fixture('llamacpp-qwen3.8-35b-a3b.props.json')
const LMS_V0 = fixture('lmstudio.api-v0-models.json')
const LMS_V1 = fixture('lmstudio.v1-models.json')

/** A llama-server: no /api/v0, so the catalog falls through to /v1/models, then /props. */
function serveLlamaCpp(models: unknown, props: unknown | null): void {
  state.catalogUnavailable = true
  state.v1ModelsBody = models
  state.propsResponse = props === null ? null : { status: 200, body: props }
}

describe('LM Studio — the same payloads give the same entries as before 4.5', () => {
  beforeEach(() => {
    resetState()
  })

  // These two expectations were written against the catalog as it stood at
  // 292ae58 (before any llama.cpp code) and passed there unchanged: they are
  // the proof that adding a second server did not move the first.
  test('the recorded /api/v0/models payload', async () => {
    state.catalogModels = LMS_V0.data
    const catalog = await fetchModelCatalog()
    assert.equal(
      JSON.stringify(catalog),
      '{"models":[' +
        '{"id":"text-embedding-nomic-embed-text-v1.5","type":"embeddings","vision":false,"loadedContextLength":2048,"maxContextLength":2048,"loaded":true,"quantization":"Q4_K_M","arch":"nomic-bert"},' +
        '{"id":"qwen3.8-9b-distill","type":"llm","vision":false,"loadedContextLength":68608,"maxContextLength":262144,"loaded":true,"quantization":"Q4_K_M","arch":"qwen35"}' +
        '],"detailed":true}'
    )
  })

  test('the recorded /v1/models payload of an LM Studio without /api/v0', async () => {
    state.catalogUnavailable = true
    state.v1ModelsBody = LMS_V1
    const catalog = await fetchModelCatalog()
    assert.equal(
      JSON.stringify(catalog),
      '{"models":[{"id":"text-embedding-nomic-embed-text-v1.5"},{"id":"qwen3.8-9b-distill"}],"detailed":false}'
    )
    assert.deepEqual(Object.keys(catalog.models[0]), ['id'])
  })

  test('an LM Studio server is asked for nothing beyond what it was before', async () => {
    state.catalogModels = LMS_V0.data
    await fetchModelCatalog()
    assert.deepEqual(
      state.fetchLog.map((f) => f.url),
      ['http://127.0.0.1:1234/api/v0/models']
    )

    resetState()
    state.catalogUnavailable = true
    state.v1ModelsBody = LMS_V1
    await fetchModelCatalog()
    assert.deepEqual(
      state.fetchLog.map((f) => f.url),
      ['http://127.0.0.1:1234/api/v0/models', 'http://127.0.0.1:1234/v1/models']
    )
  })
})

describe('llama-server — Gemma 4 26B-A4B (vision), as recorded', () => {
  beforeEach(() => {
    resetState()
  })

  test('vision from the projector, the loaded window from /props, the training window from the list', async () => {
    serveLlamaCpp(GEMMA_MODELS, GEMMA_PROPS)
    const catalog = await fetchModelCatalog()
    assert.equal(catalog.detailed, true)
    assert.deepEqual(catalog.models, [
      {
        id: 'gemma-4-26b-a4b',
        type: 'vlm',
        vision: true,
        loadedContextLength: 65536,
        maxContextLength: 262144,
        loaded: true,
        quantization: 'Q4_K_M',
        server: 'llamacpp'
      }
    ])
  })

  test('with /props unanswered, the list alone still gives vision and the window (capabilities, meta.n_ctx)', async () => {
    serveLlamaCpp(GEMMA_MODELS, null)
    const [model] = (await fetchModelCatalog()).models
    assert.equal(model.vision, true)
    assert.equal(model.type, 'vlm')
    assert.equal(model.loadedContextLength, 65536)
    assert.equal(model.maxContextLength, 262144)
  })

  test('three read-only GETs, all lmstudio traffic: /api/v0 (a 404 here), /v1/models, /props', async () => {
    serveLlamaCpp(GEMMA_MODELS, GEMMA_PROPS)
    await fetchModelCatalog()
    assert.deepEqual(
      state.fetchLog.map((f) => f.url),
      ['http://127.0.0.1:1234/api/v0/models', 'http://127.0.0.1:1234/v1/models', 'http://127.0.0.1:1234/props']
    )
    assert.ok(state.fetchLog.every((f) => f.purpose === 'lmstudio'))
  })
})

describe('llama-server — the 35B-A3B (text only), as recorded', () => {
  beforeEach(() => {
    resetState()
  })

  test('text-only is reported, with its own window (its three slots share the one window)', async () => {
    serveLlamaCpp(QWEN_MODELS, QWEN_PROPS)
    const catalog = await fetchModelCatalog()
    assert.deepEqual(catalog.models, [
      {
        id: 'qwen3.8-35b-a3b',
        type: 'llm',
        vision: false,
        loadedContextLength: 98304,
        maxContextLength: 262144,
        loaded: true,
        quantization: 'Q4_K_M',
        server: 'llamacpp'
      }
    ])
  })

  test('with /props unanswered, a capability list without multimodal still says text-only', async () => {
    serveLlamaCpp(QWEN_MODELS, null)
    const [model] = (await fetchModelCatalog()).models
    assert.equal(model.vision, false)
    assert.equal(model.type, 'llm')
    assert.equal(model.loadedContextLength, 98304)
  })
})

describe('llama-server — what each field is read from, and what wins', () => {
  beforeEach(() => {
    resetState()
  })

  test("the slot window in /props wins over the list's total (a server started with --parallel and no shared cache)", async () => {
    const props = { ...GEMMA_PROPS, default_generation_settings: { ...GEMMA_PROPS.default_generation_settings, n_ctx: 21845 } }
    serveLlamaCpp(GEMMA_MODELS, props)
    const [model] = (await fetchModelCatalog()).models
    assert.equal(model.loadedContextLength, 21845)
    assert.equal(model.maxContextLength, 262144)
  })

  test('/props modalities win over the capability list: an audio-only projector is multimodal but not vision', async () => {
    const props = { ...GEMMA_PROPS, modalities: { vision: false, video: false, audio: true } }
    serveLlamaCpp(GEMMA_MODELS, props)
    const [model] = (await fetchModelCatalog()).models
    assert.equal(model.vision, false)
    assert.equal(model.type, 'llm')
  })

  test('an older build with no capability list and no /props: vision is unknown, not "no", and the window still reads from meta', async () => {
    const old = { object: 'list', data: [{ ...GEMMA_MODELS.data[0] }] }
    serveLlamaCpp(old, null)
    const [model] = (await fetchModelCatalog()).models
    assert.equal(model.vision, undefined)
    assert.equal(model.type, undefined)
    assert.equal(model.loadedContextLength, 65536)
    assert.equal(model.server, 'llamacpp')
  })

  test('an older build whose /props has modalities but whose list has no capabilities', async () => {
    const old = { object: 'list', data: [{ ...GEMMA_MODELS.data[0] }] }
    serveLlamaCpp(old, GEMMA_PROPS)
    const [model] = (await fetchModelCatalog()).models
    assert.equal(model.vision, true)
  })

  test('an empty capability list says nothing', async () => {
    const empty = { ...GEMMA_MODELS, models: [{ ...GEMMA_MODELS.models[0], capabilities: [] }] }
    serveLlamaCpp(empty, null)
    const [model] = (await fetchModelCatalog()).models
    assert.equal(model.vision, undefined)
  })

  test('a server that reports it is asleep is not called loaded', async () => {
    serveLlamaCpp(GEMMA_MODELS, { ...GEMMA_PROPS, is_sleeping: true })
    const [model] = (await fetchModelCatalog()).models
    assert.equal(model.loaded, false)
  })

  test('/props that fail or answer nonsense are ignored, not fatal', async () => {
    for (const props of [{ status: 500, body: { error: 'busy' } }, { status: 200, body: 'not an object' }, { status: 200, body: [1, 2] }]) {
      resetState()
      state.catalogUnavailable = true
      state.v1ModelsBody = GEMMA_MODELS
      state.propsResponse = props
      const catalog = await fetchModelCatalog()
      assert.equal(catalog.models.length, 1)
      assert.equal(catalog.models[0].vision, true)
      assert.equal(catalog.models[0].loadedContextLength, 65536)
    }
  })

  test('nonsense numbers are dropped, as for LM Studio', async () => {
    const odd = { ...GEMMA_MODELS, data: [{ ...GEMMA_MODELS.data[0], meta: { n_ctx: 0, n_ctx_train: -5, ftype: '' } }] }
    serveLlamaCpp(odd, null)
    const [model] = (await fetchModelCatalog()).models
    assert.equal(model.loadedContextLength, undefined)
    assert.equal(model.maxContextLength, undefined)
    assert.equal(model.quantization, undefined)
  })

  test('llama.cpp file-type names read the way LM Studio spells them; others are kept as reported', async () => {
    const read = async (ftype: string): Promise<string | undefined> => {
      resetState()
      serveLlamaCpp({ ...GEMMA_MODELS, data: [{ ...GEMMA_MODELS.data[0], meta: { ...GEMMA_MODELS.data[0].meta, ftype } }] }, null)
      return (await fetchModelCatalog()).models[0].quantization
    }
    assert.equal(await read('Q4_K - Medium'), 'Q4_K_M')
    assert.equal(await read('Q3_K - Large'), 'Q3_K_L')
    assert.equal(await read('Q5_K - Small'), 'Q5_K_S')
    assert.equal(await read('Q6_K'), 'Q6_K')
    assert.equal(await read('MXFP4 MoE'), 'MXFP4 MoE')
  })

  test('several models listed: /props is applied only to the one its model_alias names, and "loaded" is not claimed for the rest', async () => {
    const many = {
      models: [...GEMMA_MODELS.models, ...QWEN_MODELS.models],
      object: 'list',
      data: [GEMMA_MODELS.data[0], QWEN_MODELS.data[0]]
    }
    serveLlamaCpp(many, GEMMA_PROPS)
    const byId = Object.fromEntries((await fetchModelCatalog()).models.map((m) => [m.id, m]))
    assert.equal(byId['gemma-4-26b-a4b'].loaded, true)
    assert.equal(byId['qwen3.8-35b-a3b'].loaded, undefined)
    // The list still answers for both: capabilities and meta are per model.
    assert.equal(byId['gemma-4-26b-a4b'].vision, true)
    assert.equal(byId['qwen3.8-35b-a3b'].vision, false)
    assert.equal(byId['qwen3.8-35b-a3b'].loadedContextLength, 98304)
  })
})

describe('a server that is neither', () => {
  beforeEach(() => {
    resetState()
  })

  test('a bare OpenAI-compatible list is ids only, and /props is never asked for', async () => {
    state.catalogUnavailable = true
    state.v1ModelsBody = { object: 'list', data: [{ id: 'some-model', object: 'model', owned_by: 'someone' }] }
    const catalog = await fetchModelCatalog()
    assert.equal(JSON.stringify(catalog), '{"models":[{"id":"some-model"}],"detailed":false}')
    assert.ok(!state.fetchLog.some((f) => f.url.endsWith('/props')))
  })

  test('an Ollama-style list with no capabilities is not mistaken for llama-server', async () => {
    state.catalogUnavailable = true
    state.v1ModelsBody = { object: 'list', data: [{ id: 'llama3', object: 'model', created: 1, owned_by: 'library' }] }
    const catalog = await fetchModelCatalog()
    assert.equal(catalog.detailed, false)
    assert.deepEqual(catalog.models, [{ id: 'llama3' }])
  })
})

describe('what the UI makes of a llama.cpp entry', () => {
  beforeEach(() => {
    resetState()
  })

  const entry = async (models: unknown, props: unknown | null): Promise<ModelInfo> => {
    resetState()
    serveLlamaCpp(models, props)
    return (await fetchModelCatalog()).models[0]
  }

  test("Gemma: the model row says vision, quantization, the window, loaded; the budget is the loaded window; no image warning", async () => {
    const gemma = await entry(GEMMA_MODELS, GEMMA_PROPS)
    assert.equal(describeModel(gemma), 'vision · Q4_K_M · 66K ctx · loaded')
    assert.equal(effectiveContextLength(gemma), 65536)
    assert.equal(knownToLackVision(gemma), false)
  })

  test('the 35B: the warning fires, because the server positively reported no vision, and it names llama.cpp', async () => {
    const qwen = await entry(QWEN_MODELS, QWEN_PROPS)
    assert.equal(describeModel(qwen), 'Q4_K_M · 98K ctx · loaded')
    assert.equal(knownToLackVision(qwen), true)
    assert.equal(serverName(qwen), 'llama.cpp')
  })

  test('a llama.cpp model whose vision is unknown does not trigger the warning', async () => {
    const old = await entry({ object: 'list', data: [{ ...GEMMA_MODELS.data[0] }] }, null)
    assert.equal(knownToLackVision(old), false)
  })

  test('an entry from an ids-only list, or no entry at all, is not a refusal and is called LM Studio, as before', () => {
    assert.equal(knownToLackVision({ id: 'x' }), false)
    assert.equal(knownToLackVision(undefined), false)
    assert.equal(serverName({ id: 'x' }), 'LM Studio')
    assert.equal(serverName(undefined), 'LM Studio')
    assert.equal(serverName({ id: 'x', type: 'vlm', vision: true }), 'LM Studio')
  })

  test('the composer names the server it quotes, and ConnectionTab offers no Load or Unload for a llama-server model', () => {
    const src = (file: string): string => readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', file), 'utf-8')
    assert.match(src('InputBar.tsx'), /title=\{`\$\{serverName\(activeModel\)\} reports this model as text-only\./)
    assert.match(src(join('settings', 'ConnectionTab.tsx')), /\{m\.server !== 'llamacpp' && \(\s*<Button/)
  })
})
