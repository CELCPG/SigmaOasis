const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseArgs } = require('../src/args')

test('dry run is off unless asked for', () => {
  assert.equal(parseArgs(['a.js']).dryRun, false)
  assert.equal(parseArgs(['--dry-run', 'a.js']).dryRun, true)
  assert.equal(parseArgs(['-n', 'a.js']).dryRun, true)
})

test('--out=folder works like --out folder', () => {
  assert.equal(parseArgs(['--out=build', 'a.js']).out, 'build')
  assert.equal(parseArgs(['--out', 'build', 'a.js']).out, 'build')
  assert.throws(() => parseArgs(['--out=', 'a.js']), /folder/)
})

test('everything together', () => {
  assert.deepEqual(parseArgs(['-v', '-n', '--out=www', 'a.js', 'b.js']), { out: 'www', verbose: true, dryRun: true, files: ['a.js', 'b.js'] })
})

test('what worked before still does', () => {
  assert.equal(parseArgs(['a.js']).out, 'dist')
  assert.equal(parseArgs(['-v', 'a.js']).verbose, true)
  assert.equal(parseArgs(['-o', 'x', 'a.js']).out, 'x')
  assert.deepEqual(parseArgs(['a.js', 'b.js']).files, ['a.js', 'b.js'])
  assert.throws(() => parseArgs(['--out']), /needs a folder/)
  assert.throws(() => parseArgs(['--fast']), /Unknown option: --fast/)
  assert.throws(() => parseArgs(['--dry-runs']), /Unknown option/)
})
