import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  toolsForSlot,
  selectTurnTools,
  stabilizeTurnTools,
  rankingIsDecisive,
  withBudgetNotes,
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
    'web_search', 'fetch_webpage', 'date_calculator', 'memory_search', 'memory_save'
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
      ['read_file', 'web_search', 'fetch_webpage', 'date_calculator', 'memory_search', 'memory_save']
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
    assert.ok(result.some((t) => t.function.name === 'date_calculator'))
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
      const previous = ['read_file', 'date_calculator', 'memory_search', 'memory_save']
      const selected = selectTurnTools(TURN_TOOLS, { fetch_webpage: 0.95 })
      // fetch_webpage was not on last turn's list, so the prefix has to move.
      assert.ok(names(selected).includes('fetch_webpage'))
      const out = stabilizeTurnTools(TURN_TOOLS, selected, previous)
      assert.equal(out, selected)
    })

    test('a tool disabled since last turn cannot come back through the cache', () => {
      const shrunk = TURN_TOOLS.filter((t) => t.function.name !== 'run_terminal_command')
      const previous = ['read_file', 'run_terminal_command', 'date_calculator']
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

/**
 * v1.4.5. Measured against nomic-embed-text-v1.5: a one-word turn separates
 * its top tool candidates by 0.014–0.056 cosine, which is a coin flip, while a
 * turn that genuinely names a tool separates them by 0.18–0.19. Acting on the
 * coin flip put `list_notes`, then `list_directory`, then `create_note` on
 * three consecutive turns of a conversation about a sales deck — wrong tools,
 * and a tool list that moved every turn, discarding the prompt cache with it.
 */
describe('rankingIsDecisive', () => {
  /** Scores shaped like a real ranking: one clear winner, then a tail. */
  const decisive = {
    read_file: 0.687,
    create_note: 0.601,
    list_notes: 0.571,
    fetch_webpage: 0.496,
    web_search: 0.44,
    memory_save: 0.43,
    memory_search: 0.42
  }
  /** The measured "1" case: everything within 0.014. */
  const noise = {
    web_search: 0.438,
    list_notes: 0.433,
    fetch_webpage: 0.425,
    memory_search: 0.424,
    memory_save: 0.424,
    deep_research: 0.423,
    read_file: 0.422
  }

  test('a query that names a tool ranks decisively', () => {
    assert.equal(rankingIsDecisive(decisive), true)
  })

  test('a one-word turn does not', () => {
    assert.equal(rankingIsDecisive(noise), false)
  })

  test('no ranking at all is not decisive', () => {
    assert.equal(rankingIsDecisive(null), false)
  })

  test('a list shorter than the cap needs no discrimination', () => {
    // Everything fits; there is no cut line to be uncertain about.
    assert.equal(rankingIsDecisive({ a: 0.5, b: 0.5 }), true)
  })

  test('the threshold sits between the measured noise and the measured signal', () => {
    // The two closest real cases either side of the line, so a future tweak
    // has to consciously reclassify one of them.
    const spread = (top: number, cut: number): Record<string, number> => ({
      a: top, b: top - 0.001, c: top - 0.002, d: top - 0.003,
      e: top - 0.004, f: cut, g: cut - 0.01
    })
    assert.equal(rankingIsDecisive(spread(0.508, 0.508 - 0.056)), false) // "yes"
    assert.equal(rankingIsDecisive(spread(0.482, 0.482 - 0.091)), true) // weather
  })
})

/**
 * v1.4.5. Budgets were enforced and never disclosed, so the only way to learn
 * one was to be refused. Measured: five web_search calls against a budget of
 * three, then three fetch_webpage against two, then two more searches — seven
 * of twelve rejected across three rounds, and the answer filled the gaps from
 * memory.
 */
describe('withBudgetNotes', () => {
  const tools: ToolSchema[] = ['web_search', 'read_file'].map((name) => ({
    type: 'function',
    function: { name, description: `${name} does a thing.`, parameters: {} }
  }))

  test('a budgeted tool says its budget', () => {
    const [search] = withBudgetNotes(tools, { web_search: 3 })
    assert.match(search.function.description, /at most 3 calls per turn/)
    assert.match(search.function.description, /web_search does a thing\./)
  })

  test('an unbudgeted tool is untouched', () => {
    const out = withBudgetNotes(tools, { web_search: 3 })
    assert.equal(out[1].function.description, 'read_file does a thing.')
  })

  test('singular reads correctly for a budget of one', () => {
    const [search] = withBudgetNotes(tools, { web_search: 1 })
    assert.match(search.function.description, /at most 1 call per turn/)
  })

  test('the originals are not mutated', () => {
    withBudgetNotes(tools, { web_search: 3 })
    assert.equal(tools[0].function.description, 'web_search does a thing.')
  })
})

describe('withForcedTools (v1.6)', () => {
  const { withForcedTools, ALWAYS_ON_TOOLS, TURN_TOOL_CAP } = require('../src/renderer/src/lib/toolSelection') as typeof import('../src/renderer/src/lib/toolSelection')
  const schema = (name: string): ToolSchema => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } })
  const available = [...ALWAYS_ON_TOOLS, 'web_search', 'fetch_webpage', 'run_python', 'analyze_file', 'shop_compare'].map(schema)
  test('adds a missing forced tool, evicting the last optional pick to keep the cap', () => {
    const selected = [...ALWAYS_ON_TOOLS, 'web_search', 'fetch_webpage'].map(schema) // 6 = cap
    const out = withForcedTools(available, selected, ['run_python']).map((t) => t.function.name)
    assert.ok(out.includes('run_python'))
    assert.ok(out.length <= TURN_TOOL_CAP)
    assert.ok(!out.includes('fetch_webpage'), 'the last optional pick made room')
    assert.ok(ALWAYS_ON_TOOLS.every((n) => out.includes(n)), 'always-on survives')
  })
  test('a forced tool already present changes nothing', () => {
    // selectTurnTools returns wire order, so the input is in wire order too.
    const selected = [...ALWAYS_ON_TOOLS, 'web_search', 'run_python'].map(schema)
    assert.deepEqual(withForcedTools(available, selected, ['run_python']).map((t) => t.function.name), selected.map((t) => t.function.name))
  })
  test('a forced tool not in the allowlist is ignored', () => {
    const selected = [...ALWAYS_ON_TOOLS, 'web_search'].map(schema)
    assert.deepEqual(withForcedTools(available, selected, ['nope']).map((t) => t.function.name), selected.map((t) => t.function.name))
  })
  test('wire order is preserved', () => {
    const selected = [...ALWAYS_ON_TOOLS, 'shop_compare'].map(schema)
    const out = withForcedTools(available, selected, ['analyze_file', 'run_python']).map((t) => t.function.name)
    const idx = (n: string): number => available.findIndex((t) => t.function.name === n)
    assert.deepEqual(out, [...out].sort((a, b) => idx(a) - idx(b)))
  })
})
