import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  runAgentLoop,
  consultModelSchema,
  MAX_TOOL_ITERATIONS,
  MAX_DELEGATIONS_PER_TURN,
  type AgentLoopDeps,
  type ApiMessage,
  type ApiToolCall,
  type SpecialistProfile,
  type StreamRoundResult
} from '../src/renderer/src/lib/agentLoop'
import type { ToolCallRecord, ToolSchema } from '../src/renderer/src/types'

/**
 * The agent loop is the one piece of turn logic the v1.2 checklist demands be
 * reachable from node:test. These tests pin its mechanics — round handling,
 * tool execution, wire-history shape, the delegation cap, abort and the
 * iteration cap — against scripted completions, so Layers 1–3 of the routing
 * strategy have a state machine they can change without guessing.
 */

function call(id: string, name: string, args: unknown): ApiToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

const TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: { name: 'web_search', description: 'Search the web.', parameters: {} }
  }
]

/** A streamer that replays scripted rounds in order, then ends cleanly. */
function scripted(rounds: StreamRoundResult[]): {
  streamRound: AgentLoopDeps['streamRound']
  seen: ApiMessage[][]
} {
  const seen: ApiMessage[][] = []
  return {
    seen,
    streamRound: async (messages) => {
      // Snapshot: the loop mutates the history in place between rounds.
      seen.push(messages.map((m) => ({ ...m })))
      return rounds.shift() ?? { content: 'done', toolCalls: [] }
    }
  }
}

function baseMessages(): ApiMessage[] {
  return [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' }
  ]
}

