import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { appConfigPath, isLoopback, main, parseArgs, type CliOptions } from '../src/cli/sigma'
import { load } from './harness'

/**
 * v3.0: the `sigma` CLI — its arguments, its one rule about where it may
 * connect, the launcher the app installs, and a whole task end to end against
 * a stub LM Studio over real HTTP, through the same engine the app runs.
 */

describe('arguments', () => {
  const ok = (argv: string[]): CliOptions => {
    const r = parseArgs(argv)
    assert.ok(!('error' in r), JSON.stringify(r))
    return r as CliOptions
  }

  test('a bare task is a one-shot prompt; -p says the same', () => {
    assert.equal(ok(['fix', 'the', 'tests']).prompt, 'fix the tests')
    assert.equal(ok(['-p', 'fix the tests']).prompt, 'fix the tests')
    assert.equal(ok([]).prompt, null)
  })

  test('modes, by name or by flag', () => {
    assert.equal(ok(['--mode', 'accept-edits']).permission, 'acceptEdits')
    assert.equal(ok(['--mode', 'read-only']).permission, 'readOnly')
    assert.equal(ok(['--accept-edits']).permission, 'acceptEdits')
    assert.equal(ok(['--read-only']).permission, 'readOnly')
    assert.equal(ok(['--mode', 'plan']).permission, 'readOnly')
  })

  test('a mistake is a sentence and exit code 2, never a guess', () => {
    for (const argv of [['--mode', 'yolo'], ['--frobnicate'], ['-p'], ['--max-rounds', '0']]) {
      const r = parseArgs(argv)
      assert.ok('error' in r, `${argv.join(' ')} was accepted`)
    }
  })
})

describe('where it may connect', () => {
  test('only a model server on this machine', () => {
    for (const u of ['http://127.0.0.1:1234/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1']) assert.ok(isLoopback(u), u)
    for (const u of ['http://192.168.1.4:1234/v1', 'https://api.example.com/v1', 'not a url']) assert.ok(!isLoopback(u), u)
  })

  test('the app’s settings file is where electron-store keeps it, unless SIGMA_CONFIG says otherwise', () => {
    const before = process.env.SIGMA_CONFIG
    process.env.SIGMA_CONFIG = '/tmp/x.json'
    assert.equal(appConfigPath(), '/tmp/x.json')
    delete process.env.SIGMA_CONFIG
    assert.match(appConfigPath(), /Sigma Oasis[\\/]config\.json$/)
    if (before !== undefined) process.env.SIGMA_CONFIG = before
  })
})

describe('as a real process', () => {
  // The tests above hand `main` their own output; this one runs the CLI the
  // way a terminal does, so the path to the real stdout and stderr is
  // exercised too. (It once recursed into itself on the first error message.)
  test('an error reaches stderr and the exit code, and --version reaches stdout', () => {
    const cli = join(__dirname, '..', 'src', 'cli', 'sigma.js')
    const env = { ...process.env, SIGMA_CONFIG: join(tmpdir(), 'no-such-sigma-config.json') }
    const refused = spawnSync(process.execPath, [cli, '--base-url', 'http://10.1.1.1/v1', '-p', 'x'], { env, encoding: 'utf8' })
    assert.equal(refused.status, 2, refused.stderr)
    assert.match(refused.stderr, /talks only to a model server on this machine/)
    const version = spawnSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8' })
    assert.equal(version.status, 0)
    assert.match(version.stdout, /^sigma \d+\.\d+\.\d+/)
  })
})

