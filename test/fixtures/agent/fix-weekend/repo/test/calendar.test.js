const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isWeekend, nextWorkingDay } = require('../src/calendar')

// 2026-09-26 was a Saturday.
const day = (d) => new Date(Date.UTC(2026, 8, d))

test('Saturday and Sunday are the weekend', () => {
  assert.equal(isWeekend(day(26)), true)
  assert.equal(isWeekend(day(27)), true)
})

test('after Friday comes Monday', () => {
  assert.deepEqual(nextWorkingDay(day(25)), day(28))
})
