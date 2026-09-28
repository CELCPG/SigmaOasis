import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DOMPurify from 'dompurify'
import {
  REASONING_KEEP_CHARS,
  applyAgentEvent,
  describeStep,
  historyFromConversation,
  newAgentTurn,
  todoProgress
} from '../src/renderer/src/lib/agentTurn'
import type { ChatMessage, Conversation, ToolCallRecord } from '../src/renderer/src/types'
import type { AgentWireEvent } from '../src/main/ipc/agent'

/**
 * v3.0: the window's half of an agent turn — events folded into a message in
 * the order they happened, and drawn as a timeline.
 */

const rec = (id: string, name: string, args: Record<string, unknown>, extra: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id,
  name,
  args,
  status: 'done',
  ...extra
})

function turn(): ChatMessage {
  return { id: 'a1', role: 'assistant', content: '', toolCalls: [], agent: newAgentTurn('t1', '/proj', 'ask'), createdAt: 0 }
}

function fold(message: ChatMessage, events: AgentWireEvent[]): ChatMessage {
  let m = message
  for (const e of events) {
    const patch = applyAgentEvent(m, e)
    if (patch) m = { ...m, ...patch }
  }
  return m
}

describe('folding events into the turn', () => {
  test('text and tools become steps in the order they happened', () => {
    const m = fold(turn(), [
      { type: 'text', delta: 'Let me ' },
      { type: 'text', delta: 'look.' },
      { type: 'tool_start', record: rec('c1', 'read_file', { path: 'a.ts' }, { status: 'running' }) },
      { type: 'tool_end', record: rec('c1', 'read_file', { path: 'a.ts' }, { result: '1\tx' }) },
      { type: 'text', delta: 'Fixed.' }
    ])
    assert.deepEqual(m.agent!.steps, [
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tool', callId: 'c1' },
      { kind: 'text', text: 'Fixed.' }
    ])
    assert.equal(m.toolCalls![0]!.status, 'done')
    assert.equal(m.toolCalls!.length, 1)
  })

  test('a helper’s calls are records, not steps — they render inside the helper', () => {
    const m = fold(turn(), [
      { type: 'tool_start', record: rec('t', 'task', { subagent_type: 'explore', description: 'find it' }, { status: 'running' }) },
      { type: 'tool_start', record: rec('h1', 'grep', { pattern: 'x' }, { status: 'running', parentCallId: 't' }) }
    ])
    assert.deepEqual(m.agent!.steps, [{ kind: 'tool', callId: 't' }])
    assert.equal(m.toolCalls!.length, 2)
  })

  test('the ending comes with the answer, never before it', () => {
    const running = fold(turn(), [{ type: 'status', status: 'done' }])
    assert.equal(running.agent!.status, 'running', 'a bare status does not end the turn')
    const done = fold(turn(), [{ type: 'final', status: 'done', finalText: 'All green.', changedFiles: ['a.ts'] }])
    assert.equal(done.agent!.status, 'done')
    assert.equal(done.content, 'All green.')
    assert.deepEqual(done.agent!.changedFiles, ['a.ts'])
    assert.ok(done.agent!.endedAt)
  })

  test('a paused or failed turn keeps its reason', () => {
    const m = fold(turn(), [{ type: 'final', status: 'paused', finalText: '', changedFiles: [], detail: 'Paused after 40 rounds.' }])
    assert.equal(m.agent!.status, 'paused')
    assert.equal(m.agent!.detail, 'Paused after 40 rounds.')
  })

  test('the checklist, the step count and elisions are kept', () => {
    const m = fold(turn(), [
      { type: 'todos', todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
      { type: 'round', round: 3 },
      { type: 'context_elided', toolResults: 2, chars: 9000 },
      { type: 'context_elided', toolResults: 1, chars: 4000 }
    ])
    assert.equal(m.agent!.round, 3)
    assert.equal(m.agent!.elided, 3)
    assert.deepEqual(todoProgress(m.agent!.todos), { done: 1, total: 2, current: 'b' })
  })

  test('reasoning is kept, but only its newest stretch', () => {
    const big = 'r'.repeat(REASONING_KEEP_CHARS)
    const m = fold(turn(), [{ type: 'reasoning', delta: big }, { type: 'reasoning', delta: 'NEWEST' }])
    assert.equal(m.reasoning!.length, REASONING_KEEP_CHARS)
    assert.ok(m.reasoning!.endsWith('NEWEST'))
  })

  test('an event for a message that is not an agent turn changes nothing', () => {
    assert.equal(applyAgentEvent({ id: 'x', role: 'assistant', content: '', createdAt: 0 }, { type: 'text', delta: 'hi' }), null)
  })
})

describe('the steps, in words', () => {
  test('each tool reads as what was done', () => {
    assert.equal(describeStep(rec('1', 'read_file', { path: 'src/a.ts', offset: 40 })).text, 'Read src/a.ts (from line 40)')
    assert.equal(describeStep(rec('1', 'read_file', { path: 'src/a.ts' }, { status: 'running' })).text, 'Reading src/a.ts')
    assert.equal(
      describeStep(rec('1', 'edit_file', { path: 'src/a.ts' }, { result: 'Applied to src/a.ts: +1 −1 in 1 hunk.\n\n--- a' })).text,
      'Edited src/a.ts (+1 −1 in 1 hunk)'
    )
    assert.equal(describeStep(rec('1', 'edit_file', { path: 'src/a.ts' }, { status: 'error', result: 'Declined — …' })).text, 'Edit to src/a.ts not applied')
    assert.equal(
      describeStep(rec('1', 'run_command', { command: 'npm test' }, { result: '$ npm test\nok\n(exit code 0, 2.1 s)' })).text,
      'Ran `npm test` — exit code 0'
    )
    assert.equal(
      describeStep(rec('1', 'glob', { pattern: '*.ts' }, { result: 'a.ts\nb.ts' })).text,
      'Found files matching *.ts — 2 files'
    )
    assert.equal(describeStep(rec('1', 'task', { subagent_type: 'explore', description: 'find callers' })).text, 'Helper reported: explore — find callers')
    assert.equal(describeStep(rec('1', 'web_search', { query: 'x' })).text, 'Used web_search')
  })
})

describe('history for a restarted app', () => {
  test('what was said, in order, without dividers or the turn being answered', () => {
    const convo: Conversation = {
      id: 'c',
      title: 't',
      mode: 'independent',
      createdAt: 0,
      updatedAt: 0,
      agent: { workspace: '/p', permission: 'ask' },
      messages: [
        { id: 'u1', role: 'user', content: 'fix it', createdAt: 0 },
        { id: 'a1', role: 'assistant', content: 'Fixed add().', createdAt: 0 },
        { id: 'm', role: 'assistant', content: 'rolled back', marker: 'rollback', createdAt: 0 },
        { id: 'u2', role: 'user', content: 'now the docs', createdAt: 0 },
        { id: 'a2', role: 'assistant', content: '', createdAt: 0 }
      ]
    }
    assert.deepEqual(historyFromConversation(convo), [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'Fixed add().' },
      { role: 'user', content: 'now the docs' }
    ])
    assert.deepEqual(historyFromConversation(convo, 'u2'), [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'Fixed add().' }
    ])
  })
})

