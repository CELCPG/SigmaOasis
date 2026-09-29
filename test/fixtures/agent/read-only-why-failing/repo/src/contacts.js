'use strict'

const { formatName, initials } = require('./names')

/** A contact card as the address book shows it. */
function card(contact) {
  const name = formatName(contact.name)
  return { name, badge: initials(contact.name), email: String(contact.email).toLowerCase() }
}

module.exports = { card }
