import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTurns,
  exportTraces,
  labelTurn,
  outcomeKey,
  outcomesFromConversation,
  parseToolCallEntry,
  redactText,
  schemaVersionFor,
  toOpenAIMessages,
  type AuditEntryLike,
  type TraceTurn
} from '../src/main/ipc/traceExport'
import { TOOL_SCHEMAS } from '../src/shared/tools'

/**
 * Layer 4's labels decide what a future fine-tune learns to imitate, and its
 * redaction decides what leaves the machine — so the labeling rules, the
 * redaction rules, and the export format are all pinned exactly.
 */

let clock = 0
function entry(partial: Partial<AuditEntryLike> & Pick<AuditEntryLike, 'kind' | 'conversationId' | 'text'>): AuditEntryLike {
  clock += 1
  return { at: new Date(clock).toISOString(), ...partial }
}

const CLEAN_TURN: AuditEntryLike[] = [
  entry({ kind: 'session_start', conversationId: '', text: 'start' }),
  entry({ kind: 'user_input', conversationId: 'c1', text: 'What is the weather in Paris?' }),
  entry({
    kind: 'tool_call',
    conversationId: 'c1',
    toolName: 'web_search',
    ok: true,
    text: 'web_search({"query":"weather Paris"})\n→ It is 18C and cloudy in Paris.'
  }),
  entry({
    kind: 'assistant_output',
    conversationId: 'c1',
    roleName: 'Chat',
    modelId: 'model-a',
    text: 'It is currently 18C and cloudy in Paris.'
  })
]

describe('buildTurns', () => {
  test('a clean turn carries user, tool calls, and the final answer', () => {
    const { turns, skipped } = buildTurns(CLEAN_TURN)
    assert.equal(skipped, 0)
    assert.equal(turns.length, 1)
    const t = turns[0]
    assert.equal(t.conversationId, 'c1')
    assert.equal(t.turnIndex, 0)
    assert.equal(t.user, 'What is the weather in Paris?')
    assert.equal(t.toolCalls.length, 1)
    assert.deepEqual(t.toolCalls[0].args, { query: 'weather Paris' })
    assert.equal(t.toolCalls[0].ok, true)
    assert.equal(t.toolCalls[0].output, 'It is 18C and cloudy in Paris.')
    assert.equal(t.assistant, 'It is currently 18C and cloudy in Paris.')
    assert.equal(t.modelId, 'model-a')
  })

  test('a turn with no assistant_output stopped before a final answer (the cap signature)', () => {
    const { turns } = buildTurns([
      entry({ kind: 'user_input', conversationId: 'c1', text: 'keep digging' }),
      entry({
        kind: 'tool_call',
        conversationId: 'c1',
        toolName: 'fetch_webpage',
        ok: true,
        text: 'fetch_webpage({"url":"https://example.com"})\n→ page text'
      })
    ])
    assert.equal(turns.length, 1)
    assert.equal(turns[0].assistant, undefined)
  })

  test('conversations interleave without mixing; turn indexes count user inputs', () => {
    const { turns } = buildTurns([
      entry({ kind: 'user_input', conversationId: 'c1', text: 'c1 first' }),
      entry({ kind: 'user_input', conversationId: 'c2', text: 'c2 first' }),
      entry({ kind: 'assistant_output', conversationId: 'c1', text: 'a1' }),
      entry({ kind: 'assistant_output', conversationId: 'c2', text: 'a2' }),
      entry({ kind: 'user_input', conversationId: 'c1', text: 'c1 second' }),
      entry({ kind: 'assistant_output', conversationId: 'c1', text: 'a3' })
    ])
    assert.equal(turns.length, 3)
    assert.deepEqual(
      turns.map((t) => [t.conversationId, t.turnIndex, t.assistant]),
      [
        ['c1', 0, 'a1'],
        ['c2', 0, 'a2'],
        ['c1', 1, 'a3']
      ]
    )
  })

  test('orphan tool calls and replies are skipped, not guessed into a turn', () => {
    const { turns, skipped } = buildTurns([
      entry({
        kind: 'tool_call',
        conversationId: 'c9',
        toolName: 'web_search',
        ok: true,
        text: 'web_search({"query":"x"})\n→ y'
      }),
      entry({ kind: 'assistant_output', conversationId: 'c9', text: 'stray reply' })
    ])
    assert.equal(turns.length, 0)
    assert.equal(skipped, 2)
  })
})

