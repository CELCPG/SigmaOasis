import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fillHook, parseHooks } from '../src/main/agent/hooks'
import {
  parsePlanSteps,
  PLAN_MAX_STEPS,
  planInView,
  planTodos,
  replanAsk,
  revisedTodos,
  setAsideFinishedStep,
  stepCompleted,
  stepEvidence,
  withholdCompletion
} from '../src/main/agent/plan'
import { CHANGE_TOOLS, READ_TOOLS } from '../src/main/agent/tools'
import type { TodoItem } from '../src/main/agent/types'
import { slugFor } from '../src/main/agent/worktree'
import { setAsideBefore } from '../src/main/agent/context'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'

/** v4.0: the pure parts of the A4, A8 and A9 experiments. */

describe('hooks.json', () => {
  test('strings only, five a moment at most, unknown keys dropped; nothing usable is null', () => {
    const h = parseHooks({ afterEdit: ['a', 1, '', ' b '], beforeCommand: 'no', onEnd: ['1', '2', '3', '4', '5', '6'], other: ['x'] })
    assert.deepEqual(h, { afterEdit: ['a', 'b'], beforeCommand: [], onEnd: ['1', '2', '3', '4', '5'] })
    assert.equal(parseHooks({ afterEdit: [] }), null)
    assert.equal(parseHooks(['a']), null)
    assert.equal(parseHooks('a'), null)
  })

  test('placeholders are filled; one with nothing for it stays as written', () => {
    assert.equal(fillHook('npx prettier --write {file}', { file: 'src/a.ts' }), 'npx prettier --write src/a.ts')
    assert.equal(fillHook('echo {command}', { command: 'npm test' }), 'echo npm test')
    assert.equal(fillHook('echo {file}', {}), 'echo {file}')
  })
})

describe('the plan in view', () => {
  test('names every step, marks the one in progress, and is nothing without a plan or a current step', () => {
    assert.equal(planInView([]), null)
    assert.equal(planInView([{ content: 'a', status: 'pending' }]), null)
    const view = planInView([
      { content: 'read', status: 'completed' },
      { content: 'fix', status: 'in_progress' },
      { content: 'test', status: 'pending' }
    ])
    assert.match(view!, /^Plan in view \(not a new instruction\):\n☑ read\n▶ fix\n☐ test\nYou are on: fix\./)
  })

  test('a step is completed when the count of completed items grows', () => {
    const a = [{ content: 'a', status: 'in_progress' as const }]
    assert.equal(stepCompleted(a, [{ content: 'a', status: 'completed' }]), true)
    assert.equal(stepCompleted(a, [{ content: 'a', status: 'pending' }]), false)
    assert.equal(stepCompleted([{ content: 'a', status: 'completed' }], [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]), false)
  })

  test('setting a step aside replaces the sizeable tool results before the last round, and nothing after it', () => {
    const long = 'y'.repeat(500)
    const messages: ApiMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: long },
      { role: 'tool', tool_call_id: 'b', content: 'short' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'todo_write', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: long }
    ]
    assert.equal(setAsideFinishedStep(messages), 1)
    assert.match(String(messages[3]!.content), /^\[Earlier output of read_file set aside: that step is done \(500 characters\)/)
    assert.equal(messages[4]!.content, 'short')
    assert.equal(messages[6]!.content, long, 'the round that completed the step keeps its result')
    assert.equal(setAsideFinishedStep(messages), 0, 'done once')
    assert.equal(setAsideBefore([{ role: 'user', content: 'go' }], 5), 0)
  })
})

