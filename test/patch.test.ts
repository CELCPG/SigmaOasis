import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, describeStats, unifiedDiff } from '../src/shared/patch'

/**
 * v2.8: diff-reviewed writes — the arithmetic. Edits must match exactly
 * once; the diff is a unified patch a reader can read and a tool can apply.
 */

describe('search-and-replace edits', () => {
  const file = 'alpha\nbeta\ngamma\n'

  test('an edit that matches once is applied; an empty search appends', () => {
    const r = applyEdits(file, [{ search: 'beta', replace: 'BETA' }, { search: '', replace: 'delta\n' }])
    assert.ok(r.ok)
    assert.equal(r.text, 'alpha\nBETA\ngamma\ndelta\n')
  })

  test('a search that is missing, or ambiguous, is refused with the reason', () => {
    const missing = applyEdits(file, [{ search: 'omega', replace: 'x' }])
    assert.ok(!missing.ok && /not found/.test(missing.error))
    const twice = applyEdits('a\na\n', [{ search: 'a', replace: 'b' }])
    assert.ok(!twice.ok && /more than once/.test(twice.error))
    const malformed = applyEdits(file, [{ search: 'alpha' } as never])
    assert.ok(!malformed.ok)
  })
})

describe('unified diff', () => {
  test('a one-line change is one hunk with context, and the counts say so', () => {
    const old = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n') + '\n'
    const next = old.replace('four', 'FOUR')
    const { diff, stats } = unifiedDiff(old, next, 'notes.txt')
    assert.deepEqual(stats, { added: 1, removed: 1, hunks: 1 })
    assert.equal(
      diff,
      ['--- notes.txt', '+++ notes.txt', '@@ -1,7 +1,7 @@', ' one', ' two', ' three', '-four', '+FOUR', ' five', ' six', ' seven'].join('\n')
    )
  })

  test('two distant changes are two hunks; adjacent ones merge', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const old = lines.join('\n') + '\n'
    const next = old.replace('line 3', 'LINE 3').replace('line 25', 'LINE 25')
    const two = unifiedDiff(old, next, 'f')
    assert.equal(two.stats.hunks, 2)
    const near = unifiedDiff(old, old.replace('line 3', 'LINE 3').replace('line 5', 'LINE 5'), 'f')
    assert.equal(near.stats.hunks, 1)
    assert.deepEqual(near.stats, { added: 2, removed: 2, hunks: 1 })
  })

  test('a new file is all additions; an unchanged file is no hunks', () => {
    const fresh = unifiedDiff('', 'a\nb\n', 'new.txt')
    assert.deepEqual(fresh.stats, { added: 2, removed: 0, hunks: 1 })
    assert.equal(describeStats(fresh.stats, true), 'new file, 2 lines')
    const same = unifiedDiff('a\nb\n', 'a\nb\n', 'x')
    assert.deepEqual(same.stats, { added: 0, removed: 0, hunks: 0 })
    assert.equal(describeStats({ added: 12, removed: 3, hunks: 2 }, false), '+12 −3 in 2 hunks')
  })

  test('the diff applied to the old text yields the new text (round trip through the hunks)', () => {
    const old = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n') + '\n'
    const next = old.replace('l2\n', '').replace('l7', 'l7\nl7b').replace('l11', 'L11')
    const { diff } = unifiedDiff(old, next, 'f')
    // Reconstruct by walking the hunks over the old lines.
    const oldLines = old.split('\n').slice(0, -1)
    const out: string[] = []
    let cursor = 0
    for (const h of diff.split('\n').slice(2).join('\n').split(/^(?=@@ )/m).filter(Boolean)) {
      const m = /^@@ -(\d+),(\d+)/.exec(h)!
      const start = Number(m[1]) - 1
      while (cursor < start) out.push(oldLines[cursor++]!)
      for (const line of h.split('\n').slice(1)) {
        if (line.startsWith('+')) out.push(line.slice(1))
        else if (line.startsWith('-')) cursor++
        else if (line.startsWith(' ')) out.push(oldLines[cursor++]!)
      }
    }
    while (cursor < oldLines.length) out.push(oldLines[cursor++]!)
    assert.equal(out.join('\n') + '\n', next)
  })
})
