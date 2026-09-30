import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIVE_READ_TIMEOUT_MS,
  MAX_PAGE_CONTEXT_CHARS,
  SNIPPETS_ONLY_NOTE,
  buildPageReadContext,
  pagesToRead,
  planAppSearch,
  recencyFor,
  rewriteQuery
} from '../src/renderer/src/lib/appSearch'
import { autoSearchProvider } from '../src/renderer/src/lib/contextProviders/autoSearch'
import type { ProviderIO, TurnInput } from '../src/renderer/src/lib/contextProviders'
import type { ToolSchema } from '../src/renderer/src/types'

/**
 * v4.1 (G2b–d): the app's own search. The phrasings are the 4.0.1 session's
 * ("righmond" misspelling included) and its neighbours. Wednesday 2026-09-30.
 */
const NOW = new Date(2026, 8, 30, 9, 0, 0)

describe('rewriteQuery · the question as search terms', () => {
  const cases: [string, string][] = [
    ['can you check the weather for righmond va today?', 'the weather for righmond va today September 30 2026'],
    ['how are s&p futures looking for today', 'how are s&p futures looking for today September 30 2026'],
    ['when is the next miami heat basketball game?', 'when is the next miami heat basketball game 2026'],
    ['who won the heat game last night?', 'who won the heat game last night September 29 2026'],
    ['what is the standard deduction this year?', 'what is the standard deduction 2026'],
    ['what is the current standard deduction', 'what is the current standard deduction 2026'],
    ['hey, could you please tell me who directed Heat (1995)?', 'who directed Heat (1995)'],
    ['what is the capital of France?', 'what is the capital of France']
  ]
  for (const [input, expected] of cases) {
    test(`"${input.slice(0, 44)}"`, () => assert.equal(rewriteQuery(input, NOW), expected))
  }

  test('a question already dated is not dated again', () => {
    assert.equal(rewriteQuery('standard deduction for 2025', NOW), 'standard deduction for 2025')
    assert.equal(rewriteQuery('who won the 2024 world series', NOW), 'who won the 2024 world series')
  })

  test('nothing but framing falls back to the sentence rather than sending nothing', () => {
    assert.equal(rewriteQuery('can you check?', NOW), 'can you check?')
  })
})

describe('planAppSearch', () => {
  test('one question, one query', () => {
    assert.deepEqual(planAppSearch('what is the capital of France?', undefined, NOW).queries, ['what is the capital of France'])
  })

  test('two questions in one message are searched apart, three at most', () => {
    const plan = planAppSearch(
      'when do the heat play next? what channel is the game on? who is injured? what about tickets?',
      undefined,
      NOW
    )
    assert.equal(plan.queries.length, 3)
    assert.match(plan.queries[0], /^when do the heat play next/)
    assert.match(plan.queries[1], /^what channel is the game on/)
  })

  test('a follow-up keeps its anchor', () => {
    const plan = planAppSearch('and the price?', 'Bugaboo Fox 5 stroller review', NOW)
    assert.match(plan.queries[0], /Bugaboo Fox 5 stroller review/)
  })
})

describe('recencyFor', () => {
  test('today\'s markets and last night\'s scores ask for the past day', () => {
    assert.equal(recencyFor('how are s&p futures looking for today'), 'day')
    assert.equal(recencyFor('who won the heat game last night?'), 'day')
    assert.equal(recencyFor('any breaking news today on the fed'), 'day')
  })

  test('this week and latest news ask for the past week', () => {
    assert.equal(recencyFor('what are the headlines this week'), 'week')
    assert.equal(recencyFor('latest news on the port strike'), 'week')
  })

  test('weather never filters — a forecast page carries no date', () => {
    assert.equal(recencyFor('weather for richmond va today'), undefined)
  })

  test('a schedule, a fact and a product are not filtered', () => {
    assert.equal(recencyFor('when is the next miami heat game'), undefined)
    assert.equal(recencyFor('what is the capital of France?'), undefined)
    assert.equal(recencyFor('latest iphone model'), undefined)
  })
})