describe('the plan round, pure parts (v4.2, A4)', () => {
  test('a plan reads from the grammar’s shape, a bare array, objects, a fence in prose, or a numbered list; trimmed, deduplicated, capped', () => {
    assert.deepEqual(parsePlanSteps('{"steps": ["Read a", " Fix  b ", "read A"]}'), ['Read a', 'Fix b'])
    assert.deepEqual(parsePlanSteps('["x", "y"]'), ['x', 'y'])
    assert.deepEqual(parsePlanSteps('{"steps": [{"title": "t"}, {"step": "s"}, {"content": "c"}]}'), ['t', 's', 'c'])
    assert.deepEqual(parsePlanSteps('Sure — here it is:\n```json\n{"steps": ["a {b}", "c \\"d\\""]}\n```\nGood luck.'), ['a {b}', 'c "d"'])
    assert.deepEqual(parsePlanSteps('Plan:\n1. Read the test\n2) Fix it\n- Run it'), ['Read the test', 'Fix it', 'Run it'])
    assert.equal(parsePlanSteps(JSON.stringify({ steps: Array.from({ length: 12 }, (_, i) => `s${i}`) })).length, PLAN_MAX_STEPS)
    assert.deepEqual(parsePlanSteps('I will just fix it.'), [])
    assert.deepEqual(parsePlanSteps(''), [])
  })

  test('the steps become a checklist with the first in progress; a replan keeps what is done and follows it with the new steps', () => {
    assert.deepEqual(planTodos(['a', 'b']), [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }])
    const now: TodoItem[] = [{ content: 'read', status: 'completed' }, { content: 'fix', status: 'in_progress' }, { content: 'test', status: 'pending' }]
    assert.deepEqual(revisedTodos(now, ['Read', 'fix the other branch', 'test']), [
      { content: 'read', status: 'completed' },
      { content: 'fix the other branch', status: 'in_progress' },
      { content: 'test', status: 'pending' }
    ])
    assert.equal(revisedTodos(now, ['read']), null, 'nothing new: the plan stands')
    assert.equal(revisedTodos(now, []), null)
    assert.match(replanAsk(now, 'A check failed after a change'), /^A check failed after a change\. Revise the plan before going on\. The plan so far:\n☑ read\n▶ fix\n☐ test\n/)
  })

  test('evidence: after a change only a passing check or a read that follows it; with no change, any success', () => {
    const ev = (...log: [string, boolean][]) => stepEvidence(log.map(([name, ok]) => ({ name, ok })), CHANGE_TOOLS, READ_TOOLS)
    assert.equal(ev(), false)
    assert.equal(ev(['read_file', true]), true)
    assert.equal(ev(['web_search', true]), true)
    assert.equal(ev(['read_file', false]), false)
    assert.equal(ev(['read_file', true], ['edit_file', true]), false, 'the edit’s own line is the claim, not the check')
    assert.equal(ev(['edit_file', true], ['run_command', false]), false, 'a failing check is not evidence')
    assert.equal(ev(['edit_file', true], ['run_command', true]), true)
    assert.equal(ev(['edit_file', true], ['grep', true]), true)
    assert.equal(ev(['edit_file', true], ['run_command', true], ['write_file', true]), false, 'a change after the check needs its own')
    assert.equal(ev(['edit_file', false], ['read_file', true]), true, 'a failed edit changed nothing')
  })

  test('a tick without evidence goes back to in progress and what came after it to pending — once per step', () => {
    const before: TodoItem[] = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }]
    const after: TodoItem[] = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }, { content: 'c', status: 'in_progress' }]
    const r = withholdCompletion(before, after, false, new Set())
    assert.equal(r?.withheld, 'b')
    assert.deepEqual(r?.todos.map((t) => t.status), ['completed', 'in_progress', 'pending'])
    assert.equal(withholdCompletion(before, after, true, new Set()), null, 'evidence: it stands')
    assert.equal(withholdCompletion(before, after, false, new Set(['b'])), null, 'refused already: it stands')
    assert.equal(withholdCompletion(before, before, false, new Set()), null, 'nothing newly ticked')
  })

  test('the plan in view names the evidence rule only when asked', () => {
    const todos: TodoItem[] = [{ content: 'fix', status: 'in_progress' }]
    assert.doesNotMatch(planInView(todos)!, /tool result shows it done/)
    assert.match(planInView(todos, true)!, /Mark it completed only once a tool result shows it done/)
  })
})

describe('worktree names', () => {
  test('the first words of the task and the minute, safe for a branch', () => {
    assert.equal(slugFor('Fix the failing test in src/math.ts!', new Date(2026, 8, 28, 9, 5)), 'fix-the-failing-test-0928-0905')
    assert.equal(slugFor('', new Date(2026, 0, 1, 0, 0)), 'task-0101-0000')
    assert.ok(slugFor('a'.repeat(200), new Date()).length <= 60)
  })
})
