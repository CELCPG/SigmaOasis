const { test } = require('node:test')
const assert = require('node:assert/strict')
const { paginate, pageCount } = require('../src/paginate')

const items = [1, 2, 3, 4, 5, 6, 7]

test('every full page holds size items', () => {
  assert.deepEqual(paginate(items, 0, 3), [1, 2, 3])
  assert.deepEqual(paginate(items, 1, 3), [4, 5, 6])
})

test('the last page holds what is left', () => {
  assert.deepEqual(paginate(items, 2, 3), [7])
})

test('a page past the end is empty', () => {
  assert.deepEqual(paginate(items, 3, 3), [])
})

test('a page of one', () => {
  assert.deepEqual(paginate(items, 4, 1), [5])
})

test('bad arguments still throw', () => {
  assert.throws(() => paginate(items, -1, 3), RangeError)
  assert.throws(() => paginate(items, 0, 0), RangeError)
  assert.throws(() => paginate('abc', 0, 1), TypeError)
})

test('the page count is unchanged', () => {
  assert.equal(pageCount(7, 3), 3)
  assert.equal(pageCount(6, 3), 2)
  assert.equal(pageCount(0, 3), 0)
})
