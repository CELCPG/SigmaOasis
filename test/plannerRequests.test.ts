import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { load, resetState, state } from './harness'

/**
 * v4.5 (H2): the planners that send a grammar beside `thinking: false` — plan
 * mode, the outline, deep research's planner and its reformulation.
 *
 * 4.4 (G5) found that a `<think>` family ignores that pairing in LM Studio: the
 * re-rank's 80 tokens all went to reasoning. H2 measured the four on the 9B
 * (scripts/probe-planners.ts, docs/evals.md): where the closed-think prefill was
 * no worse on validity and faster, a `<think>` family is asked plainly — no
 * grammar, the shape in the prompt, the reply read tolerantly. Everything else
 * keeps the grammar request, byte for byte. Scripted completions only; nothing
 * here reaches a model.
 */

const llm = load<typeof import('../src/main/ipc/llm')>('llm')
const plan = load<typeof import('../src/main/ipc/plan')>('plan')
const outline = load<typeof import('../src/main/ipc/outline')>('outline')
const research = load<typeof import('../src/main/ipc/deepResearch/plan')>('deepResearch/plan')

const THINK_MODEL = 'qwen3.8-9b-distill'
/** A family without think tags: it must get today's request. */
const GEMMA = 'gemma-4-26b-a4b'

type Body = {
  model?: string
  messages?: { role: string; content: string }[]
  temperature?: number
  max_tokens?: number
  stream?: boolean
  chat_template_kwargs?: unknown
  response_format?: { type?: string; json_schema?: { name?: string; strict?: boolean } }
}
const lastBody = (): Body => state.completionBodies.at(-1) as Body
const CLOSED = /^<think>\s*<\/think>/

beforeEach(() => {
  resetState()
})

describe('the plain request (v4.5 H2)', () => {
  test('chatCompleteJsonPlain on a <think> family: no grammar, the closed block ends the messages, the budget is unchanged', async () => {
    state.completions = ['{"answering": [1]}']
    const parsed = await llm.chatCompleteJsonPlain<{ answering?: number[] }>({
      model: THINK_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      maxTokens: 123,
      thinking: false,
      jsonSchema: { name: 'x', schema: { type: 'object' } },
      json: true
    })
    assert.deepEqual(parsed, { answering: [1] })
    const body = lastBody()
    assert.equal(body.response_format, undefined, 'a grammar and the prefill together are refused by LM Studio')
    assert.equal(body.max_tokens, 123)
    assert.equal(body.messages?.at(-1)?.role, 'assistant')
    assert.match(body.messages?.at(-1)?.content ?? '', CLOSED)
  })

  test('its reply is read tolerantly: prose and fences around the JSON', async () => {
    state.completions = ['Sure:\n```json\n{"a": 1}\n```\nDone.']
    const parsed = await llm.chatCompleteJsonPlain<{ a?: number }>({ model: THINK_MODEL, messages: [{ role: 'user', content: 'hi' }], thinking: false })
    assert.deepEqual(parsed, { a: 1 })
  })

  test('a family without think tags gets no prefill from it', async () => {
    state.completions = ['{}']
    await llm.chatCompleteJsonPlain({ model: GEMMA, messages: [{ role: 'user', content: 'hi' }], thinking: false })
    assert.equal(lastBody().messages?.at(-1)?.role, 'user')
  })
})

describe('plan mode: the grammar request and its plain shape', () => {
  test('today: the grammar, no shape in the prompt', () => {
    const r = plan.planRequest('m', 'Plan a trip', 6, undefined, ['web_search'])
    assert.equal(r.jsonSchema?.name, 'task_plan')
    assert.doesNotMatch(r.messages[0]!.content, /exactly this shape/)
    assert.equal(r.thinking, false)
    assert.equal(r.maxTokens, undefined)
  })

  test('plain: no grammar, the shape in the prompt — with the tools field only when tools are enabled', () => {
    const none = plan.planRequest('m', 'Plan a trip', 6, undefined, [], true)
    assert.equal(none.jsonSchema, undefined)
    assert.match(none.messages[0]!.content, /exactly this shape: \{"steps":\[\{"title":"\.\.\.","detail":"\.\.\."\}\]\}/)
    const some = plan.planRequest('m', 'Plan a trip', 6, undefined, ['web_search'], true)
    assert.match(some.messages[0]!.content, /"detail":"\.\.\.","tools":\["\.\.\."\]\}\]\}/)
    assert.match(some.messages[0]!.content, /These tools are enabled: web_search/)
    assert.equal(some.thinking, false)
  })

  test('the reader keeps only enabled tools, caps the steps, and returns null for none', () => {
    const steps = plan.stepsFromPayload({ steps: [{ title: 'a', detail: 'b', tools: ['web_search', 'x'] }, { title: 'c', detail: 'd' }] }, 1, new Set(['web_search']))
    assert.deepEqual(steps, [{ title: 'a', detail: 'b', tools: ['web_search'] }])
    assert.equal(plan.stepsFromPayload({ steps: [{ title: '', detail: 'x' }] }, 6, new Set()), null)
    assert.equal(plan.stepsFromPayload(null, 6, new Set()), null)
  })
})

