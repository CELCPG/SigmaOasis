import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './harness'

const llm = load<typeof import('../src/main/ipc/llm')>('llm')

/**
 * Through v1.3 a single 120s constant governed every main-process model call.
 * A 12B model writing a 1400-token research brief on laptop hardware does not
 * finish in that, so runs that had already fetched and ranked eight pages
 * threw all of it away at the final step. The timeout now scales with what the
 * model was asked to write.
 */

describe('timeoutForTokens', () => {
  test('a long generation gets more room than the old flat 120s', () => {
    // The research brief: the call that was actually failing.
    assert.ok(llm.timeoutForTokens(1400) > 120_000)
  })

  test('longer requests get proportionally longer ceilings', () => {
    assert.ok(llm.timeoutForTokens(1400) > llm.timeoutForTokens(400))
  })

  test('a short request still gets a usable floor', () => {
    assert.ok(llm.timeoutForTokens(10) >= 90_000)
  })

  test('nothing waits forever — the ceiling is bounded', () => {
    assert.ok(llm.timeoutForTokens(100_000) <= 300_000)
  })

  test('an unspecified budget is treated as a middling one', () => {
    assert.ok(llm.timeoutForTokens(undefined) >= 90_000)
    assert.ok(llm.timeoutForTokens(undefined) <= 300_000)
  })
})

describe('parseSseDeltas', () => {
  test('reads content out of completion frames', () => {
    const buffer =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n'
    assert.deepEqual(llm.parseSseDeltas(buffer), {
      text: 'Hello world',
      reasoning: '',
      rest: ''
    })
  })

  test('an incomplete trailing frame is carried, not dropped', () => {
    // A delta can split across chunk boundaries; losing the remainder loses
    // tokens silently, which is the bug this return shape exists to prevent.
    const buffer = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\ndata: {"choices":[{"delt'
    const out = llm.parseSseDeltas(buffer)
    assert.equal(out.text, 'Hi')
    assert.equal(out.rest, 'data: {"choices":[{"delt')
  })

  test('[DONE] and blank frames are skipped', () => {
    const buffer = 'data: [DONE]\n\ndata: {"choices":[{"delta":{"content":"x"}}]}\n'
    assert.equal(llm.parseSseDeltas(buffer).text, 'x')
  })

  test('a malformed frame does not fail the stream', () => {
    const buffer = 'data: {not json}\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n'
    assert.equal(llm.parseSseDeltas(buffer).text, 'ok')
  })

  test('non-streaming message frames are read too', () => {
    const buffer = 'data: {"choices":[{"message":{"content":"whole"}}]}\n'
    assert.equal(llm.parseSseDeltas(buffer).text, 'whole')
  })

  test('a buffer with no line break yields nothing yet', () => {
    assert.deepEqual(llm.parseSseDeltas('data: {"cho'), {
      text: '',
      reasoning: '',
      rest: 'data: {"cho'
    })
  })

  /**
   * The v1.4 failure: LM Studio routes a Qwen3 model's chain-of-thought into
   * `reasoning_content`, which this parser dropped. A model that spent its whole
   * budget thinking was therefore indistinguishable from one that said nothing,
   * and deep research reported "the model returned an empty brief" after a full
   * crawl (measured on qwen3.5-9b-mlx).
   */
  test('out-of-band reasoning is captured, not dropped', () => {
    const buffer =
      'data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}\n' +
      'data: {"choices":[{"delta":{"content":"the answer"}}]}\n'
    const out = llm.parseSseDeltas(buffer)
    assert.equal(out.text, 'the answer')
    assert.equal(out.reasoning, 'let me think')
  })

  test('reasoning never leaks into the answer text', () => {
    const buffer = 'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n'
    assert.equal(llm.parseSseDeltas(buffer).text, '')
  })
})

describe('stripReasoning', () => {
  test('removes an inline think block', () => {
    assert.equal(llm.stripReasoning('<think>weighing it up</think>The brief.'), 'The brief.')
  })

  test('removes a block the model never closed', () => {
    // A stream cut off by max_tokens mid-thought: everything after the opener
    // is deliberation, and none of it is an answer.
    assert.equal(llm.stripReasoning('Answer so far.<think>and now I wond'), 'Answer so far.')
  })

  test('leaves ordinary output alone', () => {
    assert.equal(llm.stripReasoning('No tags here.'), 'No tags here.')
  })

  test('does not eat markup that merely looks like a tag', () => {
    assert.equal(llm.stripReasoning('Use <thinking-cap> for CSS.'), 'Use <thinking-cap> for CSS.')
  })
})

describe('applyThinking', () => {
  const messages = [
    { role: 'system' as const, content: 'You are helpful.' },
    { role: 'user' as const, content: 'Summarize.' }
  ]

  test('leaves the request untouched when thinking is not specified', () => {
    const out = llm.applyThinking({ model: 'qwen3.5-9b-mlx', messages })
    assert.deepEqual(out.body, {})
    assert.deepEqual(out.messages, messages)
  })

  test('sends the template kwarg when thinking is off', () => {
    const out = llm.applyThinking({ model: 'some-model', messages, thinking: false })
    assert.deepEqual(out.body, { chat_template_kwargs: { enable_thinking: false } })
  })

  /**
   * The switch that survived measurement. Every server-side parameter —
   * chat_template_kwargs, reasoning_effort, template_kwargs, a top-level
   * enable_thinking, /no_think, /nothink — was inert on qwen3.5-9b-mlx in
   * LM Studio on 2026-08-12: identical output to sending nothing, the whole
   * budget spent thinking, no answer. Prefilling a closed thinking block is
   * what actually works, so that is what these pin.
   */
  test('prefills a closed thinking block for the tag-delimited families', () => {
    const out = llm.applyThinking({ model: 'qwen3.5-9b-mlx', messages, thinking: false })
    const last = out.messages[out.messages.length - 1]
    assert.equal(last.role, 'assistant')
    assert.match(String(last.content), /^<think>\s*<\/think>/)
  })

  test('the caller\'s own messages are passed through untouched', () => {
    const out = llm.applyThinking({ model: 'qwen3.5-9b-mlx', messages, thinking: false })
    assert.equal(out.messages[0].content, 'You are helpful.')
    assert.equal(out.messages[1].content, 'Summarize.')
    assert.equal(out.messages.length, messages.length + 1)
  })

  test('the prefill goes last, after the question it answers', () => {
    // Anywhere else and it is not a turn the model continues from.
    const out = llm.applyThinking({ model: 'deepseek-r1-distill-qwen-7b', messages, thinking: false })
    assert.equal(out.messages[out.messages.length - 2].role, 'user')
  })

  test('Gemma gets the body field alone — its thinking uses other tokens', () => {
    const out = llm.applyThinking({ model: 'google/gemma-4-12b-qat', messages, thinking: false })
    assert.deepEqual(out.messages, messages)
    assert.deepEqual(out.body, { chat_template_kwargs: { enable_thinking: false } })
  })

  test('a request with no system message is still handled', () => {
    const out = llm.applyThinking({
      model: 'qwen3.5-9b-mlx',
      messages: [{ role: 'user' as const, content: 'Hi' }],
      thinking: false
    })
    assert.equal(out.messages[0].content, 'Hi')
    assert.equal(out.messages[1].role, 'assistant')
  })
})

describe('PartialCompletionError', () => {
  test('carries what the model had already written', () => {
    const err = new llm.PartialCompletionError('Request timed out after 300s.', 'four paragraphs')
    assert.equal(err.partial, 'four paragraphs')
    assert.equal(err.name, 'PartialCompletionError')
    assert.ok(err instanceof Error)
  })
})
