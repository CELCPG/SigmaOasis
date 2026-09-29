const { test } = require('node:test')
const assert = require('node:assert/strict')
const { slugify, uniqueSlug } = require('../src/slug')

test('slugs', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
  assert.equal(slugify('  Hello, World!  '), 'hello-world')
  assert.equal(uniqueSlug('Hello World', new Set(['hello-world'])), 'hello-world-2')
})
