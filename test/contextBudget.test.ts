import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_MAX_CHARS,
  FALLBACK_MAX_MESSAGES,
  conversationContextUsage,
  estimateMessageTokens,
  estimateTokens,
  historyBudget,
  planHistory,
  planHistoryFallback
} from '../src/renderer/src/lib/contextBudget'
import type { ChatMessage, Conversation, ModelConfig } from '../src/renderer/src/types'

/**
 * Budget arithmetic. Every failure mode here is silent: the conversation
 * either overflows the model's window (and the server truncates the front,
 * where the system prompt lives) or drops more history than it needed to.
 * Neither throws, so the numbers are pinned.
 */

let counter = 0
function msg(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m${counter++}`,
    role: 'user',
    content,
    createdAt: 0,
    ...extra
  }
}

describe('estimateTokens', () => {
  test('scales with length', () => {
    assert.equal(estimateTokens('a'.repeat(400)), 100)
  })

  test('empty text costs nothing', () => {
    assert.equal(estimateTokens(''), 0)
  })

  test('an image costs far more than its message text', () => {
    const withImage = estimateMessageTokens(
      msg('look', {
        attachments: [
          { id: 'a', kind: 'image', name: 'x.png', mimeType: 'image/png', sizeBytes: 1, dataUrl: 'd' }
        ]
      })
    )
    assert.ok(withImage > 1000, `expected image cost to dominate, got ${withImage}`)
  })

  test('tool results are counted — they are replayed and usually the largest part', () => {
    const bare = estimateMessageTokens(msg('done'))
    const withTool = estimateMessageTokens(
      msg('done', {
        toolCalls: [{ id: 't', name: 'read_file', args: {}, status: 'done', result: 'x'.repeat(4000) }]
      })
    )
    assert.ok(withTool - bare >= 1000, `tool result was not counted: ${withTool - bare}`)
  })

  test('gallery thumbnails cost nothing — they are display-only, never on the wire', () => {
    // image_search hangs data URLs off the record so the chat can draw them.
    // They are deliberately excluded from the messages sent to the model, so
    // counting them here would shrink the history for tokens nobody spends.
    const bare = estimateMessageTokens(msg('here they are'))
    const withGallery = estimateMessageTokens(
      msg('here they are', {
        toolCalls: [
          {
            id: 't',
            name: 'image_search',
            args: { query: 'stroller' },
            status: 'done',
            result: '1. Stroller',
            images: [
              {
                title: 'Stroller',
                pageUrl: 'https://shop.example/a',
                dataUrl: `data:image/jpeg;base64,${'A'.repeat(40_000)}`
              }
            ]
          }
        ]
      })
    )
    assert.ok(
      withGallery - bare < 20,
      `thumbnails must not be charged to the context budget: ${withGallery - bare}`
    )
  })
})

describe('planHistory', () => {
  test('keeps everything when it fits', () => {
    const messages = [msg('one'), msg('two'), msg('three')]
    const plan = planHistory(messages, 10_000)
    assert.equal(plan.keep.length, 3)
    assert.equal(plan.drop.length, 0)
  })

  test('drops oldest first', () => {
    // Each message costs 1000 tokens of text plus 4 of wire overhead, so a
    // 2100 budget fits exactly two of the three.
    const messages = [msg('a'.repeat(4000)), msg('b'.repeat(4000)), msg('c'.repeat(4000))]
    const plan = planHistory(messages, 2100)
    assert.equal(plan.keep.length, 2)
    assert.equal(plan.keep[0].content[0], 'b')
    assert.equal(plan.drop.length, 1)
    assert.equal(plan.drop[0].content[0], 'a')
  })

  test('the newest message survives even when it alone exceeds the budget', () => {
    // Dropping what the user just sent to make room for older context is never
    // the right trade — let the server report an oversized request instead.
    const messages = [msg('old'), msg('x'.repeat(100_000))]
    const plan = planHistory(messages, 10)
    assert.equal(plan.keep.length, 1)
    assert.equal(plan.keep[0].content.length, 100_000)
    assert.equal(plan.drop.length, 1)
  })

  test('an empty conversation plans to nothing', () => {
    const plan = planHistory([], 1000)
    assert.deepEqual(plan, { keep: [], drop: [], usedTokens: 0 })
  })

  test('keep and drop always partition the input in order', () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg(`${i}`.repeat(500)))
    const plan = planHistory(messages, 1000)
    assert.deepEqual([...plan.drop, ...plan.keep], messages)
  })

  test('a zero budget still keeps the newest message', () => {
    const messages = [msg('old'), msg('new')]
    const plan = planHistory(messages, 0)
    assert.equal(plan.keep.length, 1)
    assert.equal(plan.keep[0].content, 'new')
  })
})

describe('planHistoryFallback — the pre-0.8.2 rule, unchanged', () => {
  test('caps at the message count', () => {
    const messages = Array.from({ length: 60 }, () => msg('short'))
    assert.equal(planHistoryFallback(messages).keep.length, FALLBACK_MAX_MESSAGES)
  })

  test('caps at the character budget', () => {
    const messages = Array.from({ length: 10 }, () => msg('x'.repeat(10_000)))
    const plan = planHistoryFallback(messages)
    const chars = plan.keep.reduce((n, m) => n + m.content.length, 0)
    assert.ok(chars <= FALLBACK_MAX_CHARS, `kept ${chars} chars`)
    assert.ok(plan.keep.length > 0)
  })

  test('the newest message survives regardless of size', () => {
    const plan = planHistoryFallback([msg('old'), msg('x'.repeat(200_000))])
    assert.equal(plan.keep.length, 1)
    assert.equal(plan.keep[0].content.length, 200_000)
  })
})

describe('historyBudget', () => {
  test('is undefined when the context length is unknown, so the caller falls back', () => {
    assert.equal(
      historyBudget({ systemPromptTokens: 100, toolSchemaTokens: 100, maxTokens: -1 }),
      undefined
    )
    assert.equal(
      historyBudget({
        contextLength: 0,
        systemPromptTokens: 100,
        toolSchemaTokens: 100,
        maxTokens: -1
      }),
      undefined
    )
  })

  test('reserves room for the reply, the prompt, the tools and a margin', () => {
    const budget = historyBudget({
      contextLength: 32_000,
      systemPromptTokens: 500,
      toolSchemaTokens: 1000,
      maxTokens: 2000
    })
    assert.ok(budget !== undefined)
    // 32000 - 500 - 1000 - 2000 - 1600 (5% margin)
    assert.equal(budget, 26_900)
  })

  test('reserves a slice for the reply when max_tokens is server-default', () => {
    const withDefault = historyBudget({
      contextLength: 8000,
      systemPromptTokens: 0,
      toolSchemaTokens: 0,
      maxTokens: -1
    })
    // Reserving nothing is how a history that "fits" overflows once the model
    // starts answering — the reservation must be non-zero.
    assert.ok(withDefault !== undefined && withDefault < 8000 * 0.85)
  })

  test('never goes negative on a tiny context with a large prompt', () => {
    const budget = historyBudget({
      contextLength: 2048,
      systemPromptTokens: 4000,
      toolSchemaTokens: 2000,
      maxTokens: -1
    })
    assert.equal(budget, 0)
  })
})

describe('conversationContextUsage', () => {
  function convo(extra: Partial<Conversation> = {}): Conversation {
    return {
      id: 'c1',
      title: 'test',
      mode: 'independent',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      ...extra
    }
  }

  function slot(extra: Partial<ModelConfig> = {}): ModelConfig {
    return {
      id: 'model-1',
      modelId: 'm',
      roleName: 'Assistant',
      systemPrompt: '',
      color: 'blue',
      enabled: true,
      sampling: { temperature: 0.7, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 },
      contextWindow: null,
      ...extra
    }
  }

  test('is null when no context length is known, so no meter is drawn', () => {
    // A meter against a guessed denominator is worse than no meter at all.
    assert.equal(conversationContextUsage(convo(), slot(), undefined), null)
  })

  test('counts messages, the system prompt and the summary', () => {
    const usage = conversationContextUsage(
      convo({
        messages: [msg('a'.repeat(400))],
        summary: { text: 'b'.repeat(400), throughMessageId: 'x', updatedAt: 0 }
      }),
      slot({ contextWindow: 8000, systemPrompt: 'c'.repeat(400) }),
      undefined
    )
    // 100 (message) + 4 (wire overhead) + 100 (prompt) + 100 (summary)
    assert.deepEqual(usage, { used: 304, total: 8000, ratio: 304 / 8000 })
  })

  test('an explicit slot override wins over the catalog', () => {
    const usage = conversationContextUsage(convo(), slot({ contextWindow: 4096 }), {
      id: 'm',
      contextLength: 32_000
    } as never)
    assert.equal(usage?.total, 4096)
  })
})