describe('runAgentLoop', () => {
  test('a round with no tool calls completes without touching tools', async () => {
    const { streamRound } = scripted([{ content: 'answer', toolCalls: [] }])
    const records: ToolCallRecord[] = []
    let executed = 0
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: '' }
        }
      }
    })
    assert.equal(outcome.stopReason, 'completed')
    assert.equal(executed, 0)
    assert.equal(records.length, 0)
  })

  test('a tool call executes and its result re-enters the wire history', async () => {
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: [call('c1', 'web_search', { query: 'Phish Hampton 1997' })] },
      { content: 'They played…', toolCalls: [] }
    ])
    const records: ToolCallRecord[] = []
    const got: { name: string; args: Record<string, unknown> }[] = []
    const messages = baseMessages()
    const outcome = await runAgentLoop({
      messages,
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async (name, args) => {
          got.push({ name, args })
          return { ok: true, output: 'setlist results' }
        }
      }
    })
    assert.equal(outcome.stopReason, 'completed')
    assert.deepEqual(got, [{ name: 'web_search', args: { query: 'Phish Hampton 1997' } }])

    // The visible record ran to completion.
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'done')
    assert.equal(records[0].result, 'setlist results')

    // Round 2 saw: system, user, assistant-with-tool-calls, tool result.
    const round2 = seen[1]
    assert.equal(round2.length, 4)
    assert.equal(round2[2].role, 'assistant')
    assert.equal(round2[2].tool_calls?.[0].id, 'c1')
    assert.deepEqual(round2[3], { role: 'tool', tool_call_id: 'c1', content: 'setlist results' })
  })

  test('malformed arguments get a repair message and never execute (Layer 3a)', async () => {
    const bad: ApiToolCall = { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{not json' } }
    const { streamRound, seen } = scripted([{ content: '', toolCalls: [bad] }])
    let executed = 0
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'ok' }
        }
      }
    })
    assert.equal(executed, 0)
    assert.equal(records[0].status, 'error')
    assert.match(records[0].result ?? '', /^Malformed arguments for web_search: not valid JSON/)
    // The repair message feeds back as the tool result so the model can fix it.
    assert.match(String(seen[1][3].content), /^Error: Malformed arguments for web_search/)
  })

  test('a tool error is recorded and fed back prefixed with "Error:"', async () => {
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: [call('c1', 'web_search', { query: 'x' })] }
    ])
    const records: ToolCallRecord[] = []
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => ({ ok: false, error: 'provider down' })
      }
    })
    assert.equal(outcome.stopReason, 'completed') // the next scripted round ends cleanly
    assert.equal(records[0].status, 'error')
    assert.equal(records[0].result, 'provider down')
    assert.equal(seen[1][3].content, 'Error: provider down')
  })

  test('records the caller already had keep their position; loop appends', async () => {
    const preexisting: ToolCallRecord = {
      id: 'auto',
      name: 'web_search',
      args: { query: 'auto' },
      status: 'done',
      result: 'app-run search'
    }
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'web_search', { query: 'y' })] }
    ])
    const records: ToolCallRecord[] = [preexisting]
    let changes = 0
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      onRecordChange: () => {
        changes += 1
      },
      deps: {
        streamRound,
        executeTool: async () => ({ ok: true, output: 'ok' })
      }
    })
    assert.equal(records[0], preexisting)
    assert.equal(records.length, 2)
    // One notification when the record appears, one when it resolves.
    assert.equal(changes, 2)
  })

  test('the iteration cap stops the turn but still executes the last round’s calls', async () => {
    // Every round asks for a tool; the streamer never runs out of script.
    const rounds: StreamRoundResult[] = Array.from({ length: MAX_TOOL_ITERATIONS }, (_, i) => ({
      content: '',
      toolCalls: [call(`c${i}`, 'web_search', { query: `q${i}` })]
    }))
    const { streamRound } = scripted(rounds)
    let executed = 0
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records: [],
      signal: new AbortController().signal,
      // Cap behavior, isolated: per-tool budgets are Layer 3c's concern.
      toolBudgets: {},
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'ok' }
        }
      }
    })
    assert.equal(outcome.stopReason, 'iteration_cap')
    assert.equal(executed, MAX_TOOL_ITERATIONS)
  })

  test('a custom cap bounds plan-step-style sub-turns', async () => {
    const rounds: StreamRoundResult[] = Array.from({ length: 10 }, (_, i) => ({
      content: '',
      toolCalls: [call(`c${i}`, 'web_search', { query: `q${i}` })]
    }))
    const { streamRound } = scripted(rounds)
    let executed = 0
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records: [],
      signal: new AbortController().signal,
      maxIterations: 4,
      // Cap behavior, isolated: distinct args dodge repeat detection, and
      // per-tool budgets are Layer 3c's concern.
      toolBudgets: {},
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'ok' }
        }
      }
    })
    assert.equal(outcome.stopReason, 'iteration_cap')
    assert.equal(executed, 4)
  })

  test('an abort between rounds unwinds without executing pending calls', async () => {
    const controller = new AbortController()
    const streamRound: AgentLoopDeps['streamRound'] = async () => {
      controller.abort()
      return { content: '', toolCalls: [call('c1', 'web_search', { query: 'x' })] }
    }
    let executed = 0
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records: [],
      signal: controller.signal,
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'ok' }
        }
      }
    })
    assert.equal(outcome.stopReason, 'aborted')
    assert.equal(executed, 0)
  })

  test('onToolExecuted fires for every executed call with its outcome', async () => {
    const { streamRound } = scripted([
      {
        content: '',
        toolCalls: [
          call('c1', 'web_search', { query: 'a' }),
          call('c2', 'web_search', { query: 'b' })
        ]
      }
    ])
    const audited: { name: string; ok: boolean }[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records: [],
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async (_n, args) =>
          args.query === 'a' ? { ok: true, output: 'A' } : { ok: false, error: 'nope' },
        onToolExecuted: (record, result) => audited.push({ name: record.name, ok: result.ok })
      }
    })
    assert.deepEqual(audited, [
      { name: 'web_search', ok: true },
      { name: 'web_search', ok: false }
    ])
  })
})

