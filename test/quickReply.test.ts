import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isSmallTalk, quickReplyFor } from '../src/renderer/src/lib/quickReply'
import { runAgentLoop, type ApiMessage, type ApiToolCall, type StreamRoundResult } from '../src/renderer/src/lib/agentLoop'
import { CLOSED_THINK_PREFILL } from '../src/shared/thinking'
import type { ToolSchema } from '../src/renderer/src/types'

/**
 * v3.1: a greeting is answered without thinking first — the classifier that
 * decides it (lib/quickReply.ts) and the one round it changes (agentLoop's
 * `quickReply`).
 */

describe('isSmallTalk', () => {
  test('the greetings measured slow on 2026-09-28, and their family, are small talk', () => {
    for (const t of [
      'hello',
      'yo whats up?',
      'what is up my dude?',
      'Hey there!',
      'hi 👋',
      'good morning sigma',
      'thanks!',
      'thank you so much :)',
      "how’s it going?",
      'hey, how are you doing?',
      'bye, see you later'
    ]) {
      assert.ok(isSmallTalk(t), `"${t}" should be small talk`)
    }
  })

  test('anything with a question, a number or a task in it thinks as before', () => {
    for (const t of [
      'how many cm is 6 foot 3',
      'hey what time is it?',
      'hi, can you help me with my resume',
      'how can i start to lose weight ?',
      'just testing out your new vibe mode and its super cool',
      'hello world in python',
      'what is up with my code',
      ''
    ]) {
      assert.ok(!isSmallTalk(t), `"${t}" should not be small talk`)
    }
  })

  test('a go-ahead is not small talk: after "shall I write it?" it starts the work', () => {
    for (const t of ['ok', 'okay', 'sounds good', 'great', 'cool', 'perfect', 'yes', 'go ahead']) {
      assert.ok(!isSmallTalk(t), `"${t}" should not be small talk`)
    }
  })

  test('a long message is not a greeting, whatever its words', () => {
    assert.ok(!isSmallTalk('hello hello hello hello hello hello hello hello hello hello hello'))
  })
})

describe('quickReplyFor', () => {
  test('only on a model whose thinking is <think>-delimited', () => {
    assert.ok(quickReplyFor('qwen3.8-9b-distill', 'hello'))
    assert.ok(quickReplyFor('qwen3.8-35b-a3b-distill', 'yo whats up?'))
    assert.ok(!quickReplyFor('prism-ml/bonsai-27b', 'hello'), 'an unknown family is left to think')
    assert.ok(!quickReplyFor('google/gemma-4-12b', 'hello'))
    assert.ok(!quickReplyFor('qwen3.8-9b-distill', 'how many cm is 6 foot 3'))
  })
})

describe('runAgentLoop quickReply', () => {
  const TOOLS: ToolSchema[] = [
    { type: 'function', function: { name: 'web_search', description: 'Search the web.', parameters: {} } }
  ]
  const call: ApiToolCall = { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }

  const run = async (rounds: StreamRoundResult[], quickReply: boolean) => {
    const seen: ApiMessage[][] = []
    const messages: ApiMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' }
    ]
    await runAgentLoop({
      messages,
      tools: TOOLS,
      records: [],
      signal: new AbortController().signal,
      quickReply,
      deps: {
        streamRound: async (m) => {
          seen.push(m.map((x) => ({ ...x })))
          return rounds.shift() ?? { content: 'done', toolCalls: [] }
        },
        executeTool: async () => ({ ok: true, output: 'result' })
      }
    })
    return { seen, messages }
  }
  const last = (m: ApiMessage[]): ApiMessage => m[m.length - 1]

  test('the first round begins with thinking closed, and the prefill never joins the history', async () => {
    const { seen, messages } = await run([{ content: 'Hey! Good to see you.', toolCalls: [] }], true)
    assert.equal(seen.length, 1)
    assert.deepEqual(last(seen[0]), { role: 'assistant', content: CLOSED_THINK_PREFILL })
    assert.equal(messages.length, 2, 'the wire history is what it was')
    assert.equal(last(messages).role, 'user')
  })

  test('a round after a tool call thinks as usual', async () => {
    const { seen } = await run(
      [
        { content: '', toolCalls: [call] },
        { content: 'answer', toolCalls: [] }
      ],
      true
    )
    assert.equal(seen.length, 2)
    assert.equal(last(seen[0]).content, CLOSED_THINK_PREFILL)
    assert.equal(last(seen[1]).role, 'tool')
    assert.ok(!seen[1].some((m) => m.content === CLOSED_THINK_PREFILL), 'no prefill left in the history')
  })

  test('off, nothing changes', async () => {
    const { seen } = await run([{ content: 'Hello!', toolCalls: [] }], false)
    assert.equal(last(seen[0]).role, 'user')
  })
})
