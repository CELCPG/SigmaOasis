import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ago, chooseCards, greeting, pickUp, readiness, searchConfigured, type MachineState } from '../src/renderer/src/lib/frontDoor'
import type { AppSettings, Conversation } from '../src/renderer/src/types'

/** v4.0 (track F): what the first screen offers, from what the machine has. */

const settings = (tools: Record<string, boolean>, extra: Partial<AppSettings> = {}): AppSettings =>
  ({
    baseUrl: 'http://127.0.0.1:1234/v1',
    tools: { analyze_file: true, run_python: true, deep_research: true, web_search: true, memory_search: true, reference_lookup: true, shop_compare: false, ...tools },
    search: { provider: 'duckduckgo', searxngUrl: '' },
    models: [{ id: 'a', enabled: true, modelId: 'qwen' }],
    ...extra
  }) as unknown as AppSettings

const machine = (over: Partial<MachineState> = {}): MachineState => ({
  settings: settings({}),
  workbench: true,
  memoryHasAnything: true,
  libraryHasPacks: true,
  ...over
})

describe('chooseCards', () => {
  test('a full machine shows six working cards, enabled ones first, in the table’s order', () => {
    const cards = chooseCards(machine())
    assert.equal(cards.length, 6)
    assert.deepEqual(cards.map((c) => c.id), ['summarize', 'spreadsheet', 'research', 'tidy', 'fix', 'memory'])
    assert.ok(cards.every((c) => c.enabled))
  })

  test('a fresh install sees what it could turn on, each with its setting', () => {
    const cards = chooseCards(machine({ settings: settings({ run_python: false, deep_research: false, memory_search: false, reference_lookup: false }), memoryHasAnything: false, libraryHasPacks: false }))
    const off = cards.filter((c) => !c.enabled)
    assert.ok(off.length >= 3)
    for (const c of off) {
      assert.ok(c.reason, c.id)
      assert.ok(c.link, c.id)
    }
    assert.equal(cards.find((c) => c.id === 'spreadsheet')?.link, 'tools.run_python')
    assert.equal(cards.find((c) => c.id === 'research')?.link, 'tools.deep_research')
  })

  test('a tool that is on but has nothing to work with says so and links to the place, not the switch', () => {
    const cards = chooseCards(machine({ memoryHasAnything: false, libraryHasPacks: false, workbench: false }), 8)
    assert.equal(cards.find((c) => c.id === 'memory')?.reason, 'nothing is remembered yet')
    assert.equal(cards.find((c) => c.id === 'memory')?.link, 'memory.knowledge')
    assert.equal(cards.find((c) => c.id === 'library')?.link, 'library.packs')
    assert.equal(cards.find((c) => c.id === 'spreadsheet')?.reason, 'the Python runtime is not installed')
  })

  test('SearXNG without an address is not a configured provider', () => {
    assert.equal(searchConfigured(settings({}, { search: { provider: 'searxng', searxngUrl: '' } as never })), false)
    assert.equal(searchConfigured(settings({}, { search: { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8888' } as never })), true)
    const cards = chooseCards(machine({ settings: settings({}, { search: { provider: 'searxng', searxngUrl: '' } as never }) }), 8)
    assert.equal(cards.find((c) => c.id === 'research')?.link, 'search.provider')
  })

  test('the agent cards are always offered and start a task', () => {
    const cards = chooseCards(machine({ settings: settings({ run_python: false, deep_research: false }) }))
    for (const id of ['tidy', 'fix']) {
      const c = cards.find((x) => x.id === id)!
      assert.ok(c.enabled && c.agent, id)
    }
  })
})

describe('greeting', () => {
  test('follows the hour', () => {
    assert.equal(greeting(7), 'Good morning')
    assert.equal(greeting(13), 'Good afternoon')
    assert.equal(greeting(19), 'Good evening')
    assert.equal(greeting(2), 'Good evening')
  })
})

describe('pickUp', () => {
  const convo = (id: string, title: string, updatedAt: number, messages = 1, ephemeral = false): Conversation =>
    ({ id, title, updatedAt, messages: Array.from({ length: messages }, () => ({})), ephemeral }) as unknown as Conversation
  const now = 1_000_000_000_000

  test('the two most recent with messages, not this one, not an unsaved one', () => {
    const list = [convo('me', 'New conversation', now, 0), convo('a', 'Older', now - 3600_000), convo('b', 'Newest', now - 60_000), convo('c', 'Oldest', now - 7200_000), convo('e', 'Ephemeral', now - 10_000, 2, true)]
    const p = pickUp(list, 'me', now)
    assert.deepEqual(p.recent.map((c) => c.id), ['b', 'a'])
    assert.equal(p.digest, null)
  })

  test('a digest of the last day is set aside from the recent two', () => {
    const list = [convo('d', '📬 Planning rules', now - 3000_000), convo('a', 'A', now - 60_000), convo('b', 'B', now - 120_000)]
    const p = pickUp(list, null, now)
    assert.equal(p.digest?.id, 'd')
    assert.deepEqual(p.recent.map((c) => c.id), ['a', 'b'])
    assert.equal(pickUp([convo('old', '📬 Old digest', now - 2 * 86_400_000)], null, now).digest, null)
  })
})

describe('ago and readiness', () => {
  test('ago reads as a person would say it', () => {
    const now = 1_000_000_000_000
    assert.equal(ago(now - 30_000, now), 'just now')
    assert.equal(ago(now - 5 * 60_000, now), '5m ago')
    assert.equal(ago(now - 3 * 3600_000, now), '3h ago')
    assert.equal(ago(now - 26 * 3600_000, now), 'yesterday')
    assert.equal(ago(now - 3 * 86_400_000, now), '3 days ago')
  })

  test('readiness names the missing thing', () => {
    assert.deepEqual(readiness('offline', settings({})), { kind: 'offline', baseUrl: 'http://127.0.0.1:1234/v1' })
    assert.deepEqual(readiness('online', settings({}, { models: [] })), { kind: 'no-role' })
    assert.deepEqual(readiness('online', settings({})), { kind: 'ready' })
  })
})
