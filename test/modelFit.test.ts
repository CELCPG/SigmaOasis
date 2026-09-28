import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FITTING_RATE,
  LARGE_WINDOW,
  SLOW_READ_RATE,
  SLOW_READ_WAIT_MS,
  latestSlowReading,
  slowReading,
  slowReadingAdvice,
  slowReadingFact
} from '../src/renderer/src/lib/modelFit'
import type { ChatMessage, Conversation, ResponseStats } from '../src/renderer/src/types'

/**
 * v3.1 (S6): the slow-reading verdict, against the stats the bench machine's
 * own replies recorded on 2026-09-28 (RTX 5070, 12 GB).
 */

const stats = (promptTokens: number, ttftMs: number): ResponseStats => ({ promptTokens, ttftMs, totalMs: ttftMs + 1000 })

describe('slowReading', () => {
  test('every slow reply measured on the bench is named', () => {
    for (const [label, tokens, ttft] of [
      ['bonsai-27b, "how can i start to lose weight"', 2378, 60063],
      ['bonsai-27b, "how many cm is 6 foot 3"', 2806, 69003],
      ['a 9B partly on the CPU, "yo whats up?"', 2053, 24470],
      ['the same, "just testing out your new vibe mode"', 2325, 27161],
      ['qwen3.8-27b, "hello"', 2005, 59972]
    ] as const) {
      const r = slowReading(stats(tokens, ttft))
      assert.ok(r, label)
      assert.ok(r.rate < 90, `${label}: ${r.rate.toFixed(1)}/s`)
    }
  })

  test('the model that fits the card is not, even reading from scratch', () => {
    assert.equal(slowReading(stats(2010, 1018)), null, 'the 9B distill, 2,010 tokens uncached')
    // A long conversation read from scratch at the card's rate: a long wait, a fast reading.
    assert.equal(slowReading(stats(30_000, 15_000)), null)
  })

  test('a short wait is never judged — it may be a cache hit on any model', () => {
    assert.equal(slowReading(stats(500, SLOW_READ_WAIT_MS - 1)), null)
  })

  test('the floor sits between the worst slow reading measured and the card', () => {
    assert.ok(SLOW_READ_RATE > 86 && SLOW_READ_RATE * 10 < 2000)
    assert.ok(slowReading(stats(Math.floor((SLOW_READ_RATE - 1) * 10), 10_000)))
    assert.equal(slowReading(stats((SLOW_READ_RATE + 1) * 10, 10_000)), null)
  })

  test('without the server’s token count there is nothing to divide', () => {
    assert.equal(slowReading({ ttftMs: 60_000, totalMs: 61_000 }), null)
    assert.equal(slowReading(undefined), null)
  })
})

describe('the sentence', () => {
  test('the measured half reads in the reader’s units', () => {
    assert.equal(
      slowReadingFact(slowReading(stats(2378, 60063))!),
      'read 2,378 prompt tokens at 40 a second — 60.1s before the first word'
    )
  })

  test('the advice names a window large enough to matter, and not one that is not', () => {
    assert.match(slowReadingAdvice(262_144), /loaded with a 262,144-token window/)
    assert.doesNotMatch(slowReadingAdvice(68_608), /token window/)
    assert.doesNotMatch(slowReadingAdvice(undefined), /token window/)
    assert.ok(LARGE_WINDOW > 68_608)
  })

  test('it says what else a long wait can be, so it never blames the model for a queue', () => {
    assert.match(slowReadingAdvice(), /busy with another request/)
    assert.ok(slowReadingAdvice().startsWith(FITTING_RATE))
  })
})

describe('latestSlowReading (Settings → Models)', () => {
  const reply = (modelId: string, createdAt: number, s?: ResponseStats): ChatMessage =>
    ({ id: `m${createdAt}`, role: 'assistant', content: 'x', modelId, createdAt, stats: s }) as ChatMessage
  const convo = (messages: ChatMessage[]): Conversation => ({ id: 'c', title: 't', messages }) as unknown as Conversation

  test('the model’s most recent measured reply decides', () => {
    const c = [convo([reply('bonsai', 1, stats(2378, 60063)), reply('nine', 2, stats(2010, 1018))])]
    assert.ok(latestSlowReading(c, 'bonsai'))
    assert.equal(latestSlowReading(c, 'nine'), null)
  })

  test('a model reloaded well since is not held to its old verdict', () => {
    const c = [convo([reply('bonsai', 1, stats(2378, 60063))]), convo([reply('bonsai', 5, stats(2400, 1500))])]
    assert.equal(latestSlowReading(c, 'bonsai'), null)
  })

  test('replies without stats, other models and no model at all say nothing', () => {
    const c = [convo([reply('bonsai', 9), reply('other', 10, stats(2378, 60063))])]
    assert.equal(latestSlowReading(c, 'bonsai'), null)
    assert.equal(latestSlowReading(c, ''), null)
  })
})

describe('where it is drawn', () => {
  const src = (...p: string[]): string => readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', ...p), 'utf8')

  test('under a reply in the full view, whether or not stats are shown', () => {
    const bubble = src('components', 'MessageBubble.tsx')
    assert.match(bubble, /\{!isStreaming && <SlowReadingLine stats=\{message\.stats\} modelId=\{message\.modelId\} \/>\}/)
    assert.doesNotMatch(bubble, /showStats && !isStreaming && <SlowReadingLine/)
  })

  test('beside the slot in Settings → Models, where VIBE’s reader can find it', () => {
    assert.match(src('components', 'settings', 'ModelsTab.tsx'), /<SlowReadingNote\s+modelId=\{m\.modelId\}/)
  })
})