describe('parseToolCallEntry', () => {
  test('an error result strips the Error: prefix and keeps ok false', () => {
    const call = parseToolCallEntry(
      entry({
        kind: 'tool_call',
        conversationId: 'c1',
        toolName: 'read_file',
        ok: false,
        text: 'read_file({"path":"/tmp/x"})\n→ Error: file not found'
      })
    )
    assert.equal(call.ok, false)
    assert.equal(call.output, 'file not found')
    assert.deepEqual(call.args, { path: '/tmp/x' })
  })

  test('unparseable arguments are kept as raw text', () => {
    const call = parseToolCallEntry(
      entry({
        kind: 'tool_call',
        conversationId: 'c1',
        toolName: 'web_search',
        ok: true,
        text: 'web_search({query: paris})\n→ results'
      })
    )
    assert.equal(call.args, '{query: paris}')
  })
})

describe('labelTurn (4b: outcomes, not vibes)', () => {
  const base: TraceTurn = {
    conversationId: 'c1',
    turnIndex: 0,
    user: 'q',
    toolCalls: [{ name: 'web_search', args: {}, ok: true, output: 'o' }],
    assistant: 'a'
  }

  test('an errored tool call rejects the trace and names the tool', () => {
    const { label, reasons } = labelTurn(
      { ...base, toolCalls: [{ name: 'fetch_webpage', args: {}, ok: false, output: 'boom' }] },
      { unverified: false }
    )
    assert.equal(label, 'rejected')
    assert.equal(reasons[0], 'tool error(s): fetch_webpage')
  })

  test('no final answer rejects the trace as capped or aborted', () => {
    const { label } = labelTurn({ ...base, assistant: undefined }, { unverified: false })
    assert.equal(label, 'rejected')
  })

  test('a contradicted claim rejects even an otherwise clean turn', () => {
    const { label } = labelTurn(base, {
      unverified: true,
      claimVerdicts: ['confirmed', 'contradicted']
    })
    assert.equal(label, 'rejected')
  })

  test('positive requires outcome evidence — audit alone is not enough', () => {
    assert.equal(labelTurn(base).label, 'unlabeled')
  })

  test('a clean, never-flagged turn is positive', () => {
    const { label, reasons } = labelTurn(base, { unverified: false })
    assert.equal(label, 'positive')
    assert.deepEqual(reasons, ['completed without tool errors, not flagged unverified'])
  })

  test('an unverified turn is positive only when every claim was confirmed', () => {
    assert.equal(
      labelTurn(base, { unverified: true, claimVerdicts: ['confirmed', 'confirmed'] }).label,
      'positive'
    )
    assert.equal(labelTurn(base, { unverified: true }).label, 'unlabeled')
    assert.equal(
      labelTurn(base, { unverified: true, claimVerdicts: ['confirmed', 'unverifiable'] }).label,
      'unlabeled'
    )
  })
})

describe('outcomesFromConversation', () => {
  test('the nth user message pairs with the next assistant reply', () => {
    const map = outcomesFromConversation({
      messages: [
        { role: 'user' },
        { role: 'assistant', unverified: true, claimCheck: { claims: [{ verdict: 'confirmed' }] } },
        { role: 'user' },
        { role: 'assistant', unverified: false },
        { role: 'assistant', marker: 'notice', content: '' } as never,
        { role: 'user' }
      ]
    })
    assert.deepEqual(map.get(0), { unverified: true, claimVerdicts: ['confirmed'] })
    assert.deepEqual(map.get(1), { unverified: false, claimVerdicts: undefined })
    assert.equal(map.get(2), undefined) // never answered — no outcome
  })
})

describe('redactText', () => {
  test('URLs, paths, emails, IPs, localhost, and key-shaped tokens are replaced', () => {
    const out = redactText(
      [
        'see https://example.com/page?q=secret',
        'from /Users/colin/Documents/file.txt',
        'or C:\\Users\\colin\\file.txt',
        'mail me@example.com',
        'server 127.0.0.1 and localhost',
        'key sk-abcdef0123456789abcdef',
        'hex a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
        'long abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV'
      ].join('\n')
    )
    assert.ok(!out.includes('example.com'), 'url redacted')
    assert.ok(!out.includes('colin'), 'paths and email redacted')
    assert.ok(!out.includes('127.0.0.1'), 'ip redacted')
    assert.ok(!out.includes('localhost'), 'localhost redacted')
    assert.ok(!out.includes('abcdef0123456789abcdef'), 'prefixed key redacted')
    assert.ok(!out.includes('a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'), 'hex token redacted')
    assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV'), 'long token redacted')
    assert.ok(out.includes('[url]') && out.includes('[path]') && out.includes('[email]'))
  })

  test('ordinary prose and short words survive untouched', () => {
    const text = 'The weather in Paris is 18C. Temperature is a number, not a token.'
    assert.equal(redactText(text), text)
  })
})

