'use strict'

// Dates are handled in UTC throughout, so a result never depends on where the
// server happens to run.

/** Saturday or Sunday. */
function isWeekend(date) {
  const day = date.getUTCDay()
  return day === 0 || day === 6
}

/** The next day after `date` that is not a weekend day. */
function nextWorkingDay(date) {
  const d = new Date(date.getTime())
  do {
    d.setUTCDate(d.getUTCDate() + 1)
  } while (isWeekend(d))
  return d
}

/** Working days from `start` (exclusive) to `end` (inclusive). */
function workingDaysBetween(start, end) {
  let count = 0
  const d = new Date(start.getTime())
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1)
    if (!isWeekend(d)) count++
  }
  return count
}

module.exports = { isWeekend, nextWorkingDay, workingDaysBetween }
