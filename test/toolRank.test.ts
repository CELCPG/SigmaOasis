import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installStubs, load, resetState, state } from './harness'

/**
 * toolRank ranks a turn's candidate tools against the user's message through
 * the harness's deterministic fake embedder (bag-of-words over a fixed
 * vocabulary), so the ranking assertion is about shared meaning, not mock
 * bookkeeping. The one guarantee that matters most: an embeddings failure
 * surfaces as { ok: false } — the renderer's fallback, never a turn failure.
 */

installStubs()

interface ToolRankModule {
  rankToolsByRelevance: (
    query: string,
    tools: { name: string; description: string }[]
  ) => Promise<Record<string, number>>
}

const toolRank = load<ToolRankModule>('toolRank')

const CANDIDATES = [
  { name: 'run_code', description: 'run python code with a timeout and retry' },
  { name: 'search_web', description: 'search the web for quantum encryption news' },
  { name: 'read_note', description: 'read a saved note by title' }
]

beforeEach(() => resetState())

describe('rankToolsByRelevance', () => {
  test('the tool sharing the query’s meaning outranks the others', async () => {
    const scores = await toolRank.rankToolsByRelevance('my python script hit a timeout', CANDIDATES)
    assert.ok(scores.run_code > scores.search_web)
    assert.ok(scores.run_code > scores.read_note)
  })

  test('every candidate gets a score, even one sharing no vocabulary', async () => {
    const scores = await toolRank.rankToolsByRelevance('python timeout', CANDIDATES)
    assert.deepEqual(Object.keys(scores).sort(), ['read_note', 'run_code', 'search_web'])
    // The fake embedder floors every dimension at 0.01, so a no-overlap tool
    // still gets a positive (tiny) cosine rather than NaN.
    assert.ok(scores.read_note >= 0)
  })

  test('an embeddings failure propagates so the IPC layer can answer ok:false', async () => {
    state.failEmbeddings = true
    await assert.rejects(() => toolRank.rankToolsByRelevance('python', CANDIDATES))
  })
})
