const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Stack } = require('../src/stack')

test('peek returns the top without removing it', () => {
  const s = new Stack().push('a').push('b')
  assert.equal(s.peek(), 'b')
  assert.equal(s.peek(), 'b')
  assert.equal(s.pop(), 'b')
  assert.equal(s.peek(), 'a')
})

test('peek on an empty stack is undefined', () => {
  assert.equal(new Stack().peek(), undefined)
})

test('size counts the items', () => {
  const s = new Stack()
  assert.equal(s.size, 0)
  s.push(1).push(2).push(3)
  assert.equal(s.size, 3)
  s.pop()
  assert.equal(s.size, 2)
  s.peek()
  assert.equal(s.size, 2)
})

test('size is a getter with no setter', () => {
  let proto = Stack.prototype
  let desc
  while (proto && !desc) {
    desc = Object.getOwnPropertyDescriptor(proto, 'size')
    proto = Object.getPrototypeOf(proto)
  }
  assert.ok(desc, 'size is defined on the class')
  assert.equal(typeof desc.get, 'function')
  assert.equal(desc.set, undefined)
})

test('the existing behaviour is unchanged', () => {
  const s = new Stack()
  assert.equal(s.push(1), s, 'push still chains')
  assert.equal(s.pop(), 1)
  assert.equal(s.pop(), undefined)
  assert.equal(s.isEmpty(), true)
})
