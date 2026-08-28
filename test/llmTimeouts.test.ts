import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, resetState, state } from './harness'
import {
  armWatchdog,
  newWitness,
  streamChat,
  FIRST_BYTE_TIMEOUT_MS,
  STREAM_STALL_MS
} from '../src/renderer/src/hooks/chatTransport'
import { replyAffordances } from '../src/renderer/src/lib/replyRecovery'
import { explainEmptyReply, ExplainedError } from '../src/shared/failure'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'

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
    assert.ok(llm.timeoutForTokens(10) >= 60_000)
  })

  /**
   * v1.5 recalibration. The v1.3 constant assumed 4 tokens/s of generation and
   * charged a flat 60s for the prompt whatever its size. Measured on
   * qwen3.5-9b-mlx: ~300 tokens/s prompt, 13–25 tokens/s generation — so the
   * generation term was 3–6x over and every derived timeout pinned to the
   * ceiling, while a 30k-token conversation was quietly under-budgeted.
   */
  test('a long generation no longer pins straight to the ceiling', () => {
    // The research brief. It needs room; it does not need five minutes.
    assert.ok(llm.timeoutForTokens(1400) < 300_000)
    assert.ok(llm.timeoutForTokens(1400) > 120_000)
  })

  test('a big prompt costs time, and a small one does not', () => {
    const small = llm.timeoutForTokens(400, 100)
    const large = llm.timeoutForTokens(400, 20_000)
    assert.ok(large > small, 'prompt size has to move the budget')
    // Through v1.4 these were identical — the flat allowance saw no difference
    // between a two-line question and a full conversation.
    assert.ok(large - small > 60_000)
  })

  test('prompt tokens default to zero, so old call sites are unchanged', () => {
    assert.equal(llm.timeoutForTokens(700), llm.timeoutForTokens(700, 0))
  })

  test('the ceiling still holds once both terms are large', () => {
    assert.equal(llm.timeoutForTokens(100_000, 100_000), 300_000)
  })
})

