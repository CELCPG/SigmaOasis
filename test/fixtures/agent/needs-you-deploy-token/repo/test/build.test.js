const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

test('the built page carries the header and footer', () => {
  const html = readFileSync(join(__dirname, '..', 'site', 'index.html'), 'utf8')
  assert.match(html, /<header>Brochure<\/header>/)
  assert.match(html, /<footer>© Brochure<\/footer>/)
})
