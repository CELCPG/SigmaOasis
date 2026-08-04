import { net } from 'electron'
import type { Session } from 'electron'

/**
 * A fetch-shaped client over Electron's `net` module.
 *
 * ## Why not Node's fetch
 *
 * Everything outbound used to go through Node's global `fetch`, which is undici.
 * Undici has its own network stack: it does not consult Electron sessions, so
 * `session.setProxy()` has no effect on it, and undici's SOCKS support requires a
 * dispatcher that cannot be constructed without the `undici` package (Node does
 * not expose it as a module).
 *
 * The consequence, had this not been changed: turning on a proxy would have
 * routed only the headless renderer through it and left `web_search` and
 * `fetch_webpage` going out directly — a privacy feature that silently does not
 * cover the paths that matter most. Worse than not having it.
 *
 * Electron's `net` module uses Chromium's network stack, which honors per-session
 * proxy configuration, resolves DNS through the proxy for SOCKS5 (no local DNS
 * leak), and is considerably more battle-tested than anything hand-rolled here.
 *
 * ## Shape
 *
 * Returns the subset of the `Response` interface callers actually use, so
 * migrating from `fetch` needed no changes at the call sites: `ok`, `status`,
 * `headers.get()`, `text()`, `json()`, `arrayBuffer()`. `body` is null, which is
 * the path existing readers already fall back to.
 */

export interface HttpResponseLike {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  /** Always null: callers use arrayBuffer()/text() and cap via `maxBytes`. */
  body: null
  /** True when the body hit `maxBytes` and was cut short. */
  truncated: boolean
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Which session — and therefore which proxy configuration — to use. */
  session: Session
  /** 'manual' returns the 3xx response instead of following it. */
  redirect?: 'follow' | 'manual'
  signal?: AbortSignal
  timeoutMs?: number
  /** Hard cap on bytes read. The transport stops there rather than buffering more. */
  maxBytes?: number
  /**
   * Called with each chunk as it arrives, before the response completes.
   *
   * The point is not speed — it is that a caller accumulating here keeps what
   * it received even when the request later times out or aborts. A long
   * generation that fails at the 4-minute mark has still produced most of an
   * answer, and throwing that away is a choice, not a necessity.
   */
  onChunk?: (chunk: Uint8Array) => void
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

function makeResponse(
  status: number,
  headers: Record<string, string | string[]>,
  bytes: Uint8Array,
  truncated: boolean
): HttpResponseLike {
  // Chromium lower-cases header names and may return arrays for repeats.
  const lookup = (name: string): string | null => {
    const value = headers[name.toLowerCase()]
    if (value === undefined) return null
    return Array.isArray(value) ? (value[0] ?? null) : value
  }
  const decode = (): string => new TextDecoder().decode(bytes)

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: lookup },
    text: async () => decode(),
    json: async () => JSON.parse(decode()),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    body: null,
    truncated
  }
}

/**
 * Perform one HTTP request. No policy here — the allowlist, the audit log and the
 * SSRF checks all live in their own modules; this is only transport.
 */
export function httpRequest(url: string, options: HttpRequestOptions): Promise<HttpResponseLike> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  return new Promise<HttpResponseLike>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    let request: Electron.ClientRequest
    try {
      request = net.request({
        method: options.method ?? 'GET',
        url,
        session: options.session,
        // Chromium follows redirects by default; 'manual' surfaces them instead,
        // which is what the SSRF guard needs so it can re-check every hop.
        redirect: options.redirect === 'manual' ? 'manual' : 'follow',
        useSessionCookies: false
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const timer = setTimeout(() => {
      finish(() => {
        try {
          request.abort()
        } catch {
          // Already finished.
        }
        const error = new Error(`Request timed out after ${timeoutMs / 1000}s.`)
        error.name = 'AbortError'
        reject(error)
      })
    }, timeoutMs)

    const onAbort = (): void =>
      finish(() => {
        try {
          request.abort()
        } catch {
          // Already finished.
        }
        const error = new Error('The request was aborted.')
        error.name = 'AbortError'
        reject(error)
      })

    function cleanup(): void {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      try {
        request.setHeader(name, value)
      } catch {
        // Chromium refuses some headers outright; skip rather than fail.
      }
    }

    // Electron emits 'redirect' in *both* modes: with 'follow' it continues
    // automatically afterwards, with 'manual' it waits for followRedirect().
    // Intercepting unconditionally therefore breaks follow mode — every
    // redirected request would come back as a bare 3xx, which for a search
    // provider reads as "HTTP 302" and fails the search.
    request.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      if (options.redirect !== 'manual') return // Let Chromium follow it.
      finish(() => {
        try {
          request.abort()
        } catch {
          // Already finished.
        }
        const headers: Record<string, string | string[]> = { ...responseHeaders }
        if (!headers.location) headers.location = redirectUrl
        resolve(makeResponse(statusCode, headers, new Uint8Array(0), false))
      })
    })

    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let total = 0
      let truncated = false

      response.on('data', (chunk: Buffer) => {
        if (settled) return
        if (total >= maxBytes) return
        // Surfaced before the cap check so a streaming caller sees every byte
        // the transport accepted, including the final partial one.
        options.onChunk?.(chunk)
        const room = maxBytes - total
        if (chunk.byteLength > room) {
          chunks.push(chunk.subarray(0, room))
          total = maxBytes
          truncated = true
          // Stop pulling: there is no reason to keep receiving a body we are
          // going to discard, and a hostile server may never stop sending.
          try {
            request.abort()
          } catch {
            // Already finished.
          }
          finish(() =>
            resolve(
              makeResponse(response.statusCode, response.headers, Buffer.concat(chunks), true)
            )
          )
          return
        }
        chunks.push(chunk)
        total += chunk.byteLength
      })

      response.on('end', () => {
        finish(() =>
          resolve(
            makeResponse(response.statusCode, response.headers, Buffer.concat(chunks), truncated)
          )
        )
      })

      response.on('error', (err: Error) => finish(() => reject(err)))
      response.on('aborted', () =>
        // An abort we caused after hitting the cap has already resolved; this
        // only matters when the peer went away mid-body.
        finish(() => reject(new Error('The connection was closed before the response completed.')))
      )
    })

    request.on('error', (err) => finish(() => reject(err)))
    request.on('abort', () => {
      // Only surfaces when nothing else settled first (timeout/cap/signal all do).
      finish(() => reject(new Error('The request was aborted.')))
    })

    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}
