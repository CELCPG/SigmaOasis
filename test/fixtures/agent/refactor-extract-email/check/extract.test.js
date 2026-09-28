const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const src = (f) => readFileSync(join(__dirname, '..', 'src', f), 'utf8')

test('validate.js exports isValidEmail with the old rule', () => {
  const { isValidEmail } = require('../src/validate')
  assert.equal(typeof isValidEmail, 'function')
  for (const good of ['ada@example.com', 'a.b+c@sub.example.org', 'x@y.io']) assert.equal(isValidEmail(good), true, good)
  for (const bad of ['ada@example', 'ada example@x.io', '@x.io', 'ada@', 'a@@b.io', '']) assert.equal(isValidEmail(bad), false, bad)
})

test('signup and invite use it rather than their own copies', () => {
  for (const f of ['signup.js', 'invite.js']) {
    const text = src(f)
    assert.match(text, /require\(['"]\.\/validate(?:\.js)?['"]\)/, `${f} does not require ./validate`)
    assert.match(text, /isValidEmail/, `${f} does not call isValidEmail`)
    assert.doesNotMatch(text, /\[\^\\s@\]\+@/, `${f} still has its own copy of the pattern`)
  }
})

test('sign-up behaves as before', () => {
  const { signupErrors } = require('../src/signup')
  assert.deepEqual(signupErrors({ email: 'ada@example.com', password: 'correct horse', acceptedTerms: true }), [])
  assert.deepEqual(signupErrors({ email: '  ada@example.com  ', password: 'correct horse', acceptedTerms: true }), [])
  assert.deepEqual(signupErrors({ email: 'ada@example', password: 'short', acceptedTerms: false }), [
    'Enter a valid email address.',
    'Use a password of at least 10 characters.',
    'Accept the terms to continue.'
  ])
})

test('invites behave as before', () => {
  const { sortInvites } = require('../src/invite')
  assert.deepEqual(sortInvites('a@x.io, B@X.IO; not-an-email a@x.io'), { invite: ['a@x.io', 'b@x.io'], rejected: ['not-an-email'], overLimit: 0 })
  const many = Array.from({ length: 22 }, (_, i) => `p${i}@x.io`).join(' ')
  assert.equal(sortInvites(many).overLimit, 2)
})
