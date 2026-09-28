'use strict'

/** A last-in, first-out stack. */
class Stack {
  constructor() {
    this.items = []
  }

  /** Put a value on top. Returns the stack, so pushes chain. */
  push(value) {
    this.items.push(value)
    return this
  }

  /** Take the top value off and return it; `undefined` when empty. */
  pop() {
    return this.items.pop()
  }

  isEmpty() {
    return this.items.length === 0
  }
}

module.exports = { Stack }
