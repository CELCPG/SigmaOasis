/**
 * The stdio transport for an MCP server (v2.5).
 *
 * One server is one child process. Its stdout carries newline-delimited
 * JSON-RPC messages and nothing else; its stdin takes ours; its stderr is
 * free-form logging the spec says a client must not read as an error
 * signal — it goes to a ring buffer the Settings panel can show. Framing is
 * the only protocol knowledge here: what a line means belongs to client.ts.
 *
 * Shutdown is the spec's sequence: close stdin, wait, SIGTERM, wait, SIGKILL.
 * An unexpected exit is reported, never hidden; whether to restart is the
 * manager's decision, made with a per-outage budget, not this file's.
 *
 * Node only (child_process) — no Electron import, so the node suite drives it
 * against a stub server.
 */
import { spawn, type ChildProcess } from 'child_process'

export interface TransportOptions {
  command: string
  args?: readonly string[]
  env?: Record<string, string>
  cwd?: string
  /** Lines of stderr kept for the panel. */
  stderrLines?: number
  onMessage: (message: unknown) => void
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void
  /** A stdout line that was not JSON — reported, never fatal. */
  onGarbage?: (line: string) => void
}

export interface Transport {
  send: (message: unknown) => void
  /** The last N stderr lines, oldest first. */
  stderr: () => string[]
  readonly pid: number | undefined
  readonly alive: boolean
  /** The spec's shutdown sequence. Resolves once the process is gone. */
  close: (graceMs?: number) => Promise<void>
}

const DEFAULT_STDERR_LINES = 200
const DEFAULT_GRACE_MS = 2000

export function spawnTransport(options: TransportOptions): Transport {
  const child: ChildProcess = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    // Only the named variables travel on top of the parent's environment. Values
    // never appear in a log line — the install confirmation shows names only.
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  let alive = true
  let expected = false
  let outBuffer = ''
  const errLines: string[] = []
  const maxErr = options.stderrLines ?? DEFAULT_STDERR_LINES

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    outBuffer += chunk
    let nl = outBuffer.indexOf('\n')
    while (nl !== -1) {
      const line = outBuffer.slice(0, nl).replace(/\r$/, '')
      outBuffer = outBuffer.slice(nl + 1)
      nl = outBuffer.indexOf('\n')
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        options.onGarbage?.(line)
        continue
      }
      options.onMessage(parsed)
    }
  })

  child.stderr?.setEncoding('utf8')
  let errBuffer = ''
  child.stderr?.on('data', (chunk: string) => {
    errBuffer += chunk
    let nl = errBuffer.indexOf('\n')
    while (nl !== -1) {
      errLines.push(errBuffer.slice(0, nl))
      if (errLines.length > maxErr) errLines.splice(0, errLines.length - maxErr)
      errBuffer = errBuffer.slice(nl + 1)
      nl = errBuffer.indexOf('\n')
    }
  })

  let resolveExited: () => void = () => undefined
  const exited = new Promise<void>((r) => {
    resolveExited = r
  })
  let reported = false
  const gone = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (reported) return
    reported = true
    alive = false
    options.onExit({ code, signal, expected })
    resolveExited()
  }

  child.on('error', (err) => {
    // A spawn failure (ENOENT, EACCES) never starts a process, so Node emits
    // `error` and no `exit`. It is reported as an exit with no code, and the
    // message rides the stderr ring so the panel can say why.
    errLines.push(`[spawn] ${err.message}`)
    if (child.pid === undefined) gone(null, null)
  })
  child.on('exit', (code, signal) => gone(code, signal))

  const send = (message: unknown): void => {
    if (!alive || !child.stdin || child.stdin.destroyed) return
    // One message per line, never an embedded newline: JSON.stringify escapes
    // them inside strings, so the frame boundary cannot be forged by content.
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const wait = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (!alive) return resolve(true)
      const t = setTimeout(() => resolve(!alive), ms)
      void exited.then(() => {
        clearTimeout(t)
        resolve(true)
      })
    })

  const close = async (graceMs = DEFAULT_GRACE_MS): Promise<void> => {
    if (!alive) return
    expected = true
    try {
      child.stdin?.end()
    } catch {
      // already closed
    }
    if (await wait(graceMs)) return
    try {
      child.kill('SIGTERM')
    } catch {
      // gone between the check and the signal
    }
    if (await wait(graceMs)) return
    try {
      child.kill('SIGKILL')
    } catch {
      // gone
    }
    await wait(graceMs)
  }

  return {
    send,
    stderr: () => [...errLines],
    get pid() {
      return child.pid
    },
    get alive() {
      return alive
    },
    close
  }
}
