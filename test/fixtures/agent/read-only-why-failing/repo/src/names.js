'use strict'

/** "  ada   LOVELACE " → "Ada Lovelace": spaces tidied, each word capitalised. */
function formatName(raw) {
  return String(raw)
    .trimStart()
    .split(/ +/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ')
}

/** "Ada Lovelace" → "AL" */
function initials(name) {
  return formatName(name)
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
}

module.exports = { formatName, initials }