describe('toOpenAIMessages', () => {
  test('one turn becomes user → assistant tool_calls → tool result → final answer', () => {
    const messages = toOpenAIMessages({
      conversationId: 'c1',
      turnIndex: 0,
      user: 'search https://example.com please',
      toolCalls: [{ name: 'web_search', args: { query: 'x' }, ok: true, output: 'found it' }],
      assistant: 'Here you go.'
    })
    assert.equal(messages.length, 4)
    assert.deepEqual(messages[0], { role: 'user', content: 'search [url] please' })
    assert.equal(messages[1].role, 'assistant')
    assert.equal(messages[1].content, null)
    assert.deepEqual(messages[1].tool_calls, [
      { id: 'call_0', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }
    ])
    assert.deepEqual(messages[2], { role: 'tool', tool_call_id: 'call_0', content: 'found it' })
    assert.deepEqual(messages[3], { role: 'assistant', content: 'Here you go.' })
  })

  test('tool errors are exported with the Error: prefix restored', () => {
    const messages = toOpenAIMessages({
      conversationId: 'c1',
      turnIndex: 0,
      user: 'q',
      toolCalls: [{ name: 'read_file', args: {}, ok: false, output: 'file not found' }],
      assistant: 'I could not read it.'
    })
    assert.equal(messages[2].content, 'Error: file not found')
  })
})

describe('schemaVersionFor (4c)', () => {
  test('the stamp is stable for identical schemas and changes when they do', () => {
    const a = schemaVersionFor(TOOL_SCHEMAS as unknown[])
    const b = schemaVersionFor(JSON.parse(JSON.stringify(TOOL_SCHEMAS)) as unknown[])
    assert.equal(a, b)
    assert.match(a, /^[a-f0-9]{12}$/)
    const changed = schemaVersionFor([...(TOOL_SCHEMAS as unknown[]), { extra: true }])
    assert.notEqual(a, changed)
  })
})

describe('exportTraces', () => {
  test('positive and rejected files are strict {"messages": ...} lines; provenance lives in the manifest', () => {
    const entries: AuditEntryLike[] = [
      ...CLEAN_TURN,
      entry({ kind: 'user_input', conversationId: 'c1', text: 'loop forever' }),
      entry({
        kind: 'tool_call',
        conversationId: 'c1',
        toolName: 'fetch_webpage',
        ok: false,
        text: 'fetch_webpage({"url":"https://x.example"})\n→ Error: timeout'
      })
    ]
    const result = exportTraces(entries, {
      outcomes: new Map([[outcomeKey('c1', 0), { unverified: false }]]),
      tools: TOOL_SCHEMAS as unknown[]
    })

    assert.equal(result.positive.length, 1)
    assert.equal(result.rejected.length, 1)
    assert.equal(result.unlabeled, 0)
    assert.deepEqual(result.manifest.counts, {
      turns: 2,
      positive: 1,
      rejected: 1,
      unlabeled: 0,
      skippedEntries: 0
    })
    assert.equal(result.manifest.schemaVersion, schemaVersionFor(TOOL_SCHEMAS as unknown[]))

    const line = JSON.parse(result.positive[0]) as { messages: unknown[] }
    assert.deepEqual(Object.keys(line), ['messages'])
    const trace = result.manifest.traces.find((t) => t.file === 'positive')
    assert.equal(trace?.line, 1)
    assert.equal(trace?.modelId, 'model-a')
    const rejectedTrace = result.manifest.traces.find((t) => t.file === 'rejected')
    assert.ok(rejectedTrace?.reasons.some((r) => r.includes('fetch_webpage')))
    assert.ok(rejectedTrace?.reasons.some((r) => r.includes('no final answer')))
  })

  test('unlabeled turns are excluded from both files but counted', () => {
    const result = exportTraces(CLEAN_TURN)
    assert.equal(result.positive.length, 0)
    assert.equal(result.rejected.length, 0)
    assert.equal(result.unlabeled, 1)
    assert.equal(result.manifest.schemaVersion, null)
  })
})
