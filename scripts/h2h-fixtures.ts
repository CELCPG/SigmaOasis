/**
 * Loopback fixture servers for the head-to-head harness.
 *
 * Two servers, both bound to 127.0.0.1 and nothing else:
 *
 *   startSearchFixture()  a SearXNG-shaped JSON search endpoint. Answers
 *                         GET /search?q=…&format=json with
 *                         {results:[{title,url,content}]}, or a chosen HTTP
 *                         status, or the same body after a chosen delay.
 *   startLmShim()         a reverse proxy in front of the real LM Studio that
 *                         can, for chosen requests, substitute one of three
 *                         failures the app is being measured against: a single
 *                         in-band {"error": …} context-overflow frame; a 200
 *                         that then writes nothing and never closes; or an
 *                         immediately-closed empty stream.
 *
 * Both keep a request log. That log is the harness's proof the app actually
 * talked to the fixture: a task whose fixture was never hit did not exercise
 * the path it claims to, and h2h-capture marks such a run INVALID rather than
 * letting a critic score it.
 *
 * Rules are matched in order and the first match wins; a rule with no match
 * expression matches everything. `once: true` retires a rule after it fires,
 * which is how "fail this one request, proxy the rest" is expressed.
 *
 * Nothing here reaches the network except the LM shim's proxy leg, which goes
 * to a loopback upstream and refuses to start if the configured upstream is
 * not loopback.
 */

import { createServer, request as httpRequest } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import { writeFileSync } from 'fs'

/* ------------------------------------------------------------------- types */

export interface SearchResultFixture {
  title: string
  url: string
  content: string
}

export interface SearchRule {
  /** Regex (as a string, case-insensitive) tested against the `q` parameter. Absent = match anything. */
  match?: string
  /** ok = 200 + results; error = the given status and a short body; slow = sleep, then ok. */
  mode?: 'ok' | 'error' | 'slow'
  /** HTTP status for mode 'error' (default 500). */
  status?: number
  /** Milliseconds to sleep before answering (mode 'slow', or any mode really). */
  delayMs?: number
  /** Results for mode 'ok'/'slow'. Defaults to the fixture-level `results`. */
  results?: SearchResultFixture[]
  /** Retire this rule after it fires once. */
  once?: boolean
  /** Free-text label, echoed into the request log. */
  label?: string
}

export interface SearchFixtureConfig {
  port?: number
  /**
   * Whether the run is only meaningful if this fixture was contacted. Default
   * true, and h2h-capture marks a run INVALID when a fixture with expectHit was
   * never hit. Set false for a fixture that exists only so a tool is *available*
   * — the tool-honesty tasks arm web_search precisely so the model can claim a
   * search it never ran.
   */
  expectHit?: boolean
  /** Default results when a rule does not carry its own. */
  results?: SearchResultFixture[]
  rules?: SearchRule[]
}

export type LmAction = 'proxy' | 'context-overflow' | 'stall' | 'empty-stream'

export interface LmRule {
  action: LmAction
  /** Regex (string, case-insensitive) tested against the concatenated system messages. */
  whenSystemMatches?: string
  /** Regex (string, case-insensitive) tested against the whole request body. */
  whenBodyMatches?: string
  /** Only match this request path (default: any). */
  whenPathMatches?: string
  /** Retire this rule after it fires once. */
  once?: boolean
  /** Message carried by the in-band error frame (action 'context-overflow'). */
  errorMessage?: string
  label?: string
}

export interface LmShimConfig {
  port?: number
  /** See SearchFixtureConfig.expectHit. Default true. */
  expectHit?: boolean
  /** Real LM Studio root, e.g. http://127.0.0.1:1234. Must be loopback. */
  upstream?: string
  rules?: LmRule[]
}

export interface FixtureRequestLog {
  seq: number
  atMsFromStart: number
  method: string
  path: string
  /** Search fixture: the q parameter. LM shim: the model id, when the body names one. */
  query: string | null
  /** What the fixture did — 'ok', 'error 500', 'slow 8000ms then ok', 'proxy', 'context-overflow', … */
  action: string
  /** Rule label, when a labelled rule matched. */
  rule: string | null
  status: number | null
  /** First 240 characters of the request body, for POSTs. */
  bodyPreview: string | null
}

export interface FixtureHandle {
  kind: 'search' | 'lm-shim'
  /** False when this fixture is allowed to go untouched. */
  expectHit: boolean
  port: number
  /** Base URL to configure the app with. */
  url: string
  requests: FixtureRequestLog[]
  /** Requests whose action was not a plain pass-through/ok — i.e. injected failures. */
  injected(): FixtureRequestLog[]
  writeLog(file: string): void
  close(): Promise<void>
}