describe('estimatePromptTokens', () => {
  test('counts the whole conversation, not just the last message', () => {
    const one = llm.estimatePromptTokens([{ role: 'user', content: 'x'.repeat(400) }])
    const two = llm.estimatePromptTokens([
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'y'.repeat(400) }
    ])
    assert.ok(two > one)
  })

  test('four characters to the token, near enough for a budget', () => {
    assert.equal(llm.estimatePromptTokens([{ role: 'user', content: 'x'.repeat(400) }]), 100)
  })

  test('an empty conversation costs nothing', () => {
    assert.equal(llm.estimatePromptTokens([]), 0)
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

  /**
   * The v1.9.1 planner failure, pinned. plan.ts asks for a grammar and for
   * thinking off at once; on the qwen3 family that used to append a prefilled
   * assistant turn, and LM Studio cannot build a sampler for a constrained
   * request that already has one — HTTP 400, every planned turn, measured
   * 2026-08-18. The grammar makes the prefill redundant anyway.
   */
  test('a grammar-constrained request gets no prefill, whatever the family', () => {
    for (const model of ['qwen3.5-9b-mlx', 'qwen3.8-9b', 'deepseek-r1-distill-qwen-7b']) {
      const out = llm.applyThinking({
        model,
        messages,
        thinking: false,
        jsonSchema: { name: 'task_plan', schema: { type: 'object' } }
      })
      assert.deepEqual(out.messages, messages, `${model} must not be prefilled under a grammar`)
      assert.deepEqual(out.body, { chat_template_kwargs: { enable_thinking: false } })
    }
  })

  test('without a grammar the prefill is still there — it is what works', () => {
    const out = llm.applyThinking({ model: 'qwen3.8-9b', messages, thinking: false })
    assert.equal(out.messages.length, messages.length + 1)
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

/**
 * The v1.9.1 failure end to end, against a stub that behaves the way the live
 * server actually behaves. Three chats exported on 2026-08-18 opened with
 * `📋 Planning failed (HTTP 400: 'response_format.type' must be 'json_schema'
 * or 'text')` — an error about a format the caller never asked for, because
 * the recovery path had substituted it and hit a second, unrelated rejection.
 */
describe('chatCompleteJson · stepping down when a server refuses a constraint', () => {
  beforeEach(() => resetState())

  test('an answer still comes back when both constrained formats are refused', async () => {
    state.rejectConstrainedFormats = true
    state.completions = ['{"steps":[{"title":"Find the venues","detail":"Search the tour page."}]}']
    const out = await llm.chatCompleteJson<{ steps: { title: string }[] }>({
      model: 'qwen3.8-9b',
      messages: [{ role: 'user', content: 'Plan it.' }],
      thinking: false,
      jsonSchema: { name: 'task_plan', schema: { type: 'object' } }
    })
    assert.equal(out?.steps[0].title, 'Find the venues')
  })

  test('it steps down one rung at a time, and no further than it must', async () => {
    state.rejectConstrainedFormats = true
    state.completions = ['{"ok":true}']
    await llm.chatCompleteJson({
      model: 'qwen3.8-9b',
      messages: [{ role: 'user', content: 'Plan it.' }],
      jsonSchema: { name: 'task_plan', schema: { type: 'object' } }
    })
    assert.deepEqual(state.completionFormats, ['json_schema', 'json_object', undefined])
  })

  test('a server that accepts the grammar is never asked twice', async () => {
    state.completions = ['{"ok":true}']
    await llm.chatCompleteJson({
      model: 'qwen3.8-9b',
      messages: [{ role: 'user', content: 'Plan it.' }],
      jsonSchema: { name: 'task_plan', schema: { type: 'object' } }
    })
    assert.deepEqual(state.completionFormats, ['json_schema'])
  })

  test('the planner request carries no assistant prefill to collide with', async () => {
    state.completions = ['{"steps":[]}']
    await llm.chatCompleteJson({
      model: 'qwen3.8-9b',
      messages: [{ role: 'user', content: 'Plan it.' }],
      thinking: false,
      jsonSchema: { name: 'task_plan', schema: { type: 'object' } }
    })
    const sent = state.completionBodies[0] as { messages: { role: string }[] }
    assert.equal(sent.messages[sent.messages.length - 1].role, 'user')
  })
})

/**
 * The renderer's streaming transport, against a stub that behaves the way the
 * live server behaves.
 *
 * v1.6 added a diagnosis for the failure LM Studio reports in-band — a request
 * over the loaded context length answers 200, streams one `{"error": {...}}`
 * frame, and ends. v1.12.1 found the diagnosis unreachable: it was thrown from
 * inside the try whose `catch` exists to tolerate a half-arrived JSON chunk, so
 * the throw was swallowed as one and the turn finished as a blank bubble with
 * no cause and no next action — exactly the behaviour the feature removed.
 */

const encoder = new TextEncoder()

function abortError(): Error {
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

/** A 200 that streams the given SSE text and ends, like the real server. */
function sseResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

const HELLO: ApiMessage[] = [{ role: 'user', content: 'hi' }]

/** Run one round against a scripted server; returns what the user would see. */
async function round(fetchStub: typeof fetch): Promise<{ content: string; reasoning: string }> {
  const original = globalThis.fetch
  globalThis.fetch = fetchStub
  let content = ''
  let reasoning = ''
  try {
    await streamChat(
      'http://localhost:1234/v1',
      'qwen3.8-9b',
      HELLO,
      [],
      new AbortController().signal,
      (chunk) => {
        content += chunk
      },
      (chunk) => {
        reasoning += chunk
      }
    )
    return { content, reasoning }
  } finally {
    globalThis.fetch = original
  }
}

describe('streamChat · a failure the server puts in the stream', () => {
  test('a context-overflow frame reaches the user as a named cause', async () => {
    await assert.rejects(
      () =>
        round((async () =>
          sseResponse([
            'data: {"error":{"message":"The number of tokens to keep from the initial prompt is greater than the context length","type":"invalid_request_error"}}\n\n'
          ])) as typeof fetch),
      // Swallowed through v1.12.1: this resolved with an empty answer instead.
      // v1.17.3: the transport has no arithmetic of its own, so what it names
      // is what it knows — the server refused it and said "context". The turn
      // that catches this re-reads it with the app's own measurement; that is
      // asserted in failureBoundary.test.ts.
      /refused by LM Studio, which named the context length/
    )
  })

  test('the diagnosis says what to do about it', async () => {
    await assert.rejects(
      () =>
        round((async () =>
          sseResponse(['data: {"error":{"message":"context length exceeded"}}\n\n'])) as typeof fetch),
      /Load the model with a larger context in LM Studio/
    )
  })

  /**
   * v1.17.3: the ingredients ride out with the error.
   *
   * The transport cannot check a context claim — it has no view of the
   * conversation, the tool list or the window. The turn can, and the only way
   * it gets to is if the raw frame text survives the throw beside the reading
   * that was made without it.
   */
  test('the raw frame travels with the reading, so a caller with a number can re-read it', async () => {
    const err = await round((async () =>
      sseResponse(['data: {"error":{"message":"context length exceeded"}}\n\n'])) as typeof fetch).then(
      () => null,
      (e: unknown) => e as ExplainedError
    )
    assert.equal(err?.origin?.raw, 'context length exceeded')
    assert.equal(err?.origin?.context.source, 'LM Studio')
  })

  test('a failure that is not about context is reported verbatim', async () => {
    await assert.rejects(
      () =>
        round((async () =>
          sseResponse(['data: {"error":{"message":"Model has been unloaded"}}\n\n'])) as typeof fetch),
      /Model has been unloaded/
    )
  })

  test('a bare string error is reported too', async () => {
    await assert.rejects(
      () => round((async () => sseResponse(['data: {"error":"prediction-error"}\n\n'])) as typeof fetch),
      /prediction-error/
    )
  })

  test('the turn still ends non-empty: what streamed before the frame is kept', async () => {
    let seen = ''
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Half an answer. "}}]}\n\n',
        'data: {"error":{"message":"context length exceeded"}}\n\n'
      ])) as typeof fetch
    try {
      await assert.rejects(
        () =>
          streamChat(
            'http://localhost:1234/v1',
            'q',
            HELLO,
            [],
            new AbortController().signal,
            (c) => {
              seen += c
            }
          ),
        /named the context length/
      )
    } finally {
      globalThis.fetch = original
    }
    assert.match(seen, /Half an answer/)
  })

  /**
   * The tolerance the swallowing `catch` was there for in the first place. It
   * has to survive the fix: a delta split across two socket reads is normal.
   */
  test('a frame split across chunks is still assembled, not reported as a failure', async () => {
    const out = await round((async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n'
      ])) as typeof fetch)
    assert.equal(out.content, 'Hello world')
  })

  test('a malformed frame mid-stream still does not fail the round', async () => {
    const out = await round((async () =>
      sseResponse([
        'data: {not json}\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
      ])) as typeof fetch)
    assert.equal(out.content, 'ok')
  })
})

/**
 * The third member of the same family: chatTransport called `fetch` with a
 * signal and nothing else — no timeoutMs, no stall detection, unlike every
 * main-process path, which goes through auditedFetch and has both. A server
 * that accepted the POST and then wrote nothing held the turn open forever.
 */
describe('streamChat · a server that goes quiet', () => {
  test('the budgets are bounded, and the silent-start one is the looser', () => {
    assert.ok(STREAM_STALL_MS > 0 && STREAM_STALL_MS <= 120_000)
    assert.ok(FIRST_BYTE_TIMEOUT_MS >= STREAM_STALL_MS)
    assert.ok(FIRST_BYTE_TIMEOUT_MS <= 300_000)
  })

  /**
   * v1.17.4. This test used to assert `/sent nothing for 300s/`, and the
   * sentence behind that pattern was `LM Studio accepted the request and then
   * sent nothing for 300s.` — on a `fetch` that never resolves, i.e. on a
   * request LM Studio had never accepted. The test's own name said so. The
   * suite was pinning the exact defect the failure boundary exists to prevent:
   * a true-sounding sentence naming a party the app had not established.
   *
   * The witness knows which, and the message is now chosen when the timer
   * fires rather than when it is armed. Both silences are asserted, and each
   * asserts that it is NOT the other one's sentence.
   */
  test('a POST that is never answered fails with a cause, not a hang', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = round(((_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()))
      })) as unknown as typeof fetch)
    t.mock.timers.tick(FIRST_BYTE_TIMEOUT_MS)
    await assert.rejects(() => pending, /never answered the request — no reply headers came back for 300s/)
    // The party it must not name: nothing was accepted, so nothing accepted it.
    await assert.rejects(() => pending, (err: Error) => {
      assert.doesNotMatch(err.message, /accepted the request/)
      return true
    })
  })

  /**
   * The other half of the same ceiling, and the one no capture has ever
   * reached: headers arrive, the body never starts, and five minutes later the
   * transport is supposed to give up on its own. `gives up at 5:00` has been on
   * screen since round 8 with nothing testing that the promise is kept once the
   * request has actually been accepted — the abort has to travel from the
   * watchdog through an already-delivered response into a pending `read()`.
   */
  test('a stream accepted and never begun gives up at the ceiling, and says which silence it was', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const witness = newWitness()
    const original = globalThis.fetch
    // The measured shape: take the POST, answer the headers, write nothing.
    globalThis.fetch = ((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal.addEventListener('abort', () => controller.error(abortError()))
            }
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch
    try {
      const pending = streamChat('http://localhost:1234/v1', 'q', HELLO, [], new AbortController().signal,
        () => {}, undefined, undefined, false, witness)
      for (let i = 0; i < 50 && !witness.accepted; i++) await new Promise((r) => setImmediate(r))
      assert.equal(witness.accepted, true, 'the headers have to land before the clock runs out')
      assert.equal(witness.streamed, false)
      t.mock.timers.tick(FIRST_BYTE_TIMEOUT_MS)
      await assert.rejects(() => pending, /accepted the request and then sent nothing for 300s/)
      await assert.rejects(() => pending, (err: Error) => {
        assert.doesNotMatch(err.message, /never answered the request/)
        return true
      })
    } finally {
      globalThis.fetch = original
    }
  })

  test('a stream that dies mid-answer says so, and keeps what arrived', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let seen = ''
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"Half an answer. "}}]}\n\n')
              )
              init.signal.addEventListener('abort', () => controller.error(abortError()))
            }
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch
    try {
      const pending = streamChat(
        'http://localhost:1234/v1',
        'q',
        HELLO,
        [],
        new AbortController().signal,
        (c) => {
          seen += c
        }
      )
      for (let i = 0; i < 200 && seen === ''; i++) await new Promise((r) => setImmediate(r))
      t.mock.timers.tick(STREAM_STALL_MS)
      await assert.rejects(() => pending, /stalled — nothing received for 60s/)
    } finally {
      globalThis.fetch = original
    }
    assert.match(seen, /Half an answer/)
  })
})

