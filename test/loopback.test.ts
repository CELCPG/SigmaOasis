import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackBaseUrl, isLoopbackHostname } from '../src/main/ipc/loopback'

/**
 * The LM Studio base URL is the one endpoint that receives conversations in
 * plaintext and is never proxied. store.ts refuses to persist anything that is
 * not loopback (v1.4.8) — these pin what "loopback" means, since the same
 * predicate also feeds the egress allowlist and the SSRF guard.
 */
describe('isLoopbackHostname', () => {
  test('accepts the four loopback spellings', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]']) assert.equal(isLoopbackHostname(h), true, h)
  })
  test('rejects LAN, public and lookalike hosts', () => {
    for (const h of ['192.168.1.10', '10.0.0.5', 'example.com', 'localhost.evil.com', '127.0.0.1.nip.io', '0.0.0.0'])
      assert.equal(isLoopbackHostname(h), false, h)
  })
})

describe('isLoopbackBaseUrl', () => {
  test('accepts the default and http/https loopback variants', () => {
    for (const u of [
      'http://127.0.0.1:1234/v1',
      'http://localhost:1234/v1',
      'https://localhost/v1',
      'http://[::1]:1234/v1'
    ])
      assert.equal(isLoopbackBaseUrl(u), true, u)
  })
  test('rejects remote hosts, other schemes and garbage', () => {
    for (const u of [
      'http://192.168.1.10:1234/v1',
      'http://my-desktop.local:1234/v1',
      'https://api.example.com/v1',
      'ftp://127.0.0.1/v1',
      'file:///etc/passwd',
      '127.0.0.1:1234',
      '',
      'not a url'
    ])
      assert.equal(isLoopbackBaseUrl(u), false, u)
  })
})
