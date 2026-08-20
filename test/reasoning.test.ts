import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createReasoningSplitter, isLikelyReasoningModel } from '../src/renderer/src/lib/reasoning'

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

describe('createReasoningSplitter — Gemma 4 native control tokens', () => {
  test('pipe-style think tags separate like the XML spellings', () => {
    const out = run(['<|think|>hidden<|/think|>shown'])
    assert.equal(out.reasoning, 'hidden')
    assert.equal(out.answer, 'shown')
  })

  test('the structured thinking channel separates, leading newline stripped', () => {
    const out = run(['<|channel>thought\nhidden<channel|>shown'])
    assert.equal(out.reasoning, 'hidden')
    assert.equal(out.answer, 'shown')
  })

  test('a tool-call token ends the thinking block with no close tag at all', () => {
    // Gemma 4 goes straight from thinking to calling; observed verbatim on
    // gemma-4-12b-qat through LM Studio.
    const out = run(['<|think|>planning the call<|tool_call>call:x{a:1}<tool_call|>after'])
    assert.equal(out.reasoning, 'planning the call')
    assert.equal(out.answer, '<|tool_call>call:x{a:1}<tool_call|>after')
  })

  test('the sloppy <|tool> opener also terminates thinking', () => {
    const out = run(['<|think|>plan<|tool>call:x{a:1}<tool_call|>'])
    assert.equal(out.reasoning, 'plan')
    assert.equal(out.answer, '<|tool>call:x{a:1}<tool_call|>')
  })

  test('pipe tokens split across chunks are still recognized', () => {
    const out = run(['<|th', 'ink|>hidden<|/th', 'ink|>shown'])
    assert.equal(out.reasoning, 'hidden')
    assert.equal(out.answer, 'shown')
  })

  test('the exact reply a user reported renders clean after both stages', () => {
    // Verbatim from a gemma-4-12b-qat session: thinking, then an inline tool
    // call the server never executed, and no answer text at all.
    const sample =
      '<|think|>The user has asked me to generate another story, following up on ' +
      'the previous request.<|tool>call:text_generation{prompt:<|"|>a short story about cats<|"|>}<tool_call|>'
    const out = run([sample])
    assert.equal(out.reasoning, 'The user has asked me to generate another story, following up on the previous request.')
    assert.equal(
      out.answer,
      '<|tool>call:text_generation{prompt:<|"|>a short story about cats<|"|>}<tool_call|>'
    )
  })
})

describe('isLikelyReasoningModel (the Layer 1d gate)', () => {
  test('the families whose CoT the splitter strips read as reasoning models', () => {
    assert.equal(isLikelyReasoningModel('qwen3-8b-instruct'), true)
    assert.equal(isLikelyReasoningModel('deepseek-r1-distill-qwen-7b'), true)
    assert.equal(isLikelyReasoningModel('openai/gpt-oss-20b'), true)
    assert.equal(isLikelyReasoningModel('mistralai/magistral-small'), true)
    // Gemma 4 reasons in native control tokens the splitter strips.
    assert.equal(isLikelyReasoningModel('google/gemma-4-12b-qat'), true)
    assert.equal(isLikelyReasoningModel('gemma-4-e4b-agentic-sol-fable-reasoning-geminicli'), true)
  })

  test('plain instruct models get the preamble instead', () => {
    assert.equal(isLikelyReasoningModel('llama-3.1-8b-instruct'), false)
    assert.equal(isLikelyReasoningModel('mistral-7b-instruct-v0.3'), false)
    assert.equal(isLikelyReasoningModel('qwen2.5-7b-instruct'), false)
  })
})

