const { test } = require('node:test')
const assert = require('node:assert/strict')
const { slugify, uniqueSlug } = require('../src/slug')

test('capitals are kept as letters', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
  assert.equal(slugify('ABC 123'), 'abc-123')
})

test('no hyphen at either end, and never two together', () => {
  assert.equal(slugify('  Hello, World!  '), 'hello-world')
  assert.equal(slugify('---a---b---'), 'a-b')
  assert.equal(slugify('C++ & Rust'), 'c-rust')
})

test('nothing sluggable gives an empty slug', () => {
  assert.equal(slugify('!!!'), '')
  assert.equal(slugify(''), '')
})

test('unique slugs count up', () => {
  assert.equal(uniqueSlug('Hello World', new Set()), 'hello-world')
  assert.equal(uniqueSlug('Hello World', new Set(['hello-world', 'hello-world-2'])), 'hello-world-3')
})
