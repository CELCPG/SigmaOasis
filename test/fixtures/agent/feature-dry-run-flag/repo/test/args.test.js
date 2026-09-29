const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseArgs } = require('../src/args')

test('defaults', () => {
  assert.deepEqual(parseArgs(['a.js']), { out: 'dist', verbose: false, files: ['a.js'] })
})

test('verbose and out, long and short', () => {
  assert.deepEqual(parseArgs(['-v', '--out', 'build', 'a.js', 'b.js']), { out: 'build', verbose: true, files: ['a.js', 'b.js'] })
  assert.equal(parseArgs(['-o', 'x', 'a.js']).out, 'x')
})

test('mistakes are refused', () => {
  assert.throws(() => parseArgs(['--out']), /needs a folder/)
  assert.throws(() => parseArgs(['--fast']), /Unknown option: --fast/)
})
