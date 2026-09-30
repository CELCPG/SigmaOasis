import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { installStubs, load, resetState, state } from './harness'

/**
 * v4.1 (S6): a query's vector is kept for a minute, keyed by (model, text).
 * A turn embeds the user's message for the ledger, the library, memory recall
 * and tool ranking in turn; only the first of those should reach LM Studio.
 * Counted at the harness's /embeddings endpoint, so these are round trips.
 */

installStubs()

interface EmbeddingsModule {
  embedTexts: (texts: string[]) => Promise<{ model: string; vectors: number[][] }>
  QUERY_CACHE_TTL_MS: number
}

const embeddings = load<EmbeddingsModule>('embeddings')

const realNow = Date.now
beforeEach(() => resetState())
afterEach(() => {
  Date.now = realNow
})

const settings = (): { memory: { embeddingModel: string } } => state.settings as unknown as { memory: { embeddingModel: string } }

describe('query embedding cache (v4.1 S6)', () => {
  test('the same query four times in a turn is one round trip, with the same vector', async () => {
    const first = await embeddings.embedTexts(['weather in richmond today'])
    for (let i = 0; i < 3; i++) {
      const again = await embeddings.embedTexts(['weather in richmond today'])
      assert.deepEqual(again, first)
    }
    assert.equal(state.embedCalls, 1)
  })

  test('a minute later the vector is fetched again', async () => {
    await embeddings.embedTexts(['tariff margin'])
    const t0 = realNow()
    Date.now = () => t0 + embeddings.QUERY_CACHE_TTL_MS + 1
    await embeddings.embedTexts(['tariff margin'])
    assert.equal(state.embedCalls, 2)
  })

  test('another embedding model never answers with the old one’s vector', async () => {
    await embeddings.embedTexts(['music preferences'])
    settings().memory.embeddingModel = 'other-embed'
    const again = await embeddings.embedTexts(['music preferences'])
    assert.equal(state.embedCalls, 2)
    assert.equal(again.model, 'other-embed')
  })

  test('document chunks are not kept — only query-sized text', async () => {
    const chunk = 'x '.repeat(1500)
    await embeddings.embedTexts([chunk])
    await embeddings.embedTexts([chunk])
    assert.equal(state.embedCalls, 2)
  })

  test('a batch with one new text goes to the server whole', async () => {
    await embeddings.embedTexts(['alpha'])
    const out = await embeddings.embedTexts(['alpha', 'beta'])
    assert.equal(state.embedCalls, 2)
    assert.equal(out.vectors.length, 2)
    // …and both are cached from then on.
    await embeddings.embedTexts(['beta', 'alpha'])
    assert.equal(state.embedCalls, 2)
  })

  test('a failing embedder is still a failure for text it never embedded', async () => {
    state.failEmbeddings = true
    await assert.rejects(embeddings.embedTexts(['never seen']))
  })
})
