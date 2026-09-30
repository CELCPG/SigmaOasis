import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { roundPhase } from '../src/main/agent/phase'
import { PLAN_VIEW_PREFIX } from '../src/main/agent/plan'
import { agentThinkingProfile, QUIET_ROUND_MAX_TOKENS } from '../src/renderer/src/lib/modelProfiles'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'

/** v4.0 (A3, an experiment): what the coming round is; v4.2: which of those think is the family's prior. */

const sys: ApiMessage = { role: 'system', content: 'You are Sigma.' }
const user: ApiMessage = { role: 'user', content: 'Fix the failing test.' }
const call = (id: string, name = 'read_file', args = '{}'): ApiMessage => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] } as unknown as ApiMessage)
const calls = (...c: [string, string][]): ApiMessage => ({ role: 'assistant', content: '', tool_calls: c.map(([id, name]) => ({ id, type: 'function', function: { name, arguments: '{}' } })) } as unknown as ApiMessage)
const result = (id: string, content: string): ApiMessage => ({ role: 'tool', tool_call_id: id, content } as unknown as ApiMessage)

describe('roundPhase', () => {
  test('the first round is the first', () => {
    assert.equal(roundPhase(0, [sys, user]), 'first')
  })

  test('a successful read, listing or search is a read; an edit is an edit', () => {
    assert.equal(roundPhase(1, [sys, user, call('a'), result('a', '1→export function mean() {}')]), 'read')
    assert.equal(roundPhase(1, [sys, user, call('a', 'grep'), result('a', 'src/a.ts:1: x')]), 'read')
    assert.equal(roundPhase(2, [sys, user, call('a', 'edit_file'), result('a', 'Edited src/a.ts: +1 −1')]), 'edit')
  })

  test('a tool error, or a command that exited non-zero, is a failure — anywhere in the last round', () => {
    assert.equal(roundPhase(2, [sys, user, call('a'), result('a', 'Error: old_string was not found in src/stats.js')]), 'failure')
    assert.equal(roundPhase(2, [sys, user, call('a', 'run_command'), result('a', '$ node --test\n✖ breaks\n(exit code 1, 0.4 s)')]), 'failure')
    // The failed edit was first; a read ran beside it and came back last.
    assert.equal(roundPhase(2, [sys, user, calls(['a', 'edit_file'], ['b', 'read_file']), result('a', 'Error: no match'), result('b', 'ok')]), 'failure')
  })

  test('a passing check after a change is the likely report; before any change it is not', () => {
    const pass = '$ node --test\nℹ pass 3\n(exit code 0, 0.4 s)'
    assert.equal(roundPhase(3, [sys, user, call('e', 'edit_file'), result('e', 'Edited'), call('a', 'run_command'), result('a', pass)]), 'report')
    assert.equal(roundPhase(1, [sys, user, call('a', 'run_command'), result('a', pass)]), 'other')
  })

  test('ticking the last step is the likely report; ticking one of several is not', () => {
    const done = JSON.stringify({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] })
    const half = JSON.stringify({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] })
    assert.equal(roundPhase(4, [sys, user, call('t', 'todo_write', done), result('t', '2 of 2 done')]), 'report')
    assert.equal(roundPhase(4, [sys, user, call('t', 'todo_write', half), result('t', '1 of 2 done')]), 'other')
  })

  test('the user speaking again is the user; the transient plan message is not', () => {
    assert.equal(roundPhase(3, [sys, user, call('a'), result('a', 'ok'), { role: 'user', content: 'also rename it' }]), 'user')
    assert.equal(roundPhase(3, [sys, user, call('a'), result('a', 'ok'), { role: 'user', content: `${PLAN_VIEW_PREFIX}\n▶ fix` }]), 'read', '4.0 read the plan message as the user, so every planFocus round thought')
  })
})

describe('agentThinkingProfile (v4.2)', () => {
  test('Qwen3: the closed block; thought first, after a failure and before the report, none after a read or an edit', () => {
    for (const id of ['qwen3.8-9b-distill', 'qwen3.8-35b-a3b-distill', 'magistral-small']) {
      const p = agentThinkingProfile(id)
      assert.equal(p.control, 'closed-think', id)
      assert.deepEqual(
        Object.entries(p.think).filter(([, on]) => on).map(([k]) => k).sort(),
        ['failure', 'first', 'report', 'user'],
        id
      )
    }
  })

  test('the R1 distills close the block only after a read, whatever the label says', () => {
    const p = agentThinkingProfile('deepseek-r1-distill-qwen-14b')
    assert.equal(p.control, 'closed-think')
    assert.equal(p.think.read, false)
    assert.equal(p.think.edit, true)
    assert.equal(p.think.other, true)
  })

  test('a family that thinks in its own tokens gets a cap on a quiet round, not the closed block', () => {
    for (const id of ['gemma-4-12b-it', 'gpt-oss-20b']) {
      const p = agentThinkingProfile(id)
      assert.equal(p.control, 'cap', id)
      assert.equal(p.quietMaxTokens, QUIET_ROUND_MAX_TOKENS)
      assert.equal(p.think.read, false)
      assert.equal(p.think.first, true)
    }
  })

  test('a model that does not reason has nothing to manage', () => {
    const p = agentThinkingProfile('gemma-3-12b')
    assert.equal(p.control, 'none')
    assert.equal(p.quietMaxTokens, null)
  })
})
