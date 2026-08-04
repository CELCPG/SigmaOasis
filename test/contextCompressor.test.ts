import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCAL_DIGEST_PREFIX,
  foldLocalDigest,
  heuristicSummary
} from '../src/renderer/src/lib/contextCompressor'
import type { ChatMessage } from '../src/renderer/src/types'

/**
 * The local digest only ever runs when the model summarizer failed, so it is
 * the last thing standing between a compaction and a conversation that has
 * silently lost its middle. The null contract matters most: returning a digest
 * of nothing would let the caller advance `throughMessageId` past messages that
 * were never actually recorded anywhere.
 */

let counter = 0
function msg(role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m${counter++}`, role, content, createdAt: 0, ...extra }
}

describe('heuristicSummary', () => {
  test('an empty span produces nothing', () => {
    assert.equal(heuristicSummary([]), '')
  })

  test('messages with no usable text produce nothing', () => {
    assert.equal(heuristicSummary([msg('user', ''), msg('assistant', '   ')]), '')
  })

  test('records the questions actually asked', () => {
    const out = heuristicSummary([msg('user', 'How do I pin a model?')])
    assert.match(out, /User asked about/)
    assert.match(out, /How do I pin a model\?/)
  })

  test('is marked as a local digest so it is recognizable in a summary chain', () => {
    assert.ok(heuristicSummary([msg('user', 'hello')]).startsWith(LOCAL_DIGEST_PREFIX))
  })

  test('summarizes both sides of the exchange', () => {
    const out = heuristicSummary([
      msg('user', 'What is the capital of France?'),
      msg('assistant', 'Paris is the capital of France.')
    ])
    assert.match(out, /User asked about/)
    assert.match(out, /Assistant covered/)
  })

  test('takes the first non-empty line, not a leading blank', () => {
    const out = heuristicSummary([msg('user', '\n\nthe real question')])
    assert.match(out, /the real question/)
  })

  test('long lines are truncated with an ellipsis', () => {
    const out = heuristicSummary([msg('user', 'x'.repeat(500))])
    assert.match(out, /…/)
    assert.ok(out.length < 400, 'a single query should not blow past the topic cap')
  })

  test('counts code blocks', () => {
    const out = heuristicSummary([msg('assistant', 'here:\n```ts\nconst a = 1\n```')])
    assert.match(out, /1 message\(s\) contained code blocks/)
  })

  test('names the tools that ran', () => {
    const out = heuristicSummary([
      msg('assistant', 'searched', {
        toolCalls: [{ id: 't1', name: 'web_search', args: {}, status: 'done' }]
      })
    ])
    assert.match(out, /1 tool call\(s\) ran/)
    assert.match(out, /web_search/)
  })

  test('markers are excluded — they are dividers, not conversation', () => {
    const out = heuristicSummary([msg('user', 'context rolled back', { marker: 'rollback' })])
    assert.equal(out, '')
  })

  test('caps how many topics it lists', () => {
    const many = Array.from({ length: 20 }, (_, i) => msg('user', `question ${i}`))
    const out = heuristicSummary(many)
    assert.ok(!out.includes('question 5'), 'should stop at the topic cap')
  })
})

describe('foldLocalDigest', () => {
  test('returns null when there is nothing to record', () => {
    assert.equal(foldLocalDigest('an existing summary', []), null)
  })

  test('returns null on an empty digest even with no previous summary', () => {
    assert.equal(foldLocalDigest(undefined, []), null)
  })

  test('returns the digest alone when there is no previous summary', () => {
    const out = foldLocalDigest(undefined, [msg('user', 'a question')])
    assert.ok(out !== null)
    assert.ok(out.startsWith(LOCAL_DIGEST_PREFIX))
  })

  test('keeps the model-written summary first', () => {
    const out = foldLocalDigest('MODEL SUMMARY', [msg('user', 'a question')])
    assert.ok(out !== null)
    assert.ok(out.indexOf('MODEL SUMMARY') < out.indexOf(LOCAL_DIGEST_PREFIX))
  })
})
