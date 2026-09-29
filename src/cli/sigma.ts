import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { createInterface, type Interface } from 'readline'
import { runAgentTask, DEFAULT_MAX_ROUNDS } from '../main/agent/engine'
import { restoreCheckpoints } from '../main/agent/checkpoints'
import { fetchTransport } from '../main/agent/stream'
import { defaultShell } from '../main/agent/command'
import { expandCommand, loadCommands } from '../main/agent/commands'
import { selectRecipe } from '../main/agent/recipes'
import type { AgentEvent, AgentHost, Checkpoint, CommandApproval, EditReview, PermissionMode, TodoItem } from '../main/agent/types'
import type { ApiMessage } from '../renderer/src/lib/agentLoop'
import { describeStep } from '../renderer/src/lib/agentTurn'

/**
 * `sigma` — the agent in a terminal (v3.0).
 *
 * The same engine the app runs (src/main/agent), on plain Node: in a packaged
 * install the launcher runs it on the app's own runtime (ELECTRON_RUN_AS_NODE),
 * so nothing else needs installing. It reads the app's settings for the
 * server and the model, so nothing is configured twice, and it talks to
 * LM Studio on this machine and nothing else — no web tools, no telemetry;
 * a non-loopback server address is refused, as the app refuses one.
 *
 *   sigma                      interactive, in the current folder
 *   sigma -p "fix the tests"   one task, then exit (status in the exit code)
 *   sigma --help               everything else
 */

/** Stamped in by scripts/build-cli.mjs; read from package.json when run unbundled. */
declare const __SIGMA_VERSION__: string | undefined
const VERSION: string =
  typeof __SIGMA_VERSION__ === 'string'
    ? __SIGMA_VERSION__
    : (() => {
        try {
          return (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '3'
        } catch {
          return '3'
        }
      })()

// ---- output ------------------------------------------------------------------

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = paint('2')
const bold = paint('1')
const cyan = paint('36')
const green = paint('32')
const red = paint('31')
const yellow = paint('33')

const NL = String.fromCharCode(10)
let onInterrupt: (() => void) | null = null
let interruptInstalled = false

/** Where output goes: the terminal, or — in the check suite — a buffer. */
export interface CliIO {
  out: (s: string) => void
  err: (s: string) => void
}
const terminalIO: CliIO = {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s)
}
let io: CliIO = terminalIO

function write(s: string): void {
  io.out(s)
}

function fail(s: string): void {
  io.err(s)
}

// ---- configuration ---------------------------------------------------------

interface AppSettingsLike {
  baseUrl?: string
  models?: { id?: string; modelId?: string; enabled?: boolean; specialty?: string; rules?: string }[]
  agent?: { maxRounds?: number; commandTimeoutSec?: number; defaultPermission?: PermissionMode; experiments?: Record<string, boolean> }
}

/** Where electron-store keeps the app's settings on this platform (SIGMA_CONFIG overrides it). */
export function appConfigPath(): string {
  if (process.env.SIGMA_CONFIG) return process.env.SIGMA_CONFIG
  const name = 'Sigma Oasis'
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name, 'config.json')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name, 'config.json')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), name, 'config.json')
}

function readAppSettings(): AppSettingsLike {
  try {
    const raw = JSON.parse(readFileSync(appConfigPath(), 'utf8')) as { settings?: AppSettingsLike }
    return raw.settings ?? {}
  } catch {
    return {}
  }
}