describe('runAgentLoop · consult_model', () => {
  const CODER: SpecialistProfile = {
    roleName: 'Coder',
    systemPrompt: 'You write code.',
    tools: ['read_file'],
    context: '32K',
    vision: false
  }
  const CONSULT_TOOLS: ToolSchema[] = [...TOOLS, consultModelSchema([CODER])]

  test('routes to the consult dep, not executeTool', async () => {
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: [call('c1', 'consult_model', { role: 'Coder', task: 'fix the bug' })] }
    ])
    const consulted: { role: string; task: string }[] = []
    let ipcCalls = 0
    await runAgentLoop({
      messages: baseMessages(),
      tools: CONSULT_TOOLS,
      records: [],
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => {
          ipcCalls += 1
          return { ok: true, output: '' }
        },
        consult: async (role, task) => {
          consulted.push({ role, task })
          return { ok: true, output: 'specialist reply' }
        }
      }
    })
    assert.deepEqual(consulted, [{ role: 'Coder', task: 'fix the bug' }])
    assert.equal(ipcCalls, 0)
    assert.equal(seen[1][3].content, 'specialist reply')
  })

  test('the delegation cap refuses further consults with a synthesize instruction', async () => {
    // One consult per round, more rounds than the cap allows.
    const rounds: StreamRoundResult[] = Array.from(
      { length: MAX_DELEGATIONS_PER_TURN + 1 },
      (_, i) => ({
        content: '',
        toolCalls: [call(`c${i}`, 'consult_model', { role: 'Coder', task: `task ${i}` })]
      })
    )
    const { streamRound, seen } = scripted(rounds)
    let consults = 0
    const records: ToolCallRecord[] = []
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: CONSULT_TOOLS,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => ({ ok: true, output: '' }),
        consult: async () => {
          consults += 1
          return { ok: true, output: 'reply' }
        }
      }
    })
    // The cap refused the (cap+1)-th call; that refusal fed back as the tool
    // result, and the unscripted next round ended the turn cleanly.
    assert.equal(outcome.stopReason, 'completed')
    assert.equal(consults, MAX_DELEGATIONS_PER_TURN)
    const refused = records[MAX_DELEGATIONS_PER_TURN]
    assert.equal(refused.status, 'error')
    assert.match(refused.result ?? '', /Delegation limit reached \(5 consultations per turn\)/)
    const lastRound = seen[seen.length - 1]
    const lastTool = lastRound[lastRound.length - 1]
    assert.match(String(lastTool.content), /^Error: Delegation limit reached/)
  })

  test('without a consult dep, consult_model falls through to executeTool', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'consult_model', { role: 'Coder', task: 'x' })] }
    ])
    const ipc: string[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS, // no consult_model on the wire — a model calling it anyway
      records: [],
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async (name) => {
          ipc.push(name)
          return { ok: false, error: 'Unknown tool: consult_model' }
        }
      }
    })
    assert.deepEqual(ipc, ['consult_model'])
  })
})

describe('consultModelSchema', () => {
  test('the roster is structured profile lines, enum-constrained (Layer 2a)', () => {
    const schema = consultModelSchema([
      {
        roleName: 'Coder',
        capability: 'send me: debugging and refactors; don\'t send me: research',
        systemPrompt: 'ignored when capability is set',
        tools: ['read_file', 'write_file'],
        context: '32K',
        vision: false
      },
      {
        roleName: 'Scout',
        systemPrompt: 'y'.repeat(300),
        tools: []
      }
    ])
    assert.equal(schema.function.name, 'consult_model')
    const params = schema.function.parameters as {
      properties: { role: { enum: string[] }; task: { description: string } }
      required: string[]
    }
    assert.deepEqual(params.properties.role.enum, ['Coder', 'Scout'])
    assert.deepEqual(params.required, ['role', 'task'])

    const desc = schema.function.description
    // A capability declaration wins over the persona slice.
    assert.ok(
      desc.includes(
        'Coder — send me: debugging and refactors; don\'t send me: research ' +
          'Tools: read_file, write_file. Context: 32K. Vision: no.'
      )
    )
    // Without a capability the roster falls back to 140 chars of persona,
    // with unknown context and no vision as the defaults.
    assert.ok(desc.includes('Scout — ' + 'y'.repeat(140) + ' Tools: none. Context: unknown. Vision: no.'))
    assert.ok(!desc.includes('y'.repeat(141)))
  })
})

describe('runAgentLoop · tool-call preamble (Layer 1d)', () => {
  test('a short text round that calls tools attaches its text as the preamble', async () => {
    const { streamRound } = scripted([
      { content: 'I need to check the web because this is a recent fact.', toolCalls: [call('c1', 'web_search', { query: 'x' })] }
    ])
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      deps: { streamRound, executeTool: async () => ({ ok: true, output: 'ok' }) }
    })
    assert.equal(records[0].preamble, 'I need to check the web because this is a recent fact.')
  })

  test('a long text round is answer content, not a preamble', async () => {
    const { streamRound } = scripted([
      { content: 'x'.repeat(500), toolCalls: [call('c1', 'web_search', { query: 'x' })] }
    ])
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      deps: { streamRound, executeTool: async () => ({ ok: true, output: 'ok' }) }
    })
    assert.equal(records[0].preamble, undefined)
  })

  test('a round with no text attaches nothing', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'web_search', { query: 'x' })] }
    ])
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      deps: { streamRound, executeTool: async () => ({ ok: true, output: 'ok' }) }
    })
    assert.equal(records[0].preamble, undefined)
  })
})


