const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mean, median } = require('../src/stats')

test('mean counts every element', () => {
  assert.equal(mean([2, 4, 6]), 4)
  assert.equal(mean([5]), 5)
  assert.equal(mean([-1, 1]), 0)
  assert.equal(mean([10, 20, 30, 40]), 25)
})

test('median sorts numerically', () => {
  assert.equal(median([10, 2, 33]), 10)
  assert.equal(median([100, 20, 3]), 20)
  assert.equal(median([1.5, 10, 2]), 2)
})

test('median of an even count is the mean of the middle two', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([10, 9, 100, 1]), 9.5)
})

test('median leaves its input alone', () => {
  const xs = [3, 1, 2]
  median(xs)
  assert.deepEqual(xs, [3, 1, 2])
})
