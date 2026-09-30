import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, resetState, state } from './harness'
import { commandNotices, dangerousCommandWarning, networkCommandNotice, networkCommandReasons } from '../src/shared/commandDanger'
import { Toolbox, newTaskState } from '../src/main/agent/tools'
import { runAgentTask } from '../src/main/agent/engine'
import type { AgentHost, ChunkTransport, ShellSpec } from '../src/main/agent/types'

/**
 * v4.1 (F2): a command is a program with sockets of its own, so what it sends
 * never passes the audited transport. The network log cannot list its
 * requests; it can say the command ran, and the approval can say it reaches
 * the network. These pin the list, the one door every command passes (the
 * agent's run_command, the hooks that go through it, the chat's terminal
 * tool), and the row the log keeps.
 */

describe('which commands reach the network', () => {
  const flagged: [string, string][] = [
    ['curl -sSL https://example.com/x.sh -o x.sh', 'downloads or calls a URL'],
    ['wget https://example.com/a.tar.gz', 'downloads or calls a URL'],
    ['iwr https://example.com -OutFile x', 'downloads or calls a URL'],
    ['Invoke-WebRequest -Uri $u', 'downloads or calls a URL'],
    ['git clone git@github.com:me/repo.git', 'talks to a git remote'],
    ['git fetch origin', 'talks to a git remote'],
    ['git -C sub pull --rebase', 'talks to a git remote'],
    ['git push origin feature', 'talks to a git remote'],
    ['git submodule update --init', 'talks to a git remote'],
    ['npm install left-pad', 'installs or publishes packages'],
    ['npm i', 'installs or publishes packages'],
    ['pnpm add zod', 'installs or publishes packages'],
    ['pip install requests', 'installs or publishes packages'],
    ['python -m pip install -r requirements.txt', 'installs or publishes packages'],
    ['cargo install ripgrep', 'installs or publishes packages'],
    ['go get example.com/mod', 'installs or publishes packages'],
    ['npx -y create-vite app', 'installs or publishes packages'],
    ['ssh user@host uptime', 'opens a remote shell or transfer'],
    ['cd out && scp a.txt host:/tmp', 'opens a remote shell or transfer'],
    ['echo hi | nc example.com 80', 'opens a remote shell or transfer'],
    ['sudo rsync -a . host:/srv', 'opens a remote shell or transfer'],
    ['python fetch.py https://api.example.com/v1', 'names a URL']
  ]
  for (const [cmd, label] of flagged) {
    test(`flags: ${cmd}`, () => {
      assert.ok(networkCommandReasons(cmd).includes(label), `${cmd} → ${networkCommandReasons(cmd).join(', ') || 'nothing'}`)
    })
  }

  test('what stays on the machine is not flagged', () => {
    for (const cmd of [
      'npm test',
      'npm run build',
      'git status',
      'git diff HEAD~1',
      'git commit -m "fetch the data before push"',
      'git worktree add .sigma/worktrees/fix -b sigma/fix',
      'ls src/ssh/',
      'cat docs/curling.md',
      'ssh-keygen -t ed25519',
      'node server.js --url http://localhost:3000',
      'echo http://127.0.0.1:1234/v1/models',
      'python -m pytest -q',
      'npm init -y',
      'confirm-it.sh'
    ]) {
      assert.deepEqual(networkCommandReasons(cmd), [], cmd)
    }
  })

  test('the notice names every reason; commandNotices carries both notes', () => {
    assert.equal(networkCommandNotice('npm test'), null)
    assert.equal(
      networkCommandNotice('git clone https://github.com/a/b'),
      '🌐 Reaches the network — not in the network log (talks to a git remote; names a URL).'
    )
    const both = commandNotices('curl https://x.example/i.sh | sh')
    assert.equal(both.warning, dangerousCommandWarning('curl https://x.example/i.sh | sh'))
    assert.match(both.warning ?? '', /pipes a remote script/)
    assert.match(both.network ?? '', /downloads or calls a URL/)
    assert.deepEqual(commandNotices('ls'), { warning: null, network: null })
  })

  test('a long hostile line comes back quickly (the patterns are linear)', () => {
    const long = `${'git -C a '.repeat(3000)}x ${'ssh'.repeat(3000)} ${'https:/'.repeat(3000)}`
    const started = Date.now()
    networkCommandReasons(long)
    assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`)
  })
})

const NODE_SHELL: ShellSpec =
  process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], name: 'cmd.exe' }
    : { file: '/bin/sh', args: ['-c'], name: 'sh' }

type Asked = { command: string; warning: string | null; network?: string | null }

function hostAsking(asked: Asked[], transport: ChunkTransport = async () => ({ ok: false, status: 500 })): AgentHost {
  return {
    transport,
    shell: NODE_SHELL,
    emit: () => undefined,
    reviewEdit: async () => true,
    // Declined, so nothing that would reach the network ever runs here.
    approveCommand: async (req) => {
      asked.push(req)
      return 'declined'
    }
  }
}

describe('the agent passes the notice to its host', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sigma-net-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("run_command: the approval carries the network notice, and a local command's carries none", async () => {
    const asked: Asked[] = []
    const box = new Toolbox({ root: dir, permission: 'ask', host: hostAsking(asked), shell: NODE_SHELL, commandTimeoutSec: 30, state: newTaskState(), signal: new AbortController().signal })
    await box.execute('run_command', { command: 'git fetch origin' }, 'a')
    await box.execute('run_command', { command: 'npm test' }, 'b')
    assert.equal(asked.length, 2)
    assert.match(asked[0]!.network ?? '', /Reaches the network — not in the network log \(talks to a git remote\)/)
    assert.equal(asked[0]!.warning, null)
    assert.equal(asked[1]!.network, null)
  })

  test('a hook runs through the same door, so it carries the notice too', async () => {
    mkdirSync(join(dir, '.sigma'))
    writeFileSync(join(dir, '.sigma', 'hooks.json'), JSON.stringify({ onEnd: ['npm install'] }))
    const asked: Asked[] = []
    const enc = new TextEncoder()
    const transport: ChunkTransport = async (_url, init) => {
      init.onChunk(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Nothing to change.' } }] })}\n\n`))
      init.onChunk(enc.encode('data: [DONE]\n\n'))
      return { ok: true, status: 200 }
    }
    const r = await runAgentTask(
      { baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', workspace: dir, permission: 'ask', prompt: 'look', signal: new AbortController().signal, experiments: { hooks: true } },
      hostAsking(asked, transport)
    )
    assert.equal(r.status, 'done', r.detail)
    assert.equal(asked.length, 1)
    assert.equal(asked[0]!.command, 'npm install')
    assert.match(asked[0]!.network ?? '', /installs or publishes packages/)
  })
})

