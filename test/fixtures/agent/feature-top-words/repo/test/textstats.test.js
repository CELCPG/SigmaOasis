const { test } = require('node:test')
const assert = require('node:assert/strict')
const { wordCount, averageWordLength } = require('../src/textstats')

test('words are counted across any whitespace', () => {
  assert.equal(wordCount('one  two\nthree\tfour'), 4)
  assert.equal(wordCount('   '), 0)
})

test('average word length ignores punctuation', () => {
  assert.equal(averageWordLength('Hi, there!'), 3.5)
  assert.equal(averageWordLength(''), 0)
})