describe('the outline: the grammar request and its plain shape', () => {
  test('today: the grammar and the 1,500-token cap; plain: the shape in the prompt and the same cap', () => {
    const today = outline.outlineRequest('m', 'Write a 1,500-word report on heat pumps.')
    assert.equal(today.jsonSchema?.name, 'document_outline')
    assert.equal(today.maxTokens, outline.OUTLINE_MAX_TOKENS)
    assert.equal(today.timeoutMs, outline.OUTLINE_TIMEOUT_MS)
    assert.doesNotMatch(today.messages[0]!.content, /exactly this shape/)
    const plain = outline.outlineRequest('m', 'Write a 1,500-word report on heat pumps.', undefined, true)
    assert.equal(plain.jsonSchema, undefined)
    assert.equal(plain.maxTokens, outline.OUTLINE_MAX_TOKENS)
    assert.equal(plain.timeoutMs, outline.OUTLINE_TIMEOUT_MS)
    assert.match(plain.messages[0]!.content, /exactly this shape: \{"title":"\.\.\.","sections":\[\{"heading":"\.\.\.","brief":"\.\.\."\}\]\}/)
  })

  test('the section calls already carry the closed block on a <think> family — they never paired a grammar with it', async () => {
    state.completions = ['A section about it.']
    await outline.writeOutlined({
      model: THINK_MODEL,
      persona: 'You write.',
      request: 'Write a 600-word note. Sections: One, Two, Three.'
    })
    const first = state.completionBodies[0] as Body
    assert.equal(first.response_format, undefined)
    assert.equal(first.messages?.at(-1)?.role, 'assistant')
    assert.match(first.messages?.at(-1)?.content ?? '', CLOSED)
  })
})

describe('deep research: the planner and the reformulation', () => {
  test('today: the grammars and the budgets; plain: no grammar, the budgets and the prompts unchanged', () => {
    const p = research.plannerRequest('How do retries work?', 'm')
    const pp = research.plannerRequest('How do retries work?', 'm', undefined, true)
    assert.equal(p.jsonSchema?.name, 'research_plan')
    assert.equal(p.maxTokens, 700)
    assert.equal(pp.jsonSchema, undefined)
    assert.equal(pp.maxTokens, 700)
    assert.deepEqual(pp.messages, p.messages, 'the prompt already says the shape')
    const open = [{ question: 'q1', queries: ['one'] }]
    const r = research.reformulateRequest(open, 'm')
    const rp = research.reformulateRequest(open, 'm', undefined, true)
    assert.equal(r.jsonSchema?.name, 'research_reformulate')
    assert.equal(r.maxTokens, 400)
    assert.equal(rp.jsonSchema, undefined)
    assert.equal(rp.maxTokens, 400)
    assert.deepEqual(rp.messages, r.messages)
  })

  test('the reformulation reader maps by order, caps, and hands back the old queries where the reply holds none', () => {
    const open = [
      { question: 'q1', queries: ['old one'] },
      { question: 'q2', queries: ['old two'] }
    ]
    const out = research.queriesFromReformulation({ queries: [{ queries: ['a', 'b', 'c'] }, { queries: [] }] }, open)
    assert.deepEqual(out, [['a', 'b'], ['old two']])
    assert.equal(out[1], open[1]!.queries, 'the same array: the probe counts a fallback by identity')
    assert.deepEqual(research.queriesFromReformulation(null, open), [['old one'], ['old two']])
  })
})

