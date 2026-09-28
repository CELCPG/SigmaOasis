'use strict'

const { isValidEmail } = require('./validate')

/** Validate a sign-up form; returns a list of problems, empty when it is fine. */
function signupErrors(form) {
  const errors = []
  const email = String(form.email ?? '').trim()
  if (!isValidEmail(email)) errors.push('Enter a valid email address.')
  if (String(form.password ?? '').length < 10) errors.push('Use a password of at least 10 characters.')
  if (!form.acceptedTerms) errors.push('Accept the terms to continue.')
  return errors
}

module.exports = { signupErrors }