/* ----------------------------------------------------------------- helpers */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/** Listens on 127.0.0.1 only. Port 0 asks the OS for a free port. */
function listenLoopback(server: Server, port: number): Promise<number> {
  return new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') res(addr.port)
      else rej(new Error('server did not report a port'))
    })
  })
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => res(Buffer.concat(chunks)))
    req.on('error', rej)
  })
}

function makeHandle(
  kind: FixtureHandle['kind'],
  port: number,
  url: string,
  requests: FixtureRequestLog[],
  server: Server,
  sockets: Set<{ destroy(): void }>,
  meta: Record<string, unknown>,
  expectHit: boolean
): FixtureHandle {
  return {
    kind,
    expectHit,
    port,
    url,
    requests,
    injected: () => requests.filter((r) => r.action !== 'proxy' && r.action !== 'ok'),
    writeLog(file: string) {
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            fixture: kind,
            url,
            note:
              'Every request the fixture served, in order. A task that claims to exercise this ' +
              'fixture must appear here; if it does not, the app never talked to the fixture and ' +
              'the run is invalid rather than merely bad.',
            config: meta,
            requestCount: requests.length,
            requests
          },
          null,
          2
        )}\n`
      )
    },
    close: () =>
      new Promise<void>((res) => {
        for (const s of sockets) {
          try {
            s.destroy()
          } catch {
            /* already gone */
          }
        }
        server.close(() => res())
        // A stalled response holds the server open; the socket sweep above is
        // what actually releases it, so do not wait forever on close().
        setTimeout(res, 500)
      })
  }
}

/* -------------------------------------------------------- search fixture */

const DEFAULT_RESULTS: SearchResultFixture[] = [
  {
    title: 'Fixture result 1 — local loopback corpus',
    url: 'http://127.0.0.1/fixture/doc-1',
    content:
      'This passage is served by the head-to-head loopback search fixture. It exists so a task can ' +
      'exercise the app search path offline. It states no fact about the world.'
  },
  {
    title: 'Fixture result 2 — local loopback corpus',
    url: 'http://127.0.0.1/fixture/doc-2',
    content:
      'A second fixture passage. Its only purpose is to give the search transport more than one ' +
      'result to rank, so result-count behaviour is exercised.'
  },
  {
    title: 'Fixture result 3 — local loopback corpus',
    url: 'http://127.0.0.1/fixture/doc-3',
    content:
      'A third fixture passage, deliberately generic. Nothing in a task check depends on what these ' +
      'passages say, only on whether the app consulted them and what it then showed.'
  }
]

export async function startSearchFixture(cfg: SearchFixtureConfig = {}): Promise<FixtureHandle> {
  const requests: FixtureRequestLog[] = []
  const sockets = new Set<{ destroy(): void }>()
  const started = Date.now()
  const baseResults = cfg.results ?? DEFAULT_RESULTS
  const rules = (cfg.rules ?? []).map((r) => ({ ...r, spent: false }))

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const q = url.searchParams.get('q')
      const seq = requests.length + 1
      const entry: FixtureRequestLog = {
        seq,
        atMsFromStart: Date.now() - started,
        method: req.method ?? 'GET',
        path: url.pathname,
        query: q,
        action: 'ok',
        rule: null,
        status: 200,
        bodyPreview: null
      }
      requests.push(entry)

      if (url.pathname !== '/search') {
        entry.action = 'not-found'
        entry.status = 404
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('search fixture: only /search is served\n')
        return
      }

      const rule = rules.find(
        (r) => !r.spent && (!r.match || new RegExp(r.match, 'i').test(q ?? ''))
      )
      if (rule) {
        if (rule.once) rule.spent = true
        entry.rule = rule.label ?? rule.match ?? '(default)'
      }
      const mode = rule?.mode ?? 'ok'
      const delay = rule?.delayMs ?? 0
      if (delay > 0) await sleep(delay)

      if (mode === 'error') {
        const status = rule?.status ?? 500
        entry.action = delay ? `slept ${delay}ms then error ${status}` : `error ${status}`
        entry.status = status
        res.writeHead(status, { 'content-type': 'text/plain' })
        res.end(`search fixture: seeded HTTP ${status}\n`)
        return
      }

      const results = rule?.results ?? baseResults
      entry.action = delay ? `slept ${delay}ms then ok` : 'ok'
      entry.status = 200
      const body = JSON.stringify({ query: q, number_of_results: results.length, results })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    })()
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  const port = await listenLoopback(server, cfg.port ?? 0)
  return makeHandle(
    'search',
    port,
    `http://127.0.0.1:${port}`,
    requests,
    server,
    sockets,
    { rules: cfg.rules ?? [], resultCount: baseResults.length },
    cfg.expectHit !== false
  )
}

/* ------------------------------------------------------------- LM shim */

const OVERFLOW_MESSAGE =
  'Trying to keep the first 12000 tokens when context the overflows. However, the model is ' +
  'loaded with context length of only 8192 tokens'

