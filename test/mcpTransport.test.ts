/**
 * The stdio transport (v2.5): framing, stderr, shutdown, unexpected exit.
 * Driven against a tiny inline server so the node suite needs no fixture
 * process beyond node itself.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnTransport } from '../src/main/ipc/mcp/transport'

/** Node (or Electron-as-node) running an inline script. */
const NODE = process.execPath
const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }

// A server that: echoes every JSON line back with `echoed: true`, writes one
// stderr line per message, writes one non-JSON stdout line on demand, and
// exits when its stdin closes (the portable shutdown signal).
const ECHO_SERVER = `
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      process.stderr.write('got ' + m.id + '\\n');
      if (m.garbage) process.stdout.write('this is not json\\n');
      if (m.crash) process.exit(3);
      process.stdout.write(JSON.stringify({ ...m, echoed: true }) + '\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
`

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('MCP stdio transport', () => {
  test('frames one JSON message per line, in order, across chunk boundaries', async () => {
    const got: unknown[] = []
    const t = spawnTransport({
      command: NODE,
      args: ['-e', ECHO_SERVER],
      env: NODE_ENV,
      onMessage: (m) => got.push(m),
      onExit: () => undefined
    })
    t.send({ id: 1, text: 'a\nb' }) // an embedded newline is escaped, never a frame break
    t.send({ id: 2 })
    for (let i = 0; i < 50 && got.length < 2; i++) await wait(50)
    assert.deepEqual(got, [
      { id: 1, text: 'a\nb', echoed: true },
      { id: 2, echoed: true }
    ])
    await t.close(500)
    assert.equal(t.alive, false)
  })

  test('a stdout line that is not JSON is reported and never fatal', async () => {
    const got: unknown[] = []
    const garbage: string[] = []
    const t = spawnTransport({
      command: NODE,
      args: ['-e', ECHO_SERVER],
      env: NODE_ENV,
      onMessage: (m) => got.push(m),
      onExit: () => undefined,
      onGarbage: (l) => garbage.push(l)
    })
    t.send({ id: 1, garbage: true })
    for (let i = 0; i < 50 && got.length < 1; i++) await wait(50)
    assert.deepEqual(garbage, ['this is not json'])
    assert.deepEqual(got, [{ id: 1, garbage: true, echoed: true }])
    await t.close(500)
  })

  test('stderr is kept in a bounded ring, oldest first', async () => {
    const got: unknown[] = []
    const t = spawnTransport({
      command: NODE,
      args: ['-e', ECHO_SERVER],
      env: NODE_ENV,
      stderrLines: 2,
      onMessage: (m) => got.push(m),
      onExit: () => undefined
    })
    for (const id of [1, 2, 3]) t.send({ id })
    for (let i = 0; i < 50 && got.length < 3; i++) await wait(50)
    await wait(50)
    assert.deepEqual(t.stderr(), ['got 2', 'got 3'])
    await t.close(500)
  })

  test('close is the spec sequence: stdin closes, the server exits, and the exit is expected', async () => {
    let exit: { code: number | null; expected: boolean } | null = null
    const t = spawnTransport({
      command: NODE,
      args: ['-e', ECHO_SERVER],
      env: NODE_ENV,
      onMessage: () => undefined,
      onExit: (e) => {
        exit = { code: e.code, expected: e.expected }
      }
    })
    await wait(100)
    await t.close(2000)
    assert.deepEqual(exit, { code: 0, expected: true })
  })

  test('an unexpected exit is reported as such, with its code', async () => {
    let exit: { code: number | null; expected: boolean } | null = null
    const t = spawnTransport({
      command: NODE,
      args: ['-e', ECHO_SERVER],
      env: NODE_ENV,
      onMessage: () => undefined,
      onExit: (e) => {
        exit = { code: e.code, expected: e.expected }
      }
    })
    t.send({ id: 9, crash: true })
    for (let i = 0; i < 50 && exit === null; i++) await wait(50)
    assert.deepEqual(exit, { code: 3, expected: false })
    assert.equal(t.alive, false)
    // sending into a dead transport is a no-op, not a throw
    t.send({ id: 10 })
  })

  test('a server that ignores stdin closing is terminated', async () => {
    const stubborn = `process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1000)`
    const exits: { signal: string | null; expected: boolean }[] = []
    const t = spawnTransport({
      command: NODE,
      args: ['-e', stubborn],
      env: NODE_ENV,
      onMessage: () => undefined,
      onExit: (e) => exits.push({ signal: e.signal, expected: e.expected })
    })
    await wait(100)
    await t.close(200)
    assert.equal(t.alive, false)
    assert.equal(exits.length, 1)
    assert.ok(exits[0].expected && (exits[0].signal === 'SIGTERM' || exits[0].signal === 'SIGKILL'), JSON.stringify(exits))
  })

  test('a command that does not exist reports the spawn failure in stderr and exits', async () => {
    let exited = false
    const t = spawnTransport({
      command: '/definitely/not/a/real/binary',
      onMessage: () => undefined,
      onExit: () => {
        exited = true
      }
    })
    for (let i = 0; i < 50 && !exited; i++) await wait(50)
    assert.ok(exited)
    assert.ok(t.stderr().some((l) => /\[spawn\] .*ENOENT/.test(l)), t.stderr().join('\n'))
  })
})
