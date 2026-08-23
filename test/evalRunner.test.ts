import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  evalStubResult,
  parseCompletionMessage,
  runToolChoiceEval,
  summarizeRuns,
  type EvalFixture,
  type EvalFixtureRun
} from '../src/renderer/src/lib/evalRunner'
import { TOOL_SCHEMAS } from '../src/shared/tools'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'
import type { ToolSchema } from '../src/renderer/src/types'

/**
 * The shared eval runner (Layer 0b core): both the CLI and the in-app "Run
 * eval" button shell this module, so its scoring and parsing are what the
 * four judged numbers mean. Tested here with scripted completions — no
 * server.
 */

function run(partial: Partial<EvalFixtureRun> & { file: string }): EvalFixtureRun {
  return {
    prompt: 'p',
    expect: { tool: 'read_file' },
    round1Calls: [],
    allCalls: [],
    stopReason: 'completed',
    correct: null,
    spurious: null,
    looped: false,
    ...partial
  }
}

describe('summarizeRuns', () => {
  test('the four rates, with errored runs excluded from rates but not loops', () => {
    const rates = summarizeRuns([
      run({ file: 'a', correct: true, allCalls: [{ name: 'read_file', valid: true, errors: [] }] }),
      run({ file: 'b', correct: false }),
      run({ file: 'c', expect: 'no_tool', spurious: false }),
      run({ file: 'd', expect: 'no_tool', spurious: true, round1Calls: ['web_search'] }),
      run({ file: 'e', error: 'timeout' })
    ])
    assert.deepEqual(rates.correctTool, { hit: 1, of: 2 })
    assert.deepEqual(rates.spuriousCall, { hit: 1, of: 2 })
    assert.deepEqual(rates.argValidity, { hit: 1, of: 1 })
    assert.deepEqual(rates.loop, { hit: 0, of: 5 })
  })
})

describe('evalStubResult', () => {
  test('every shipped tool has a stub, so a call never scores against a missing result', () => {
    for (const t of TOOL_SCHEMAS) {
      const r = evalStubResult(t.function.name)
      assert.equal(r.ok, true, t.function.name)
      assert.ok(r.output && r.output !== '(ok)', `${t.function.name} should have a real stub`)
    }
  })

  test('unknown tools get the generic stub', () => {
    assert.deepEqual(evalStubResult('nope'), { ok: true, output: '(ok)' })
  })
})

describe('parseCompletionMessage', () => {
  test('structured tool_calls pass through with string arguments', () => {
    const { toolCalls } = parseCompletionMessage({
      content: null,
      tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: { path: 'a.txt' } } }]
    })
    assert.equal(toolCalls.length, 1)
    assert.equal(toolCalls[0].function.name, 'read_file')
    assert.equal(toolCalls[0].function.arguments, '{"path":"a.txt"}')
  })

  test('think tags are split out of the content', () => {
    const { content } = parseCompletionMessage({ content: '<think>hmm</think>The answer.' })
    assert.equal(content, 'The answer.')
  })
})

describe('runToolChoiceEval', () => {
  const fixtures: EvalFixture[] = [
    { file: 'a.json', prompt: 'read a.txt', expect: { tool: 'read_file' } },
    { file: 'b.json', prompt: 'write a haiku', expect: 'no_tool' }
  ]

  function scriptedComplete(callsPerModel: Record<string, string[]>) {
    return (model: string, messages: ApiMessage[], _tools: ToolSchema[]) => {
      // Second and later rounds (after a tool result) reply plainly, the way
      // a well-behaved model does — re-calling forever would hit the cap.
      if (messages.some((m) => m.role === 'tool')) {
        return Promise.resolve({ content: 'done', toolCalls: [] })
      }
      const names = callsPerModel[model] ?? []
      return Promise.resolve({
        content: names.length === 0 ? 'just an answer' : '',
        toolCalls: names.map((name, i) => ({
          id: `c${i}`,
          type: 'function' as const,
          function: { name, arguments: '{"path":"a.txt"}' }
        }))
      })
    }
  }

  test('a correct call and a clean no-tool turn score 100%', async () => {
    const [result] = await runToolChoiceEval({
      models: ['m'],
      fixtures,
      tools: TOOL_SCHEMAS,
      systemPromptFor: () => 'sys',
      complete: (model, messages, tools) => {
        const isToolFixture = (messages[1].content as string).includes('read')
        return scriptedComplete({ m: isToolFixture ? ['read_file'] : [] })(model, messages, tools)
      }
    })
    assert.deepEqual(result.rates.correctTool, { hit: 1, of: 1 })
    assert.deepEqual(result.rates.spuriousCall, { hit: 0, of: 1 })
    // The stub result feeds back; the scripted next round ends the turn.
    assert.equal(result.runs[0].stopReason, 'completed')
  })

  test('shouldStop cancels between fixtures and keeps partial results', async () => {
    let calls = 0
    const [result] = await runToolChoiceEval({
      models: ['m'],
      fixtures,
      tools: TOOL_SCHEMAS,
      systemPromptFor: () => 'sys',
      complete: (model, messages, tools) => {
        calls += 1
        return scriptedComplete({ m: ['read_file'] })(model, messages, tools)
      },
      shouldStop: () => calls >= 2 // first fixture = call round + reply round
    })
    assert.equal(result.runs.length, 1)
  })

  test('a transport error marks the fixture errored, excluded from rates', async () => {
    const [result] = await runToolChoiceEval({
      models: ['m'],
      fixtures: [fixtures[0]],
      tools: TOOL_SCHEMAS,
      systemPromptFor: () => 'sys',
      complete: () => Promise.reject(new Error('connection refused'))
    })
    assert.equal(result.runs[0].error, 'connection refused')
    assert.deepEqual(result.rates.correctTool, { hit: 0, of: 0 })
  })
})
