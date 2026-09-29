const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { readConfig } = require('../src/config')
const { loadPort, DEFAULT_PORT } = require('../src/server')

const cfg = (f) => join(__dirname, '..', 'config', f)
const scratch = mkdtempSync(join(tmpdir(), 'promise-check-'))
const file = (name, body) => {
  const p = join(scratch, name)
  writeFileSync(p, body)
  return p
}

test('readConfig returns a Promise of the parsed config', async () => {
  const p = readConfig(cfg('app.json'))
  assert.ok(p instanceof Promise, 'readConfig returns a Promise')
  assert.deepEqual(await p, { port: 8080, name: 'tiny' })
})

test('readConfig rejects with the same messages as before', async () => {
  await assert.rejects(readConfig(cfg('missing.json')), /Cannot read config .*missing\.json: ENOENT/)
  await assert.rejects(readConfig(file('bad.json', '{ nope')), /Config .*bad\.json is not valid JSON/)
})

test('loadPort returns a Promise of the port, with the default', async () => {
  const p = loadPort(cfg('app.json'))
  assert.ok(p instanceof Promise, 'loadPort returns a Promise')
  assert.equal(await p, 8080)
  assert.equal(await loadPort(cfg('no-port.json')), DEFAULT_PORT)
  assert.equal(DEFAULT_PORT, 3000)
})

test('loadPort rejects a bad port and passes read errors through', async () => {
  await assert.rejects(loadPort(file('zero.json', '{"port": 0}')), /Bad port in .*zero\.json: 0/)
  await assert.rejects(loadPort(file('text.json', '{"port": "80"}')), /Bad port/)
  await assert.rejects(loadPort(cfg('missing.json')), /ENOENT/)
})