describe('pagesToRead and the page context', () => {
  const results =
    '[1] Richmond, VA Weather - YouTube\n   https://www.youtube.com/watch?v=x\n   video\n\n' +
    '[2] Richmond, VA 10-Day Forecast\n   https://weather.example/richmond\n   Sunny, high 74.\n\n' +
    '[3] NWS Richmond\n   https://forecast.example/rva\n   Forecast.\n\n' +
    '[4] Other\n   https://third.example/x\n   x'

  test('the top readable pages, in rank order, two at most', () => {
    assert.deepEqual(pagesToRead([results]), ['https://weather.example/richmond', 'https://forecast.example/rva'])
  })

  test('each page keeps its number and loses its link list; the size is bounded', () => {
    const page =
      '[untrusted]\n\n[2] Page: Richmond forecast\nURL: https://weather.example/richmond\n\n' +
      '--- passage 1 ---\n' + 'Sunny. '.repeat(600) +
      '\n\nOutbound links on this page (use fetch_webpage to follow one):\n- a → https://a.example'
    const block = buildPageReadContext([page])
    assert.doesNotMatch(block, /Outbound links/)
    assert.match(block, /\(Cite this page as \[2\]\.\)/)
    assert.ok(block.length < MAX_PAGE_CONTEXT_CHARS + 600)
  })
})

function schemas(...names: string[]): ToolSchema[] {
  return names.map((name) => ({ type: 'function' as const, function: { name, description: '', parameters: {} } }))
}

function input(text: string, tools = schemas('web_search', 'fetch_webpage')): TurnInput {
  return {
    convo: { id: 'c1', messages: [] },
    conversations: [],
    slot: { modelId: 'm', roleName: 'Assistant' },
    slotTools: tools,
    lastUserContent: text,
    previousUserContent: undefined,
    offline: false,
    factualTurn: true,
    referenceTurn: false,
    shoppingTurn: false,
    project: null,
    assistantMsgId: 'a1',
    signal: new AbortController().signal
  } as unknown as TurnInput
}

interface Run {
  name: string
  args: Record<string, unknown>
  options?: { charge?: boolean }
}

function io(pages: 'ok' | 'fail'): { io: ProviderIO; runs: Run[] } {
  const runs: Run[] = []
  const stub = {
    async runTool(name: string, args: Record<string, unknown>, options?: { charge?: boolean }) {
      runs.push({ name, args, ...(options ? { options } : {}) })
      if (name === 'web_search') {
        return { ok: true, output: '[1] Forecast\n   https://weather.example/rva\n   Sunny.\n\n[2] NWS\n   https://nws.example/rva\n   Clear.' }
      }
      return pages === 'ok'
        ? { ok: true, output: `[untrusted]\n\n[1] Page: Forecast\nURL: ${String(args.url)}\n\nHigh of 74°F today.` }
        : { ok: false, error: 'Timed out after 6s.' }
    },
    recordSyntheticCall() {},
    api: {},
    patch() {},
    settings: () => null
  }
  return { io: stub as unknown as ProviderIO, runs }
}

describe('autoSearch provider · live questions', () => {
  test('a live question reads the top two pages, bounded and uncharged, and hands over their text', async () => {
    const { io: stub, runs } = io('ok')
    const result = await autoSearchProvider.gather(input('what is the weather for richmond va today'), stub)
    const reads = runs.filter((r) => r.name === 'fetch_webpage')
    assert.deepEqual(reads.map((r) => r.args.url), ['https://weather.example/rva', 'https://nws.example/rva'])
    for (const r of reads) {
      assert.equal(r.args.timeout_ms, LIVE_READ_TIMEOUT_MS)
      assert.deepEqual(r.options, { charge: false })
    }
    assert.match(result!.blocks!.at(-1)!, /^Pages the app read/)
    assert.match(result!.blocks!.at(-1)!, /High of 74°F today/)
  })

  test('the search itself carries the recency filter when the question is about now', async () => {
    const { io: stub, runs } = io('ok')
    await autoSearchProvider.gather(input('how are s&p futures looking for today'), stub)
    assert.equal(runs[0].args.recency, 'day')
  })

  test('no page read — the model is told it holds snippets, not sources', async () => {
    const { io: stub } = io('fail')
    const result = await autoSearchProvider.gather(input('what is the weather for richmond va today'), stub)
    assert.equal(result!.blocks!.at(-1), SNIPPETS_ONLY_NOTE)
  })

  test('without fetch_webpage on the slot nothing is read', async () => {
    const { io: stub, runs } = io('ok')
    const result = await autoSearchProvider.gather(input('weather for richmond today', schemas('web_search')), stub)
    assert.equal(runs.filter((r) => r.name === 'fetch_webpage').length, 0)
    assert.equal(result!.blocks!.at(-1), SNIPPETS_ONLY_NOTE)
  })

  test('a question that is not live reads nothing and adds no note', async () => {
    const { io: stub, runs } = io('ok')
    const result = await autoSearchProvider.gather(input('who directed the film Heat?'), stub)
    assert.equal(runs.filter((r) => r.name === 'fetch_webpage').length, 0)
    assert.equal(result!.blocks!.length, 1)
  })
})
