/**
 * The MCP client (v2.5) against the stub server in both eras: the probe, the
 * handshakes, pagination, calls, timeouts, cancellation, and the things the
 * client refuses to do.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createMcpClient, McpTimeoutError, PROTOCOL_VERSION_MODERN } from '../src/main/ipc/mcp/client'

// Fixtures are not compiled, so the path goes through the repo root the way
// the other fixture-reading tests do (.test-build/test → ../../test/fixtures).
const STUB = join(__dirname, '..', '..', 'test', 'fixtures', 'mcp', 'stub-server.mjs')
const NODE = process.execPath
const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }

const client = (...stubArgs: string[]) =>
  createMcpClient({
    transport: { command: NODE, args: [STUB, ...stubArgs], env: NODE_ENV },
    probeTimeoutMs: 1500,
    requestTimeoutMs: 5000
  })

describe('MCP client — modern server', () => {
  test('the probe finds a modern server and no handshake follows', async () => {
    const c = client()
    const info = await c.connect()
    assert.equal(info.era, 'modern')
    assert.equal(info.protocolVersion, PROTOCOL_VERSION_MODERN)
    assert.deepEqual(info.serverInfo, { name: 'stub-server', version: '1.0.0' })
    const tools = await c.listTools()
    assert.deepEqual(
      tools.map((t) => t.name),
      ['echo', 'add', 'slow']
    )
    assert.equal(tools[1].inputSchema.required && (tools[1].inputSchema.required as string[])[0], 'a')
    await c.close()
    assert.equal(c.alive, false)
  })

  test('a call returns the text parts and names what it could not carry', async () => {
    const c = client()
    await c.connect()
    assert.deepEqual(await c.callTool('add', { a: 2, b: 3 }), { ok: true, text: '5', isError: false })
    assert.deepEqual(await c.callTool('slow', {}, 5000), { ok: true, text: 'done\n[image content omitted]', isError: false })
    const bad = await c.callTool('nope', {})
    assert.equal(bad.ok, false)
    assert.equal(bad.isError, true)
    await c.close()
  })

  test('tools/list pagination is followed to the end', async () => {
    const c = client('--page-size', '1')
    await c.connect()
    assert.deepEqual((await c.listTools()).map((t) => t.name), ['echo', 'add', 'slow'])
    await c.close()
  })

  test('an unsupported preferred version is retried with one the server names', async () => {
    const c = client('--unsupported')
    const info = await c.connect()
    assert.equal(info.era, 'modern')
    assert.equal(info.protocolVersion, '2026-01-01')
    assert.deepEqual(await c.callTool('echo', { text: 'hi' }), { ok: true, text: 'hi', isError: false })
    await c.close()
  })

  test('a call that outlives its timeout is cancelled and reported as a timeout', async () => {
    const c = client('--slow-ms', '3000')
    await c.connect()
    await assert.rejects(() => c.callTool('slow', {}, 300), (e: unknown) => e instanceof McpTimeoutError)
    // the transport is still alive and answers the next call
    assert.deepEqual(await c.callTool('echo', { text: 'still here' }), { ok: true, text: 'still here', isError: false })
    assert.ok(c.stderr().some((l) => /notifications\/cancelled/.test(l)), c.stderr().join('\n'))
    await c.close()
  })

  test('a result that asks the client for input is refused, not answered', async () => {
    const c = client('--input-required')
    await c.connect()
    await assert.rejects(() => c.callTool('echo', { text: 'x' }), /asked the client for input/)
    await c.close()
  })

  test('a server that dies mid-call fails the call and says the server exited', async () => {
    let exits = 0
    const c = createMcpClient({
      transport: { command: NODE, args: [STUB, '--crash-after', '1'], env: NODE_ENV },
      probeTimeoutMs: 1500,
      requestTimeoutMs: 5000,
      onExit: () => {
        exits += 1
      }
    })
    await c.connect()
    assert.deepEqual(await c.callTool('echo', { text: 'one' }), { ok: true, text: 'one', isError: false })
    await assert.rejects(() => c.callTool('echo', { text: 'two' }), /the server exited \(code 9/)
    assert.equal(exits, 1)
    assert.equal(c.alive, false)
  })
})

describe('MCP client — legacy server', () => {
  test('the probe falls back to initialize and the handshake completes', async () => {
    const c = client('--legacy')
    const info = await c.connect()
    assert.equal(info.era, 'legacy')
    assert.deepEqual(info.serverInfo, { name: 'stub-server', version: '1.0.0' })
    assert.deepEqual((await c.listTools()).map((t) => t.name), ['echo', 'add', 'slow'])
    assert.deepEqual(await c.callTool('add', { a: 40, b: 2 }), { ok: true, text: '42', isError: false })
    // legacy requests carry no modern _meta and the stub saw the handshake
    assert.ok(c.stderr().some((l) => l === 'stub: initialize'))
    assert.ok(c.stderr().some((l) => l === 'stub: notifications/initialized'))
    await c.close()
  })
})
