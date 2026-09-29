'use strict'

// Dates are formatted by the shared helper that lives beside this project
// (../shared/format.js), so every report in the company prints them alike.
let formatDate
try {
  ;({ formatDate } = require('../../shared/format'))
} catch {
  // Outside the monorepo checkout the shared folder is not there; fall back to ISO.
  formatDate = (d) => d.toISOString().slice(0, 10)
}

/** The header line of a monthly report. */
function reportHeader(title, date) {
  return `${title} — ${formatDate(date)}`
}

module.exports = { reportHeader }
