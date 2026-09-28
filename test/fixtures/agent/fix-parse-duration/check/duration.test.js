const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseDuration, formatDuration } = require('../src/duration')

test('every written form', () => {
  assert.equal(parseDuration('1h30m'), 90)
  assert.equal(parseDuration('45m'), 45)
  assert.equal(parseDuration('2h'), 120)
  assert.equal(parseDuration('1h5m'), 65)
  assert.equal(parseDuration('0m'), 0)
  assert.equal(parseDuration(' 90m '), 90)
})

test('anything else still throws', () => {
  for (const bad of ['', 'abc', '1x', 'h', '1.5h', '30m1h']) assert.throws(() => parseDuration(bad), /Not a duration/, bad)
})

test('parsing and formatting round-trip', () => {
  for (const m of [0, 5, 60, 95, 600]) assert.equal(parseDuration(formatDuration(m)), m)
})
