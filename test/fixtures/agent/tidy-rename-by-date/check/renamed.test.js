const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = join(__dirname, '..')

test('dated notes carry their date; the undated one is untouched; contents unchanged', () => {
  assert.deepEqual(readdirSync(join(ROOT, 'Notes')).sort(), ['2026-01-15-ideas.md', '2026-03-04-meeting.md', '2026-03-04-retro.md', 'todo.md'])
  assert.equal(readFileSync(join(ROOT, 'Notes', '2026-03-04-meeting.md'), 'utf8'), 'Date: 2026-03-04\n\n# Planning meeting\n\n- budget\n- hiring\n')
  assert.equal(readFileSync(join(ROOT, 'Notes', '2026-01-15-ideas.md'), 'utf8'), 'Date: 2026-01-15\n\nA list of ideas.\n')
  assert.equal(readFileSync(join(ROOT, 'Notes', '2026-03-04-retro.md'), 'utf8'), 'Date: 2026-03-04\n\nWhat went well.\n')
  assert.equal(readFileSync(join(ROOT, 'Notes', 'todo.md'), 'utf8'), '# Todo\n\n- call the bank\n')
})
