import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'fs'
import { join } from 'path'
import { load, resetState, testUserDataDir } from './harness'

/**
 * v2.6: standing grants. A grant is bound to the tool and the exact
 * arguments and working directory it was approved with; a call that differs
 * by one byte anywhere has no grant and asks. Nothing matches by pattern.
 */

const grants = load<typeof import('../src/main/ipc/grants')>('grants')
const { canonicalJson, grantKey, createGrant, useGrant, listGrants, revokeGrant, revokeAllGrants, MAX_GRANTS } = grants

beforeEach(async () => {
  resetState()
  await fs.rm(join(testUserDataDir(), 'grants.json'), { force: true })
  await fs.mkdir(testUserDataDir(), { recursive: true })
})

describe('grant keys', () => {
  test('canonical JSON sorts keys at every depth and nothing else', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}')
    assert.equal(canonicalJson('a"b'), '"a\\"b"')
    assert.equal(canonicalJson(undefined), 'null')
  })

  test('the same call in a different key order is the same key', () => {
    const a = grantKey({ tool: 'mcp__fs__read', args: { path: '/a', limit: 5 }, cwd: '/w' })
    const b = grantKey({ tool: 'mcp__fs__read', args: { limit: 5, path: '/a' }, cwd: '/w' })
    assert.equal(a, b)
  })

  test('one byte of difference anywhere is a different key', () => {
    const base = { tool: 'run_terminal_command', args: { command: 'npm test' }, cwd: '/w' }
    const k = grantKey(base)
    assert.notEqual(grantKey({ ...base, args: { command: 'npm test ' } }), k)
    assert.notEqual(grantKey({ ...base, args: { command: 'npm Test' } }), k)
    assert.notEqual(grantKey({ ...base, cwd: '/w2' }), k)
    assert.notEqual(grantKey({ ...base, cwd: undefined }), k)
    assert.notEqual(grantKey({ ...base, tool: 'write_file' }), k)
    assert.notEqual(grantKey({ ...base, args: { command: 'npm test', extra: 1 } }), k)
  })
})

describe('grant store', () => {
  const binding = { tool: 'run_terminal_command', args: { command: 'npm test' }, cwd: '/Users/me/proj' }

  test('no grant until one is minted; a use counts and stamps', async () => {
    assert.equal(await useGrant(binding), null)
    const g = await createGrant(binding, 'npm test')
    assert.equal(g.uses, 0)
    assert.equal(g.cwd, '/Users/me/proj')
    const used = await useGrant(binding)
    assert.equal(used?.id, g.id)
    assert.equal(used?.uses, 1)
    assert.equal(typeof used?.lastUsedAt, 'number')
    assert.equal((await listGrants())[0]!.uses, 1)
  })

  test('a grant does not cover a one-byte variant, and minting twice is one grant', async () => {
    await createGrant(binding, 'npm test')
    assert.equal(await useGrant({ ...binding, args: { command: 'npm test && rm -rf /' } }), null)
    assert.equal(await useGrant({ ...binding, cwd: '/Users/me/other' }), null)
    await createGrant(binding, 'npm test')
    assert.equal((await listGrants()).length, 1)
  })

  test('revoking takes effect on the next call; revoke-all empties the store', async () => {
    const g = await createGrant(binding, 'npm test')
    await createGrant({ tool: 'write_file', args: { path: '/tmp/out.txt' } }, '/tmp/out.txt')
    assert.deepEqual(await revokeGrant(g.id), { removed: 1 })
    assert.equal(await useGrant(binding), null)
    assert.equal((await listGrants()).length, 1)
    assert.deepEqual(await revokeAllGrants(), { removed: 1 })
    assert.equal((await listGrants()).length, 0)
  })

  test('the summary is one line, cut short; the store refuses past its bound', async () => {
    const g = await createGrant(binding, 'npm   test\n\nand a very long tail '.padEnd(400, 'x'))
    assert.ok(!g.summary.includes('\n'))
    assert.ok(g.summary.length <= 160)
    assert.match(g.summary, /^npm test and a very long tail/)
    for (let i = 1; i < MAX_GRANTS; i++) {
      await createGrant({ tool: 'write_file', args: { path: `/tmp/${i}` } }, `/tmp/${i}`)
    }
    await assert.rejects(
      () => createGrant({ tool: 'write_file', args: { path: '/tmp/one-too-many' } }, 'x'),
      /Too many standing grants/
    )
  })

  test('a hand-edited file with junk rows keeps only well-formed grants', async () => {
    await fs.writeFile(
      join(testUserDataDir(), 'grants.json'),
      JSON.stringify({ grants: [{ id: 'x' }, { id: 'ok', tool: 't', key: 'k', summary: 's', createdAt: 1, uses: 0 }] })
    )
    const list = await listGrants()
    assert.deepEqual(
      list.map((g) => g.id),
      ['ok']
    )
  })
})
