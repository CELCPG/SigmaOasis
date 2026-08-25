import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { reviseAgainstFindings } from '../src/renderer/src/hooks/verification'
import type { ApiToolCall } from '../src/renderer/src/lib/agentLoop'
import type {
  Conversation,
  GroundingReport,
  ModelConfig,
  ToolCallRecord,
  ToolSchema
} from '../src/renderer/src/types'

/**
 * The grounding correction pass runs with the slot's real tools, and every call
 * it makes is appended to the turn's own record list — the same corpus the
 * re-check grades the revision against. So a call that joins the corpus without
 * joining the rendered transcript lets a figure the first check flagged be
 * certified by a passage the reader never sees, with the disclosure line then
 * reporting the finding as cleared.
 *
 * Measured in .h2h-runs/judge-r4/V1/run-1: the reply states 165°F / 74°C, none
 * of the five rendered passages contains "165" or "74", re-running the checker
 * on the shipped answer against the rendered passages still reports
 * quantities: ["165°F"] — yet the app adopted the revision and printed a
 * resolution. The pass had looked the figure up a second time and shown no one.
 *
 * `streamChat` and `window.api` are the pass's only two runtime seams; both are
 * replaced here, so the wiring under test is the code that ships.
 */

/** One scripted model round: what it streams, and what it calls. */
interface Round {
  content: string
  toolCalls: ApiToolCall[]
}

/** Every publish the pass made, in order, each a snapshot of the record list. */
let publishes: ToolCallRecord[][]

/**
 * Records are mutated in place as they run, and the app's publish is a shallow
 * array copy — right for rendering, useless for observing order after the fact.
 * Clone each record so a snapshot keeps the status it was published with.
 */
function snapshot(records: ToolCallRecord[]): void {
  publishes.push(records.map((r) => ({ ...r })))
}
/** Tool calls the pass actually executed. */
let executed: { name: string; args: Record<string, unknown> }[]

function scriptRounds(rounds: Round[]): void {
  // TS emits `chatTransport_1.streamChat(...)` for the named import, so the
  // export is read at call time and swapping it here reaches the real caller.
  const transport = require('../src/renderer/src/hooks/chatTransport') as {
    streamChat: unknown
  }
  transport.streamChat = async (
    _baseUrl: string,
    _modelId: string,
    _messages: unknown,
    _tools: unknown,
    _signal: AbortSignal,
    onContent: (chunk: string) => void
  ): Promise<{ toolCalls: ApiToolCall[]; usage: null; ttftMs: null; truncated: boolean }> => {
    const round = rounds.shift() ?? { content: '', toolCalls: [] }
    if (round.content) onContent(round.content)
    return { toolCalls: round.toolCalls, usage: null, ttftMs: null, truncated: false }
  }
}

const LOOKUP: ToolSchema = {
  type: 'function',
  function: {
    name: 'search_docs',
    description: 'Search the loaded document packs.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
}

const SLOT: ModelConfig = {
  id: 'slot-1',
  modelId: 'test-model',
  roleName: 'Cook',
  systemPrompt: 'You answer food-safety questions.',
  color: 'blue',
  enabled: true,
  sampling: { temperature: 0, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 },
  contextWindow: null,
  tools: ['search_docs']
}

const CONVO: Conversation = {
  id: 'c1',
  title: 'Chicken',
  mode: 'independent',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

/** The first check's finding: a temperature no rendered passage supports. */
const REPORT: GroundingReport = {
  figures: [],
  links: [],
  quantities: ['165°F'],
  checkedAgainst: ['search_docs']
}

beforeEach(() => {
  publishes = []
  executed = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      executeTool: async (name: string, args: Record<string, unknown>) => {
        executed.push({ name, args })
        return {
          ok: true,
          output: 'Poultry, all cuts: cook to a safe minimum internal temperature of 165°F (74°C).'
        }
      }
    }
  }
})

/** The turn's already-rendered lookup, which does not mention the figure. */
function priorRecords(): ToolCallRecord[] {
  return [
    {
      id: 'call-1',
      name: 'search_docs',
      args: { query: 'roast chicken resting time' },
      status: 'done',
      result: 'Rest the bird for 15 minutes before carving.'
    }
  ]
}

async function runCorrection(records: ToolCallRecord[]): Promise<string> {
  scriptRounds([
    {
      content: 'Let me confirm the temperature.',
      toolCalls: [
        {
          id: 'call-2',
          type: 'function',
          function: {
            name: 'search_docs',
            arguments: JSON.stringify({ query: 'safe minimum internal temperature poultry' })
          }
        }
      ]
    },
    { content: 'Cook chicken to 165°F (74°C).', toolCalls: [] }
  ])
  return reviseAgainstFindings(
    SLOT,
    'http://localhost:1234',
    [LOOKUP],
    new AbortController().signal,
    CONVO,
    'Cook chicken to 165°F (74°C).',
    REPORT,
    records,
    () => snapshot(records)
  )
}

describe('correction-pass tool calls reach the transcript', () => {
  test('a lookup made while correcting is published, not only recorded', async () => {
    const records = priorRecords()
    const revised = await runCorrection(records)

    // Preconditions: the pass ran a real lookup and it joined the corpus the
    // re-check grades against. Without these the case proves nothing.
    assert.equal(revised, 'Cook chicken to 165°F (74°C).')
    assert.deepEqual(executed, [
      { name: 'search_docs', args: { query: 'safe minimum internal temperature poultry' } }
    ])
    assert.equal(records.length, 2, 'the correction-pass call joined the evidence corpus')

    // The claim: what the reader sees is what the checker read. A publish that
    // never happened leaves the message showing one passage while two decide
    // the badge.
    const shown = publishes[publishes.length - 1]
    assert.ok(shown, 'the correction pass published its records at least once')
    assert.deepEqual(
      shown.map((r) => r.id),
      records.map((r) => r.id)
    )
    assert.equal(shown[1]!.result, records[1]!.result)
  })

  test('the call renders while it runs, as every other tool call does', async () => {
    const records = priorRecords()
    await runCorrection(records)

    // Every other tool path publishes on creation and again on completion, so
    // the block appears the moment the call starts. Publishing only the
    // finished record would hide a lookup that hangs or is aborted mid-flight —
    // exactly the one worth seeing.
    const running = publishes.find((snap) => snap.some((r) => r.id === 'call-2' && r.status === 'running'))
    assert.ok(running, 'the correction-pass call was published while still running')
    const done = publishes[publishes.length - 1]!.find((r) => r.id === 'call-2')
    assert.equal(done?.status, 'done')
  })

  test('a correction pass that calls no tool publishes nothing', async () => {
    const records = priorRecords()
    scriptRounds([{ content: 'Cook chicken until the juices run clear.', toolCalls: [] }])
    const revised = await reviseAgainstFindings(
      SLOT,
      'http://localhost:1234',
      [LOOKUP],
      new AbortController().signal,
      CONVO,
      'Cook chicken to 165°F (74°C).',
      REPORT,
      records,
      () => snapshot(records)
    )

    assert.equal(revised, 'Cook chicken until the juices run clear.')
    assert.equal(records.length, 1)
    assert.deepEqual(publishes, [])
  })
})
