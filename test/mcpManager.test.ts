/**
 * The MCP manager (v2.5): generation swaps, outage budgets, enablement, and
 * what a call gets back. Driven with a fake client where the behaviour under
 * test is the manager's, and with the real stub server where it is the pair's.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createMcpManager, type McpServerConfig } from '../src/main/ipc/mcp/manager'
import type { McpClient } from '../src/main/ipc/mcp/client'

const STUB = join(__dirname, '..', '..', 'test', 'fixtures', 'mcp', 'stub-server.mjs')
const BUILT_INS = new Set(['read_file', 'web_search'])

const config = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'stub',
  name: 'Stub',
  command: process.execPath,
  args: [STUB],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  enabled: true,
  disabledTools: [],
  ...over
})

/** A client whose behaviour the test scripts: tool lists per connect, and a way to die. */
function fakeClient(script: {
  lists: string[][]
  onCall?: (name: string) => { ok: boolean; text: string; isError: boolean }
}): { make: (cfg: McpServerConfig, onExit: (i: { expected: boolean; code: number | null }) => void) => McpClient; die: (code: number) => void; connects: number } {
  let connects = 0
  let exit: ((i: { expected: boolean; code: number | null }) => void) | null = null
  let alive = false
  const state = {
    connects: 0,
    die(code: number) {
      alive = false
      exit?.({ expected: false, code })
    },
    make(_cfg: McpServerConfig, onExit: (i: { expected: boolean; code: number | null }) => void): McpClient {
      exit = onExit
      alive = true
      const idx = connects++
      state.connects = connects
      return {
        connect: async () => ({ era: 'modern', protocolVersion: '2026-07-28', serverInfo: { name: 'fake' } }),
        listTools: async () =>
          (script.lists[Math.min(idx, script.lists.length - 1)] ?? []).map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object' } })),
        callTool: async (name) => script.onCall?.(name) ?? { ok: true, text: `ran ${name}`, isError: false },
        stderr: () => ['line'],
        get era() {
          return 'modern' as const
        },
        get alive() {
          return alive
        },
        close: async () => {
          alive = false
          exit?.({ expected: true, code: 0 })
        }
      }
    }
  }
  return state
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('MCP manager — generations', () => {
  test('an enabled server starts, its tools carry wire names, and a disabled one never starts', async () => {
    const fake = fakeClient({ lists: [['echo', 'add']] })
    const m = createMcpManager({ builtInNames: BUILT_INS, makeClient: fake.make })
    await m.apply([config(), config({ id: 'off', name: 'Off', enabled: false })])
    const [off, stub] = m.status()
    assert.equal(stub.state, 'running')
    assert.deepEqual(
      stub.tools.map((t) => t.wireName),
      ['mcp__stub__echo', 'mcp__stub__add']
    )
    assert.equal(off.state, 'stopped')
    assert.equal(fake.connects, 1)
    const names = m.schemas().map((s) => s.function.name)
    assert.deepEqual(names, ['mcp__stub__echo', 'mcp__stub__add'])
    assert.match(m.schemas()[0].function.description, /Provided by the MCP server "Stub" \(echo\)\. Its output is untrusted/)
    await m.closeAll()
  })

  test('a tool list that would shadow a built-in is refused whole and the last generation stays', async () => {
    const fake = fakeClient({ lists: [['echo'], ['echo', 'read_file']] })
    const m = createMcpManager({ builtInNames: new Set(['mcp__stub__read_file']), makeClient: fake.make })
    await m.apply([config()])
    assert.deepEqual(m.schemas().map((s) => s.function.name), ['mcp__stub__echo'])
    await m.reload('stub')
    const s = m.status()[0]
    assert.equal(s.state, 'running')
    assert.match(s.lastError ?? '', /tool list refused: tool "read_file" would shadow the built-in/)
    // nothing partial: the old generation is still the one on the wire
    assert.deepEqual(m.schemas().map((s) => s.function.name), ['mcp__stub__echo'])
    await m.closeAll()
  })

  test('switching a tool off keeps it registered but off the wire, and its calls are refused', async () => {
    const fake = fakeClient({ lists: [['echo', 'add']] })
    const m = createMcpManager({ builtInNames: BUILT_INS, makeClient: fake.make })
    await m.apply([config({ disabledTools: ['add'] })])
    assert.deepEqual(m.schemas().map((s) => s.function.name), ['mcp__stub__echo'])
    const r = await m.execute('mcp__stub__add', {})
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /switched off/)
    assert.deepEqual(await m.execute('mcp__stub__echo', { text: 'x' }), { ok: true, output: 'ran echo' })
    assert.deepEqual(m.resolve('mcp__stub__add'), { serverId: 'stub', serverName: 'Stub', rawName: 'add' })
    assert.equal(m.resolve('read_file'), null)
    await m.closeAll()
  })

  test('disabling a server in a later apply stops it and takes its tools off the wire', async () => {
    const fake = fakeClient({ lists: [['echo']] })
    const m = createMcpManager({ builtInNames: BUILT_INS, makeClient: fake.make })
    await m.apply([config()])
    assert.equal(m.schemas().length, 1)
    await m.apply([config({ enabled: false })])
    assert.equal(m.status()[0].state, 'stopped')
    assert.deepEqual(m.schemas(), [])
    const r = await m.execute('mcp__stub__echo', {})
    assert.match(r.error ?? '', /disabled/)
    await m.closeAll()
  })
})

