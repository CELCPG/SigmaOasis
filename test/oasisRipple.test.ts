import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RIPPLES,
  THINKING_VISUAL,
  capRipples,
  describeOasisState,
  resolveMotion,
  settleRipple,
  toolVisualForName
} from '../src/renderer/src/lib/oasisRipple'
import type { ToolCallRecord } from '../src/renderer/src/types'

/**
 * Stress tests for the thinking indicator's state machine. The component
 * (OasisRipple.tsx) is a thin renderer over these pure functions, so hammering
 * them here covers the behavior users see: rapid tool storms, malformed tool
 * names, and every streaming/content combination the engine can produce.
 */

function tc(id: string, name: string, status: ToolCallRecord['status'] = 'running'): ToolCallRecord {
  return { id, name, args: {}, status }
}

// ---- Tool name → visual mapping ------------------------------------------------

test('every built-in tool maps to its documented visual', () => {
  const cases: [string, string, string][] = [
    // [tool name, expected kind, expected label]
    ['web_search', 'search', 'SEARCHING'],
    ['fetch_webpage', 'search', 'SEARCHING'],
    ['deep_research', 'search', 'SEARCHING'],
    ['run_terminal_command', 'code', 'EXECUTING'],
    ['memory_save', 'memory', 'RECALLING'],
    ['memory_search', 'memory', 'RECALLING'],
    ['memory_forget', 'memory', 'RECALLING'],
    ['create_note', 'memory', 'RECALLING'],
    ['list_notes', 'memory', 'RECALLING'],
    ['read_note', 'memory', 'RECALLING'],
    ['write_file', 'write', 'WRITING'],
    ['read_file', 'file', 'READING'],
    ['list_directory', 'file', 'READING'],
    ['consult_model', 'consult', 'CONSULTING'],
    ['get_current_datetime', 'generic', 'WORKING'],
    // v1.12: a market fetch is network activity and shows as such — not the
    // generic teal, which would hide that the app is contacting a host.
    ['market_data', 'search', 'SEARCHING']
  ]
  for (const [name, kind, label] of cases) {
    const visual = toolVisualForName(name)
    assert.equal(visual.kind, kind, `${name} → kind`)
    assert.equal(visual.label, label, `${name} → label`)
    assert.match(visual.color, /^#[0-9a-f]{6}$/, `${name} → hex color`)
  }
})

test('malformed, empty, and invented tool names never break the indicator', () => {
  for (const junk of ['', '   ', '!!@@##', 'delete_everything', '🚀', 'null', 'undefined']) {
    const visual = toolVisualForName(junk)
    assert.equal(visual.kind, 'generic', `"${junk}" degrades to generic`)
    assert.equal(visual.label, 'WORKING')
  }
})

test('tool matching is case-insensitive and whitespace-tolerant', () => {
  assert.equal(toolVisualForName('  WEB_SEARCH ').kind, 'search')
  assert.equal(toolVisualForName('Memory_Search').kind, 'memory')
  assert.equal(toolVisualForName('CONSULT_MODEL').kind, 'consult')
})

test('write_file matches write before the generic file rule', () => {
  // Ordering guard: 'write_file' contains 'file' but must be WRITING.
  assert.equal(toolVisualForName('write_file').kind, 'write')
})

// ---- Thinking state machine ------------------------------------------------------

test('hidden when not streaming, even with tools on the message', () => {
  const state = describeOasisState(false, '', [tc('a', 'web_search')])
  assert.equal(state.mode, 'hidden')
  assert.equal(state.tool, null)
  assert.equal(state.runningCount, 0)
})

test('ambient while the model composes with no tool activity', () => {
  const state = describeOasisState(true, '', [])
  assert.equal(state.mode, 'ambient')
  assert.equal(state.activeToolId, null)
})

test('tool mode while a tool runs with nothing said yet', () => {
  const state = describeOasisState(true, '', [tc('call_1', 'memory_search')])
  assert.equal(state.mode, 'tool')
  assert.equal(state.tool?.label, 'RECALLING')
  assert.equal(state.tool?.color, '#a78bfa')
  assert.equal(state.runningCount, 1)
  assert.equal(state.activeToolId, 'call_1')
})

test('finished tools (done/error) return the pool to ambient', () => {
  const done = describeOasisState(true, '', [tc('a', 'web_search', 'done')])
  assert.equal(done.mode, 'ambient')
  const errored = describeOasisState(true, '', [tc('a', 'web_search', 'error')])
  assert.equal(errored.mode, 'ambient')
})

test('ripple yields as soon as text starts flowing, even mid-tool', () => {
  // Once the model is visibly writing, the message owns the surface —
  // otherwise the indicator and text fight for the same space.
  const state = describeOasisState(true, 'Partial answer…', [tc('a', 'web_search')])
  assert.equal(state.mode, 'hidden')
})

test('whitespace content counts as flowing text', () => {
  const state = describeOasisState(true, ' ', [tc('a', 'web_search')])
  assert.equal(state.mode, 'hidden')
})

// ---- Stress: the agentic loop, exactly as the engine drives it --------------------

test('full tool storm: 8 iterations × 3 parallel calls, most-recent wins', () => {
  // Mirror useLMStudio.runTurn: records accumulate across iterations and are
  // patched as running → done. Feed the whole history at every step.
  const tools = ['web_search', 'fetch_webpage', 'read_file', 'run_terminal_command', 'memory_save']
  let records: ToolCallRecord[] = []
  let dropletEvents = 0

  for (let iteration = 0; iteration < 8; iteration++) {
    // A round can request several calls at once; all enter 'running' together.
    const round = Array.from({ length: 3 }, (_, i) =>
      tc(`r${iteration}c${i}`, tools[(iteration + i) % tools.length])
    )
    for (const record of round) {
      records = [...records, record]
      const state = describeOasisState(true, '', records)
      assert.equal(state.mode, 'tool')
      assert.equal(state.activeToolId, record.id, 'most recently started tool wins')
      assert.equal(state.tool, toolVisualForName(record.name), 'label matches the active tool')
      dropletEvents++
    }
    // Round finishes: all flip to done, pool goes back to ambient.
    records = records.map((r) => ({ ...r, status: 'done' as const }))
    assert.equal(describeOasisState(true, '', records).mode, 'ambient')
  }
  assert.equal(dropletEvents, 24)

  // The message ends: streaming stops, indicator hides. Never leaks a state.
  assert.equal(describeOasisState(false, '', records).mode, 'hidden')
})

test('parallel batch: runningCount reflects simultaneous calls', () => {
  const records = [tc('a', 'web_search'), tc('b', 'read_file'), tc('c', 'memory_save', 'done')]
  const state = describeOasisState(true, '', records)
  assert.equal(state.mode, 'tool')
  assert.equal(state.runningCount, 2)
  assert.equal(state.activeToolId, 'b', 'last running call is the active one')
})

test('mixed statuses: running wins over both done and error', () => {
  const records = [
    tc('a', 'web_search', 'error'),
    tc('b', 'read_file', 'done'),
    tc('c', 'deep_research', 'running')
  ]
  const state = describeOasisState(true, '', records)
  assert.equal(state.activeToolId, 'c')
  assert.equal(state.tool?.label, 'SEARCHING')
})

// ---- Ripple capping ---------------------------------------------------------------

test('ripples cap at MAX_RIPPLES under a droplet flood', () => {
  let active: string[] = []
  for (let i = 0; i < 50; i++) active = capRipples(active, `drop_${i}`)
  assert.equal(active.length, MAX_RIPPLES)
  assert.equal(active[active.length - 1], 'drop_49', 'newest survives')
  assert.equal(active[0], `drop_${50 - MAX_RIPPLES}`, 'oldest evicted first')
})

test('capRipples dedupes and returns identity for no-ops', () => {
  const base = ['a', 'b']
  assert.equal(capRipples(base, 'a'), base, 'duplicate → same reference')
  assert.deepEqual(capRipples(base, 'c', 3), ['a', 'b', 'c'], 'room → appended')
})

test('settleRipple removes only the finished id', () => {
  assert.deepEqual(settleRipple(['a', 'b', 'c'], 'b'), ['a', 'c'])
  const base = ['a']
  assert.equal(settleRipple(base, 'zzz'), base, 'absent → same reference')
})

// ---- Motion policy ------------------------------------------------------------------

test('reduced motion keeps information, drops movement', () => {
  const reduced = resolveMotion(true)
  assert.equal(reduced.animateDroplets, false)
  assert.equal(reduced.animateAmbient, false)
  const full = resolveMotion(false)
  assert.equal(full.animateDroplets, true)
  assert.equal(full.animateAmbient, true)
})

test('ambient thinking visual is always the brand teal THINKING', () => {
  assert.equal(THINKING_VISUAL.label, 'THINKING')
  assert.equal(THINKING_VISUAL.color, '#00d4aa')
})