describe('the timeline on screen', () => {
  beforeEach(() => {
    ;(globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), api: {} }
    const purify = DOMPurify as unknown as { sanitize?: (html: string) => string }
    if (typeof purify.sanitize !== 'function') purify.sanitize = (html) => html
  })

  const render = async (message: ChatMessage): Promise<string> => {
    const { AgentTurn } = await import('../src/renderer/src/components/agent/AgentTurn')
    // As ChatArea renders it: with its conversation, which Undo and Continue act on.
    const conversation: Conversation = {
      id: 'c',
      title: 't',
      mode: 'independent',
      createdAt: 0,
      updatedAt: 0,
      agent: { workspace: '/proj', permission: 'ask' },
      messages: [message]
    }
    return renderToStaticMarkup(createElement(AgentTurn, { message, conversation }))
  }

  test('a finished turn shows its steps in order, the answer, what changed and Undo', async () => {
    const m = fold(turn(), [
      { type: 'text', delta: 'Looking at the tests.' },
      { type: 'tool_start', record: rec('c1', 'read_file', { path: 'test.js' }, { status: 'running' }) },
      { type: 'tool_end', record: rec('c1', 'read_file', { path: 'test.js' }, { result: '1\tok' }) },
      { type: 'tool_start', record: rec('c2', 'edit_file', { path: 'src/stats.js' }, { status: 'running' }) },
      { type: 'tool_end', record: rec('c2', 'edit_file', { path: 'src/stats.js' }, { result: 'Applied to src/stats.js: +1 −1 in 1 hunk.\n\n--- x' }) },
      { type: 'todos', todos: [{ content: 'Fix mean', status: 'completed' }, { content: 'Run tests', status: 'completed' }] },
      { type: 'text', delta: 'Both bugs fixed; tests pass.' },
      { type: 'final', status: 'done', finalText: 'Both bugs fixed; tests pass.', changedFiles: ['src/stats.js'] }
    ])
    const html = await render(m)
    const at = (s: string): number => {
      const i = html.indexOf(s)
      assert.ok(i >= 0, `missing: ${s}`)
      return i
    }
    assert.ok(at('Looking at the tests.') < at('Read test.js'))
    assert.ok(at('Read test.js') < at('Edited src/stats.js (+1 −1 in 1 hunk)'))
    assert.ok(at('Edited src/stats.js') < at('Both bugs fixed; tests pass.'))
    assert.match(html, /CHECKLIST · 2\/2/)
    assert.match(html, /1 file changed/)
    assert.match(html, /Undo changes/)
    assert.match(html, /Done in/)
    assert.doesNotMatch(html, /data-testid="agent-thinking"/, 'no thinking row once it has ended')
  })

  test('a running turn between steps says it is thinking, and offers Stop', async () => {
    const m = fold(turn(), [
      { type: 'tool_start', record: rec('c1', 'read_file', { path: 'a.ts' }, { status: 'running' }) },
      { type: 'tool_end', record: rec('c1', 'read_file', { path: 'a.ts' }, { result: 'x' }) },
      { type: 'reasoning', delta: 'The loop starts at 1.\nSo the first element is skipped' }
    ])
    const html = await render(m)
    assert.match(html, /data-testid="agent-thinking"/)
    assert.match(html, /So the first element is skipped/, 'the newest line of its thinking, as proof of life')
    assert.match(html, />Stop</)
    assert.match(html, /Working/)
  })

  test('a paused turn says why and offers Continue', async () => {
    const m = fold(turn(), [{ type: 'final', status: 'paused', finalText: '', changedFiles: [], detail: 'Paused after 40 rounds. Say “continue” to let it keep going.' }])
    const html = await render({ ...m })
    assert.match(html, /Paused after 40 rounds/)
    assert.match(html, /Continue/)
  })

  test('an undone turn says what it restored and what it left alone', async () => {
    const m = fold(turn(), [{ type: 'final', status: 'done', finalText: 'ok', changedFiles: ['a.ts', 'b.ts'] }])
    m.agent!.undo = { restored: ['a.ts'], skipped: [{ path: 'b.ts', reason: 'it has been changed since the task wrote it' }] }
    const html = await render(m)
    assert.match(html, /Undone: restored a\.ts/)
    assert.match(html, /Left b\.ts — it has been changed since the task wrote it/)
    assert.doesNotMatch(html, /↶ Undo changes/)
  })
})

describe('wiring', () => {
  const src = (...p: string[]): string => readFileSync(join(__dirname, '..', '..', 'src', ...p), 'utf-8').replace(/\r\n/g, '\n')

  test('an agent chat’s message is a task, routed before any chat-turn logic', () => {
    const engine = src('renderer', 'src', 'hooks', 'useLMStudio.ts')
    const route = engine.indexOf('if (target?.agent) {')
    const streamingGate = engine.indexOf('if (store.streaming) {', engine.indexOf('const sendMessage'))
    assert.ok(route > 0 && route < streamingGate, 'the agent branch comes before the chat’s streaming gate')
  })

  test('the bubble hands an agent turn to its timeline', () => {
    assert.match(src('renderer', 'src', 'components', 'MessageBubble.tsx'), /if \(message\.agent\) return <AgentTurn /)
  })
})
