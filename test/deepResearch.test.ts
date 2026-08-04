import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, state, resetState } from './harness'
// Type-only: erased at compile time, so it does not bypass the harness's stubs.
import type { CandidateSource, ReadSource, SubQuestion } from '../src/main/ipc/deepResearch'

const research = load<typeof import('../src/main/ipc/deepResearch')>('deepResearch')
const llm = load<typeof import('../src/main/ipc/llm')>('llm')
const search = load<typeof import('../src/main/ipc/search')>('search')
const researchIndex = load<typeof import('../src/main/ipc/researchIndex')>('researchIndex')

const {
  parsePlan,
  selectSources,
  assessCoverage,
  budgetFor,
  searchPacing,
  BudgetTracker,
  runDeepResearch
} = research

beforeEach(() => {
  resetState()
  search.clearSearchCache()
  researchIndex.clearResearchIndex()
})

describe('extractJson', () => {
  test('parses clean JSON', () => {
    assert.deepEqual(llm.extractJson('{"a":1}'), { a: 1 })
  })

  test('parses JSON inside a markdown fence', () => {
    assert.deepEqual(llm.extractJson('```json\n{"a":1}\n```'), { a: 1 })
  })

  test('parses JSON wrapped in prose, which local models do constantly', () => {
    assert.deepEqual(
      llm.extractJson('Sure! Here is the plan:\n{"a":1}\nLet me know if you want changes.'),
      { a: 1 }
    )
  })

  test('is not fooled by a brace inside a string value', () => {
    assert.deepEqual(llm.extractJson('text {"a":"}not the end"} tail'), { a: '}not the end' })
  })

  test('handles escaped quotes inside strings', () => {
    assert.deepEqual(llm.extractJson('{"a":"say \\"hi\\""}'), { a: 'say "hi"' })
  })

  test('parses a top-level array', () => {
    assert.deepEqual(llm.extractJson('here: [1,2,3]'), [1, 2, 3])
  })

  test('skips a malformed object and finds the next valid one', () => {
    assert.deepEqual(llm.extractJson('{not json} then {"b":2}'), { b: 2 })
  })

  test('returns null when there is no JSON at all', () => {
    assert.equal(llm.extractJson('I cannot help with that.'), null)
    assert.equal(llm.extractJson(''), null)
  })
})

describe('parsePlan', () => {
  const fallback = 'original question'

  test('parses the documented shape', () => {
    const plan = parsePlan(
      { subQuestions: [{ question: 'q1', queries: ['a', 'b'] }] },
      fallback
    )
    assert.equal(plan!.subQuestions.length, 1)
    assert.deepEqual(plan!.subQuestions[0].queries, ['a', 'b'])
  })

  test('accepts a bare array instead of the wrapper object', () => {
    const plan = parsePlan([{ question: 'q1', queries: ['a'] }], fallback)
    assert.equal(plan!.subQuestions[0].question, 'q1')
  })

  test('accepts bare strings as sub-questions', () => {
    const plan = parsePlan({ subQuestions: ['how fast is it'] }, fallback)
    assert.deepEqual(plan!.subQuestions[0], {
      question: 'how fast is it',
      queries: ['how fast is it']
    })
  })

  test('accepts a single query string instead of an array', () => {
    const plan = parsePlan({ subQuestions: [{ question: 'q', queries: 'just one' }] }, fallback)
    assert.deepEqual(plan!.subQuestions[0].queries, ['just one'])
  })

  test('accepts alternate key spellings a model might emit', () => {
    const plan = parsePlan({ subQuestions: [{ q: 'q1', searches: ['s1'] }] }, fallback)
    assert.equal(plan!.subQuestions[0].question, 'q1')
    assert.deepEqual(plan!.subQuestions[0].queries, ['s1'])
  })

  test('a sub-question with no queries is searched by its own text', () => {
    const plan = parsePlan({ subQuestions: [{ question: 'lone question' }] }, fallback)
    assert.deepEqual(plan!.subQuestions[0].queries, ['lone question'])
  })

  test('caps sub-questions and queries per sub-question', () => {
    const plan = parsePlan(
      {
        subQuestions: Array.from({ length: 20 }, (_, i) => ({
          question: `q${i}`,
          queries: ['a', 'b', 'c', 'd', 'e']
        }))
      },
      fallback
    )
    assert.ok(plan!.subQuestions.length <= 5)
    assert.ok(plan!.subQuestions.every((s) => s.queries.length <= 2))
  })

  test('falls back to the original question when the model produced nothing usable', () => {
    for (const garbage of [null, {}, { subQuestions: [] }, 'nope', { subQuestions: [{}] }]) {
      const plan = parsePlan(garbage, fallback)
      assert.deepEqual(plan!.subQuestions, [{ question: fallback, queries: [fallback] }])
    }
  })

  test('returns null only when there is no fallback either', () => {
    assert.equal(parsePlan(null, '   '), null)
  })

  test('drops empty entries rather than emitting blank queries', () => {
    const plan = parsePlan(
      { subQuestions: [{ question: 'good', queries: ['a'] }, { question: '', queries: [] }, ''] },
      fallback
    )
    assert.equal(plan!.subQuestions.length, 1)
  })
})

