import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import type { ShellSpec } from './types'

/**
 * Running a shell command for the agent (v3.0).
 *
 * A login shell on macOS and Linux (`-lc`), because an app started from the
 * Dock inherits a PATH with no npm, no pyenv and no cargo in it, and a test
 * command that cannot find its runner is the agent's most confusing failure.
 * On Windows, Git Bash when it is installed — models write POSIX commands far
 * more reliably than cmd.exe syntax — and cmd.exe otherwise; the prompt names
 * whichever it is so the model writes for it.
 *
 * Output is capped by keeping the head and the tail: the start of a log says
 * what ran, the end says how it went, and the middle of a 40,000-line build is
 * what nobody reads. Timeout and Stop kill the whole process tree, not just
 * the shell — `npm test` is a shell that started node that started workers.
 */

const HEAD_CHARS = 4_000
const TAIL_CHARS = 14_000

const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`
]

export function defaultShell(): ShellSpec {
  if (process.platform === 'win32') {
    const bash = GIT_BASH_CANDIDATES.find((p) => p && existsSync(p))
    if (bash) return { file: bash, args: ['-lc'], name: 'Git Bash (bash syntax)' }
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], name: 'cmd.exe (Windows command syntax)' }
  }
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash'
  const name = shell.split('/').pop() ?? 'sh'
  return { file: shell, args: ['-lc'], name: `${name} (POSIX shell syntax)` }
}

export interface CommandResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  aborted: boolean
  ms: number
  /** Characters dropped from the middle of the output. */
  elided: number
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

/**
 * The environment a command runs in: the host's, less what belongs to the
 * host's own process. NODE_TEST_CONTEXT is set by Node's test runner for the
 * files it runs; a `node --test` started beneath one inherits it, reports to a
 * parent that is not listening, and exits 0 whatever its tests did — measured
 * when the agent eval's own tests first ran a fixture's failing suite.
 */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.NODE_TEST_CONTEXT === undefined) return env
  const own = { ...env }
  delete own.NODE_TEST_CONTEXT
  return own
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 2_000).unref()
}

export function runCommand(
  command: string,
  cwd: string,
  shell: ShellSpec,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CommandResult> {
  const startedAt = Date.now()
  return new Promise((resolvePromise) => {
    const isCmd = /cmd(?:\.exe)?$/i.test(shell.file)
    // cmd.exe needs Node's own quoting of `/s /c "…"`; every other shell takes
    // the command as one argument after its flags.
    const env = commandEnv()
    const child = isCmd
      ? spawn(command, { cwd, shell: shell.file, env, windowsHide: true })
      : spawn(shell.file, [...shell.args, command], {
          cwd,
          env,
          windowsHide: true,
          detached: process.platform !== 'win32'
        })

    let head = ''
    let tail = ''
    let total = 0
    const take = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      total += text.length
      if (head.length < HEAD_CHARS) {
        const room = HEAD_CHARS - head.length
        head += text.slice(0, room)
        tail += text.slice(room)
      } else tail += text
      if (tail.length > TAIL_CHARS * 2) tail = tail.slice(-TAIL_CHARS)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)

    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      killTree(child)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    let settled = false
    const finish = (exitCode: number | null, spawnError?: Error): void => {
      // 'error' and 'close' can both fire for one child; the first one wins.
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS)
      const kept = head.length + tail.length
      const elided = Math.max(0, total - kept)
      const body = elided > 0 ? `${head}\n… [${elided.toLocaleString('en-US')} characters of output omitted] …\n${tail}` : head + tail
      resolvePromise({
        exitCode,
        output: (spawnError ? `Could not start the shell (${shell.file}): ${spawnError.message}` : body).replace(ANSI, '').replace(/\r\n/g, '\n').trimEnd(),
        timedOut,
        aborted,
        ms: Date.now() - startedAt,
        elided
      })
    }
    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(code))
  })
}
