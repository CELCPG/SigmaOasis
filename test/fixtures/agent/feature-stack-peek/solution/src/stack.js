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

  /** The top value, left where it is; `undefined` when empty. */
  peek() {
    return this.items[this.items.length - 1]
  }

  /** How many values the stack holds. */
  get size() {
    return this.items.length
  }

  isEmpty() {
    return this.items.length === 0
  }
}

module.exports = { Stack }