describe('budgetFor / BudgetTracker', () => {
  test('depth presets increase monotonically', () => {
    const quick = budgetFor('quick')
    const standard = budgetFor('standard')
    const thorough = budgetFor('thorough')
    assert.ok(quick.maxFetches < standard.maxFetches)
    assert.ok(standard.maxFetches < thorough.maxFetches)
    assert.ok(quick.maxHosts < standard.maxHosts)
    assert.ok(standard.maxHosts < thorough.maxHosts)
  })

  test('an unknown depth falls back to standard', () => {
    assert.deepEqual(
      budgetFor('nonsense' as 'standard'),
      budgetFor('standard')
    )
  })

  test('search limit stops further searches and is recorded', () => {
    const tracker = new BudgetTracker({
      maxRounds: 2, maxSearches: 2, maxFetches: 9, maxHosts: 9, maxWallClockMs: 60_000, synthesisReserveMs: 0
    })
    assert.equal(tracker.canSearch(), true)
    tracker.recordSearch()
    tracker.recordSearch()
    assert.equal(tracker.canSearch(), false)
    assert.deepEqual(tracker.ledger().limitsHit, ['search limit'])
  })

  test('fetch limit stops further fetches', () => {
    const tracker = new BudgetTracker({
      maxRounds: 2, maxSearches: 9, maxFetches: 1, maxHosts: 9, maxWallClockMs: 60_000, synthesisReserveMs: 0
    })
    tracker.recordFetch('a.com')
    assert.equal(tracker.canFetch('b.com'), false)
    assert.ok(tracker.ledger().limitsHit.includes('fetch limit'))
  })

  test('the distinct-host cap blocks a new host but still allows a known one', () => {
    // The privacy-relevant limit: more pages from a site already contacted
    // discloses less than the first page from a new one.
    const tracker = new BudgetTracker({
      maxRounds: 2, maxSearches: 9, maxFetches: 9, maxHosts: 2, maxWallClockMs: 60_000, synthesisReserveMs: 0
    })
    tracker.recordFetch('a.com')
    tracker.recordFetch('b.com')
    assert.equal(tracker.canFetch('c.com'), false)
    assert.equal(tracker.canFetch('a.com'), true)
    assert.ok(tracker.ledger().limitsHit.includes('distinct-host limit'))
  })

  test('round limit stops further rounds', () => {
    const tracker = new BudgetTracker({
      maxRounds: 1, maxSearches: 9, maxFetches: 9, maxHosts: 9, maxWallClockMs: 60_000, synthesisReserveMs: 0
    })
    assert.equal(tracker.canStartRound(), true)
    tracker.rounds = 1
    assert.equal(tracker.canStartRound(), false)
  })

  test('retrieval stops early to leave synthesis its reserve', () => {
    // The measured v1.3 failure: retrieval spent 183s, then synthesis was
    // handed a deadline it could not meet and the whole run returned nothing.
    // Retrieval's deadline is now the wall clock minus the reserve.
    const tracker = new BudgetTracker({
      maxRounds: 9, maxSearches: 9, maxFetches: 9, maxHosts: 9,
      maxWallClockMs: 1000, synthesisReserveMs: 1000
    })
    // Reserve equals the whole budget, so retrieval has none: expired at once.
    assert.equal(tracker.expired, true)
    assert.equal(tracker.canSearch(), false)
  })

  test('synthesis is never given less than its reserve', () => {
    const tracker = new BudgetTracker({
      maxRounds: 9, maxSearches: 9, maxFetches: 9, maxHosts: 9,
      maxWallClockMs: 150_000, synthesisReserveMs: 45_000
    })
    assert.ok(tracker.synthesisBudgetMs >= 45_000)
    assert.ok(tracker.synthesisBudgetMs <= 150_000)
  })

  test('every shipped depth reserves time for the write-up', () => {
    for (const depth of ['quick', 'standard', 'thorough'] as const) {
      const budget = budgetFor(depth)
      assert.ok(
        budget.synthesisReserveMs > 0 && budget.synthesisReserveMs < budget.maxWallClockMs,
        `${depth} must reserve a slice of its wall clock, not all or none of it`
      )
    }
  })

  test('an expired wall clock blocks every phase', () => {
    const tracker = new BudgetTracker({
      maxRounds: 9, maxSearches: 9, maxFetches: 9, maxHosts: 9, maxWallClockMs: -1, synthesisReserveMs: 0
    })
    assert.equal(tracker.canSearch(), false)
    assert.equal(tracker.canFetch('a.com'), false)
    assert.equal(tracker.canStartRound(), false)
    assert.deepEqual(tracker.ledger().limitsHit, ['time limit'])
  })

  test('the ledger reports hosts and does not duplicate a limit', () => {
    const tracker = new BudgetTracker({
      maxRounds: 2, maxSearches: 1, maxFetches: 9, maxHosts: 9, maxWallClockMs: 60_000, synthesisReserveMs: 0
    })
    tracker.recordSearch()
    tracker.canSearch()
    tracker.canSearch()
    tracker.recordFetch('a.com')
    tracker.recordFetch('a.com')
    const ledger = tracker.ledger()
    assert.deepEqual(ledger.hosts, ['a.com'])
    assert.equal(ledger.fetches, 2)
    assert.deepEqual(ledger.limitsHit, ['search limit'])
  })
})

