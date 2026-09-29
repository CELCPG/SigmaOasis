const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = join(__dirname, '..')

const expected = {
  'Ada Lovelace': ['Dear Ada Lovelace,', 'Your balance is 120.00, due on 2026-10-15.'],
  'Grace Hopper': ['Dear Grace Hopper,', 'Your balance is 0.00, due on 2026-10-15.'],
  'Linus Torvalds': ['Dear Linus Torvalds,', 'Your balance is 45.50, due on 2026-11-01.']
}

for (const [name, lines] of Object.entries(expected)) {
  test('a letter for ' + name, () => {
    const file = join(ROOT, 'letters', name + '.txt')
    assert.ok(existsSync(file), file + ' is missing')
    const text = readFileSync(file, 'utf8')
    for (const line of lines) assert.ok(text.includes(line), 'missing: ' + line)
    assert.ok(!/[{}]/.test(text), 'a placeholder was left in')
    assert.ok(text.includes('Thank you,'), 'the closing is missing')
  })
}

test('the sources are untouched', () => {
  assert.equal(readFileSync(join(ROOT, 'template.md'), 'utf8'), 'Dear {name},\n\nYour balance is {balance}, due on {due}.\n\nThank you,\nAccounts\n')
  assert.ok(readFileSync(join(ROOT, 'customers.csv'), 'utf8').startsWith('name,balance,due\n'))
})
