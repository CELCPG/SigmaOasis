const { test } = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { readConfig } = require('../src/config')
const { loadPort } = require('../src/server')

const cfg = (f) => join(__dirname, '..', 'config', f)

test('reads a config', (t, done) => {
  readConfig(cfg('app.json'), (err, config) => {
    assert.equal(err, null)
    assert.deepEqual(config, { port: 8080, name: 'tiny' })
    done()
  })
})

test('the port comes from the config', (t, done) => {
  loadPort(cfg('app.json'), (err, port) => {
    assert.equal(err, null)
    assert.equal(port, 8080)
    done()
  })
})

test('a missing file is an error', (t, done) => {
  readConfig(cfg('missing.json'), (err) => {
    assert.match(err.message, /Cannot read config .*missing\.json: ENOENT/)
    done()
  })
})