describe('searchPacing', () => {
  test('a self-hosted SearXNG may be queried in parallel', () => {
    assert.ok(searchPacing('searxng').concurrency > 1)
    assert.equal(searchPacing('searxng').spacingMs, 0)
  })

  test('Brave and DuckDuckGo are serialized and spaced', () => {
    // Fanning out on these produces blocks and 429s, not results.
    for (const provider of ['brave', 'duckduckgo']) {
      assert.equal(searchPacing(provider).concurrency, 1)
      assert.ok(searchPacing(provider).spacingMs > 0)
    }
  })
})

describe('selectSources', () => {
  const candidate = (url: string, sub = 0): CandidateSource => ({
    url,
    title: url,
    snippet: 'snippet',
    subQuestion: sub
  })

  test('orders by relevance', () => {
    const candidates = [candidate('https://a.com/1'), candidate('https://b.com/1')]
    const relevance = new Map([
      ['https://a.com/1', 0.1],
      ['https://b.com/1', 0.9]
    ])
    assert.equal(selectSources(candidates, relevance, 2)[0].url, 'https://b.com/1')
  })

  test('deduplicates URLs differing only by fragment or trailing slash', () => {
    const candidates = [
      candidate('https://a.com/x'),
      candidate('https://a.com/x#frag'),
      candidate('https://a.com/x')
    ]
    assert.equal(selectSources(candidates, new Map(), 5).length, 1)
  })

  test('caps sources per domain so one site cannot fill the read list', () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, i) => candidate(`https://prolific.com/${i}`)),
      candidate('https://other.com/1'),
      candidate('https://third.com/1')
    ]
    const chosen = selectSources(candidates, new Map(), 4)
    const fromProlific = chosen.filter((c) => c.url.includes('prolific.com')).length
    assert.ok(fromProlific <= 2, `got ${fromProlific}`)
    assert.ok(chosen.some((c) => c.url.includes('other.com')))
  })

  test('relaxes the domain cap rather than under-reading', () => {
    // If only one domain has results, better to read four of its pages than one.
    const candidates = Array.from({ length: 6 }, (_, i) => candidate(`https://only.com/${i}`))
    assert.equal(selectSources(candidates, new Map(), 4).length, 4)
  })

  test('never exceeds the limit', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => candidate(`https://s${i}.com/x`))
    assert.equal(selectSources(candidates, new Map(), 3).length, 3)
  })

  test('a zero limit selects nothing', () => {
    assert.equal(selectSources([candidate('https://a.com/1')], new Map(), 0).length, 0)
  })

  test('skips unparseable URLs', () => {
    assert.equal(selectSources([candidate('not a url')], new Map(), 5).length, 0)
  })
})