export function isLoopback(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

async function firstChatModel(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`)
    const data = (await res.json()) as { data?: { id: string }[] }
    return data.data?.map((m) => m.id).find((id) => !/embed/i.test(id) && !id.startsWith('_disabled')) ?? null
  } catch {
    return null
  }
}

// ---- arguments -------------------------------------------------------------

export interface CliOptions {
  prompt: string | null
  model: string | null
  cwd: string
  noFolder: boolean
  permission: PermissionMode | null
  baseUrl: string | null
  maxRounds: number | null
  json: boolean
  help: boolean
  version: boolean
}

const MODE_ALIASES: Record<string, PermissionMode> = {
  ask: 'ask',
  'accept-edits': 'acceptEdits',
  acceptedits: 'acceptEdits',
  accept: 'acceptEdits',
  'read-only': 'readOnly',
  readonly: 'readOnly',
  plan: 'readOnly'
}

export function parseArgs(argv: string[]): CliOptions | { error: string } {
  const o: CliOptions = { prompt: null, model: null, cwd: process.cwd(), noFolder: false, permission: null, baseUrl: null, maxRounds: null, json: false, help: false, version: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string | undefined => argv[++i]
    switch (a) {
      case '-p':
      case '--print':
      case '--prompt': {
        const v = next()
        if (!v) return { error: `${a} needs the task, e.g. sigma -p "fix the failing test"` }
        o.prompt = v
        break
      }
      case '-m':
      case '--model': {
        const v = next()
        if (!v) return { error: '--model needs a model id' }
        o.model = v
        break
      }
      case '-C':
      case '--cwd':
      case '--folder': {
        const v = next()
        if (!v) return { error: `${a} needs a folder` }
        o.cwd = isAbsolute(v) ? v : resolve(v)
        break
      }
      case '--mode': {
        const v = MODE_ALIASES[(next() ?? '').toLowerCase()]
        if (!v) return { error: '--mode is one of: ask, accept-edits, read-only' }
        o.permission = v
        break
      }
      case '--accept-edits':
        o.permission = 'acceptEdits'
        break
      case '--read-only':
        o.permission = 'readOnly'
        break
      case '--no-folder':
        o.noFolder = true
        break
      case '--base-url': {
        const v = next()
        if (!v) return { error: '--base-url needs a URL' }
        o.baseUrl = v
        break
      }
      case '--max-rounds': {
        const n = Number(next())
        if (!Number.isFinite(n) || n < 1) return { error: '--max-rounds needs a positive number' }
        o.maxRounds = Math.floor(n)
        break
      }
      case '--json':
        o.json = true
        break
      case '-h':
      case '--help':
        o.help = true
        break
      case '-v':
      case '--version':
        o.version = true
        break
      default:
        if (a.startsWith('-')) return { error: `Unknown option ${a}. Try sigma --help.` }
        rest.push(a)
    }
  }
  if (!o.prompt && rest.length > 0) o.prompt = rest.join(' ')
  return o
}

const HELP = `sigma — the Sigma Oasis agent, in your terminal

Usage
  sigma                         work interactively in the current folder
  sigma "task"  |  sigma -p "task"   do one task, then exit

Options
  -m, --model <id>              LM Studio model (default: the app's agent/coding slot)
  -C, --cwd <folder>            work in this folder (default: the current one)
      --mode <ask|accept-edits|read-only>
      --accept-edits            edits land without asking (commands still ask)
      --read-only               look, don't touch: no edits, no commands
      --no-folder               no files at all
      --max-rounds <n>          steps before a task pauses (default ${DEFAULT_MAX_ROUNDS})
      --base-url <url>          LM Studio's address (must be on this machine)
      --json                    one JSON event per line, for scripts
  -v, --version                 print the version
  -h, --help                    this

In a session
  /mode ask|accept-edits|read-only   /model <id>   /undo   /clear   /help   /exit
  Type while a task works to add a note it reads at its next step. Ctrl+C stops a task.

Privacy: talks only to LM Studio on this machine. Reads the app's settings
(${appConfigPath()}) for the server and model.`

// ---- the session -----------------------------------------------------------

const PERMISSION_WORDS: Record<PermissionMode, string> = {
  ask: 'asks before each change and command',
  acceptEdits: 'edits without asking, commands ask',
  readOnly: 'read-only'
}

/**
 * One line of input at a time, for whoever is waiting: an approval question
 * takes the next line; otherwise a line is a task (or, while one runs, a note
 * for it).
 */
class Terminal {
  private waiting: ((line: string) => void) | null = null
  private onLine: ((line: string) => void) | null = null
  readonly rl: Interface
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    this.rl.on('line', (line) => {
      if (this.waiting) {
        const w = this.waiting
        this.waiting = null
        w(line)
      } else this.onLine?.(line)
    })
  }
  listen(fn: (line: string) => void): void {
    this.onLine = fn
  }
  ask(question: string): Promise<string> {
    write(question)
    return new Promise((res) => (this.waiting = res))
  }
  prompt(): void {
    write(cyan('› '))
  }
}

function printDiff(diff: string): void {
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) write(`${dim(line)}\n`)
    else if (line.startsWith('@@')) write(`${cyan(line)}\n`)
    else if (line.startsWith('+')) write(`${green(line)}\n`)
    else if (line.startsWith('-')) write(`${red(line)}\n`)
    else write(`${line}\n`)
  }
}

function printTodos(todos: TodoItem[]): void {
  const done = todos.filter((t) => t.status === 'completed').length
  write(`${dim(`  checklist ${done}/${todos.length}`)}\n`)
  for (const t of todos) {
    const mark = t.status === 'completed' ? green('☑') : t.status === 'in_progress' ? cyan('◐') : dim('☐')
    write(`   ${mark} ${t.status === 'completed' ? dim(t.content) : t.content}\n`)
  }
}

export async function main(argv: string[], output: CliIO = terminalIO): Promise<number> {
  io = output
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    fail(`${parsed.error}\n`)
    return 2
  }
  const o = parsed
  if (o.help) {
    write(`${HELP}\n`)
    return 0
  }
  if (o.version) {
    write(`sigma ${VERSION}\n`)
    return 0
  }

  const app = readAppSettings()
  const baseUrl = o.baseUrl ?? app.baseUrl ?? 'http://127.0.0.1:1234/v1'
  if (!isLoopback(baseUrl)) {
    fail(`Refusing ${baseUrl}: sigma talks only to a model server on this machine (localhost / 127.0.0.1).\n`)
    return 2
  }
  const enabled = (app.models ?? []).filter((m) => m.enabled && m.modelId)
  const slot = enabled.find((m) => m.specialty === 'coding') ?? enabled[0]
  const model = o.model ?? slot?.modelId ?? (await firstChatModel(baseUrl))
  if (!model) {
    fail(`No model to use. Is LM Studio running at ${baseUrl}? Load a model, or pass --model <id>.\n`)
    return 1
  }
  if (!o.noFolder && !existsSync(o.cwd)) {
    fail(`No such folder: ${o.cwd}\n`)
    return 2
  }
  let permission: PermissionMode = o.permission ?? app.agent?.defaultPermission ?? 'ask'
  let currentModel = model
  const workspace = o.noFolder ? null : o.cwd
  const maxRounds = o.maxRounds ?? app.agent?.maxRounds ?? DEFAULT_MAX_ROUNDS
  const commandTimeoutSec = app.agent?.commandTimeoutSec ?? 120
  const shell = defaultShell()
  const interactive = !o.prompt && Boolean(process.stdin.isTTY)
  const term = new Terminal()
  /** Session-wide "always": commands approved for the rest of this session. */
  const alwaysCommands = new Set<string>()
  let history: ApiMessage[] = []
  let lastCheckpoints: Checkpoint[] = []
  /** v4.0 (A9): the worktree the last turn worked in, carried to the next. */
  let lastWorktree: { path: string; branch: string } | undefined
  let controller: AbortController | null = null
  const steers: { id: string; text: string }[] = []

  const header = (): void => {
    if (o.json) return
    write(`${bold('sigma')} ${dim(VERSION)} · ${cyan(currentModel)} · ${workspace ? workspace : dim('no folder')}\n`)
    write(dim(`${PERMISSION_WORDS[permission]} · shell: ${shell.name} · LM Studio at ${baseUrl}\n`))
  }

  const host = (): AgentHost => {
    let text = ''
    let thinkingSince = 0
    let spinner: ReturnType<typeof setInterval> | null = null
    const stopSpinner = (): void => {
      if (spinner) {
        clearInterval(spinner)
        spinner = null
        if (process.stdout.isTTY) write('\r\x1b[K')
      }
    }
    const startSpinner = (): void => {
      if (o.json || !process.stdout.isTTY || spinner) return
      thinkingSince = Date.now()
      spinner = setInterval(() => write(`\r\x1b[K${dim(`  thinking… ${Math.round((Date.now() - thinkingSince) / 1000)}s`)}`), 1000)
    }
    return {
      transport: fetchTransport,
      shell,
      emit: (e: AgentEvent) => {
        if (o.json) {
          write(`${JSON.stringify(e)}\n`)
          return
        }
        switch (e.type) {
          case 'reasoning':
            startSpinner()
            break
          case 'text':
            stopSpinner()
            text += e.delta
            write(e.delta)
            break
          case 'tool_start': {
            stopSpinner()
            if (text && !text.endsWith('\n')) write('\n')
            text = ''
            const d = describeStep(e.record)
            write(`${e.record.parentCallId ? '    ' : '  '}${dim('⏺')} ${d.text}\n`)
            break
          }
          case 'tool_end': {
            if (e.record.status === 'error') {
              const first = (e.record.result ?? '').split('\n').slice(0, e.record.name === 'run_command' ? 12 : 3).join('\n')
              write(`${e.record.parentCallId ? '      ' : '    '}${yellow(first)}\n`)
            } else if (e.record.name === 'run_command') {
              const lines = (e.record.result ?? '').split('\n')
              write(dim(`${lines.slice(1, 7).map((l) => `    ${l}`).join('\n')}${lines.length > 8 ? '\n    …' : ''}\n    ${lines[lines.length - 1] ?? ''}\n`))
            }
            startSpinner()
            break
          }
          case 'todos':
            printTodos(e.todos)
            break
          case 'context_elided':
            write(dim(`  (set aside ${e.toolResults} old tool result${e.toolResults === 1 ? '' : 's'} to fit the model's window)\n`))
            break
          case 'steer_delivered':
            write(dim('  (your note reached the agent)\n'))
            break
          case 'question':
            stopSpinner()
            write(`\n${bold('The agent asks:')} ${e.question}${e.choices.length > 0 ? dim(`  [${e.choices.join(' / ')}]`) : ''}\n${dim('Your next line is the answer.')}\n`)
            break
          case 'status':
            stopSpinner()
            break
          default:
            break
        }
      },
      reviewEdit: async (r: EditReview): Promise<boolean> => {
        if (o.json || !interactive) {
          // Nobody to ask: a one-shot run applies only in accept-edits mode,
          // which never reaches this; anything else is declined, and said.
          fail(`Declined an edit to ${r.path}: no one to ask (use --accept-edits to allow edits in a one-shot run).\n`)
          return false
        }
        write(`\n${bold(`Change to ${r.path}`)} ${dim(`(${r.isNew ? 'new file' : `+${r.stats.added} −${r.stats.removed}`})`)}\n`)
        printDiff(r.diff)
        for (;;) {
          const a = (await term.ask(`${bold('Apply?')} [y]es / [n]o / [a]ccept all edits this session: `)).trim().toLowerCase()
          if (a === 'y' || a === 'yes') return true
          if (a === 'n' || a === 'no') return false
          if (a === 'a') {
            permission = 'acceptEdits'
            write(dim('  Edits will land without asking for the rest of this session (commands still ask).\n'))
            return true
          }
        }
      },
      approveCommand: async ({ command, cwd, warning }): Promise<CommandApproval> => {
        if (alwaysCommands.has(`${cwd}\n${command}`)) return 'granted'
        if (o.json || !interactive) {
          fail(`Declined a command (no one to ask in a one-shot run): ${command}\n`)
          return 'declined'
        }
        write(`\n${warning ? red(warning) : bold('Run this command?')}\n  ${cyan(command)}\n  ${dim(`in ${cwd}`)}\n`)
        for (;;) {
          const a = (await term.ask(`[y]es / [n]o / [a]lways this command this session: `)).trim().toLowerCase()
          if (a === 'y' || a === 'yes') return 'once'
          if (a === 'n' || a === 'no') return 'declined'
          if (a === 'a') {
            alwaysCommands.add(`${cwd}\n${command}`)
            return 'once'
          }
        }
      }
    }
  }

  const runTask = async (prompt: string): Promise<number> => {
    controller = new AbortController()
    // C7 (v4.0, an experiment): a leading /name is a slash command from the folder's .sigma/commands.
    if (app.agent?.experiments?.commands && workspace && /^\/[a-z0-9]/i.test(prompt.trim())) {
      const { text, command } = expandCommand(prompt, await loadCommands(workspace, null))
      if (command) {
        write(dim(`  (/${command.name}: ${command.summary})\n`))
        prompt = text
      }
    }
    // C3 (v4.0, an experiment): the shipped recipes; a skill's agent.md is the app's to match.
    const recipe = app.agent?.experiments?.recipes ? selectRecipe(prompt) : null
    if (recipe) write(dim(`  (recipe: ${recipe.name})\n`))
    const result = await runAgentTask(
      {
        baseUrl,
        model: currentModel,
        workspace,
        permission,
        prompt,
        history,
        rules: slot?.rules,
        maxRounds,
        commandTimeoutSec,
        experiments: app.agent?.experiments,
        worktree: lastWorktree,
        ...(recipe ? { recipe: { name: recipe.name, text: recipe.text } } : {}),
        signal: controller.signal,
        takeSteers: () => steers.splice(0)
      },
      host()
    )
    controller = null
    history = result.history
    if (result.worktree) lastWorktree = result.worktree
    if (result.checkpoints.length > 0) lastCheckpoints = result.checkpoints
    if (o.json) {
      write(`${JSON.stringify({ type: 'final', status: result.status, finalText: result.finalText, changedFiles: result.changedFiles, detail: result.detail })}\n`)
    } else {
      if (!result.finalText.endsWith('\n')) write('\n')
      const tone = result.status === 'done' ? green : result.status === 'error' ? red : yellow
      const files = result.changedFiles.length > 0 ? ` · changed ${result.changedFiles.join(', ')}` : ''
      write(`${tone(`● ${result.status}`)}${dim(files)}${result.detail ? `\n${yellow(result.detail)}` : ''}\n`)
    }
    return result.status === 'done' ? 0 : result.status === 'paused' ? 3 : 1
  }

  const undo = async (): Promise<void> => {
    if (!workspace || lastCheckpoints.length === 0) {
      write(dim('Nothing to undo.\n'))
      return
    }
    const { restored, skipped } = await restoreCheckpoints(workspace, lastCheckpoints)
    for (const path of restored) write(`  restored ${path}\n`)
    for (const s of skipped) write(yellow(`  left ${s.path} — ${s.reason}\n`))
    lastCheckpoints = []
    history = []
    write(dim('Undone. The next task starts fresh.\n'))
  }

  // Ctrl+C stops the running task; with none running, it leaves. One process
  // listener for the life of the process, pointed at the current session.
  onInterrupt = (): void => {
    if (controller) {
      write(yellow(`${NL}  stopping…${NL}`))
      controller.abort()
    } else {
      write(NL)
      process.exit(0)
    }
  }
  if (!interruptInstalled) {
    interruptInstalled = true
    process.on('SIGINT', () => onInterrupt?.())
  }

  header()
  if (o.prompt) {
    const code = await runTask(o.prompt)
    term.rl.close()
    return code
  }
  if (!interactive) {
    fail('No task given. Run sigma "your task", or run sigma in a terminal for a session.\n')
    term.rl.close()
    return 2
  }

  write(dim('What should I do? (/help for commands)\n'))
  term.prompt()
  return await new Promise<number>((finish) => {
    term.listen((raw) => {
      const line = raw.trim()
      if (controller) {
        if (line) {
          steers.push({ id: String(Date.now()), text: line })
          write(dim('  (noted — the agent reads it at its next step)\n'))
        }
        return
      }
      if (!line) return term.prompt()
      if (line.startsWith('/')) {
        const [cmd, ...args] = line.slice(1).split(/\s+/)
        if (cmd === 'exit' || cmd === 'quit') {
          term.rl.close()
          finish(0)
          return
        }
        if (cmd === 'help') write(`${HELP}\n`)
        else if (cmd === 'mode') {
          const m = MODE_ALIASES[(args[0] ?? '').toLowerCase()]
          if (m) {
            permission = m
            write(dim(`Now: ${PERMISSION_WORDS[m]}.\n`))
          } else write(dim('Modes: ask, accept-edits, read-only\n'))
        } else if (cmd === 'model') {
          if (args[0]) {
            currentModel = args[0]
            write(dim(`Model: ${currentModel}\n`))
          } else write(dim(`Model: ${currentModel}\n`))
        } else if (cmd === 'clear') {
          history = []
          write(dim('Fresh start: the next task does not see this conversation.\n'))
        } else if (cmd === 'undo') {
          void undo().then(() => term.prompt())
          return
        } else write(dim(`Unknown command /${cmd}. /help lists them.\n`))
        term.prompt()
        return
      }
      void runTask(line).then(() => term.prompt())
    })
    term.rl.on('close', () => finish(0))
  })
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => process.exit(code))
}
