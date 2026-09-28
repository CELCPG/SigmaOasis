const { test } = require('node:test')
const assert = require('node:assert/strict')
const { card } = require('../src/contacts')

test('a messy entry becomes a tidy card', () => {
  assert.deepEqual(card({ name: '  ada   LOVELACE ', email: 'Ada@Example.com' }), {
    name: 'Ada Lovelace',
    badge: 'AL',
    email: 'ada@example.com'
  })
})
