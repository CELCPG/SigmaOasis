const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = join(__dirname, '..')

const bytes = {
  'Documents/report.pdf': Buffer.from('%PDF-1.4 fake report\n'),
  'Documents/notes.txt': Buffer.from('some notes\n'),
  'Images/holiday.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
  'Images/screenshot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7])
}

test('every file is in its folder, byte for byte', () => {
  for (const [p, b] of Object.entries(bytes)) {
    const file = join(ROOT, 'Downloads', p)
    assert.ok(existsSync(file), p + ' is missing')
    assert.ok(readFileSync(file).equals(b), p + ' changed')
  }
  assert.ok(existsSync(join(ROOT, 'Downloads', 'Documents', 'budget.xlsx')), 'budget.xlsx is missing')
})

test('nothing is left loose in Downloads, and nothing was copied', () => {
  const loose = readdirSync(join(ROOT, 'Downloads')).filter((n) => n !== 'Documents' && n !== 'Images')
  assert.deepEqual(loose, [])
  assert.deepEqual(readdirSync(join(ROOT, 'Downloads', 'Documents')).sort(), ['budget.xlsx', 'notes.txt', 'report.pdf'])
  assert.deepEqual(readdirSync(join(ROOT, 'Downloads', 'Images')).sort(), ['holiday.jpg', 'screenshot.png'])
})