// ---- Layer 3: repair and budget the loop --------------------------------------

const READ_FILE: ToolSchema = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  }
}

describe('runAgentLoop · argument validation and repair (Layer 3a)', () => {
  test('schema-invalid args get a named repair message and never dispatch', async () => {
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: [call('c1', 'read_file', {})] }
    ])
    let executed = 0
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: [READ_FILE],
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'contents' }
        }
      }
    })
    assert.equal(executed, 0)
    assert.equal(records[0].status, 'error')
    assert.match(records[0].result ?? '', /^Invalid arguments for read_file:/)
    assert.match(records[0].result ?? '', /path/)
    assert.match(String(seen[1][3].content), /^Error: Invalid arguments for read_file:/)
  })

  test('a repaired call succeeds within the free repair iteration', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'read_file', {})] }, // invalid
      { content: '', toolCalls: [call('c2', 'read_file', { path: 'a.txt' })] } // repaired
      // unscripted third round ends the turn cleanly
    ])
    const got: Record<string, unknown>[] = []
    let roundsStreamed = 0
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: [READ_FILE],
      records: [],
      signal: new AbortController().signal,
      maxIterations: 2, // without the free repair round the cap eats the clean-up round
      deps: {
        streamRound: async (messages) => {
          roundsStreamed += 1
          return streamRound(messages, [])
        },
        executeTool: async (_name, args) => {
          got.push(args)
          return { ok: true, output: 'contents' }
        }
      }
    })
    // 2 cap rounds + the free repair round let the loop see the clean ending.
    assert.equal(roundsStreamed, 3)
    assert.equal(outcome.stopReason, 'completed')
    assert.deepEqual(got, [{ path: 'a.txt' }])
  })

  test('the default repair allowance extends the cap once after an argument failure', async () => {
    const rounds: StreamRoundResult[] = Array.from({ length: 10 }, (_, i) => ({
      content: '',
      toolCalls: [call(`c${i}`, 'read_file', i === 0 ? {} : { path: `f${i}.txt` })]
    }))
    const { streamRound } = scripted(rounds)
    let roundsStreamed = 0
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: [READ_FILE],
      records: [],
      signal: new AbortController().signal,
      maxIterations: 3,
      deps: {
        streamRound: async (messages) => {
          roundsStreamed += 1
          return streamRound(messages, [])
        },
        executeTool: async () => ({ ok: true, output: 'ok' })
      }
    })
    // 3 cap rounds + 1 free repair round, then the cap still stops the turn.
    assert.equal(roundsStreamed, 4)
    assert.equal(outcome.stopReason, 'iteration_cap')
  })

  test('tools without a wire schema are not validated — they keep the executor error path', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'mystery_tool', { anything: 1 })] }
    ])
    const calls: string[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: [READ_FILE], // mystery_tool is not on the wire list
      records: [],
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async (name) => {
          calls.push(name)
          return { ok: false, error: `Unknown tool: ${name}` }
        }
      }
    })
    assert.deepEqual(calls, ['mystery_tool'])
  })
})

describe('runAgentLoop · repeat detection (Layer 3b)', () => {
  test('the same call with the same args reuses its result instead of re-running', async () => {
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: [call('c1', 'read_file', { path: 'a.txt' })] },
      { content: '', toolCalls: [call('c2', 'read_file', { path: 'a.txt' })] }
    ])
    let executed = 0
    await runAgentLoop({
      messages: baseMessages(),
      tools: [READ_FILE],
      records: [],
      signal: new AbortController().signal,
      toolBudgets: {},
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'file contents' }
        }
      }
    })
    assert.equal(executed, 1)
    // The reused result feeds back with the disclosure note attached.
    const secondResult = seen[2][5].content
    assert.match(String(secondResult), /^file contents/)
    assert.match(String(secondResult), /result reused, not re-executed/)
  })

  test('argument key order does not matter', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'read_file', { path: 'a.txt', extra: 1 })] },
      { content: '', toolCalls: [call('c2', 'read_file', { extra: 1, path: 'a.txt' })] }
    ])
    let executed = 0
    await runAgentLoop({
      messages: baseMessages(),
      tools: [READ_FILE],
      records: [],
      signal: new AbortController().signal,
      toolBudgets: {},
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'ok' }
        }
      }
    })
    assert.equal(executed, 1)
  })

  test('the same tool with different args executes every time', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'read_file', { path: 'a.txt' })] },
      { content: '', toolCalls: [call('c2', 'read_file', { path: 'b.txt' })] }
    ])
    let executed = 0
    await runAgentLoop({
      messages: baseMessages(),
      tools: [READ_FILE],
      records: [],
      signal: new AbortController().signal,
      toolBudgets: {},
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'ok' }
        }
      }
    })
    assert.equal(executed, 2)
  })

  test('a repeated failure is not retried either', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'read_file', { path: 'missing.txt' })] },
      { content: '', toolCalls: [call('c2', 'read_file', { path: 'missing.txt' })] }
    ])
    let executed = 0
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: [READ_FILE],
      records,
      signal: new AbortController().signal,
      toolBudgets: {},
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: false, error: 'no such file' }
        }
      }
    })
    assert.equal(executed, 1)
    assert.match(records[1].result ?? '', /not retried/)
  })
})

