import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  answerRecords,
  runPlanStep,
  stepRecords
} from '../src/renderer/src/hooks/planMode'
import type {
  Conversation,
  ModelConfig,
  ToolCallRecord,
  ToolSchema
} from '../src/renderer/src/types'

/**
 * v1.12.2: a plan step's tool calls are as visible as an ordinary turn's.
 *
 * Through v1.12.1 `runPlanStep` handed the agent loop `records: []` — a
 * throwaway array nobody read back — so a six-step plan could run twenty
 * searches and the message showed zero tool-call blocks. With the audit log
 * shipping disabled, that work was recorded nowhere the user could reach.
 *
 * The step now writes into the message's own record list, tagging each call
 * with the step that made it. These tests drive the real `runPlanStep` — the
 * real agent loop, the real SSE transport — against a stubbed LM Studio.
 */

// ---- stub LM Studio + preload bridge -----------------------------------------

type Frame = Record<string, unknown>

/** One /chat/completions reply, as the SSE frames LM Studio streams. */
function sse(...frames: Frame[]): Response {
  const body = `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

const callFrame = (id: string, name: string, args: Record<string, unknown>): Frame => ({
  choices: [
    {
      delta: {
        tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }]
      }
    }
  ]
})

const textFrame = (content: string): Frame => ({ choices: [{ delta: { content } }] })

const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window

/** Queue the rounds this stub will answer, in order, and record tool executions. */
function stubLMStudio(rounds: Response[]): { executed: string[] } {
  const queue = [...rounds]
  const executed: string[] = []
  globalThis.fetch = (async () => {
    const next = queue.shift()
    assert.ok(next, 'the stub ran out of queued rounds')
    return next
  }) as typeof fetch
  ;(globalThis as { window?: unknown }).window = {
    api: {
      executeTool: async (name: string, args: Record<string, unknown>) => {
        executed.push(name)
        return { ok: true, output: `${name} ran with ${JSON.stringify(args)}` }
      }
    }
  }
  return { executed }
}

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

// ---- fixtures ----------------------------------------------------------------

const slot: ModelConfig = {
  id: 'slot-1',
  modelId: 'qwen3.8-9b',
  roleName: 'Sigma',
  systemPrompt: 'You are helpful.',
  color: 'green',
  enabled: true,
  sampling: { temperature: 0, topP: 1, maxTokens: -1, seed: 7, topK: -1, minP: -1 },
  contextWindow: null
}

const convo: Conversation = {
  id: 'convo-1',
  title: 'tides',
  mode: 'independent',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

const searchTool: ToolSchema = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for' } },
      required: ['query']
    }
  }
}

function step(
  stepId: string,
  input: string,
  records: ToolCallRecord[],
  onChange: () => void
): Promise<string> {
  return runPlanStep(
    slot,
    input,
    'http://localhost:1234/v1',
    [searchTool],
    new AbortController().signal,
    convo,
    '',
    { stepId, records, onChange }
  )
}

// ---- the eval ----------------------------------------------------------------

describe('a plan step’s tool calls reach the message', () => {
  test('an executed call lands in the message’s record list, tagged with its step', async () => {
    const { executed } = stubLMStudio([
      sse(callFrame('call-1', 'web_search', { query: 'ocean city tide tables' })),
      sse(textFrame('Low tide is at 06:12.'))
    ])

    const records: ToolCallRecord[] = []
    let patches = 0
    const output = await step('step-a', 'Step 1 of 2: find the tide times', records, () => {
      patches += 1
    })

    assert.deepEqual(executed, ['web_search'])
    // The gap this closes: through v1.12.1 this list was `[]` and stayed empty.
    assert.equal(records.length, 1)
    assert.equal(records[0].name, 'web_search')
    assert.equal(records[0].status, 'done')
    assert.deepEqual(records[0].args, { query: 'ocean city tide tables' })
    assert.match(records[0].result ?? '', /web_search ran with/)
    // Tagged, so the plan block can show it under the step that made it.
    assert.equal(records[0].planStepId, 'step-a')
    // Patched at creation and again at completion: the call is visible while it
    // runs, not only once the step is finished.
    assert.ok(patches >= 2, `expected at least 2 UI patches, got ${patches}`)
    assert.match(output, /Low tide/)
  })

  test('each step keeps its own calls; none float into the answer’s list', async () => {
    stubLMStudio([
      sse(callFrame('call-1', 'web_search', { query: 'tide tables' })),
      sse(textFrame('06:12.')),
      sse(callFrame('call-2', 'web_search', { query: 'sunrise' })),
      sse(callFrame('call-3', 'web_search', { query: 'sunset' })),
      sse(textFrame('05:58 and 20:14.'))
    ])

    const records: ToolCallRecord[] = []
    const noop = (): void => {}
    await step('step-a', 'Step 1 of 2: find the tide times', records, noop)
    await step('step-b', 'Step 2 of 2: find the light', records, noop)

    assert.equal(records.length, 3)
    assert.equal(stepRecords(records, 'step-a').length, 1)
    assert.equal(stepRecords(records, 'step-b').length, 2)
    // The message's own block shows the answer's calls, not the plan's — which
    // is what keeps twenty step calls a checklist rather than a wall.
    assert.equal(answerRecords(records).length, 0)
    assert.deepEqual(
      stepRecords(records, 'step-b').map((r) => r.args.query),
      ['sunrise', 'sunset']
    )
  })
})
