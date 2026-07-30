import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, resetState, state } from './harness'

const { fetchModelCatalog } = load<typeof import('../src/main/ipc/modelCatalog')>('modelCatalog')

/**
 * The model catalog is what makes context budgeting and the vision warning
 * possible. The failure that matters is the quiet one: an older LM Studio with
 * no /api/v0 must degrade to ids-only rather than reporting an empty model
 * list, which would read to the user as "LM Studio is offline".
 */

describe('fetchModelCatalog — the detailed path', () => {
  beforeEach(() => {
    resetState()
  })

  test('reads capabilities from /api/v0/models', async () => {
    state.catalogModels = [
      {
        id: 'qwen3-8b',
        type: 'llm',
        state: 'loaded',
        max_context_length: 32768,
        loaded_context_length: 8192,
        quantization: 'Q4_K_M',
        arch: 'qwen3'
      }
    ]
    const catalog = await fetchModelCatalog()
    assert.equal(catalog.detailed, true)
    const model = catalog.models[0]
    assert.equal(model.id, 'qwen3-8b')
    assert.equal(model.loaded, true)
    assert.equal(model.maxContextLength, 32768)
    assert.equal(model.loadedContextLength, 8192)
    assert.equal(model.quantization, 'Q4_K_M')
  })

  test('vision comes from type vlm, and only from there', async () => {
    state.catalogModels = [
      { id: 'gemma-vision', type: 'vlm' },
      { id: 'plain-llm', type: 'llm' }
    ]
    const catalog = await fetchModelCatalog()
    assert.equal(catalog.models.find((m) => m.id === 'gemma-vision')?.vision, true)
    assert.equal(catalog.models.find((m) => m.id === 'plain-llm')?.vision, false)
  })

  test('a model that is not resident is reported as not loaded', async () => {
    state.catalogModels = [{ id: 'cold', type: 'llm', state: 'not-loaded' }]
    const catalog = await fetchModelCatalog()
    assert.equal(catalog.models[0].loaded, false)
  })

  test('absent or nonsensical context lengths are dropped, not passed through as zero', async () => {
    // A zero would flow into historyBudget and be read as "unknown", but a
    // negative or NaN would produce a negative budget — reject both here.
    state.catalogModels = [
      { id: 'a', type: 'llm', max_context_length: 0, loaded_context_length: -1 }
    ]
    const catalog = await fetchModelCatalog()
    assert.equal(catalog.models[0].maxContextLength, undefined)
    assert.equal(catalog.models[0].loadedContextLength, undefined)
  })

  test('entries without an id are skipped rather than yielding undefined ids', async () => {
    state.catalogModels = [{ type: 'llm' }, { id: 'real', type: 'llm' }]
    const catalog = await fetchModelCatalog()
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      ['real']
    )
  })
})

describe('fetchModelCatalog — falling back to /v1/models', () => {
  beforeEach(() => {
    resetState()
  })

  test('a 404 on the REST endpoint falls back to ids only', async () => {
    state.catalogUnavailable = true
    const catalog = await fetchModelCatalog()
    assert.equal(catalog.detailed, false)
    assert.deepEqual(
      catalog.models.map((m) => m.id).sort(),
      ['fake-chat', 'fake-embed']
    )
    // No invented capabilities on the fallback path.
    assert.equal(catalog.models[0].maxContextLength, undefined)
    assert.equal(catalog.models[0].vision, undefined)
  })

  test('an empty detailed list also falls back rather than reporting no models', async () => {
    state.catalogModels = []
    const catalog = await fetchModelCatalog()
    assert.equal(catalog.detailed, false)
    assert.ok(catalog.models.length > 0)
  })

  test('both endpoints go out as lmstudio traffic, so they stay on the allowlist', async () => {
    state.catalogUnavailable = true
    await fetchModelCatalog()
    assert.ok(state.fetchLog.length > 0)
    assert.ok(
      state.fetchLog.every((entry) => entry.purpose === 'lmstudio'),
      `unexpected purposes: ${state.fetchLog.map((f) => f.purpose).join(', ')}`
    )
  })
})