describe('runAgentLoop · per-tool budgets (Layer 3c)', () => {
  test('the default web_search budget refuses the 4th call, disclosed', async () => {
    const rounds: StreamRoundResult[] = Array.from({ length: 4 }, (_, i) => ({
      content: '',
      toolCalls: [call(`c${i}`, 'web_search', { query: `q${i}` })]
    }))
    const { streamRound } = scripted(rounds)
    let executed = 0
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'results' }
        }
      }
    })
    assert.equal(executed, 3)
    assert.equal(records[3].status, 'error')
    assert.equal(records[3].result, 'web_search budget reached (3 of 3 this turn) — answer from the results you already have, and name plainly what you could not check. Never invent the missing data.')
  })

  test('budgets are per tool, not shared', async () => {
    const bothTools: ToolSchema[] = [
      ...TOOLS,
      {
        type: 'function',
        function: { name: 'fetch_webpage', description: 'Fetch.', parameters: {} }
      }
    ]
    const rounds: StreamRoundResult[] = Array.from({ length: 6 }, (_, i) => ({
      content: '',
      toolCalls:
        i % 2 === 0
          ? [call(`c${i}`, 'web_search', { query: `q${i}` })]
          : [call(`c${i}`, 'fetch_webpage', { url: `https://x/${i}` })]
    }))
    const { streamRound } = scripted(rounds)
    const executed: string[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: bothTools,
      records: [],
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async (name) => {
          executed.push(name)
          return { ok: true, output: 'ok' }
        }
      }
    })
    // web_search 3 of 3 allowed, fetch_webpage 2 of 2 allowed — both budgets hit independently.
    assert.deepEqual(executed, [
      'web_search',
      'fetch_webpage',
      'web_search',
      'fetch_webpage',
      'web_search'
    ])
  })

  test('image_search is budgeted — it fans out to more third parties than any other tool', async () => {
    const imageTools: ToolSchema[] = [
      {
        type: 'function',
        function: { name: 'image_search', description: 'Find pictures.', parameters: {} }
      }
    ]
    const rounds: StreamRoundResult[] = Array.from({ length: 4 }, (_, i) => ({
      content: '',
      toolCalls: [call(`c${i}`, 'image_search', { query: `q${i}` })]
    }))
    const { streamRound } = scripted(rounds)
    let executed = 0
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: imageTools,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'images' }
        }
      }
    })
    assert.equal(executed, 2)
    assert.equal(records[2].status, 'error')
    assert.match(records[2].result ?? '', /image_search budget reached \(2 of 2 this turn\)/)
  })

  test('a caller-provided budget map overrides the defaults', async () => {
    const rounds: StreamRoundResult[] = Array.from({ length: 2 }, (_, i) => ({
      content: '',
      toolCalls: [call(`c${i}`, 'web_search', { query: `q${i}` })]
    }))
    const { streamRound } = scripted(rounds)
    let executed = 0
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      toolBudgets: { web_search: 1 },
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'ok' }
        }
      }
    })
    assert.equal(executed, 1)
    assert.match(records[1].result ?? '', /budget reached \(1 of 1 this turn\)/)
  })

  test('deduped calls do not consume budget — budgets count work, not requests', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'web_search', { query: 'same' })] },
      { content: '', toolCalls: [call('c2', 'web_search', { query: 'same' })] },
      { content: '', toolCalls: [call('c3', 'web_search', { query: 'same' })] },
      { content: '', toolCalls: [call('c4', 'web_search', { query: 'same' })] }
    ])
    let executed = 0
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      toolBudgets: { web_search: 1 },
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'results' }
        }
      }
    })
    // One execution, three reuses — the budget refusal never fires because
    // only one unit of work happened.
    assert.equal(executed, 1)
    assert.ok(records.every((r) => r.status === 'done'))
  })
})

