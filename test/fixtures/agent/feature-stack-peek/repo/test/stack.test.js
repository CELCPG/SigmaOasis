const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Stack } = require('../src/stack')

test('pop returns the last value pushed', () => {
  const s = new Stack().push(1).push(2)
  assert.equal(s.pop(), 2)
  assert.equal(s.pop(), 1)
})

test('an empty stack pops undefined', () => {
  assert.equal(new Stack().pop(), undefined)
})

test('isEmpty follows pushes and pops', () => {
  const s = new Stack()
  assert.equal(s.isEmpty(), true)
  s.push('a')
  assert.equal(s.isEmpty(), false)
  s.pop()
  assert.equal(s.isEmpty(), true)
})
