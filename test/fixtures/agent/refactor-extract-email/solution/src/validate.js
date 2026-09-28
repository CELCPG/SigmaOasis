'use strict'

/** Something, an @, something, a dot, something — and no spaces anywhere. */
function isValidEmail(address) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(address))
}

module.exports = { isValidEmail }
