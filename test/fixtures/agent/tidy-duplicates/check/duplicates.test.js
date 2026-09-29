const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const ROOT = join(__dirname, '..')

test('one file per content remains, the first by name', () => {
  const names = readdirSync(join(ROOT, 'Photos')).sort()
  assert.deepEqual(names, ['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg'])
  assert.equal(readFileSync(join(ROOT, 'Photos', 'IMG_0001.jpg'), 'utf8'), 'alpha photo bytes 0001')
  assert.equal(readFileSync(join(ROOT, 'Photos', 'IMG_0002.jpg'), 'utf8'), 'beta photo bytes 0002')
  assert.equal(readFileSync(join(ROOT, 'Photos', 'IMG_0003.jpg'), 'utf8'), 'gamma photo bytes 0003')
})
