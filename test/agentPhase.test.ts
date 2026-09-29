import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { skipThinking } from '../src/main/agent/phase'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'

/** v4.0 (A3, an experiment): which rounds start with the thinking block closed. */

const sys: ApiMessage = { role: 'system', content: 'You are Sigma.' }
const user: ApiMessage = { role: 'user', content: 'Fix the failing test.' }
const call = (id: string): ApiMessage => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }] } as unknown as ApiMessage)
const result = (id: string, content: string): ApiMessage => ({ role: 'tool', tool_call_id: id, content } as unknown as ApiMessage)

describe('skipThinking', () => {
  test('the first round thinks', () => {
    assert.equal(skipThinking(0, [sys, user]), false)
  })

  test('a round after a successful read does not', () => {
    assert.equal(skipThinking(1, [sys, user, call('a'), result('a', '1→export function mean() {}')]), true)
  })

  test('a round after a tool error thinks', () => {
    assert.equal(skipThinking(2, [sys, user, call('a'), result('a', 'Error: old_string was not found in src/stats.js')]), false)
  })

  test('a round after a command that exited non-zero thinks', () => {
    assert.equal(skipThinking(2, [sys, user, call('a'), result('a', '$ node --test\n✖ breaks\n(exit code 1, 0.4 s)')]), false)
    assert.equal(skipThinking(2, [sys, user, call('a'), result('a', '$ node --test\nℹ pass 3\n(exit code 0, 0.4 s)')]), true)
  })

  test('a round after the user spoke again thinks', () => {
    assert.equal(skipThinking(3, [sys, user, call('a'), result('a', 'ok'), { role: 'user', content: 'also rename it' }]), false)
  })
})
