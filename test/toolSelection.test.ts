import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  toolsForSlot,
  selectTurnTools,
  stabilizeTurnTools,
  TURN_TOOL_CAP
} from '../src/renderer/src/lib/toolSelection'
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

  /**
   * v1.5: the subset is rendered inside the system block by every chat
   * template, so reshuffling it per turn moves the prompt's first bytes and
   * costs a full re-prefill of the conversation. Stability is only allowed to
   * hold while it changes nothing the ranking asked for.
   */
  describe('stabilizeTurnTools', () => {
    const names = (tools: ToolSchema[]): string[] => tools.map((t) => t.function.name)

    test('the first turn of a conversation has nothing to hold to', () => {
      const selected = selectTurnTools(TURN_TOOLS, { web_search: 0.9 })
      assert.equal(stabilizeTurnTools(TURN_TOOLS, selected, undefined), selected)
      assert.equal(stabilizeTurnTools(TURN_TOOLS, selected, []), selected)
    })

    test('a follow-up covered by last turn\'s subset reuses it exactly', () => {
      const selected = selectTurnTools(TURN_TOOLS, {
        web_search: 0.9,
        read_file: 0.8,
        fetch_webpage: 0.7
      })
      // Last turn carried everything this turn wants, and one tool besides.
      const previous = [...names(selected), 'write_file']
      const out = stabilizeTurnTools(TURN_TOOLS, selected, previous)
      assert.ok(names(out).includes('write_file'))
      assert.equal(names(out).length, previous.length)
    })

    test('a change of subject takes the new selection', () => {
      const previous = ['read_file', 'get_current_datetime', 'memory_search', 'memory_save']
      const selected = selectTurnTools(TURN_TOOLS, { fetch_webpage: 0.95 })
      // fetch_webpage was not on last turn's list, so the prefix has to move.
      assert.ok(names(selected).includes('fetch_webpage'))
      const out = stabilizeTurnTools(TURN_TOOLS, selected, previous)
      assert.equal(out, selected)
    })

    test('a tool disabled since last turn cannot come back through the cache', () => {
      const shrunk = TURN_TOOLS.filter((t) => t.function.name !== 'run_terminal_command')
      const previous = ['read_file', 'run_terminal_command', 'get_current_datetime']
      const selected = selectTurnTools(shrunk, { read_file: 0.9 }, 3)
      const out = stabilizeTurnTools(shrunk, selected, previous)
      assert.ok(!names(out).includes('run_terminal_command'))
    })

    test('a cache naming nothing still available falls back to the selection', () => {
      const selected = selectTurnTools(TURN_TOOLS, { web_search: 0.9 }, 3)
      assert.equal(stabilizeTurnTools(TURN_TOOLS, selected, ['gone', 'also_gone']), selected)
    })

    test('the reused list keeps wire order, not cache order', () => {
      const selected = selectTurnTools(TURN_TOOLS, { read_file: 0.9 })
      // The same set as the cache holds it: reversed. Wire order has to win,
      // because a reordered tool list is a changed prompt prefix.
      const previous = [...names(selected)].reverse()
      const out = stabilizeTurnTools(TURN_TOOLS, selected, previous)
      assert.deepEqual(names(out), names(selected))
    })
  })
})
