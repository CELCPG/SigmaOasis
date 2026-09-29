const { test } = require('node:test')
const assert = require('node:assert/strict')
const { reportHeader } = require('../src/report')

test('the header names the title and the date', () => {
  const header = reportHeader('Sales', new Date(Date.UTC(2026, 2, 31)))
  assert.match(header, /^Sales — /)
  assert.match(header, /2026/)
})