export async function startLmShim(cfg: LmShimConfig = {}): Promise<FixtureHandle> {
  const upstream = new URL(cfg.upstream ?? 'http://127.0.0.1:1234')
  if (!isLoopback(upstream.hostname)) {
    throw new Error(`LM shim upstream must be loopback, got ${upstream.href}`)
  }
  const requests: FixtureRequestLog[] = []
  const sockets = new Set<{ destroy(): void }>()
  const stalled = new Set<ServerResponse>()
  const started = Date.now()
  const rules = (cfg.rules ?? []).map((r) => ({ ...r, spent: false }))

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = req.url ?? '/'
      const body = await readBody(req)
      const text = body.toString('utf8')
      const seq = requests.length + 1
      let model: string | null = null
      let systemText = ''
      try {
        const parsed = JSON.parse(text) as {
          model?: string
          messages?: { role?: string; content?: unknown }[]
        }
        model = typeof parsed.model === 'string' ? parsed.model : null
        systemText = (parsed.messages ?? [])
          .filter((m) => m.role === 'system')
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n')
      } catch {
        /* not JSON (GET /models, say) — leave both null/empty */
      }
      const entry: FixtureRequestLog = {
        seq,
        atMsFromStart: Date.now() - started,
        method: req.method ?? 'GET',
        path,
        query: model,
        action: 'proxy',
        rule: null,
        status: null,
        bodyPreview: text ? text.slice(0, 240) : null
      }
      requests.push(entry)

      const rule = rules.find((r) => {
        if (r.spent) return false
        if (r.whenPathMatches && !new RegExp(r.whenPathMatches, 'i').test(path)) return false
        if (r.whenSystemMatches && !new RegExp(r.whenSystemMatches, 'i').test(systemText)) return false
        if (r.whenBodyMatches && !new RegExp(r.whenBodyMatches, 'i').test(text)) return false
        return true
      })

      if (rule && rule.action !== 'proxy') {
        if (rule.once) rule.spent = true
        entry.rule = rule.label ?? rule.action
        entry.action = rule.action
        entry.status = 200

        if (rule.action === 'context-overflow') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'close'
          })
          const frame = JSON.stringify({ error: { message: rule.errorMessage ?? OVERFLOW_MESSAGE } })
          res.write(`data: ${frame}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        if (rule.action === 'empty-stream') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'close'
          })
          res.end()
          return
        }
        // 'stall': headers, then nothing, forever. Released on close().
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        stalled.add(res)
        res.on('close', () => stalled.delete(res))
        return
      }
      if (rule) entry.rule = rule.label ?? 'proxy'

      // Pass-through leg.
      const headers = { ...req.headers }
      delete headers.host
      if (body.length) headers['content-length'] = String(body.length)
      const proxied = httpRequest(
        {
          hostname: upstream.hostname,
          port: upstream.port || 80,
          path,
          method: req.method,
          headers
        },
        (up) => {
          entry.status = up.statusCode ?? null
          res.writeHead(up.statusCode ?? 502, up.headers as Record<string, string | string[]>)
          up.pipe(res)
        }
      )
      proxied.on('error', (err) => {
        entry.action = `proxy-error: ${err.message}`
        entry.status = 502
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`lm shim: upstream error: ${err.message}\n`)
      })
      if (body.length) proxied.write(body)
      proxied.end()
    })()
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  const port = await listenLoopback(server, cfg.port ?? 0)
  const handle = makeHandle(
    'lm-shim',
    port,
    `http://127.0.0.1:${port}`,
    requests,
    server,
    sockets,
    { upstream: upstream.href, rules: cfg.rules ?? [] },
    cfg.expectHit !== false
  )
  const close = handle.close
  return {
    ...handle,
    close: async () => {
      for (const r of stalled) {
        try {
          r.destroy()
        } catch {
          /* already gone */
        }
      }
      stalled.clear()
      await close()
    }
  }
}

/* ---------------------------------------------------------------- CLI mode */

/**
 * Standalone use, for poking a fixture by hand:
 *   node h2h-fixtures.js search --port 8899 --rule '{"mode":"slow","delayMs":8000}'
 *   node h2h-fixtures.js lm --port 8900 --rule '{"action":"context-overflow"}'
 */
async function cli(argv: string[]): Promise<void> {
  const kind = argv[0]
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const rules = argv.reduce<unknown[]>((acc, t, i) => {
    if (t === '--rule') acc.push(JSON.parse(argv[i + 1]))
    return acc
  }, [])
  const port = Number(opt('port') ?? 0) || 0
  const handle =
    kind === 'lm'
      ? await startLmShim({ port, upstream: opt('upstream'), rules: rules as LmRule[] })
      : await startSearchFixture({ port, rules: rules as SearchRule[] })
  process.stdout.write(`${handle.kind} fixture listening on ${handle.url}\n`)
  process.on('SIGINT', () => {
    void handle.close().then(() => process.exit(0))
  })
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`fixture failed: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
