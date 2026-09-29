const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isWeekend, nextWorkingDay, workingDaysBetween } = require('../src/calendar')

// 2026-09-21 was a Monday.
const day = (d) => new Date(Date.UTC(2026, 8, d))

test('every day of one week', () => {
  const expected = [false, false, false, false, false, true, true]
  for (let i = 0; i < 7; i++) assert.equal(isWeekend(day(21 + i)), expected[i], `2026-09-${21 + i}`)
})

test('the next working day', () => {
  assert.deepEqual(nextWorkingDay(day(23)), day(24))
  assert.deepEqual(nextWorkingDay(day(25)), day(28))
  assert.deepEqual(nextWorkingDay(day(26)), day(28))
  assert.deepEqual(nextWorkingDay(day(27)), day(28))
})

test('working days between two dates', () => {
  assert.equal(workingDaysBetween(day(21), day(28)), 5)
  assert.equal(workingDaysBetween(day(25), day(28)), 1)
})

test('the input date is left alone', () => {
  const d = day(25)
  nextWorkingDay(d)
  assert.deepEqual(d, day(25))
})
