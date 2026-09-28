const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseDuration, formatDuration } = require('../src/duration')

test('hours and minutes', () => {
  assert.equal(parseDuration('1h30m'), 90)
})

test('minutes alone', () => {
  assert.equal(parseDuration('45m'), 45)
})

test('formatting', () => {
  assert.equal(formatDuration(95), '1h35m')
})
