import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  aggregateEvalFiles,
  readEvalFixtures,
  saveEvalResult,
  type EvalFixtureRun,
  type EvalResultFile
} from '../src/main/ipc/evalResults'

/**
 * Layer 0c: the fold from .eval-results/ chunk files into per-model score
 * summaries. The rules that matter: per fixture the newest run wins (a retry
 * replaces its timeout), errored runs are excluded from rates, and malformed
 * files are skipped rather than fatal.
 */

function run(partial: Partial<EvalFixtureRun> & { file: string }): EvalFixtureRun {
  return {
    expect: { tool: 'read_file' },
    round1Calls: [],
    allCalls: [],
    stopReason: 'completed',
    correct: null,
    spurious: null,
    looped: false,
    ...partial
  }
}

function file(model: string, ranAt: string, runs: EvalFixtureRun[]): EvalResultFile {
  return { model, ranAt, runs }
}

const OK_CALL = { name: 'read_file', valid: true, errors: [] as string[] }

describe('aggregateEvalFiles (Layer 0c)', () => {
  test('a successful retry replaces the earlier timeout, newest run wins', () => {
    const summaries = aggregateEvalFiles([
      file('big', '2026-08-03T10:00:00Z', [run({ file: '01.json', correct: true, allCalls: [OK_CALL] })]),
      file('big', '2026-08-03T11:00:00Z', [run({ file: '01.json', error: 'timeout' })]),
      file('big', '2026-08-03T12:00:00Z', [run({ file: '01.json', correct: true, allCalls: [OK_CALL] })])
    ])
    assert.equal(summaries.length, 1)
    assert.deepEqual(summaries[0].correctTool, { hit: 1, of: 1 })
    assert.equal(summaries[0].ranAt, '2026-08-03T12:00:00Z')
  })

  test('when the newest run of a fixture errored, it is excluded from rates', () => {
    const summaries = aggregateEvalFiles([
      file('big', '2026-08-03T10:00:00Z', [run({ file: '01.json', correct: true, allCalls: [OK_CALL] })]),
      file('big', '2026-08-03T11:00:00Z', [run({ file: '01.json', error: 'timeout' })])
    ])
    assert.deepEqual(summaries[0].correctTool, { hit: 0, of: 0 })
  })

  test('file order does not matter', () => {
    const oldest = file('big', '2026-08-03T10:00:00Z', [run({ file: '01.json', correct: false })])
    const newest = file('big', '2026-08-03T12:00:00Z', [run({ file: '01.json', correct: true, allCalls: [OK_CALL] })])
    const forward = aggregateEvalFiles([oldest, newest])
    const reverse = aggregateEvalFiles([newest, oldest])
    assert.deepEqual(reverse, forward)
    assert.deepEqual(reverse[0].correctTool, { hit: 1, of: 1 })
  })

  test('rates split across models, and no-tool fixtures feed only spurious', () => {
    const summaries = aggregateEvalFiles([
      file('small', '2026-08-03T10:00:00Z', [
        run({ file: '01.json', correct: true, allCalls: [OK_CALL] }),
        run({ file: '02.json', correct: false }),
        run({ file: '17.json', expect: 'no_tool', spurious: false })
      ]),
      file('big', '2026-08-03T11:00:00Z', [
        run({ file: '01.json', correct: true, allCalls: [OK_CALL, { name: 'x', valid: false, errors: ['bad'] }] })
      ])
    ])
    assert.deepEqual(summaries.map((s) => s.model), ['big', 'small'])
    const small = summaries[1]
    assert.deepEqual(small.correctTool, { hit: 1, of: 2 })
    assert.deepEqual(small.spuriousCall, { hit: 0, of: 1 })
    assert.deepEqual(small.argValidity, { hit: 1, of: 1 })
    const big = summaries[0]
    assert.deepEqual(big.spuriousCall, { hit: 0, of: 0 })
    assert.deepEqual(big.argValidity, { hit: 1, of: 2 })
  })

  test('looped runs count against the loop rate', () => {
    const summaries = aggregateEvalFiles([
      file('m', '2026-08-03T10:00:00Z', [
        run({ file: '01.json', correct: false, looped: true, stopReason: 'iteration_cap' })
      ])
    ])
    assert.deepEqual(summaries[0].loop, { hit: 1, of: 1 })
  })

  test('malformed files are skipped, not fatal', () => {
    const summaries = aggregateEvalFiles([
      { nope: true } as unknown as EvalResultFile,
      file('m', '2026-08-03T10:00:00Z', [run({ file: '01.json', correct: true, allCalls: [OK_CALL] })])
    ])
    assert.equal(summaries.length, 1)
    assert.deepEqual(summaries[0].correctTool, { hit: 1, of: 1 })
  })
})


describe('readEvalFixtures (in-app eval support)', () => {
  const FIXTURES_DIR = join(process.cwd(), 'test', 'fixtures', 'toolchoice')
  const TOOL_NAMES = [
    'read_file',
    'write_file',
    'list_directory',
    'run_terminal_command',
    'web_search',
    'fetch_webpage',
    'get_current_datetime',
    'create_note',
    'list_notes',
    'read_note',
    'memory_save',
    'memory_search',
    'memory_forget',
    'deep_research',
    'finance_calculator',
    'shop_requirements',
    'shop_compare',
    'price_watch'
  ]

  test('the repo fixture tree loads, sorted, with both expectation kinds', () => {
    const fixtures = readEvalFixtures(FIXTURES_DIR, TOOL_NAMES)
    assert.ok(fixtures.length >= 19, `expected the 19 shipped fixtures, got ${fixtures.length}`)
    assert.ok(fixtures.some((f) => f.expect === 'no_tool'))
    assert.ok(fixtures.some((f) => typeof f.expect === 'object'))
    const names = fixtures.map((f) => f.file)
    assert.deepEqual(names, [...names].sort())
  })

  test('a missing directory is an empty list, never an error', () => {
    assert.deepEqual(readEvalFixtures(join(FIXTURES_DIR, 'does-not-exist'), TOOL_NAMES), [])
  })
})

describe('saveEvalResult', () => {
  test('writes the CLI filename convention so the fold picks it up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oasis-eval-'))
    try {
      const payload = { model: 'acme/model-7b', baseUrl: 'http://x', ranAt: 'now', runs: [] }
      const res = saveEvalResult(dir, payload)
      assert.equal(res.ok, true)
      const names = readdirSync(dir)
      assert.equal(names.length, 1)
      assert.match(names[0], /^toolchoice-acme_model-7b-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/)
      assert.deepEqual(JSON.parse(readFileSync(join(dir, names[0]), 'utf-8')), payload)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects payloads without a model and runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oasis-eval-'))
    try {
      assert.equal(saveEvalResult(dir, { runs: [] }).ok, false)
      assert.equal(saveEvalResult(dir, { model: 'm' }).ok, false)
      assert.equal(saveEvalResult(dir, 'nope').ok, false)
      assert.equal(readdirSync(dir).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