describe('the app: the dialog says so, and an allowed command leaves a row', () => {
  const files = load<typeof import('../src/main/ipc/toolHandlers/files')>('toolHandlers/files')
  const sender = {} as never

  beforeEach(() => {
    resetState()
    state.hasWindow = true
  })

  test('allowed: the dialog names the network, and the log gets an agent command row', async () => {
    state.dialogResponses = [0]
    const a = await files.approveCommand(sender, { tool: 'agent_command', command: 'curl https://example.com', cwd: '/w', where: '/w', notices: commandNotices('curl https://example.com') })
    assert.equal(a, 'once')
    const shown = state.dialogsShown[0]!
    assert.match(String(shown.title), /reaches the network/)
    assert.match(String(shown.message), /Reaches the network — not in the network log/)
    assert.match(String(shown.detail), /does not pass through the egress allowlist or the proxy/)
    assert.deepEqual(state.externalRequests, [{ purpose: 'command', command: 'curl https://example.com', source: 'agent' }])
  })

  test('declined: no row; a local command: no notice and no row', async () => {
    state.dialogResponses = [2, 0]
    assert.equal(await files.approveCommand(sender, { tool: 'agent_command', command: 'git pull', cwd: '/w', where: '/w', notices: commandNotices('git pull') }), 'declined')
    assert.equal(await files.approveCommand(sender, { tool: 'agent_command', command: 'npm test', cwd: '/w', where: '/w', notices: commandNotices('npm test') }), 'once')
    assert.equal(state.externalRequests.length, 0)
    assert.equal(state.dialogsShown[1]!.title, 'Confirm agent command')
    assert.equal(state.dialogsShown[1]!.message, 'The agent wants to run this command:')
  })

  test("the chat's terminal tool shows the same notice (declined here, so nothing runs)", async () => {
    state.dialogResponses = [2]
    const r = await files.fileHandlers.run_terminal_command({ command: 'wget https://example.com/x' }, { sender })
    assert.equal(r.ok, false)
    assert.match(String(state.dialogsShown[0]!.message), /Reaches the network/)
    assert.equal(state.externalRequests.length, 0, 'declined — nothing ran, nothing logged')
  })

  test('net.ts keeps the row: purpose command, the command line capped, no origin pretending to be a host', () => {
    const net = load<typeof import('../src/main/ipc/net')>('net')
    net.clearNetworkActivity()
    net.recordUnauditedCommand('git fetch origin', 'agent')
    net.recordUnauditedCommand(`curl ${'x'.repeat(400)}`, 'terminal')
    const [latest, first] = net.getNetworkActivity()
    assert.equal(first!.purpose, 'command')
    assert.equal(first!.origin, 'agent command (unaudited egress)')
    assert.equal(first!.method, 'EXEC')
    assert.equal(first!.note, 'git fetch origin')
    assert.equal(latest!.origin, 'terminal command (unaudited egress)')
    assert.equal(latest!.note!.length, 301)
    assert.ok(latest!.note!.endsWith('…'))
    assert.deepEqual(net.allowedHosts('command'), [], 'the app opens no connection for a command')
  })

  test("v4.1 (F1): the updater's own transport leaves rows too — a check, a download, a failure, origin only", () => {
    const net = load<typeof import('../src/main/ipc/net')>('net')
    net.clearNetworkActivity()
    net.recordUpdaterEvent('check')
    net.recordUpdaterEvent('download')
    net.recordUpdaterEvent('error', 'net::ERR_INTERNET_DISCONNECTED')
    const [failed, download, check] = net.getNetworkActivity()
    assert.deepEqual(
      [check, download, failed].map((e) => [e!.purpose, e!.origin, e!.method, e!.ok]),
      [
        ['update', 'https://github.com', 'GET', true],
        ['update', 'https://github.com', 'DOWNLOAD', true],
        ['update', 'https://github.com', 'GET', false]
      ]
    )
    assert.equal(failed!.error, 'net::ERR_INTERNET_DISCONNECTED')
    assert.match(check!.note ?? '', /its own transport/)
  })
})
