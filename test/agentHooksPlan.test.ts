import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fillHook, parseHooks } from '../src/main/agent/hooks'
import { planInView, setAsideFinishedStep, stepCompleted } from '../src/main/agent/plan'
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

describe('worktree names', () => {
  test('the first words of the task and the minute, safe for a branch', () => {
    assert.equal(slugFor('Fix the failing test in src/math.ts!', new Date(2026, 8, 28, 9, 5)), 'fix-the-failing-test-0928-0905')
    assert.equal(slugFor('', new Date(2026, 0, 1, 0, 0)), 'task-0101-0000')
    assert.ok(slugFor('a'.repeat(200), new Date()).length <= 60)
  })
})
