// A stub MCP server over stdio, for the node suite and the tool-choice eval.
//
//   node stub-server.mjs            modern: answers server/discover, per-request _meta
//   node stub-server.mjs --legacy   legacy: answers only after `initialize`
//   --crash-after N                 exit(9) after N tools/call requests
//   --slow-ms N                     tools/call "slow" sleeps N ms (default 200)
//   --page-size N                   tools/list pages of N (default: all in one page)
//   --unsupported                   modern, but rejects 2026-07-28 with -32022 naming 2026-01-01
//   --input-required                tools/call answers with resultType input_required
//
// Three tools with deliberately overlapping descriptions, so the tool-choice
// eval can ask whether their presence degrades built-in selection:
//   echo(text)      → the text back
//   add(a, b)       → a + b
//   slow()          → sleeps, then "done"
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const num = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt
}
const legacy = flag('--legacy')
const crashAfter = num('--crash-after', Infinity)
const slowMs = num('--slow-ms', 200)
const pageSize = num('--page-size', Infinity)
const unsupported = flag('--unsupported')
const inputRequired = flag('--input-required')

const SERVER_INFO = { name: 'stub-server', version: '1.0.0' }
const TOOLS = [
  { name: 'echo', description: 'Echo text back. Use to repeat a string exactly.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers and return the sum. Use for arithmetic on two values.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'slow', description: 'A tool that takes a while. Use to wait.', inputSchema: { type: 'object', properties: {} } }
]

let initialized = false
let calls = 0
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const result = (id, r) => write({ jsonrpc: '2.0', id, result: legacy ? r : { resultType: 'complete', ...r } })
const error = (id, code, message, data) => write({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let m
  try {
    m = JSON.parse(line)
  } catch {
    process.stderr.write('stub: not json\n')
    return
  }
  const { id, method, params } = m
  process.stderr.write(`stub: ${method}\n`)
  if (id === undefined) return // notifications: initialized, cancelled
  if (legacy) {
    if (method === 'initialize') {
      initialized = true
      return result(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER_INFO })
    }
    if (!initialized) return error(id, -32002, 'Not initialized')
  } else {
    const version = params?._meta?.['io.modelcontextprotocol/protocolVersion']
    if (method === 'server/discover' || method === 'tools/list' || method === 'tools/call') {
      if (unsupported && version === '2026-07-28') {
        return error(id, -32022, 'Unsupported protocol version', { supported: ['2026-01-01'], requested: version })
      }
      if (typeof version !== 'string') return error(id, -32602, 'Invalid params: missing protocol version')
    }
    if (method === 'server/discover') {
      return result(id, { serverInfo: SERVER_INFO, supportedVersions: unsupported ? ['2026-01-01'] : ['2026-07-28'], capabilities: { tools: {} } })
    }
    if (method === 'initialize') return error(id, -32601, 'Method not found: initialize (modern server; supported: 2026-07-28)')
  }
  if (method === 'tools/list') {
    const start = params?.cursor ? Number(params.cursor) : 0
    const page = TOOLS.slice(start, Number.isFinite(pageSize) ? start + pageSize : undefined)
    const next = Number.isFinite(pageSize) && start + pageSize < TOOLS.length ? String(start + pageSize) : undefined
    return result(id, { tools: page, ...(next ? { nextCursor: next } : {}) })
  }
  if (method === 'tools/call') {
    calls += 1
    if (calls > crashAfter) process.exit(9)
    if (inputRequired) return write({ jsonrpc: '2.0', id, result: { resultType: 'input_required', requestId: id } })
    const name = params?.name
    const a = params?.arguments ?? {}
    if (name === 'echo') return result(id, { content: [{ type: 'text', text: String(a.text ?? '') }] })
    if (name === 'add') return result(id, { content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] })
    if (name === 'slow') {
      await new Promise((r) => setTimeout(r, slowMs))
      return result(id, { content: [{ type: 'text', text: 'done' }, { type: 'image', data: '', mimeType: 'image/png' }] })
    }
    return result(id, { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true })
  }
  return error(id, -32601, `Method not found: ${method}`)
})
rl.on('close', () => process.exit(0))
