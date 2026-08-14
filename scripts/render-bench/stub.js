// A stand-in LM Studio server that streams one fixed reply at a chosen rate.
//
// This is the load-bearing part of the benchmark. A real model writes a
// different answer every run, at a rate that varies with thermal state and
// whatever else is loaded, so an A/B against a real model compares two
// different workloads and reports the difference as a result. Here both sides
// render byte-identical text on an identical token cadence.
//
// Only the model is replaced. Everything downstream of the socket — SSE
// parsing, the reasoning split, markdown, highlighting, sanitizing, React — is
// the app's own shipped code.
const http = require('http')

const PORT = Number(process.env.BENCH_STUB_PORT || 1235)
/** Notional tokens emitted per second. */
const TOKENS_PER_SEC = Number(process.env.BENCH_TOK_PER_SEC || 60)
/** Code blocks in the generated reply; raise for a longer answer. */
const BLOCKS = Number(process.env.BENCH_BLOCKS || 8)
/** Roughly one token. LM Studio emits one SSE frame per token. */
const CHARS_PER_CHUNK = 4

/**
 * A long, code-heavy reply: prose interleaved with fenced Python. Code matters
 * because highlight.js runs per block, and it is the shape of answer where the
 * old per-token re-parse cost the most.
 */
function buildReply() {
  const names = ['parser', 'scheduler', 'cache', 'router', 'indexer', 'planner', 'executor', 'reporter']
  const parts = ["Here's a complete implementation, broken into modules with an explanation of each.\n\n"]
  for (let block = 0; block < BLOCKS; block++) {
    parts.push(`## Module ${block + 1}: the ${names[block % names.length]}\n\n`)
    parts.push(
      'This module owns one job and holds no global state. The constructor takes its ' +
        'dependencies explicitly so it can be exercised from a test without patching ' +
        'imports, and every public method returns a value rather than mutating an ' +
        'argument in place. The error path is deliberately boring: it raises, and the ' +
        'caller decides.\n\n'
    )
    parts.push('```python\n')
    const lines = [
      'def process(records: list[dict], *, strict: bool = False) -> dict:',
      '    """Fold records into a summary keyed by source."""',
      '    out: dict[str, int] = {}',
      '    for record in records:',
      '        key = record.get("source", "unknown")',
      '        if strict and key == "unknown":',
      '            raise ValueError(f"record {record!r} has no source")',
      '        out[key] = out.get(key, 0) + int(record.get("count", 1))',
      '    return dict(sorted(out.items(), key=lambda kv: -kv[1]))',
      ''
    ]
    for (let i = 0; i < 55; i++) parts.push(lines[i % lines.length].replace('process(', `process_${block}_${i}(`) + '\n')
    parts.push('```\n\n')
    parts.push(
      'The sort is stable, so records that tie keep their input order — which matters ' +
        'because the caller renders this directly and a list that reshuffles between ' +
        'identical runs reads as a bug.\n\n'
    )
  }
  parts.push(
    'Wire them together in that order. Each stage is independently testable, and the ' +
      'only shared state is the cache, which is keyed by content hash rather than by ' +
      'position so a reordering upstream cannot produce a stale hit.\n'
  )
  return parts.join('')
}

const REPLY = buildReply()
const CHUNKS = []
for (let i = 0; i < REPLY.length; i += CHARS_PER_CHUNK) CHUNKS.push(REPLY.slice(i, i + CHARS_PER_CHUNK))

console.log(
  `stub: ${REPLY.length} chars / ${REPLY.split('\n').length} lines / ${CHUNKS.length} chunks ` +
    `at ${TOKENS_PER_SEC} tok/s (~${(CHUNKS.length / TOKENS_PER_SEC).toFixed(1)}s per stream)`
)

const MODELS = {
  data: [
    {
      id: 'bench-model',
      object: 'model',
      type: 'llm',
      // Reported as loaded so the model-pin path is a no-op, and with a large
      // window so history compaction never fires mid-measurement.
      state: 'loaded',
      max_context_length: 131072,
      loaded_context_length: 131072,
      quantization: 'Q4_K_M',
      capabilities: []
    }
  ]
}

const stats = { lastStreamStart: 0, lastStreamEnd: 0, replyChars: REPLY.length, tokensPerSec: TOKENS_PER_SEC }

function json(res, body) {
  const text = JSON.stringify(body)
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

async function streamCompletion(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  const frame = (delta, extra = {}) =>
    `data: ${JSON.stringify({
      id: 'bench',
      object: 'chat.completion.chunk',
      model: 'bench-model',
      choices: [{ index: 0, delta, finish_reason: extra.finish ?? null }],
      ...(extra.usage ? { usage: extra.usage } : {})
    })}\n\n`

  res.write(frame({ role: 'assistant' }))
  const startedAt = Date.now()
  stats.lastStreamStart = startedAt
  stats.lastStreamEnd = 0
  const interval = 1000 / TOKENS_PER_SEC

  for (let i = 0; i < CHUNKS.length; i++) {
    if (res.writableEnded) return
    res.write(frame({ content: CHUNKS[i] }))
    // Pace against a fixed wall-clock schedule rather than sleeping a fixed
    // amount, so a slow write cannot stretch the whole stream and change the
    // very cadence being compared.
    const wait = startedAt + (i + 1) * interval - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  res.write(
    frame({}, {
      finish: 'stop',
      usage: { prompt_tokens: 40, completion_tokens: CHUNKS.length, total_tokens: 40 + CHUNKS.length }
    })
  )
  res.write('data: [DONE]\n\n')
  res.end()
  stats.lastStreamEnd = Date.now()
  console.log(`stub: stream done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}

http
  .createServer((req, res) => {
    const url = req.url.split('?')[0]
    if (req.method === 'GET' && url === '/stats') return json(res, stats)
    if (req.method === 'GET' && (url === '/v1/models' || url === '/api/v0/models')) return json(res, MODELS)
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      req.on('data', () => {})
      req.on('end', () => void streamCompletion(res))
      return
    }
    // Model pin / unload and anything else the app probes: succeed quietly.
    req.on('data', () => {})
    req.on('end', () => json(res, { ok: true }))
  })
  .listen(PORT, '127.0.0.1', () => console.log(`stub: listening on ${PORT}`))