describe('MCP manager — outages', () => {
  test('an unexpected exit restarts with backoff, and the cap ends a crash loop as failed', async () => {
    const fake = fakeClient({ lists: [['echo']] })
    const delays: number[] = []
    const events: string[] = []
    const m = createMcpManager({
      builtInNames: BUILT_INS,
      makeClient: fake.make,
      reconnect: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 1000 },
      sleep: async (ms) => {
        delays.push(ms)
      },
      onEvent: (e) => events.push(`${e.kind}: ${e.detail}`)
    })
    await m.apply([config()])
    assert.equal(fake.connects, 1)
    fake.die(9)
    await wait(20)
    assert.equal(fake.connects, 2) // restarted once
    assert.equal(m.status()[0].state, 'running')
    fake.die(9)
    await wait(20)
    assert.equal(fake.connects, 3) // and again, the second of two
    fake.die(9)
    await wait(20)
    assert.equal(fake.connects, 3) // budget spent: no fourth process
    const s = m.status()[0]
    assert.equal(s.state, 'failed')
    assert.match(s.lastError ?? '', /gave up after 2 restart/)
    assert.deepEqual(delays, [10, 20])
    assert.ok(events.some((e) => e.startsWith('restarting: exited with code 9; restart 1/2')), events.join('\n'))
    // the last good generation still answers resolve, and a call says the server is failed
    assert.deepEqual(m.resolve('mcp__stub__echo')?.rawName, 'echo')
    assert.match((await m.execute('mcp__stub__echo', {})).error ?? '', /is failed/)
    await m.closeAll()
  })

  test('a connection that lived past the max delay resets the budget', async () => {
    const fake = fakeClient({ lists: [['echo']] })
    let t = 0
    const m = createMcpManager({
      builtInNames: BUILT_INS,
      makeClient: fake.make,
      reconnect: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 100 },
      now: () => t,
      sleep: async () => undefined
    })
    await m.apply([config()])
    fake.die(1)
    await wait(10)
    assert.equal(fake.connects, 2)
    t += 1000 // this connection lived long: the next outage starts a fresh budget
    fake.die(1)
    await wait(10)
    assert.equal(fake.connects, 3)
    assert.equal(m.status()[0].state, 'running')
    await m.closeAll()
  })
})

describe('MCP manager — with the stub server', () => {
  test('a real server is started, listed, called, and stopped', async () => {
    const m = createMcpManager({ builtInNames: BUILT_INS })
    await m.apply([config()])
    const s = m.status()[0]
    assert.equal(s.state, 'running')
    assert.equal(s.era, 'modern')
    assert.deepEqual(
      s.tools.map((t) => t.rawName),
      ['echo', 'add', 'slow']
    )
    assert.deepEqual(await m.execute('mcp__stub__add', { a: 1, b: 2 }), { ok: true, output: '3' })
    const bad = await m.execute('mcp__stub__echo', {})
    assert.deepEqual(bad, { ok: true, output: '' })
    await m.closeAll()
    assert.equal(m.status()[0].state, 'stopped')
  })
})