describe('runAgentLoop · display payloads (image_search)', () => {
  const imageTools: ToolSchema[] = [
    {
      type: 'function',
      function: { name: 'image_search', description: 'Find pictures.', parameters: {} }
    }
  ]

  const gallery = [
    { title: 'Stroller', pageUrl: 'https://shop.example/a', dataUrl: 'data:image/jpeg;base64,AAAA' }
  ]

  test('images ride the record and never the wire history', async () => {
    // The split the feature depends on: the model gets a text list it can
    // reason about, the user gets pictures. Putting base64 on the wire would
    // evict the conversation for nothing the model can read.
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: [call('c1', 'image_search', { query: 'stroller' })] },
      { content: 'here they are', toolCalls: [] }
    ])
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: imageTools,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => ({ ok: true, output: '1. Stroller', images: gallery })
      }
    })

    assert.deepEqual(records[0].images, gallery)
    assert.equal(records[0].result, '1. Stroller')

    const wire = JSON.stringify(seen[seen.length - 1])
    assert.ok(wire.includes('1. Stroller'), 'the text list must reach the model')
    assert.ok(!wire.includes('data:image'), 'no data URL may reach the model')
  })

  test('a tool that returns no images leaves the field unset', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: [call('c1', 'image_search', { query: 'x' })] },
      { content: 'done', toolCalls: [] }
    ])
    const records: ToolCallRecord[] = []
    await runAgentLoop({
      messages: baseMessages(),
      tools: imageTools,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => ({ ok: true, output: 'no images found', images: [] })
      }
    })
    assert.equal(records[0].images, undefined)
  })
})

describe('prose paren-call recovery (v1.7.1)', () => {
  const SCHEMA_TOOLS: ToolSchema[] = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
      }
    }
  ]

  test('a reply that IS a prose tool call executes it and answers on the next round', async () => {
    const { streamRound } = scripted([
      { content: 'web_search("hypothermia what to do while waiting for help nhs")', toolCalls: [] },
      { content: 'Keep them warm and dry while waiting.', toolCalls: [] }
    ])
    const records: ToolCallRecord[] = []
    const got: { name: string; args: Record<string, unknown> }[] = []
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: SCHEMA_TOOLS,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async (name, args) => {
          got.push({ name, args })
          return { ok: true, output: 'NHS: move them somewhere warm and dry…' }
        }
      }
    })
    assert.equal(outcome.stopReason, 'completed')
    assert.deepEqual(got, [{ name: 'web_search', args: { query: 'hypothermia what to do while waiting for help nhs' } }])
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'done')
  })

  test('recovery happens at most once per turn', async () => {
    const { streamRound } = scripted([
      { content: 'web_search("first")', toolCalls: [] },
      { content: 'web_search("second")', toolCalls: [] }
    ])
    const records: ToolCallRecord[] = []
    let executed = 0
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: SCHEMA_TOOLS,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'r' }
        }
      }
    })
    // The second prose call is NOT recovered: the turn completes with it as text.
    assert.equal(outcome.stopReason, 'completed')
    assert.equal(executed, 1)
  })

  test('no recovery on the final permitted round — a following round must exist', async () => {
    const { streamRound } = scripted([{ content: 'web_search("x")', toolCalls: [] }])
    let executed = 0
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: SCHEMA_TOOLS,
      records: [],
      signal: new AbortController().signal,
      maxIterations: 1,
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: 'r' }
        }
      }
    })
    assert.equal(outcome.stopReason, 'completed')
    assert.equal(executed, 0)
  })

  test('an ordinary prose reply is untouched', async () => {
    const { streamRound } = scripted([{ content: 'You can call web_search("query") like this.', toolCalls: [] }])
    let executed = 0
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: SCHEMA_TOOLS,
      records: [],
      signal: new AbortController().signal,
      deps: {
        streamRound,
        executeTool: async () => {
          executed += 1
          return { ok: true, output: '' }
        }
      }
    })
    assert.equal(outcome.stopReason, 'completed')
    assert.equal(executed, 0)
  })
})

