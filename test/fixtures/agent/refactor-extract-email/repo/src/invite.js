'use strict'

const MAX_INVITES = 20

/** Split a pasted list of addresses into the ones to invite and the ones rejected. */
function sortInvites(pasted) {
  const addresses = String(pasted)
    .split(/[\s,;]+/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
  const unique = [...new Set(addresses)]
  const valid = unique.filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))
  const rejected = unique.filter((a) => !valid.includes(a))
  return { invite: valid.slice(0, MAX_INVITES), rejected, overLimit: Math.max(0, valid.length - MAX_INVITES) }
}

module.exports = { sortInvites, MAX_INVITES }
