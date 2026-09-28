const { test } = require('node:test')
const assert = require('node:assert/strict')
const { topWords, wordCount, averageWordLength } = require('../src/textstats')

test('most frequent first, as [word, count] pairs', () => {
  assert.deepEqual(topWords('the cat and the hat and the bat', 2), [
    ['the', 3],
    ['and', 2]
  ])
})

test('ties go alphabetically', () => {
  assert.deepEqual(topWords('b a c b a c', 3), [
    ['a', 2],
    ['b', 2],
    ['c', 2]
  ])
})

test('case and punctuation do not split a word', () => {
  assert.deepEqual(topWords('Dog! dog, DOG? cat.', 2), [
    ['dog', 3],
    ['cat', 1]
  ])
})

test("apostrophes and digits belong to words", () => {
  assert.deepEqual(topWords("it's it's its 42 42 42", 3), [
    ['42', 3],
    ["it's", 2],
    ['its', 1]
  ])
})

test('fewer distinct words than n returns them all; none returns none', () => {
  assert.deepEqual(topWords('one two', 5), [
    ['one', 1],
    ['two', 1]
  ])
  assert.deepEqual(topWords('', 3), [])
  assert.deepEqual(topWords('...', 3), [])
})

test('the existing functions are unchanged', () => {
  assert.equal(wordCount('one  two\nthree'), 3)
  assert.equal(averageWordLength('Hi, there!'), 3.5)
})
