const { test } = require('node:test')
const assert = require('node:assert/strict')
const { paginate, pageCount } = require('../src/paginate')

test('the first page holds `size` items', () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5, 6, 7], 0, 3), [1, 2, 3])
})

test('the page count rounds up', () => {
  assert.equal(pageCount(7, 3), 3)
})