/**
 * The wired callers. On a `<think>` family plan mode, the outline and deep
 * research's planner ask plainly (measured on the 9B: valid either way for plan
 * and research, 3/12 against 12/12 for the outline, and faster in all three);
 * the reformulation keeps the grammar (plain was 9/12 against 11/12). A family
 * without think tags gets today's request, byte for byte.
 */
describe('which model gets which request', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'plannerRequests', 'gemma-grammar-bodies.json'), 'utf8')) as { bodies: Record<string, string[]> }
  const PLAN_JSON = '{"steps":[{"title":"a","detail":"b"}]}'
  const OUTLINE_JSON = '{"title":"T","sections":[{"heading":"a","brief":"b"},{"heading":"c","brief":"d"},{"heading":"e","brief":"f"}]}'
  const PLANNED = '{"subQuestions":[{"question":"q","queries":["a"]}]}'
  const REFORMULATED = '{"queries":[{"queries":["x"]}]}'

  const callers: Record<string, (model: string) => Promise<unknown>> = {
    'plan+tools+context': async (model) => {
      state.completions = [PLAN_JSON]
      return plan.generatePlan('Plan a weekend in Paris', model, 6, 'User: hi\nAssistant: hello', ['web_search', 'read_file'])
    },
    plan: async (model) => {
      state.completions = [PLAN_JSON]
      return plan.generatePlan('Plan a weekend in Paris', model, 6)
    },
    outline: async (model) => {
      state.completions = [OUTLINE_JSON]
      return outline.generateOutline({ model, persona: 'p', request: 'Write a 1,500-word report on heat pumps.' })
    },
    'research plan': async (model) => {
      state.completions = [PLANNED]
      return research.makePlan('How do retries work?', model)
    },
    reformulate: async (model) => {
      state.completions = [REFORMULATED]
      return research.reformulateQueries([{ question: 'q1', queries: ['one'] }], model)
    }
  }

  for (const [name, call] of Object.entries(callers)) {
    test(`${name}: a family without think tags is sent today's request, byte for byte`, async () => {
      await call(GEMMA)
      assert.deepEqual(
        state.completionBodies.map((b) => JSON.stringify(b)),
        fixture.bodies[name],
        'what a non-think family is asked changed'
      )
    })
  }

  for (const name of ['plan+tools+context', 'plan', 'outline', 'research plan']) {
    test(`${name}: a <think> family is asked plainly — no grammar, the closed block last, the budget as before`, async () => {
      await callers[name]!(THINK_MODEL)
      assert.equal(state.completionBodies.length, 1)
      const body = lastBody()
      assert.equal(body.response_format, undefined)
      assert.equal(body.messages?.at(-1)?.role, 'assistant')
      assert.match(body.messages?.at(-1)?.content ?? '', CLOSED)
      const grammar = JSON.parse(fixture.bodies[name]![0]!) as Body
      assert.equal(body.max_tokens, grammar.max_tokens, 'the token budget is not what changed')
      assert.equal(body.temperature, grammar.temperature)
    })
  }

  test('plan mode and the outline say the shape in the prompt when the grammar no longer does', async () => {
    await callers['plan']!(THINK_MODEL)
    assert.match(lastBody().messages?.[0]?.content ?? '', /exactly this shape: \{"steps"/)
    resetState()
    await callers['outline']!(THINK_MODEL)
    assert.match(lastBody().messages?.[0]?.content ?? '', /exactly this shape: \{"title"/)
  })

  test('the reformulation keeps the grammar on a <think> family: plain read worse on the 9B', async () => {
    await callers['reformulate']!(THINK_MODEL)
    assert.equal(lastBody().response_format?.json_schema?.name, 'research_reformulate')
    assert.equal(lastBody().messages?.at(-1)?.role, 'user')
  })

  test('a plain reply is parsed tolerantly: a fenced plan with prose around it', async () => {
    state.completions = [`Here is the plan:\n\`\`\`json\n${PLAN_JSON}\n\`\`\`\n`]
    const steps = await plan.generatePlan('Plan a weekend in Paris', THINK_MODEL, 6)
    assert.equal(steps?.length, 1)
  })

  test('a <think> family whose server cannot take the plain request still fails loudly, not silently', async () => {
    state.failCompletions = true
    await assert.rejects(() => plan.generatePlan('Plan a weekend in Paris', THINK_MODEL, 6))
  })
})
