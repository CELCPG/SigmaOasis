'use strict'

/**
 * One page of a list. Pages are numbered from 0.
 *
 *   paginate(['a', 'b', 'c', 'd', 'e'], 1, 2)  →  ['c', 'd']
 */
function paginate(items, page, size) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array')
  if (!Number.isInteger(page) || page < 0) throw new RangeError('page must be a whole number from 0')
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a whole number from 1')
  const start = page * size
  return items.slice(start, start + size)
}

/** How many pages `count` items fill at `size` per page. */
function pageCount(count, size) {
  return Math.ceil(count / size)
}

module.exports = { paginate, pageCount }
