import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { docxScript, formatProfile, parseProfile, profileScript } from '../src/main/ipc/workbenchProfile'
import { formatRun } from '../src/main/ipc/workbenchFormat'

/**
 * The pure halves of the Workbench tools: the profile script is well-formed
 * for a file, its JSON comes back out of stdout, and the report reads as
 * facts with the anti-eyeballing rule. The Python itself is exercised in
 * test/workbenchCheck.ts against real CSV/XLSX/JSON files.
 */
describe('profileScript', () => {
  test('substitutes file, sheet and bounds', () => {
    const s = profileScript('sales.csv', null)
    assert.match(s, /FILE = "sales\.csv"/)
    assert.match(s, /SHEET = None/)
    assert.match(s, /MAX_ROWS = 200000/)
    assert.match(profileScript('b.xlsx', 'Q3'), /SHEET = "Q3"/)
    assert.doesNotMatch(s, /__FILE__|__SHEET__|__MAX_ROWS__|__HEAD__|__TOPN__|__MAX_COLS__/)
  })
})

describe('parseProfile', () => {
  test('finds the marker among other stdout', () => {
    const p = parseProfile('warmup\n__PROFILE__{"file":"a.csv","rows":2,"columns":1,"truncated":false}\n')
    assert.equal(p?.file, 'a.csv')
    assert.equal(parseProfile('nothing here'), null)
  })
})

describe('formatProfile', () => {
  test('numbers, dates, text and head, plus the rule', () => {
    const out = formatProfile({
      file: 'sales.csv',
      kind: 'csv',
      delimiter: ',',
      rows: 1200,
      columns: 3,
      truncated: false,
      duplicateRows: 2,
      profile: [
        { name: 'amount', type: 'number', nonNull: 1198, nulls: 2, min: 3.5, max: 1249.99, mean: 87.123456, median: 60, sum: 104375.4 },
        { name: 'date', type: 'date', nonNull: 1200, nulls: 0, min: '2025-01-01', max: '2025-12-31' },
        { name: 'region', type: 'text', nonNull: 1200, nulls: 0, distinct: 4, top: [['West', 400], ['East', 380]], avgLen: 4.5 }
      ],
      head: [['amount', 'date', 'region'], ['12.5', '2025-01-01', 'West']]
    })
    assert.match(out, /^Profile of \/work\/sales\.csv — delimited text \(","-separated\): 1,200 data row\(s\) × 3 column\(s\)\./m)
    assert.match(out, /2 exact duplicate row\(s\)/)
    assert.match(out, /- amount: number · 1,198 non-null · 2 null\/blank · min 3\.5 · max 1,249\.99 · mean 87\.1235 · median 60 · sum 104,375\.4/)
    assert.match(out, /- date: date · 1,200 non-null · from 2025-01-01 to 2025-12-31/)
    assert.match(out, /- region: text · 1,200 non-null · 4 distinct · top: "West" ×400, "East" ×380/)
    assert.match(out, /\| amount \| date \| region \|/)
    assert.match(out, /do not eyeball totals or percentages/)
  })
  test('xlsx names its sheet and siblings; truncation is stated', () => {
    const out = formatProfile({ file: 'b.xlsx', kind: 'xlsx', sheet: 'Q3', sheets: ['Q3', 'Q4'], rows: 200000, columns: 2, truncated: true, profile: [], head: [] })
    assert.match(out, /spreadsheet \(sheet "Q3"; sheets: Q3, Q4\)/)
    assert.match(out, /read stopped at 200,000 rows/)
  })
  test('errors are stated, not formatted as a profile', () => {
    assert.match(formatProfile({ file: 'x.csv', rows: 0, columns: 0, truncated: false, error: 'UnicodeDecodeError: bad' }), /Could not profile x\.csv: UnicodeDecodeError/)
  })
})

describe('formatRun', () => {
  const base = { ok: true, stdout: '', stderr: '', result: null, files: [], durationMs: 3 }
  test('stdout and result and the computed-not-recalled rule', () => {
    const f = formatRun({ ...base, stdout: '6.4\n', result: '391' }, '')
    assert.ok(f.ok)
    assert.match(f.output ?? '', /stdout:\n6\.4/)
    assert.match(f.output ?? '', /result \(last expression\): 391/)
    assert.match(f.output ?? '', /computed, not recalled/)
  })
  test('images go to the gallery, small text files inline', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const f = formatRun({ ...base, files: [{ name: 'chart.png', data: png }, { name: 'out.csv', data: Buffer.from('a,b\n1,2') }] }, '')
    assert.equal(f.images?.length, 1)
    assert.match(f.images![0].dataUrl, /^data:image\/png;base64,/)
    assert.match(f.output ?? '', /out\.csv \(7 bytes\):\n```\na,b\n1,2\n```/)
  })
  test('a failure carries the traceback and the no-guessing rule', () => {
    const f = formatRun({ ...base, ok: false, error: 'Traceback…\nZeroDivisionError: division by zero' }, '')
    assert.equal(f.ok, false)
    assert.match(f.error ?? '', /ZeroDivisionError/)
    assert.match(f.error ?? '', /do not guess/)
  })
  test('nothing printed → a hint', () => {
    assert.match(formatRun(base, '').output ?? '', /print\(\) what you want to see/)
  })
})

describe('docxScript (v1.7.1)', () => {
  test('reads /work/input.docx, maps heading styles, and caps output', () => {
    const script = docxScript(5000)
    assert.match(script, /\/work\/input\.docx/)
    assert.match(script, /word\/document\.xml/)
    assert.match(script, /\[Hh\]eading\(\[1-6\]\)/)
    assert.match(script, /\[:5000\]/)
    assert.ok(!script.includes('__MAX_CHARS__'))
  })
  test('the cap is floored and never zero', () => {
    assert.match(docxScript(0.4), /\[:1\]/)
  })
})
