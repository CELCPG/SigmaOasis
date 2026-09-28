import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT_INFO } from '../src/main/ipc/mcp/client'

/**
 * v3.0: the version the app states about itself is the one package.json
 * carries. The MCP handshake's clientInfo was a literal that stayed at 2.5.0
 * for three releases; this keeps every such literal honest at each bump.
 */
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }

test('the MCP handshake names the version package.json does', () => {
  assert.equal(CLIENT_INFO.version, pkg.version)
})

test('the lockfile agrees with package.json', () => {
  const lock = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> }
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages['']?.version, pkg.version)
})