describe('assessCoverage', () => {
  const sub = (question: string): SubQuestion => ({ question, queries: [question] })
  const source = (
    subQuestion: number,
    passages: { text: string; score: number }[]
  ): ReadSource => ({
    index: 1, url: 'https://a.com', title: 't', subQuestion, passages, via: 'static'
  })

  test('a sub-question with substantial high-scoring text is covered', () => {
    const coverage = assessCoverage(
      [sub('q1')],
      [source(0, [{ text: 'x'.repeat(300), score: 0.9 }])]
    )
    assert.equal(coverage[0].covered, true)
  })

  test('a sub-question with no sources is not covered', () => {
    assert.equal(assessCoverage([sub('q1')], [])[0].covered, false)
  })

  test('weak passages do not count as evidence', () => {
    // The ranker always returns its best candidates; a low score means it had
    // nothing good, so counting those would mark everything covered.
    const coverage = assessCoverage(
      [sub('q1')],
      [source(0, [{ text: 'x'.repeat(400), score: 0.05 }])]
    )
    assert.equal(coverage[0].covered, false)
  })

  test('a snippet of strong text is still too little', () => {
    const coverage = assessCoverage([sub('q1')], [source(0, [{ text: 'short', score: 0.99 }])])
    assert.equal(coverage[0].covered, false)
  })

  test('coverage is attributed per sub-question, not pooled', () => {
    const coverage = assessCoverage(
      [sub('q1'), sub('q2')],
      [source(0, [{ text: 'x'.repeat(300), score: 0.9 }])]
    )
    assert.equal(coverage[0].covered, true)
    assert.equal(coverage[1].covered, false)
  })
})

// ---- full orchestrator runs -------------------------------------------------

/** Search results page with N hits across distinct domains. */
function searchHtmlFor(hosts: string[]): string {
  return hosts
    .map(
      (host, i) =>
        `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(
          `https://${host}/page`
        )}">Result ${i} about retry timeout cache</a>` +
        `<a class="result__snippet">Discussion of retry timeout and cache invalidation defaults.</a></div>`
    )
    .join('')
}

const ARTICLE = (host: string): string =>
  `<html><head><title>${host} article</title></head><body><article>` +
  `<p>${'The retry timeout default is thirty seconds on this system. '.repeat(8)}</p>` +
  `<p>${'Cache invalidation uses a write-through policy throughout. '.repeat(8)}</p>` +
  '</article></body></html>'

const PLAN_JSON = JSON.stringify({
  subQuestions: [
    { question: 'What is the retry timeout default?', queries: ['retry timeout default'] },
    { question: 'How does cache invalidation work?', queries: ['cache invalidation policy'] }
  ]
})

/**
 * Full happy-path fixture. Each planned query routes to its own pair of hosts,
 * the way a real search provider would answer different queries with different
 * results. Without that, both sub-questions compete for the same URLs and the
 * per-URL dedupe in selectSources hands every source to one sub-question, so
 * coverage can never pass in round one.
 */
function fullFixture(): void {
  const retryHosts = ['alpha.example', 'beta.example']
  const cacheHosts = ['gamma.example', 'delta.example']
  state.searchHtml = searchHtmlFor(['alpha.example', 'beta.example', 'gamma.example'])
  state.searchRoutes = [
    { match: 'retry', html: searchHtmlFor(retryHosts) },
    { match: 'invalidation', html: searchHtmlFor(cacheHosts) }
  ]
  state.responses = [...retryHosts, ...cacheHosts].map((h) => ({
    match: h,
    contentType: 'text/html',
    body: ARTICLE(h)
  }))
  state.completions = [PLAN_JSON, 'The retry timeout defaults to thirty seconds [1].']
}

