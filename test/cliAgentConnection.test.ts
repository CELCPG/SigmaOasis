import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { main } from '../src/cli/sigma'
import { readSource } from './harness'

/**
 * 4.6 (J1): `sigma` and the app's agent connection, over real HTTP. Two stub
 * servers: one plays LM Studio, the other the agent's own server (a
 * llama-server serving one model). The CLI reads the app's settings file;
 * with the connection on, every request goes to the second server with its
 * model and none to LM Studio, `--json`'s last line says so, and a server that
 * is down or lacks the model ends the run in words naming the connection.
 */

interface Seen {
  method: string
  path: string
  model?: string
}

function stub(models: string[], seen: Seen[]): Server {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { model?: string }) : {}
      seen.push({ method: req.method ?? '', path: req.url ?? '', ...(body.model ? { model: body.model } : {}) })
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'llamacpp' })) }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Nothing to change.' } }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
}

const listen = async (s: Server): Promise<string> => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`
}

describe('sigma on the agent connection', () => {
  const lmSeen: Seen[] = []
  const agentSeen: Seen[] = []
  const lm = stub(['qwen3.8-9b-distill', 'text-embedding-nomic-embed-text-v1.5'], lmSeen)
  const agent = stub(['qwen3.8-35b-a3b'], agentSeen)
  let lmUrl = ''
  let agentUrl = ''
  let deadUrl = ''
  let dir = ''
  let config = ''

  const settings = (agentConnection: Record<string, unknown> | undefined): void =>
    writeFileSync(
      config,
      JSON.stringify({ settings: { baseUrl: lmUrl, models: [{ id: 'm1', modelId: 'qwen3.8-9b-distill', enabled: true, specialty: 'coding' }], ...(agentConnection ? { agentConnection } : {}) } })
    )
  const run = async (argv: string[]): Promise<{ code: number; out: string; err: string; final: Record<string, any> | null }> => {
    const out: string[] = []
    const err: string[] = []
    const code = await main(['-p', 'look', '-C', dir, '--read-only', '--json', ...argv], { out: (s) => out.push(s), err: (s) => err.push(s) })
    const lines = out.join('').trim().split('\n').filter(Boolean)
    const final = lines.length > 0 ? (JSON.parse(lines[lines.length - 1]!) as Record<string, any>) : null
    return { code, out: out.join(''), err: err.join(''), final }
  }

  before(async () => {
    lmUrl = await listen(lm)
    agentUrl = await listen(agent)
    // A port that was listening a moment ago and is not now: nothing answers there.
    const gone = createServer()
    deadUrl = await listen(gone)
    await new Promise<void>((r) => gone.close(() => r()))
    dir = mkdtempSync(join(tmpdir(), 'sigma-cli-agentconn-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.js'), 'module.exports = 1\n')
    config = join(dir, 'config.json')
    process.env.SIGMA_CONFIG = config
  })
  after(() => {
    lm.close()
    agent.close()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.SIGMA_CONFIG
  })
  beforeEach(() => {
    lmSeen.length = 0
    agentSeen.length = 0
  })

  test('off (absent, as in a 4.5 file): LM Studio and the slot\'s model, as before — the last line says so', async () => {
    settings(undefined)
    const r = await run([])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.final?.connection, { via: 'main', baseUrl: lmUrl, model: 'qwen3.8-9b-distill' })
    assert.ok(lmSeen.some((s) => s.method === 'POST' && s.model === 'qwen3.8-9b-distill'))
    assert.equal(agentSeen.length, 0)
  })

  test('on: the agent server and its model, nothing to LM Studio; the last line names the connection', async () => {
    settings({ enabled: true, baseUrl: agentUrl, model: '' })
    const r = await run([])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.final?.connection, { via: 'agent', baseUrl: agentUrl, model: 'qwen3.8-35b-a3b' })
    const posts = agentSeen.filter((s) => s.method === 'POST')
    assert.ok(posts.length > 0 && posts.every((s) => s.path === '/v1/chat/completions' && s.model === 'qwen3.8-35b-a3b'))
    assert.deepEqual(lmSeen, [], 'LM Studio is asked nothing')
  })

  test('on, the server is down: exit 1 and a message naming the agent connection — LM Studio is not tried', async () => {
    settings({ enabled: true, baseUrl: deadUrl, model: 'qwen3.8-35b-a3b' })
    const r = await run([])
    assert.equal(r.code, 1)
    assert.match(r.err, new RegExp(`^The agent connection \\(${deadUrl.replace(/[.]/g, '\\.')}, Settings → LM Studio\\) did not answer: .*ECONNREFUSED.*\\. The agent does not fall back to LM Studio`))
    assert.deepEqual(lmSeen, [])
  })

  test('on, the model is not served: exit 1, in words — another model is not swapped in', async () => {
    settings({ enabled: true, baseUrl: agentUrl, model: 'qwen3.8-9b-distill' })
    const r = await run([])
    assert.equal(r.code, 1)
    assert.match(r.err, /does not serve qwen3\.8-9b-distill \(it lists qwen3\.8-35b-a3b\)/)
    assert.ok(!agentSeen.some((s) => s.method === 'POST'))
    assert.deepEqual(lmSeen, [])
  })

  test('--model and --base-url still decide: the model on the agent server, or the run on the server named', async () => {
    settings({ enabled: true, baseUrl: agentUrl, model: 'qwen3.8-9b-distill' })
    const named = await run(['--model', 'qwen3.8-35b-a3b'])
    assert.equal(named.code, 0, named.err)
    assert.equal(named.final?.connection.via, 'agent')
    assert.equal(named.final?.connection.model, 'qwen3.8-35b-a3b')

    agentSeen.length = 0
    const flag = await run(['--base-url', lmUrl, '--model', 'qwen3.8-9b-distill'])
    assert.equal(flag.code, 0, flag.err)
    assert.deepEqual(flag.final?.connection, { via: 'main', baseUrl: lmUrl, model: 'qwen3.8-9b-distill' })
    assert.equal(agentSeen.length, 0)
  })

  // Not run against a real port: the default address (llama-server's :8080)
  // may have something listening on a given machine. The rule itself is
  // normalizeAgentConnection's, tested in agentConnection.test.ts.
  test('the file is read by the app\'s own rule: a non-loopback agent address is never used', () => {
    const source = readSource(join(__dirname, '..', '..', 'src', 'cli', 'sigma.ts'))
    assert.match(source, /const connection = o\.baseUrl \? undefined : normalizeAgentConnection\(app\.agentConnection\)/)
  })
})
