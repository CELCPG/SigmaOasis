import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { describeRun, parseRanCode } from '../src/renderer/src/lib/ranCode'
import { formatRun } from '../src/main/ipc/workbenchFormat'

/**
 * The "Ran code" block parses the run_python result text back into sections.
 * Pinned against the formatter's own output so the two cannot drift apart.
 */
const base = { ok: true, stdout: '', stderr: '', result: null, files: [] as { name: string; data: Buffer }[], durationMs: 3 }

describe('parseRanCode', () => {
  test('a successful run: duration, stdout, result, files; boilerplate dropped', () => {
    const text = formatRun({ ...base, durationMs: 1515, stdout: 'East 37907.39\nWest 37317.44\n', result: '391', files: [{ name: 'chart.png', data: Buffer.from('89504e470d0a1a0a', 'hex') }, { name: 'out.csv', data: Buffer.from('a,b\n1,2') }] }, '').output!
    const p = parseRanCode(text + '\n\nFiles available under /work: sales.csv.', true)
    assert.equal(p.durationMs, 1515)
    assert.equal(p.stdout, 'East 37907.39\nWest 37317.44')
    assert.equal(p.result, '391')
    assert.equal(p.files.length, 2)
    assert.match(p.files[0], /^chart\.png .*image — shown to the user/)
    assert.match(p.files[1], /^out\.csv/)
    assert.equal(p.error, '')
    assert.deepEqual(p.notes, ['Files available under /work: sales.csv.'])
    assert.equal(describeRun(p), 'ran in 1.5 s')
  })
  test('a failed run: stdout before the error, the traceback, no rule sentence', () => {
    const text = formatRun({ ...base, ok: false, durationMs: 40, stdout: 'partial\n', error: 'Traceback (most recent call last):\n  File "<exec>", line 2\nZeroDivisionError: division by zero' }, '').error!
    const p = parseRanCode(text, false)
    assert.equal(p.durationMs, 40)
    assert.equal(p.stdout, 'partial')
    assert.match(p.error, /ZeroDivisionError/)
    assert.ok(!p.notes.some((n) => /do not guess/.test(n)), 'the rule is not shown as a note')
    assert.equal(describeRun(p), 'failed after 40 ms')
  })
  test('the offline-package note is kept as a note', () => {
    const text = formatRun({ ...base, ok: false, error: "ModuleNotFoundError: No module named 'seaborn'" }, '').error! + '\n\nThe sandbox is offline: only the standard library and these packages are available: numpy, pandas, matplotlib. Rewrite without the missing module.'
    const p = parseRanCode(text, false)
    assert.ok(p.notes.some((n) => /numpy, pandas, matplotlib/.test(n)))
  })
  test('no output at all', () => {
    const p = parseRanCode(formatRun(base, '').output!, true)
    assert.equal(p.stdout, '')
    assert.equal(p.result, '')
    assert.deepEqual(p.notes, [])
    assert.equal(describeRun(p), 'ran in 3 ms')
  })
})