/**
 * v1.17.3: the transport records who fell silent.
 *
 * `explainEmptyReply` can only be as right as what it is told, and what it is
 * told is two booleans set here. The pair is one layer apart on purpose:
 * headers arriving means the server took the request; a body byte arriving
 * means a reply had begun. `accepted && !streamed` is the server's silence;
 * `streamed` with no text is the model's.
 *
 * The witness is a mutable object rather than a return value for one reason,
 * and the last test is that reason: on the measured case — a stall the user
 * presses Stop on — this function leaves by the throw and never returns.
 */
describe('streamChat · what the transport witnessed', () => {
  test('a clean empty stream: the server answered, a body arrived, no text did', async () => {
    const witness = newWitness()
    const original = globalThis.fetch
    globalThis.fetch = (async () => sseResponse(['data: [DONE]\n\n'])) as typeof fetch
    try {
      await streamChat('http://localhost:1234/v1', 'q', HELLO, [], new AbortController().signal,
        () => {}, undefined, undefined, false, witness)
    } finally {
      globalThis.fetch = original
    }
    assert.equal(witness.accepted, true)
    assert.equal(witness.streamed, true)
    // Which is exactly the shape that must still be called the model's silence.
    assert.match(
      explainEmptyReply({ ...witness, produced: false, stoppedByUser: false, silentMs: 0 }).sentence,
      /The model produced no text/
    )
  })

  test('an immediately-closed empty 200: answered, but nothing was ever written', async () => {
    const witness = newWitness()
    const original = globalThis.fetch
    globalThis.fetch = (async () => sseResponse([])) as typeof fetch
    try {
      await streamChat('http://localhost:1234/v1', 'q', HELLO, [], new AbortController().signal,
        () => {}, undefined, undefined, false, witness)
    } finally {
      globalThis.fetch = original
    }
    assert.equal(witness.accepted, true)
    assert.equal(witness.streamed, false, 'no body byte arrived — this is the server, not the model')
    assert.match(
      explainEmptyReply({ ...witness, produced: false, stoppedByUser: false, silentMs: 0 }).sentence,
      /closed the connection without sending a reply/
    )
  })

  test('the measured stall: the record survives the abort that ends the turn', async () => {
    const witness = newWitness()
    const outer = new AbortController()
    const original = globalThis.fetch
    // The shim's behaviour: take the POST, answer the headers, write nothing.
    globalThis.fetch = ((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal.addEventListener('abort', () => controller.error(abortError()))
            }
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch
    try {
      const pending = streamChat('http://localhost:1234/v1', 'q', HELLO, [], outer.signal,
        () => {}, undefined, undefined, false, witness)
      for (let i = 0; i < 50 && !witness.accepted; i++) await new Promise((r) => setImmediate(r))
      outer.abort() // the user presses Stop
      await assert.rejects(() => pending)
    } finally {
      globalThis.fetch = original
    }
    assert.equal(witness.accepted, true, 'the POST was taken — the address is right')
    assert.equal(witness.streamed, false, 'and nothing was ever written back')
    const said = explainEmptyReply({
      ...witness,
      produced: false,
      stoppedByUser: true,
      silentMs: 90_000
    }).sentence
    assert.match(said, /You stopped this turn/)
    assert.match(said, /sent nothing at all for 90s/)
    // The round-9 defect, gone: the model is not blamed for a reply that the
    // transport can prove never started.
    assert.doesNotMatch(said, /nothing came back from the model/)
  })
})

/**
 * v1.17.4: the same two facts, asked about the request in flight.
 *
 * The pair above is turn-scoped and is read once, at the end. The thinking
 * indicator asks a different question — what is happening to the request I am
 * waiting on *now* — and a tool loop makes the two disagree: round two arms the
 * five-minute first-byte ceiling afresh, so round one having streamed says
 * nothing about the silence the reader is sitting in.
 *
 * MessageBubble used to guess it from the message instead, and the guess was
 * wrong in exactly that case: after any tool call it declared the stream
 * started for the rest of the turn, and the wait line promised `gives up at
 * 1:00` against a deadline four minutes further out.
 */
describe('streamChat · the request in flight, round by round', () => {
  test('a second round starts from nothing seen, and says so as it happens', async () => {
    const witness = newWitness()
    const seen: { accepted: boolean; streamed: boolean }[] = []
    witness.onChange = (): void => {
      seen.push({ ...witness.round })
    }
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'])) as typeof fetch
    try {
      for (let round = 0; round < 2; round++) {
        await streamChat('http://localhost:1234/v1', 'q', HELLO, [], new AbortController().signal,
          () => {}, undefined, undefined, false, witness)
      }
    } finally {
      globalThis.fetch = original
    }

    // Three transitions per round, in order, and the second round's first one
    // is the reset: the deadline the reader is shown depends on it.
    assert.deepEqual(seen, [
      { accepted: false, streamed: false },
      { accepted: true, streamed: false },
      { accepted: true, streamed: true },
      { accepted: false, streamed: false },
      { accepted: true, streamed: false },
      { accepted: true, streamed: true }
    ])

    // The turn-scoped pair is untouched by any of this — it still answers the
    // question explainEmptyReply asks, about the turn as a whole.
    assert.equal(witness.accepted, true)
    assert.equal(witness.streamed, true)
  })

  test('the screen learns the request went out before anything comes back', async () => {
    // The first publish happens at the request, not at the response: a wait
    // whose record only appears once headers land would spend its opening
    // seconds unable to say even that a request is open.
    const witness = newWitness()
    let firstSeen: { accepted: boolean; streamed: boolean } | null = null
    witness.onChange = (): void => {
      firstSeen ??= { ...witness.round }
    }
    const original = globalThis.fetch
    globalThis.fetch = (async () => sseResponse(['data: [DONE]\n\n'])) as typeof fetch
    try {
      await streamChat('http://localhost:1234/v1', 'q', HELLO, [], new AbortController().signal,
        () => {}, undefined, undefined, false, witness)
    } finally {
      globalThis.fetch = original
    }
    assert.deepEqual(firstSeen, { accepted: false, streamed: false })
  })
})

describe('armWatchdog', () => {
  test('a silent stream is stopped, and the reason is available afterwards', async () => {
    const watchdog = armWatchdog(new AbortController().signal)
    watchdog.touch(5, 'nothing for 5ms')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(watchdog.signal.aborted, true)
    assert.match(String(watchdog.expired()?.message), /nothing for 5ms/)
    watchdog.stop()
  })

  test('every chunk restarts the clock', async () => {
    const watchdog = armWatchdog(new AbortController().signal)
    watchdog.touch(40, 'stalled')
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 15))
      watchdog.touch(40, 'stalled')
    }
    assert.equal(watchdog.signal.aborted, false)
    watchdog.stop()
  })

  test('the user pressing Stop is not a failure with a cause', () => {
    const outer = new AbortController()
    const watchdog = armWatchdog(outer.signal)
    watchdog.touch(60_000, 'stalled')
    outer.abort()
    assert.equal(watchdog.signal.aborted, true)
    // Nothing to report: the turn unwinds quietly, as an abort must.
    assert.equal(watchdog.expired(), null)
    watchdog.stop()
  })

  test('an already-aborted caller never starts a request', () => {
    const outer = new AbortController()
    outer.abort()
    const watchdog = armWatchdog(outer.signal)
    assert.equal(watchdog.signal.aborted, true)
    watchdog.stop()
  })

  test('stop disarms it — a finished round leaves no timer behind', async () => {
    const watchdog = armWatchdog(new AbortController().signal)
    watchdog.touch(5, 'stalled')
    watchdog.stop()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(watchdog.signal.aborted, false)
    assert.equal(watchdog.expired(), null)
  })
})

