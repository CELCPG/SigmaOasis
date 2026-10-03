import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load, resetState, state } from './harness'

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
