import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { CLOSED_THINK_PREFILL, thinkingMode, withUtilityThinking } from '../src/shared/thinking'
import { turnThinking } from '../src/renderer/src/lib/quickReply'
import type { ModelConfig } from '../src/renderer/src/types'

/**
 * v4.1 (S4): thinking where it pays. The app's own checks read a verdict off
 * the reply's text, so on a think-tag model they run with the block closed,
 * as the main process's utility calls have since v1.9.2; and a role's
 * Thinking setting (auto / on / off) decides the rest.
 */

const QWEN = 'qwen3.8-9b'
const GEMMA = 'gemma-4-12b'
const messages = [
  { role: 'system' as const, content: 'You check answers.' },
  { role: 'user' as const, content: 'Q and A' }
]

describe('thinkingMode', () => {
  test('reads on and off back, and anything else as auto', () => {
    assert.equal(thinkingMode('on'), 'on')
    assert.equal(thinkingMode('off'), 'off')
    for (const v of [undefined, null, 'auto', 'yes', 1]) assert.equal(thinkingMode(v), 'auto')
  })
})

describe('withUtilityThinking', () => {
  test('a check on a think-tag model starts with the block closed, auto or off', () => {
    for (const mode of [undefined, 'auto', 'off'] as const) {
      const out = withUtilityThinking(messages, QWEN, mode)
      assert.deepEqual(out[out.length - 1], { role: 'assistant', content: CLOSED_THINK_PREFILL })
      assert.equal(out.length, messages.length + 1)
    }
    assert.equal(messages.length, 2, 'the caller’s array is not touched')
  })

  test('on keeps the check thinking, and a family outside the tags is never touched', () => {
    assert.equal(withUtilityThinking(messages, QWEN, 'on'), messages)
    assert.equal(withUtilityThinking(messages, GEMMA, 'off'), messages)
  })
})

describe('turnThinking', () => {
  test('auto is the v3.1 rule: a greeting skips thinking, a question does not', () => {
    assert.deepEqual(turnThinking({ modelId: QWEN }, 'hey there!'), { quickReply: true })
    assert.deepEqual(turnThinking({ modelId: QWEN }, 'why is the sky blue?'), { quickReply: false })
  })

  test('on thinks even on a greeting', () => {
    assert.deepEqual(turnThinking({ modelId: QWEN, thinking: 'on' }, 'hey there!'), { quickReply: false })
  })

  test('off closes the block on every round, not only the first', () => {
    const t = turnThinking({ modelId: QWEN, thinking: 'off' }, 'why is the sky blue?')
    assert.equal(t.quickReply, true)
    assert.equal(t.quickReplyFor?.(), true)
  })

  test('off on a model outside the think-tag families changes nothing', () => {
    assert.deepEqual(turnThinking({ modelId: GEMMA, thinking: 'off' }, 'why is the sky blue?'), { quickReply: false })
  })
})

describe('the auto-critic runs with thinking closed (v4.1 S4)', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const slot = (id: string, over: Partial<ModelConfig> = {}): ModelConfig =>
    ({
      id,
      modelId: QWEN,
      roleName: id,
      systemPrompt: 'p',
      color: 'green',
      enabled: true,
      sampling: { temperature: 0, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 },
      contextWindow: null,
      ...over
    }) as ModelConfig

  async function criticRequest(critic: ModelConfig): Promise<{ role: string; content: unknown }[]> {
    const bodies: { messages: { role: string; content: unknown }[] }[] = []
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      const frame = { choices: [{ index: 0, delta: { content: 'Looks right.' }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }) as unknown as typeof fetch
    ;(globalThis as { window?: unknown }).window = { api: { pinModel: async () => true } }
    const { useAppStore } = await import('../src/renderer/src/stores/appStore')
    const answerer = slot('Answerer', { modelId: 'other-model' })
    useAppStore.setState({
      settings: { secondOpinion: { enabled: true, criticSlotId: critic.id }, models: [answerer, critic] } as never,
      conversations: [{ id: 'c', title: 't', messages: [{ id: 'a', role: 'assistant', content: 'x', createdAt: 0 }] }] as never
    } as never)
    const { runAutoCritic } = await import('../src/renderer/src/hooks/verification')
    await runAutoCritic(
      { id: 'c' } as never,
      'a',
      'Who wrote it?',
      'Someone did.',
      { modelId: answerer.modelId, roleName: answerer.roleName },
      'http://127.0.0.1:1/v1',
      new AbortController().signal
    )
    assert.equal(bodies.length, 1)
    return bodies[0].messages
  }

  test('auto: the critic’s request ends in the closed block', async () => {
    const sent = await criticRequest(slot('Critic'))
    assert.deepEqual(sent[sent.length - 1], { role: 'assistant', content: CLOSED_THINK_PREFILL })
  })

  test('on: the critic thinks, as before 4.1', async () => {
    const sent = await criticRequest(slot('Critic', { thinking: 'on' }))
    assert.notEqual(sent[sent.length - 1].role, 'assistant')
  })
})