describe('the launcher the app installs', () => {
  const { launcherText } = load<typeof import('../src/main/ipc/cli')>('cli')

  test('Windows: runs the CLI on the app’s own runtime, arguments passed through', () => {
    const t = launcherText('win32', 'C:\\Program Files\\Sigma Oasis\\Sigma Oasis.exe', 'C:\\Program Files\\Sigma Oasis\\resources\\cli\\sigma.js')
    assert.match(t, /set "ELECTRON_RUN_AS_NODE=1"/)
    assert.match(t, /"C:\\Program Files\\Sigma Oasis\\Sigma Oasis\.exe" "C:\\Program Files\\Sigma Oasis\\resources\\cli\\sigma\.js" %\*/)
    assert.match(t, /Sigma Oasis CLI launcher/, 'the marker uninstall looks for before it removes anything')
  })

  test('macOS / Linux: exec, with paths quoted even when they hold a quote', () => {
    const t = launcherText('darwin', "/Applications/Sigma Oasis.app/Contents/MacOS/Sigma Oasis", "/Users/o'brien/cli/sigma.js")
    assert.match(t, /^#!\/bin\/sh\n/)
    assert.match(t, /ELECTRON_RUN_AS_NODE=1 exec '\/Applications\/Sigma Oasis\.app\/Contents\/MacOS\/Sigma Oasis' '\/Users\/o'\\''brien\/cli\/sigma\.js' "\$@"/)
  })
})

describe('a task, from the command line', () => {
  let server: Server
  let url = ''
  let replies: ((body: { messages: { role: string; content: unknown }[] }) => Record<string, unknown>[])[] = []
  let requests = 0
  let dir = ''

  const text = (content: string) => ({ choices: [{ delta: { content } }] })
  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }]
  })

  before(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const reply = replies[requests++]
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const f of reply ? reply(JSON.parse(raw)) : [text('(script ran out)')]) res.write(`data: ${JSON.stringify(f)}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    dir = mkdtempSync(join(tmpdir(), 'sigma-cli-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'add.js'), 'module.exports = (a, b) => a - b\n')
    process.env.SIGMA_CONFIG = join(dir, 'no-such-config.json')
  })
  after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.SIGMA_CONFIG
  })

  test('one-shot, accept-edits, JSON: reads, edits, answers, exits 0', async () => {
    replies = [
      () => [call('c1', 'read_file', { path: 'src/add.js' })],
      () => [call('c2', 'edit_file', { path: 'src/add.js', old_string: 'a - b', new_string: 'a + b' })],
      () => [text('Fixed: add() subtracted.')]
    ]
    requests = 0
    const out: string[] = []
    const code = await main(['-p', 'fix add', '-C', dir, '--accept-edits', '--base-url', url, '--model', 'stub', '--json'], {
      out: (s) => out.push(s),
      err: () => {}
    })
    assert.equal(code, 0)
    assert.equal(readFileSync(join(dir, 'src', 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b\n')
    const events = out.join('').trim().split('\n').map((l) => JSON.parse(l) as { type: string; status?: string; finalText?: string; changedFiles?: string[] })
    const final = events[events.length - 1]!
    assert.deepEqual([final.type, final.status, final.finalText, final.changedFiles], ['final', 'done', 'Fixed: add() subtracted.', ['src/add.js']])
    assert.ok(events.some((e) => e.type === 'tool_start'))
  })

  test('with nobody to ask, an edit in ask mode is declined — and said — rather than made', async () => {
    writeFileSync(join(dir, 'src', 'add.js'), 'module.exports = (a, b) => a - b\n')
    replies = [
      () => [call('c1', 'read_file', { path: 'src/add.js' })],
      () => [call('c2', 'edit_file', { path: 'src/add.js', old_string: 'a - b', new_string: 'a + b' })],
      () => [text('I could not apply the fix.')]
    ]
    requests = 0
    const err: string[] = []
    await main(['-p', 'fix add', '-C', dir, '--mode', 'ask', '--base-url', url, '--model', 'stub', '--json'], {
      out: () => {},
      err: (s) => err.push(s)
    })
    assert.equal(readFileSync(join(dir, 'src', 'add.js'), 'utf8'), 'module.exports = (a, b) => a - b\n')
    assert.match(err.join(''), /Declined an edit to src\/add\.js: no one to ask/)
  })

  test('a server that is not on this machine is refused before anything is sent', async () => {
    requests = 0
    const err: string[] = []
    const code = await main(['-p', 'hi', '--base-url', 'http://10.0.0.5:1234/v1', '--model', 'x'], { out: () => {}, err: (s) => err.push(s) })
    assert.equal(code, 2)
    assert.equal(requests, 0)
    assert.match(err.join(''), /talks only to a model server on this machine/)
  })
})
