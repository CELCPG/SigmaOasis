import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, resetState, state } from './harness'

/**
 * v2.9: MCP environment values in the keychain (src/main/ipc/mcpEnv.ts).
 *
 * Through v2.8 they were a field of each server's settings row, in config.json
 * in clear, while the privacy audit said they were not. These pin the parts
 * that make the claim true: the settings row can carry names only, values are
 * sealed per server by the keychain, what the keychain could not take is marked
 * and re-sealed once it can, and the migration lifts every legacy value out of
 * the rows before anything could drop it.
 *
 * The harness's safeStorage is a deterministic stand-in (`enc:` + base64), so
 * "not plaintext" is checkable here without an OS keychain.
 */
const env = load<typeof import('../src/main/ipc/mcpEnv')>('mcpEnv')

const SECRET = 'ghp_7f3a91c0ffee'

beforeEach(() => resetState())

describe('what a settings row can hold', () => {
  test('names only: a legacy row’s env contributes its keys and never its values', () => {
    const names = env.envNamesOf({ envNames: ['A_TOKEN'], env: { B_URL: SECRET, 'bad-name': 'x', A_TOKEN: 'dup' } })
    assert.deepEqual(names, ['A_TOKEN', 'B_URL'])
    assert.ok(!JSON.stringify(names).includes(SECRET))
  })

  test('names are POSIX names, deduplicated, and anything else is dropped', () => {
    assert.deepEqual(env.envNamesOf({ envNames: ['OK', 'OK', '1BAD', 'has space', 7, null] }), ['OK'])
    assert.deepEqual(env.envNamesOf(null), [])
    assert.deepEqual(env.envNamesOf({ env: ['not', 'an', 'object'] }), [])
  })

  test('values keep only well-formed names with string values, first occurrence winning', () => {
    assert.deepEqual(env.normalizeMcpEnv({ TOKEN: SECRET, N: 3, 'x-y': 'z', EMPTY: '' }), { TOKEN: SECRET, EMPTY: '' })
    assert.deepEqual(env.normalizeMcpEnv('TOKEN=x'), {})
  })
})

describe('sealing', () => {
  test('with a keychain, what is stored is not the plaintext, and opens back to it', () => {
    const sealed = env.sealMcpEnv({ TOKEN: SECRET })
    assert.equal(sealed.unencrypted, undefined)
    assert.ok(!sealed.values.includes(SECRET))
    assert.ok(!Buffer.from(sealed.values, 'base64').toString('utf-8').includes(SECRET), 'not merely base64 of the plaintext either')
    assert.deepEqual(env.openMcpEnv(sealed), { TOKEN: SECRET })
  })

  test('without one, it is stored and marked, as the Brave key is — and opens', () => {
    state.encryptionAvailable = false
    const sealed = env.sealMcpEnv({ TOKEN: SECRET })
    assert.equal(sealed.unencrypted, true)
    assert.deepEqual(env.openMcpEnv(sealed), { TOKEN: SECRET })
  })

  test('an entry this keychain did not seal opens to null, not to an empty environment', () => {
    assert.equal(env.openMcpEnv({ values: Buffer.from('sealed-elsewhere').toString('base64') }), null)
    assert.deepEqual(env.openMcpEnv(undefined), {}, 'no entry at all is simply no environment')
  })
})

describe('the table', () => {
  test('replacing a server’s values, and an empty set removing its entry', () => {
    let table = env.withMcpEnv({}, 'gh', { TOKEN: SECRET })
    table = env.withMcpEnv(table, 'db', { URL: 'postgres://x' })
    assert.deepEqual(Object.keys(table).sort(), ['db', 'gh'])
    table = env.withMcpEnv(table, 'gh', {})
    assert.deepEqual(Object.keys(table), ['db'])
  })

  test('pruning keeps the entries of servers that still exist, and only those', () => {
    const table = env.withMcpEnv(env.withMcpEnv({}, 'gh', { T: '1' }), 'gone', { T: '2' })
    assert.deepEqual(Object.keys(env.pruneMcpEnv(table, ['gh', 'never-had-values'])), ['gh'])
  })

  test('status counts stored, unencrypted and unreadable entries without opening any to the caller', () => {
    state.encryptionAvailable = false
    let table = env.withMcpEnv({}, 'plain', { T: SECRET })
    state.encryptionAvailable = true
    table = env.withMcpEnv(table, 'sealed', { T: SECRET })
    table = { ...table, foreign: { values: Buffer.from('elsewhere').toString('base64') } }
    const status = env.mcpEnvStatus(table)
    assert.deepEqual(status, { servers: 3, unencrypted: 1, unreadable: ['foreign'] })
    assert.ok(!JSON.stringify(status).includes(SECRET))
  })

  test('what had to be stored in clear is sealed at the first start that finds a keychain', () => {
    state.encryptionAvailable = false
    const clear = env.withMcpEnv({}, 'gh', { TOKEN: SECRET })
    assert.equal(env.resealMcpEnv(clear), clear, 'still no keychain: the same table, so the caller skips the write')
    state.encryptionAvailable = true
    const resealed = env.resealMcpEnv(clear)
    assert.equal(resealed.gh.unencrypted, undefined)
    assert.ok(!resealed.gh.values.includes(SECRET))
    assert.deepEqual(env.openMcpEnv(resealed.gh), { TOKEN: SECRET })
    assert.equal(env.resealMcpEnv(resealed), resealed, 'nothing left to do: the same table')
  })
})

describe('the migration’s lift', () => {
  test('every legacy value leaves its row, keyed by the id the row will be stored under', () => {
    const { servers, values } = env.liftMcpEnv([
      { id: 'git hub', name: 'GitHub', command: 'npx', args: [], env: { GITHUB_TOKEN: SECRET }, enabled: true },
      { id: 'plain', command: 'srv', args: [], envNames: ['ALREADY'] },
      { id: 'blank', command: 'srv', args: [], env: {} }
    ])
    assert.deepEqual(values, { git_hub: { GITHUB_TOKEN: SECRET } })
    assert.equal(env.mcpServerId('git hub'), 'git_hub')
    assert.ok(!JSON.stringify(servers).includes(SECRET), 'no value survives in the rows')
    const [gh, plain, blank] = servers as Record<string, unknown>[]
    assert.deepEqual(gh.envNames, ['GITHUB_TOKEN'])
    assert.ok(!('env' in gh))
    assert.deepEqual(plain.envNames, ['ALREADY'], 'a row already in the new shape passes through')
    assert.deepEqual(blank.envNames, [])
  })

  test('not a list: nothing to lift', () => {
    assert.deepEqual(env.liftMcpEnv(undefined), { servers: [], values: {} })
  })
})
