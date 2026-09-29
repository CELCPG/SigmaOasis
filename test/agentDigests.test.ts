import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { changedSpan, digestCommandOutput, digestTestOutput, editedWindow, groupGrepOutput } from '../src/main/agent/digests'

/** v4.0 (A2, an experiment): tool results shaped for a small reader. */

describe('digestTestOutput', () => {
  test('node --test: totals and the failures', () => {
    const out = ['▶ suite', '  ✔ works (1ms)', '  ✖ breaks (2ms)', 'ℹ tests 3', 'ℹ pass 2', 'ℹ fail 1', '✖ failing tests:', '✖ breaks (2ms)'].join('\n')
    const d = digestTestOutput(out)
    assert.equal(d.runner, 'node')
    assert.deepEqual([d.passed, d.failed], [2, 1])
    assert.deepEqual(d.failures, ['breaks'])
  })

  test('pytest: FAILED lines and the summary', () => {
    const out = 'FAILED tests/test_a.py::test_x - AssertionError: 1 != 2\n=========== 1 failed, 4 passed in 0.31s ==========='
    const d = digestTestOutput(out)
    assert.equal(d.runner, 'pytest')
    assert.deepEqual([d.passed, d.failed], [4, 1])
    assert.deepEqual(d.failures, ['tests/test_a.py::test_x - AssertionError: 1 != 2'])
  })

  test('vitest and jest: the Tests line and ✕ rows', () => {
    const v = digestTestOutput(' ✕ adds (3 ms)\n Test Files  1 failed (1)\n      Tests  1 failed | 5 passed (6)')
    assert.equal(v.runner, 'vitest')
    assert.deepEqual([v.passed, v.failed, v.failures], [5, 1, ['adds']])
    const j = digestTestOutput('  ● adds\nTests:       1 failed, 5 passed, 6 total')
    assert.equal(j.runner, 'jest')
    assert.deepEqual([j.passed, j.failed], [5, 1])
  })

  test('go test and cargo test', () => {
    const g = digestTestOutput('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\nFAIL\tpkg\t0.02s')
    assert.deepEqual([g.runner, g.passed, g.failed, g.failures], ['go', 1, 1, ['TestB']])
    const c = digestTestOutput('test adds ... ok\ntest breaks ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 0 ignored')
    assert.deepEqual([c.runner, c.passed, c.failed, c.failures], ['cargo', 1, 1, ['breaks']])
  })

  test('anything else is unknown, and the command result is left untouched', () => {
    assert.equal(digestTestOutput('Compiled 3 files.').runner, 'unknown')
    assert.equal(digestCommandOutput('Compiled 3 files.'), 'Compiled 3 files.')
  })

  test('a digested result puts the totals and failures first and keeps the raw tail', () => {
    const out = ['ℹ tests 2', 'ℹ pass 1', 'ℹ fail 1', '✖ breaks (1ms)', 'x'.repeat(3000)].join('\n')
    const d = digestCommandOutput(out)
    assert.match(d, /^Test digest \(node\): 1 failed, 1 passed\.\n  ✖ breaks/)
    assert.match(d, /--- output \(last 2000 of \d+ chars\) ---/)
    assert.ok(d.endsWith('x'.repeat(2000)))
  })
})

describe('groupGrepOutput', () => {
  test('groups by file, most hits first, with the count', () => {
    const out = ['src/a.ts:3: foo()', 'src/b.ts:10: foo', 'src/a.ts:9: foo again', 'src/a.ts:20: foo'].join('\n')
    const g = groupGrepOutput(out)
    assert.match(g, /^4 hits in 2 files\nsrc\/a\.ts \(3\)\n  3: foo\(\)\n  9: foo again\n  20: foo\nsrc\/b\.ts \(1\)\n  10: foo$/)
  })

  test('output that is not grep lines is left as it is', () => {
    assert.equal(groupGrepOutput('No matches.'), 'No matches.')
  })
})

describe('editedWindow and changedSpan', () => {
  test('finds the changed lines and shows them with context, numbered', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
    const after = ['a', 'b', 'C', 'D', 'e', 'f', 'g'].join('\n')
    const span = changedSpan(before, after)!
    assert.deepEqual(span, { from: 3, to: 4 })
    const w = editedWindow(after, span.from, span.to, 1)
    assert.equal(w, 'Lines 2–5 of 7 after the edit:\n2→b\n3→C\n4→D\n5→e')
  })

  test('identical texts have no span; an insertion is bounded', () => {
    assert.equal(changedSpan('a\nb', 'a\nb'), null)
    assert.deepEqual(changedSpan('a\nb', 'a\nx\nb'), { from: 2, to: 2 })
  })
})
