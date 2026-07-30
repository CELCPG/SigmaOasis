import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createReasoningSplitter } from '../src/renderer/src/lib/reasoning'

/**
 * The reasoning splitter is pure logic over a token stream, so it is tested
 * directly rather than through the React hook that drives it. Every case here
 * is a silent-corruption failure if it regresses — the answer text changes
 * without anything throwing — which is exactly why they are pinned.
 */

/** Feed a whole reply through the splitter in the given chunks. */
function run(chunks: string[]): { answer: string; reasoning: string } {
  const splitter = createReasoningSplitter()
  let answer = ''
  let reasoning = ''
  for (const chunk of chunks) {
    const out = splitter.push(chunk)
    answer += out.answer
    reasoning += out.reasoning
  }
  const tail = splitter.flush()
  return { answer: answer + tail.answer, reasoning: reasoning + tail.reasoning }
}

describe('createReasoningSplitter — the common case', () => {
  test('separates a leading think block from the answer', () => {
    const out = run(['<think>Let me work this out. 2+2.</think>The answer is 4.'])
    assert.equal(out.reasoning, 'Let me work this out. 2+2.')
    assert.equal(out.answer, 'The answer is 4.')
  })

  test('a reply with no reasoning is passed through untouched', () => {
    const out = run(['Hello, ', 'how can I help?'])
    assert.equal(out.answer, 'Hello, how can I help?')
    assert.equal(out.reasoning, '')
  })

  test('recognizes the other tag spellings, case-insensitively', () => {
    for (const tag of ['think', 'thinking', 'reason', 'reasoning', 'THINK', 'Thinking']) {
      const out = run([`<${tag}>hidden</${tag}>shown`])
      assert.equal(out.reasoning, 'hidden', `tag: ${tag}`)
      assert.equal(out.answer, 'shown', `tag: ${tag}`)
    }
  })

  test('leading whitespace before the tag does not start the answer', () => {
    const out = run(['\n\n<think>thought</think>answer'])
    assert.equal(out.reasoning, 'thought')
    assert.equal(out.answer.trim(), 'answer')
  })
})

describe('createReasoningSplitter — chunk boundaries', () => {
  test('an opening tag split across deltas is still recognized', () => {
    const out = run(['<thi', 'nk>thought', '</think>answer'])
    assert.equal(out.reasoning, 'thought')
    assert.equal(out.answer, 'answer')
  })

  test('a closing tag split across deltas is still recognized', () => {
    const out = run(['<think>thought</thi', 'nk>answer'])
    assert.equal(out.reasoning, 'thought')
    assert.equal(out.answer, 'answer')
  })

  test('one character per delta — the worst case — round-trips exactly', () => {
    const source = '<think>step one. step two.</think>The final answer.'
    const out = run(source.split(''))
    assert.equal(out.reasoning, 'step one. step two.')
    assert.equal(out.answer, 'The final answer.')
  })

  test('a partial tag is never emitted as answer text mid-stream', () => {
    const splitter = createReasoningSplitter()
    // `<thi` could still become `<think>`; it must be held, not shown.
    assert.equal(splitter.push('<thi').answer, '')
  })

  test('a held-back prefix that turns out to be prose is emitted on flush', () => {
    // `<thi` never completes into a tag, so it is real answer text.
    const out = run(['<thi'])
    assert.equal(out.answer, '<thi')
    assert.equal(out.reasoning, '')
  })
})

describe('createReasoningSplitter — refusing to eat the answer', () => {
  test('a think tag inside a code block mid-answer is left as text', () => {
    const out = run([
      'Reasoning models emit this:\n```html\n<think>example</think>\n```\nThat is the format.'
    ])
    assert.equal(out.reasoning, '')
    assert.match(out.answer, /<think>example<\/think>/)
    assert.match(out.answer, /That is the format\.$/)
  })

  test('a think tag after the answer has started is text, even across chunks', () => {
    const out = run(['Here is how it works. ', '<think>not really thinking</think>', ' Done.'])
    assert.equal(out.reasoning, '')
    assert.equal(out.answer, 'Here is how it works. <think>not really thinking</think> Done.')
  })
})

describe('createReasoningSplitter — truncated streams', () => {
  test('an unclosed block flushes as reasoning rather than vanishing', () => {
    // What a max_tokens cutoff or an aborted turn looks like.
    const out = run(['<think>I was still thinking when the stream ended'])
    assert.equal(out.reasoning, 'I was still thinking when the stream ended')
    assert.equal(out.answer, '')
  })

  test('an empty stream produces nothing', () => {
    const out = run([])
    assert.equal(out.answer, '')
    assert.equal(out.reasoning, '')
  })

  test('an empty think block is dropped without disturbing the answer', () => {
    const out = run(['<think></think>Straight to the point.'])
    assert.equal(out.reasoning, '')
    assert.equal(out.answer, 'Straight to the point.')
  })
})