/**
 * And the bubble the failure lands in. Through v1.12.1 the entire action row
 * was gated on `message.content`, so an empty reply — the one that most needs
 * it — offered no way forward at all, not even Regenerate.
 */
describe('replyAffordances', () => {
  const empty = { content: '' }
  const answered = { content: 'The answer.' }

  test('an empty last reply still gets the action row', () => {
    assert.equal(replyAffordances(empty, true, false).actions, true)
  })

  test('an empty reply is named as one', () => {
    assert.equal(replyAffordances(empty, true, false).empty, true)
  })

  test('the text actions stay off when there is no text to act on', () => {
    assert.equal(replyAffordances(empty, true, false).onText, false)
  })

  test('an answered reply gets the row and the text actions', () => {
    assert.deepEqual(replyAffordances(answered, false, false), {
      empty: false,
      actions: true,
      onText: true
    })
  })

  test('whitespace is not an answer', () => {
    assert.equal(replyAffordances({ content: '   \n ' }, true, false).empty, true)
  })

  test('a turn that ran tools is not an empty reply', () => {
    const out = replyAffordances(
      { content: '', toolCalls: [{ id: '1', name: 'web_search', args: {}, status: 'done' }] },
      true,
      false
    )
    assert.equal(out.empty, false)
  })

  test('a turn that only thought is not an empty reply either', () => {
    assert.equal(replyAffordances({ content: '', reasoning: 'hmm' }, true, false).empty, false)
  })

  test('nothing is offered while the reply is still streaming', () => {
    assert.equal(replyAffordances(answered, true, true).actions, false)
    assert.equal(replyAffordances(answered, true, true).onText, false)
  })

  test('an older empty bubble mid-history offers nothing new', () => {
    assert.equal(replyAffordances(empty, false, false).actions, false)
  })
})