describe('createReasoningSplitter — e4b-agentic thought/response spellings', () => {
  // Measured on gemma-4-e4b-agentic-sol-fable and google/gemma-4-12b-qat,
  // 2026-08-03: the thought opens with <|thought> and closes with whichever
  // delimiter the template carries — </thought>, <|response>, or <response>.
  test('<|thought>…<|response> separates thought from answer', () => {
    const out = run(['<|thought>working it out<|response>The answer.'])
    assert.equal(out.reasoning, 'working it out')
    assert.equal(out.answer, 'The answer.')
  })

  test('<|thought>…</thought> closes with the xml-ish spelling', () => {
    const out = run(['<|thought>working it out</thought>The answer.'])
    assert.equal(out.reasoning, 'working it out')
    assert.equal(out.answer, 'The answer.')
  })

  test('<|thought>…<response> closes with the bare spelling', () => {
    const out = run(['<|thought>working it out<response>The answer.'])
    assert.equal(out.reasoning, 'working it out')
    assert.equal(out.answer, 'The answer.')
  })

  test('the thought block split across chunks is still recognized', () => {
    const out = run(['<|thou', 'ght>working it out<|resp', 'onse>The answer.'])
    assert.equal(out.reasoning, 'working it out')
    assert.equal(out.answer, 'The answer.')
  })

  test('a thought after the answer has started is not swallowed', () => {
    const out = run(['The answer.<|thought>not a real thought'])
    assert.equal(out.answer, 'The answer.<|thought>not a real thought')
    assert.equal(out.reasoning, '')
  })
})

// ---- v1.12: boundary-exhaustive property test --------------------------------
// A real session produced a reply missing its opening words ("be happy to
// help…" for "I'd be happy to help…"). The streaming splitter is the component
// with chunk-boundary state, so it gets the exhaustive treatment: for every
// transcript below and EVERY possible 1-cut and a sweep of 2-cut chunkings,
// reassembled answer+reasoning must equal the single-push result exactly.

describe('splitter is lossless across all chunk boundaries', () => {
  const TRANSCRIPTS = [
    "I'd be happy to help with research, but I need a topic first.",
    "<think>user wants research; ask for the topic</think>I'd be happy to help with research, but I need a topic first.",
    "<think>alpha</think>\n\nI'd be happy to help.",
    "  \n<thinking>two\nlines\nof thought</thinking>Answer starts here.",
    "<|channel>thought\nponder ponder<channel|>The visible answer.",
    "<|thought>brief<|response>I'd say yes.",
    "<think>calling a tool</think><|tool_call>{\"name\":\"web_search\"}",
    "No tags at all, just an answer with a < sign and 3 < 5 math.",
    "<think>unclosed thinking that runs to the end of the stream"
  ]

  function runChunks(chunks: string[]): { answer: string; reasoning: string } {
    const s = createReasoningSplitter()
    let answer = ''
    let reasoning = ''
    for (const c of chunks) {
      const d = s.push(c)
      answer += d.answer
      reasoning += d.reasoning
    }
    const f = s.flush()
    answer += f.answer
    reasoning += f.reasoning
    return { answer, reasoning }
  }

  test('every single-cut chunking matches the whole-string parse', () => {
    for (const t of TRANSCRIPTS) {
      const whole = runChunks([t])
      for (let i = 1; i < t.length; i++) {
        const split = runChunks([t.slice(0, i), t.slice(i)])
        assert.deepEqual(split, whole, `transcript ${JSON.stringify(t.slice(0, 40))}… cut at ${i}`)
      }
    }
  })

  test('every double-cut chunking around the tag regions matches too', () => {
    for (const t of TRANSCRIPTS) {
      const whole = runChunks([t])
      for (let i = 1; i < t.length - 1; i++) {
        // Second cut sweeps a window after the first — covers tag spans.
        for (let j = i + 1; j < Math.min(t.length, i + 14); j++) {
          const split = runChunks([t.slice(0, i), t.slice(i, j), t.slice(j)])
          assert.deepEqual(split, whole, `cut at ${i},${j} of ${JSON.stringify(t.slice(0, 40))}`)
        }
      }
    }
  })

  test('token-at-a-time (worst case) matches as well', () => {
    for (const t of TRANSCRIPTS) {
      const whole = runChunks([t])
      const split = runChunks([...t])
      assert.deepEqual(split, whole, JSON.stringify(t.slice(0, 40)))
    }
  })

  test('the decapitation shape specifically: nothing eats the first word after a close tag', () => {
    const t = "<think>x</think>I'd be happy to help."
    for (let i = 1; i < t.length; i++) {
      const { answer } = runChunks([t.slice(0, i), t.slice(i)])
      assert.ok(answer.includes("I'd be happy"), `cut at ${i}: answer=${JSON.stringify(answer)}`)
    }
  })
})
