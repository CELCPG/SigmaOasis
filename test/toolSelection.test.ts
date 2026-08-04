import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toolsForSlot, selectTurnTools, TURN_TOOL_CAP } from '../src/renderer/src/lib/toolSelection'
import type { ToolSchema } from '../src/renderer/src/types'

/**
 * Layer 1a's one rule: absent means all (legacy migration), an array — even
 * empty — is an allowlist intersected with the globally-enabled set.
 */

const AVAILABLE: ToolSchema[] = ['read_file', 'web_search', 'list_directory'].map((name) => ({
  type: 'function',
  function: { name, description: `${name} tool`, parameters: {} }
}))

describe('toolsForSlot', () => {
  test('absent allowlist returns every globally-enabled tool (legacy)', () => {
    assert.equal(toolsForSlot({}, AVAILABLE), AVAILABLE)
  })

  test('non-array residue (null, old settings) also means all', () => {
    assert.equal(toolsForSlot({ tools: null as unknown as string[] }, AVAILABLE), AVAILABLE)
  })

  test('an allowlist keeps only named, globally-enabled tools, in wire order', () => {
    const result = toolsForSlot({ tools: ['web_search', 'read_file'] }, AVAILABLE)
    assert.deepEqual(
      result.map((t) => t.function.name),
      ['read_file', 'web_search']
    )
  })

  test('a global toggle-off always wins over the allowlist', () => {
    const result = toolsForSlot({ tools: ['web_search', 'run_terminal_command'] }, AVAILABLE)
    assert.deepEqual(result.map((t) => t.function.name), ['web_search'])
  })

  test('an empty array is a real allowlist: no tools at all', () => {
    assert.deepEqual(toolsForSlot({ tools: [] }, AVAILABLE), [])
  })

  test('stale names from an older toolbox are ignored, not fatal', () => {
    const result = toolsForSlot({ tools: ['web_search', 'retired_tool'] }, AVAILABLE)
    assert.deepEqual(result.map((t) => t.function.name), ['web_search'])
  })
})

describe('selectTurnTools', () => {
  const TURN_TOOLS: ToolSchema[] = [
    'read_file', 'write_file', 'list_directory', 'run_terminal_command',
    'web_search', 'fetch_webpage', 'get_current_datetime', 'memory_search', 'memory_save'
  ].map((name) => ({
    type: 'function',
    function: { name, description: `${name} tool`, parameters: {} }
  }))

  test('null scores mean "no ranking" — the full list is the fallback', () => {
    assert.equal(selectTurnTools(TURN_TOOLS, null), TURN_TOOLS)
  })

  test('a list already under the cap passes through untouched', () => {
    const small = TURN_TOOLS.slice(0, 4)
    assert.equal(selectTurnTools(small, { read_file: 0.9 }), small)
  })

  test('always-on tools ride every turn; top matches fill to the cap', () => {
    const scores = { web_search: 0.9, fetch_webpage: 0.8, read_file: 0.7 }
    const result = selectTurnTools(TURN_TOOLS, scores)
    assert.deepEqual(
      result.map((t) => t.function.name),
      // Wire order preserved: read_file was 3rd-ranked but sits first in the list.
      ['read_file', 'web_search', 'fetch_webpage', 'get_current_datetime', 'memory_search', 'memory_save']
    )
    assert.equal(result.length, TURN_TOOL_CAP)
  })

  test('unscored tools rank as zero and are cut first', () => {
    const scores = { read_file: 0.5, write_file: 0.4, list_directory: 0.3, run_terminal_command: 0.2 }
    const result = selectTurnTools(TURN_TOOLS, scores)
    assert.ok(!result.some((t) => t.function.name === 'web_search'))
    assert.equal(result.length, TURN_TOOL_CAP)
  })

  test('a custom cap bounds plan-step-style turns', () => {
    const result = selectTurnTools(TURN_TOOLS, { web_search: 0.9 }, 4)
    assert.equal(result.length, 4)
    assert.ok(result.some((t) => t.function.name === 'web_search'))
    assert.ok(result.some((t) => t.function.name === 'get_current_datetime'))
  })
})