describe('runDeepResearch', () => {
  beforeEach(() => {
    fullFixture()
  })

  test('returns a brief with sources and a ledger', async () => {
    const outcome = await runDeepResearch({ question: 'How do retries work?', modelId: 'fake-chat' })
    assert.equal(outcome.ok, true, outcome.error)
    assert.match(outcome.brief!, /thirty seconds/)
    assert.ok(outcome.sources!.length > 0)
    assert.ok(outcome.ledger!.searches > 0)
    assert.ok(outcome.ledger!.fetches > 0)
    assert.ok(outcome.ledger!.hosts.length > 0)
  })

  test('uses the plan the model produced', async () => {
    const outcome = await runDeepResearch({ question: 'How do retries work?', modelId: 'fake-chat' })
    assert.equal(outcome.planned, true)
    assert.equal(outcome.plan!.subQuestions.length, 2)
  })

  test('sources are numbered so citations resolve', async () => {
    const outcome = await runDeepResearch({ question: 'How do retries work?', modelId: 'fake-chat' })
    outcome.sources!.forEach((s, i) => assert.equal(s.index, i + 1))
  })

  test('the synthesizer is given the sources and the question', async () => {
    await runDeepResearch({ question: 'How do retries work?', modelId: 'fake-chat' })
    const synthPrompt = state.completionPrompts.at(-1)!
    assert.match(synthPrompt, /How do retries work\?/)
    assert.match(synthPrompt, /alpha\.example/)
    // The synthesizer must be told the evidence is untrusted.
    assert.match(synthPrompt, /untrusted/i)
  })

  test('the question itself is never sent to the search provider', async () => {
    const question = 'How do retries work in my private codebase?'
    await runDeepResearch({ question, modelId: 'fake-chat' })
    // Only planner-produced keyword queries go out.
    assert.ok(outgoingQueries().length > 0)
    assert.ok(!outgoingQueries().some((q) => q.includes('private codebase')))
  })

  test('respects the quick depth budget', async () => {
    const outcome = await runDeepResearch({
      question: 'How do retries work?',
      modelId: 'fake-chat',
      depth: 'quick'
    })
    const budget = budgetFor('quick')
    assert.ok(outcome.ledger!.searches <= budget.maxSearches)
    assert.ok(outcome.ledger!.fetches <= budget.maxFetches)
    assert.ok(outcome.ledger!.hosts.length <= budget.maxHosts)
  })

  test('reports progress for each phase', async () => {
    const phases: string[] = []
    await runDeepResearch({
      question: 'How do retries work?',
      modelId: 'fake-chat',
      onProgress: (phase) => phases.push(phase)
    })
    for (const expected of ['planning', 'searching', 'selecting', 'reading', 'synthesizing']) {
      assert.ok(phases.includes(expected), `missing ${expected}: ${phases.join(',')}`)
    }
  })

  test('declining the plan sends nothing at all', async () => {
    const outcome = await runDeepResearch({
      question: 'How do retries work?',
      modelId: 'fake-chat',
      approvePlan: async () => false
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error!, /declined/i)
    assert.equal(state.fetchLog.filter((f) => f.purpose === 'search').length, 0)
    assert.equal(state.fetchLog.filter((f) => f.purpose === 'webpage').length, 0)
  })

  test('the approval callback receives every query before any egress', async () => {
    let seen: string[] = []
    await runDeepResearch({
      question: 'How do retries work?',
      modelId: 'fake-chat',
      approvePlan: async (_plan, queries) => {
        seen = queries
        // Nothing may have been sent yet at this point.
        assert.equal(state.fetchLog.filter((f) => f.purpose === 'search').length, 0)
        return true
      }
    })
    assert.deepEqual(seen, ['retry timeout default', 'cache invalidation policy'])
  })

  test('falls back to researching the question as given when planning fails', async () => {
    state.completions = ['I am not able to produce JSON.', 'A brief from one source [1].']
    const outcome = await runDeepResearch({
      question: 'How do retries work?',
      modelId: 'fake-chat'
    })
    assert.equal(outcome.ok, true, outcome.error)
    assert.equal(outcome.planned, false)
    assert.equal(outcome.plan!.subQuestions.length, 1)
  })

  test('surviving a completely failed planner still produces research', async () => {
    state.failCompletions = true
    const outcome = await runDeepResearch({ question: 'q', modelId: 'fake-chat' })
    // Every model call fails: planning falls back to the bare question, and
    // synthesis cannot run. The retrieval half still worked, so v1.3 returns
    // what it found and says plainly that nothing was written from it — the
    // model is explicitly told not to summarize the sources from memory.
    assert.equal(outcome.ok, true)
    assert.equal(outcome.planned, false)
    assert.equal(outcome.synthesized, false)
    assert.ok((outcome.sources ?? []).length > 0, 'retrieval succeeded and must be kept')
    assert.match(outcome.synthesisNote!, /could not write the brief/i)
  })

  test('fails clearly when no source yields text', async () => {
    state.responses = ['alpha.example', 'beta.example', 'gamma.example', 'delta.example'].map((h) => ({
      match: h,
      contentType: 'text/html',
      body: '<html><body></body></html>'
    }))
    const outcome = await runDeepResearch({ question: 'q', modelId: 'fake-chat' })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error!, /No usable sources/i)
    assert.ok(outcome.ledger)
  })

  test('fails clearly when search returns nothing', async () => {
    state.searchHtml = '<html></html>'
    state.searchRoutes = []
    const outcome = await runDeepResearch({ question: 'q', modelId: 'fake-chat' })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error!, /No usable sources/i)
  })

  test('an empty question is refused without any model call', async () => {
    const outcome = await runDeepResearch({ question: '   ', modelId: 'fake-chat' })
    assert.equal(outcome.ok, false)
    assert.equal(state.completionPrompts.length, 0)
  })

  test('an empty brief keeps the sources instead of discarding the run', async () => {
    // Changed in v1.3. Through v1.3 this returned ok:false and threw away
    // every page the run had fetched and ranked — measured at 183 seconds of
    // retrieval discarded because the write-up failed. Retrieval succeeding
    // and synthesis failing are different outcomes, and the second one still
    // leaves the user with cited sources.
    state.completions = [PLAN_JSON, '   ']
    const outcome = await runDeepResearch({ question: 'q', modelId: 'fake-chat' })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.synthesized, false)
    assert.ok((outcome.sources ?? []).length > 0, 'the sources must survive')
    assert.match(outcome.synthesisNote!, /nothing was synthesized/i)
  })

  test('a successful run is marked as actually synthesized', async () => {
    const outcome = await runDeepResearch({ question: 'How do retries work?', modelId: 'fake-chat' })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.synthesized, true)
    assert.equal(outcome.synthesisNote, undefined)
  })

  test('cancellation stops the run', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await runDeepResearch({
      question: 'How do retries work?',
      modelId: 'fake-chat',
      signal: controller.signal
    })
    assert.equal(outcome.ok, false)
  })

  test('does not re-read a URL it already read', async () => {
    await runDeepResearch({ question: 'How do retries work?', modelId: 'fake-chat' })
    const pageFetches = state.fetchLog.filter((f) => f.purpose === 'webpage').map((f) => f.url)
    assert.equal(new Set(pageFetches).size, pageFetches.length)
  })

  test('works with no embedding model — selection degrades to keyword scoring', async () => {
    state.failEmbeddings = true
    const outcome = await runDeepResearch({
      question: 'retry timeout cache',
      modelId: 'fake-chat'
    })
    assert.equal(outcome.ok, true, outcome.error)
    assert.ok(outcome.sources!.length > 0)
  })

  test('reports redactions when a query had to be sanitized', async () => {
    state.completions = [
      JSON.stringify({
        subQuestions: [
          { question: 'creds', queries: ['error in /Users/someone/Documents/secret.txt'] }
        ]
      }),
      'A brief [1].'
    ]
    const outcome = await runDeepResearch({ question: 'q', modelId: 'fake-chat' })
    assert.ok(outcome.redactions!.length > 0)
    assert.ok(!outgoingQueries().some((q) => q.includes('secret.txt')))
  })
})