/**
 * v1.9.2. Reproduced against qwen3.8-9b on 2026-08-18 and deterministic across
 * repeats: after a tool returns, the model writes a complete answer inside an
 * unclosed `<think>` block, the server files all of it as reasoning, and the
 * round arrives with no content and no tool call. The answer exists; it is on
 * the channel the app does not show. 13 of 20 Workbench cases ended this way.
 */
describe('runAgentLoop · an answer written into the thinking channel', () => {
  const searchCall = [call('c1', 'web_search', { query: 'x' })]

  test('the empty round after a tool result is retried, and the answer recovered', async () => {
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: searchCall },
      { content: '', toolCalls: [] }, // the answer went to reasoning
      { content: 'The total is $31,997.12.', toolCalls: [] }
    ])
    const records: ToolCallRecord[] = []
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records,
      signal: new AbortController().signal,
      deps: { streamRound, executeTool: async () => ({ ok: true, output: 'result text' }) }
    })
    assert.equal(outcome.stopReason, 'completed')
    // The retry carried a turn that starts with thinking already closed.
    const retryPrompt = seen[2]
    const last = retryPrompt[retryPrompt.length - 1]
    assert.equal(last.role, 'assistant')
    assert.match(String(last.content), /^<think>\s*<\/think>/)
  })

  test('the prefill is scaffolding, not history', async () => {
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: searchCall },
      { content: '', toolCalls: [] },
      { content: '', toolCalls: [call('c2', 'web_search', { query: 'y' })] },
      { content: 'done', toolCalls: [] }
    ])
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records: [],
      signal: new AbortController().signal,
      deps: { streamRound, executeTool: async () => ({ ok: true, output: 'result text' }) }
    })
    // The round after the recovery must not still be carrying the prefill.
    const later = seen[3]
    assert.ok(
      !later.some((m) => typeof m.content === 'string' && m.content.startsWith('<think>')),
      'the prefill should have been popped once it had done its job'
    )
  })

  test('once per turn — a model doing it twice is not being recovered', async () => {
    const { streamRound } = scripted([
      { content: '', toolCalls: searchCall },
      { content: '', toolCalls: [] },
      { content: '', toolCalls: [] }
    ])
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records: [],
      signal: new AbortController().signal,
      deps: { streamRound, executeTool: async () => ({ ok: true, output: 'result text' }) }
    })
    assert.equal(outcome.stopReason, 'completed')
  })

  test('a first round that answered into thinking is recovered too', async () => {
    // The generalised gate: no tool has run, but text went *somewhere*, and it
    // was not to the answer. That is the same failure one round earlier.
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: [], reasoning: 'The answer is 42, because…' },
      { content: 'The answer is 42.', toolCalls: [] }
    ])
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records: [],
      signal: new AbortController().signal,
      deps: { streamRound, executeTool: async () => ({ ok: true, output: '' }) }
    })
    assert.equal(outcome.stopReason, 'completed')
    assert.equal(seen.length, 2, 'the round should have been retried')
    const retry = seen[1]
    assert.match(String(retry[retry.length - 1].content), /^<think>\s*<\/think>/)
  })

  test('a round with neither content nor thinking is a model with nothing to say', async () => {
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: [], reasoning: '   ' },
      { content: 'unreachable', toolCalls: [] }
    ])
    await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records: [],
      signal: new AbortController().signal,
      deps: { streamRound, executeTool: async () => ({ ok: true, output: '' }) }
    })
    assert.equal(seen.length, 1, 'nothing to recover, so nothing to retry')
  })

  test('an empty first round is left alone — no tool has answered yet', async () => {
    const { streamRound, seen } = scripted([
      { content: '', toolCalls: [] },
      { content: 'should not be reached', toolCalls: [] }
    ])
    const outcome = await runAgentLoop({
      messages: baseMessages(),
      tools: TOOLS,
      records: [],
      signal: new AbortController().signal,
      deps: { streamRound, executeTool: async () => ({ ok: true, output: '' }) }
    })
    assert.equal(outcome.stopReason, 'completed')
    assert.equal(seen.length, 1, 'a model with nothing to say is not a lost answer')
  })
})
