import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { schemaVersionFor } from '../src/main/ipc/traceExport'
import {
  ALWAYS_ON_TOOLS,
  DEFAULT_TOOL_TOGGLES,
  SOURCE_TOOLS,
  TOOL_DEFS,
  TOOL_LABELS,
  TOOL_SCHEMAS,
  TOOL_TURN_BUDGETS
} from '../src/shared/tools'

/**
 * The tool table (src/shared/tools) is the single declaration every other
 * tool-keyed structure derives from. Two things TypeScript cannot pin are
 * pinned here instead:
 *
 * 1. **The wire bytes.** TOOL_SCHEMAS is what LM Studio sees and what the
 *    tool-choice eval scores; its hash is the trace exporter's schemaVersion.
 *    A def edit that changes the hash is a measured change (re-run the evals),
 *    never a refactor — this test makes that visible in CI, not in a diff of
 *    committed eval results three weeks later.
 *
 * 2. **Toggle identity.** Settings keys derive from def names, so renaming a
 *    def silently drops the user's stored toggle and reverts that tool to its
 *    default — for a default-on tool the user had turned off, it would come
 *    back on. The name snapshot turns a rename into a red test.
 */

/** The wire hash at the point the table was extracted from toolSchemas.ts (v1.12.1). */
// v2.7: run_code joined the table (Code Mode); the hash moved with it.
const PINNED_SCHEMA_HASH = 'd1450cd52b24'

const PINNED_NAMES = [
  'read_file',
  'write_file',
  'list_directory',
  'run_terminal_command',
  'web_search',
  'image_search',
  'fetch_webpage',
  'deep_research',
  'finance_calculator',
  'geo_locate',
  'date_calculator',
  'get_current_datetime',
  'create_note',
  'list_notes',
  'read_note',
  'memory_save',
  'memory_search',
  'memory_forget',
  'reference_lookup',
  'run_code',
  'run_python',
  'analyze_file',
  'shop_requirements',
  'shop_compare',
  'price_watch',
  'market_data'
]

/** Off by default: machine-mutating or egress-initiating tools. */
const PINNED_OFF_BY_DEFAULT = [
  'write_file',
  'run_terminal_command',
  'shop_requirements',
  'shop_compare',
  'price_watch',
  'market_data'
]

describe('tool table', () => {
  test('names are unique (a duplicate collapses silently in the ToolName union)', () => {
    const names = TOOL_DEFS.map((d) => d.name)
    assert.equal(new Set(names).size, names.length)
  })

  test('the wire order and name set are pinned', () => {
    assert.deepEqual(
      TOOL_SCHEMAS.map((t) => t.function.name),
      PINNED_NAMES
    )
  })

  test('the wire schema hash is pinned — a change here is a measured change', () => {
    assert.equal(schemaVersionFor(TOOL_SCHEMAS as unknown[]), PINNED_SCHEMA_HASH)
  })

  test('toggle defaults are pinned — a def rename would revert a user setting', () => {
    for (const name of PINNED_NAMES) {
      const expected = !PINNED_OFF_BY_DEFAULT.includes(name)
      assert.equal(DEFAULT_TOOL_TOGGLES[name as keyof typeof DEFAULT_TOOL_TOGGLES], expected, name)
    }
  })

  test('derived budget table matches the pre-refactor literals', () => {
    assert.deepEqual(TOOL_TURN_BUDGETS, {
      web_search: 3,
      image_search: 2,
      fetch_webpage: 2,
      deep_research: 1,
      reference_lookup: 3,
      run_code: 3,
      run_python: 4,
      analyze_file: 2,
      shop_requirements: 2,
      shop_compare: 2,
      market_data: 4
    })
  })

  test('derived always-on and source sets match the pre-refactor literals', () => {
    assert.deepEqual(
      [...ALWAYS_ON_TOOLS],
      ['date_calculator', 'memory_save', 'memory_search', 'memory_forget']
    )
    assert.deepEqual(
      [...SOURCE_TOOLS].sort(),
      [
        'analyze_file',
        'deep_research',
        'fetch_webpage',
        'finance_calculator',
        'market_data',
        'reference_lookup',
        'run_code',
        'run_python',
        'web_search'
      ]
    )
  })

  test('every def carries a label', () => {
    for (const d of TOOL_DEFS) {
      assert.ok(TOOL_LABELS[d.name].length > 0, d.name)
    }
  })
})