/** Queries actually put on the wire, decoded from the stubbed search URLs. */
function outgoingQueries(): string[] {
  return state.fetchLog
    .filter((f) => f.purpose === 'search')
    .map((f) => {
      try {
        return decodeURIComponent(new URL(f.url).searchParams.get('q') ?? '')
      } catch {
        return ''
      }
    })
}

// ---- structured planning + adaptive rounds ------------------------------------

describe('structured planning and adaptive rounds', () => {
  beforeEach(() => {
    fullFixture()
  })

  test('the planner request is grammar-constrained with the plan schema', async () => {
    await runDeepResearch({ question: 'How do retries work?', modelId: 'fake-chat' })
    const plannerBody = state.completionBodies[0]!
    const format = plannerBody.response_format as {
      type?: string
      json_schema?: { name?: string; strict?: boolean; schema?: { required?: string[] } }
    }
    assert.equal(format.type, 'json_schema')
    assert.equal(format.json_schema?.name, 'research_plan')
    assert.equal(format.json_schema?.strict, true)
    assert.deepEqual(format.json_schema?.schema?.required, ['subQuestions'])
  })

  test('the synthesizer request is free-form, not schema-constrained', async () => {
    await runDeepResearch({ question: 'How do retries work?', modelId: 'fake-chat' })
    const synthBody = state.completionBodies.at(-1)!
    const format = synthBody.response_format as { type?: string } | undefined
    assert.notEqual(format?.type, 'json_schema')
  })

  test('a server that rejects json_schema gets a plain retry and research still plans', async () => {
    state.completionOnce400 = true
    const outcome = await runDeepResearch({ question: 'How do retries work?', modelId: 'fake-chat' })
    assert.equal(outcome.ok, true, outcome.error)
    assert.equal(outcome.planned, true)
    // The retry went out without the schema constraint.
    const retryBody = state.completionBodies[0]!
    const format = retryBody.response_format as { type?: string } | undefined
    assert.equal(format?.type, 'json_object')
  })

  test('uncovered sub-questions are attacked with reformulated queries in later rounds', async () => {
    // Every page read fails, so coverage never passes and the run adapts until
    // the round ceiling stops it.
    state.responses = []
    state.completions = [
      PLAN_JSON,
      JSON.stringify({
        queries: [
          { queries: ['retry backoff strategy'] },
          { queries: ['cache eviction policy'] }
        ]
      })
    ]
    const outcome = await runDeepResearch({
      question: 'How do retries work?',
      modelId: 'fake-chat'
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error!, /No usable sources/i)
    // Standard depth now allows three coverage-driven rounds, and all three ran.
    assert.equal(outcome.ledger!.rounds, 3)
    // Round two searched the reformulated angle, not just the failed query again.
    assert.ok(outgoingQueries().includes('retry backoff strategy'))
    assert.ok(outgoingQueries().includes('cache eviction policy'))
  })

  test('reformulateQueries falls back to the original queries when the model is useless', async () => {
    state.completions = ['not json at all']
    const queries = await research.reformulateQueries(
      [
        { question: 'q1', queries: ['original one'] },
        { question: 'q2', queries: ['original two'] }
      ],
      'fake-chat'
    )
    assert.deepEqual(queries, [['original one'], ['original two']])
  })

  test('reformulateQueries maps by order and caps queries per sub-question', async () => {
    state.completions = [
      JSON.stringify({
        queries: [
          { queries: ['new a', 'new b', 'new c'] },
          { queries: [] }
        ]
      })
    ]
    const queries = await research.reformulateQueries(
      [
        { question: 'q1', queries: ['old one'] },
        { question: 'q2', queries: ['old two'] }
      ],
      'fake-chat'
    )
    // Capped at MAX_QUERIES_PER_SUB, and an empty set falls back per sub-question.
    assert.deepEqual(queries, [['new a', 'new b'], ['old two']])
  })
})
