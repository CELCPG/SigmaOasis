const assert = require('assert')
const { mean, median } = require('./src/stats')

assert.strictEqual(mean([2, 4, 6]), 4)
assert.strictEqual(mean([5]), 5)
assert.strictEqual(median([10, 2, 33]), 10)
assert.strictEqual(median([4, 1, 3, 2]), 2.5)

console.log('all tests passed')
