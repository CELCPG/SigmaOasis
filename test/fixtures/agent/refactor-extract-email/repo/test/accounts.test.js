const { test } = require('node:test')
const assert = require('node:assert/strict')
const { signupErrors } = require('../src/signup')
const { sortInvites } = require('../src/invite')

test('a good sign-up has no errors', () => {
  assert.deepEqual(signupErrors({ email: 'ada@example.com', password: 'correct horse', acceptedTerms: true }), [])
})

test('a bad email is caught at sign-up', () => {
  assert.deepEqual(signupErrors({ email: 'ada@example', password: 'correct horse', acceptedTerms: true }), ['Enter a valid email address.'])
})

test('invites are split into good and rejected', () => {
  assert.deepEqual(sortInvites('a@x.io, B@X.IO; not-an-email a@x.io'), { invite: ['a@x.io', 'b@x.io'], rejected: ['not-an-email'], overLimit: 0 })
})
