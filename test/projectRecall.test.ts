import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, resetState } from './harness'
import type { StoredConversationLike } from '../src/main/ipc/projectRecall'

/**
 * v1.10 project-wide recall: a chat recalls what its project's other chats
 * established. These pin the transcript shape (no markers, summary first),
 * the re-index-on-change rule, that a missing/ephemeral chat is simply not
 * consulted, and that the best passages across chats come back with their
 * chat titles as citations.
 */

const recall = load<typeof import('../src/main/ipc/projectRecall')>('projectRecall')
const research = load<typeof import('../src/main/ipc/researchIndex')>('researchIndex')

function convo(
  id: string,
  title: string,
  turns: Array<[string, string]>,
  extra: Partial<StoredConversationLike> = {}
): StoredConversationLike {
  return {
    id,
    title,
    updatedAt: 1,
    messages: turns.flatMap(([q, a]) => [
      { role: 'user' as const, content: q },
      { role: 'assistant' as const, content: a, roleName: 'Professor' }
    ]),
    ...extra
  }
}

beforeEach(() => {
  resetState()
  research.clearResearchIndex()
  recall.resetProjectRecallCache()
})

describe('conversationTranscript', () => {
  test('renders user/assistant turns, skips markers, leads with the summary', () => {
    const c = convo('a', 'A', [['What is the retry timeout?', 'Thirty seconds.']], {
      summary: { text: 'Earlier we set up the gateway.' }
    })
    c.messages.push({ role: 'assistant', content: '⏪ rolled back', marker: 'rollback' })
    const t = recall.conversationTranscript(c)
    assert.match(t, /^Summary of earlier discussion:\nEarlier we set up the gateway\./)
    assert.match(t, /User: What is the retry timeout\?/)
    assert.match(t, /Assistant \(Professor\): Thirty seconds\./)
    assert.doesNotMatch(t, /rolled back/)
  })

  test('a very long message is cut, not dropped', () => {
    const c = convo('a', 'A', [['q', 'x'.repeat(10_000)]])
    const t = recall.conversationTranscript(c)
    assert.ok(t.length < 5_000)
    assert.match(t, /…$/)
  })
})

describe('recallFromConversations', () => {
  const filler = 'We talked about the weather and the schedule and nothing in particular happened. '
  const docs: Record<string, StoredConversationLike> = {
    tariffs: convo('tariffs', 'Tariff impact on margins', [
      ['How do the new tariffs hit us?', filler.repeat(20) + 'The Section 301 tariff adds 25% to landed cost on the Shenzhen SKUs, which drops gross margin from 41% to 33%.' + filler.repeat(20)]
    ]),
    pricing: convo('pricing', 'Competitor pricing scan', [
      ['What did the scan find?', filler.repeat(20) + 'Acme cut their list price by 8% in July; Globex held steady.' + filler.repeat(20)]
    ]),
    empty: convo('empty', 'Nothing here', [])
  }
  const loader = async (id: string): Promise<StoredConversationLike | null> => docs[id] ?? null

  test('returns the relevant passage with its chat title as the citation', async () => {
    const out = await recall.recallFromConversations(loader, ['tariffs', 'pricing'], 'what did tariffs do to gross margin', 2)
    assert.equal(out.ok, true)
    assert.equal(out.consulted, 2)
    assert.ok(out.items.length >= 1)
    // Items come back grouped by chat in reading order (not by score), and
    // each chat's scores are normalized within that chat, so check membership.
    const hit = out.items.find((i) => /gross margin from 41% to 33%/.test(i.text))
    assert.ok(hit, 'the tariff passage is recalled')
    assert.equal(hit!.title, 'Tariff impact on margins')
    assert.equal(hit!.conversationId, 'tariffs')
  })

  test('missing (deleted or ephemeral) and empty chats are skipped, not errors', async () => {
    const out = await recall.recallFromConversations(loader, ['ghost', 'empty', 'pricing'], 'Acme list price', 3)
    assert.equal(out.ok, true)
    assert.equal(out.consulted, 2) // empty + pricing exist; ghost does not
    assert.ok(out.items.every((i) => i.conversationId === 'pricing'))
  })

  test('a chat with no word in common with the message contributes nothing', async () => {
    const out = await recall.recallFromConversations(loader, ['tariffs', 'pricing'], 'Acme list price July', 4)
    assert.ok(out.items.length >= 1)
    assert.ok(out.items.every((i) => i.conversationId === 'pricing'), JSON.stringify(out.items.map((i) => i.title)))
    const none = await recall.recallFromConversations(loader, ['tariffs', 'pricing'], 'zebra quantum banjo', 4)
    assert.deepEqual(none.items, [])
    assert.equal(none.consulted, 2)
  })

  test('the chat with the stronger lexical evidence contributes first', async () => {
    const out = await recall.recallFromConversations(loader, ['pricing', 'tariffs'], 'Section 301 tariff landed cost Shenzhen margin', 1)
    assert.equal(out.items.length, 1)
    assert.equal(out.items[0]!.conversationId, 'tariffs')
  })

  test('a blank query or no ids is a no-op', async () => {
    assert.deepEqual(await recall.recallFromConversations(loader, [], 'x', 3), { ok: true, items: [], consulted: 0 })
    assert.deepEqual(await recall.recallFromConversations(loader, ['tariffs'], '   ', 3), { ok: true, items: [], consulted: 0 })
  })

  test('re-indexes only when updatedAt moves', async () => {
    const live = convo('live', 'Live chat', [['q', filler.repeat(10) + 'The budget is four thousand dollars.' + filler.repeat(10)]])
    const loadLive = async (): Promise<StoredConversationLike> => live
    let out = await recall.recallFromConversations(loadLive, ['live'], 'what is the budget', 1)
    assert.match(out.items[0]!.text, /four thousand/)

    // Same updatedAt: the index is reused, so new content is not yet visible.
    live.messages.push({ role: 'user', content: 'update' }, { role: 'assistant', content: filler.repeat(10) + 'The budget was raised to nine thousand dollars.' + filler.repeat(10) })
    out = await recall.recallFromConversations(loadLive, ['live'], 'what is the budget', 2)
    assert.ok(!out.items.some((i) => /nine thousand/.test(i.text)))

    live.updatedAt = 2
    out = await recall.recallFromConversations(loadLive, ['live'], 'what is the budget', 2)
    assert.ok(out.items.some((i) => /nine thousand/.test(i.text)))
  })

  test('indexed transcripts are pinned — they outlive fetched-page pressure', async () => {
    await recall.recallFromConversations(loader, ['tariffs'], 'tariffs', 1)
    for (let i = 0; i < 40; i++) {
      research.indexPage({ key: `https://x/${i}`, url: `https://x/${i}`, title: 'p', text: 'page text '.repeat(200), truncated: false })
    }
    assert.ok(research.getIndexedPage('conversation:tariffs'))
  })
})

describe('formatProjectRecall', () => {
  test('cites the chat title per passage', () => {
    const s = recall.formatProjectRecall([
      { conversationId: 'a', title: 'Alpha', text: 'one', position: 0.1, score: 0.9 }
    ])
    assert.match(s, /from the chat "Alpha" · relevance 0\.9/)
    assert.match(s, /\none$/)
  })
})
