import { promises as fs } from 'fs'
import { dirname } from 'path'
import { describeStats, unifiedDiff } from '../../shared/patch'
import { declinedCall } from '../../shared/tools/outcomes'
import { dangerousCommandWarning } from '../../shared/commandDanger'
import { applyEdit } from './editMatch'
import { runCommand } from './command'
import {
  assertWritableInside,
  globToRegExp,
  IGNORED_DIRS,
  looksBinary,
  relPath,
  resolveInside,
  walkFiles,
  WorkspaceError
} from './workspace'
import type { AgentHost, Checkpoint, PermissionMode, ShellSpec, SubagentType, TodoItem, ToolResult, ToolSchema } from './types'

/**
 * The agent's workspace tools (v3.0): find, read, change, run, keep a list.
 *
 * The names and shapes follow the agentic CLIs local models were trained
 * against (read_file / edit_file / write_file / glob / grep / run_command /
 * todo_write / task), and the descriptions are written for a 9–35B model:
 * short, imperative, and saying what comes back. Every path is held to the
 * workspace (./workspace.ts); every change is a diff the reader can see and,
 * unless the task was started with "Accept edits", has to approve; every
 * command asks; a file is checkpointed before its first change so the task
 * can be undone.
 */

export const READ_DEFAULT_LINES = 400
const READ_MAX_BYTES = 5 * 1024 * 1024
const READ_LINE_CHARS = 1_000
const GLOB_MAX = 200
const GREP_MAX_MATCHES = 120
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024
const LIST_MAX = 300

/** Tools that change the workspace or run something; not offered read-only. */
export const WRITING_TOOLS = new Set(['edit_file', 'write_file', 'run_command'])

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSchema => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
})

export function workspaceToolSchemas(shell: ShellSpec, commandTimeoutSec: number): ToolSchema[] {
  return [
    fn(
      'list_directory',
      'List a folder in the workspace: sub-folders first (ending in /), then files with their sizes.',
      { path: { type: 'string', description: 'Folder path relative to the workspace; omit for the workspace root.' } }
    ),
    fn(
      'glob',
      'Find files by name pattern. `**` matches across folders (`src/**/*.test.ts`); a pattern with no slash, like `*.py`, matches file names at any depth. Newest first, up to 200. Skips node_modules, .git, build output.',
      {
        pattern: { type: 'string', description: 'Glob pattern.' },
        path: { type: 'string', description: 'Folder to search under; omit for the whole workspace.' }
      },
      ['pattern']
    ),
    fn(
      'grep',
      'Search file contents with a regular expression. Returns `path:line: text` for each matching line (or just file paths, or counts). Skips binary files and node_modules, .git, build output.',
      {
        pattern: { type: 'string', description: 'Regular expression (JavaScript syntax). Escape literal ( ) [ ] . * + ? with a backslash.' },
        path: { type: 'string', description: 'File or folder to search; omit for the whole workspace.' },
        glob: { type: 'string', description: 'Only search files whose path matches this glob, e.g. `*.ts`.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Default: content.' },
        context: { type: 'number', description: 'Lines of context around each match (0-5). Default 0.' }
      },
      ['pattern']
    ),
    fn(
      'read_file',
      `Read a text file. Each line comes back numbered like \`   12\\tcode\` — the number and tab are NOT part of the file; never copy them into edit_file. Up to ${READ_DEFAULT_LINES} lines per call; pass offset (the first line to read, from 1) and limit for other parts of a long file.`,
      {
        path: { type: 'string', description: 'File path relative to the workspace.' },
        offset: { type: 'number', description: 'First line to read, starting at 1.' },
        limit: { type: 'number', description: `How many lines to read (default ${READ_DEFAULT_LINES}).` }
      },
      ['path']
    ),
    fn(
      'edit_file',
      'Change part of a file by exact replacement. old_string must be copied exactly from the file (without read_file line numbers), including indentation, and must occur exactly once — add surrounding lines until it is unique — unless replace_all is true. Read the file first. The user sees the diff.',
      {
        path: { type: 'string', description: 'File path relative to the workspace.' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'The text to put in its place.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one.' }
      },
      ['path', 'old_string', 'new_string']
    ),
    fn(
      'write_file',
      'Create a new file, or replace the whole content of an existing one (read it first). For changes to part of an existing file use edit_file instead. The user sees the diff.',
      {
        path: { type: 'string', description: 'File path relative to the workspace.' },
        content: { type: 'string', description: 'The complete file content.' }
      },
      ['path', 'content']
    ),
    fn(
      'run_command',
      `Run a shell command with ${shell.name}. It already runs in the workspace folder — no need to cd there. The user approves each command before it runs. Returns the combined output and the exit code; very long output keeps its beginning and end. Use it to run tests, builds, linters, git status/diff. Time limit ${commandTimeoutSec} s unless you pass timeout_seconds (max 600).`,
      {
        command: { type: 'string', description: 'The command line to run.' },
        timeout_seconds: { type: 'number', description: 'Time limit in seconds (max 600).' }
      },
      ['command']
    )
  ]
}

export const TODO_SCHEMA: ToolSchema = fn(
  'todo_write',
  'Replace your task checklist, which the user watches live. For any task with three or more steps: write the steps first, keep exactly one "in_progress", and mark each "completed" as soon as it is done. Send the whole list each time.',
  {
    todos: {
      type: 'array',
      description: 'The full checklist.',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The step, in a few words.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
        },
        required: ['content', 'status']
      }
    }
  },
  ['todos']
)

export function taskSchema(types: readonly SubagentType[]): ToolSchema {
  const lines: Record<SubagentType, string> = {
    explore: 'explore — read-only: find where something is, how something works, what calls what',
    review: 'review — read-only second look at changes you made: bugs, missed cases, what to test',
    general: 'general — an independent sub-task; can also edit files and run commands'
  }
  return fn(
    'task',
    'Hand a focused job to a helper agent. It starts with a fresh, empty context, works on its own with its own tools, and returns one report — so a broad search does not fill your context. Types: ' +
      types.map((t) => lines[t]).join('; ') +
      '. Write the prompt as complete, self-contained instructions: the helper sees nothing of this conversation.',
    {
      subagent_type: { type: 'string', enum: [...types] },
      description: { type: 'string', description: 'Three to six words naming the job.' },
      prompt: { type: 'string', description: 'The full instructions for the helper, including what to report back.' }
    },
    ['subagent_type', 'description', 'prompt']
  )
}

/** State a whole task shares — the parent and every helper it starts. */
export interface TaskState {
  checkpoints: Map<string, Checkpoint>
  todos: TodoItem[]
}

export function newTaskState(): TaskState {
  return { checkpoints: new Map(), todos: [] }
}

export interface ToolboxOptions {
  root: string | null
  permission: PermissionMode
  host: AgentHost
  shell: ShellSpec
  commandTimeoutSec: number
  state: TaskState
  signal: AbortSignal
}

/** A tool's answer, with what the record shows when it differs from what the model is handed. */
export type ToolboxResult = ToolResult

/**
 * One agent's hands. The parent and each helper get their own (a helper has
 * not "read" what its parent read), sharing the task's checkpoints and list.
 */
export class Toolbox {
  private readonly readPaths = new Set<string>()

  constructor(private readonly o: ToolboxOptions) {}

  /** The workspace tools this agent may be offered, before todo/task/extra tools. */
  schemas(): ToolSchema[] {
    if (!this.o.root) return []
    const all = workspaceToolSchemas(this.o.shell, this.o.commandTimeoutSec)
    return this.o.permission === 'readOnly' ? all.filter((s) => !WRITING_TOOLS.has(s.function.name)) : all
  }

  has(name: string): boolean {
    return this.schemas().some((s) => s.function.name === name) || name === 'todo_write'
  }

  async execute(name: string, args: Record<string, unknown>, callId: string): Promise<ToolboxResult> {
    try {
      switch (name) {
        case 'list_directory':
          return await this.listDirectory(args)
        case 'glob':
          return await this.glob(args)
        case 'grep':
          return await this.grep(args)
        case 'read_file':
          return await this.readFile(args)
        case 'edit_file':
          return await this.editFile(args, callId)
        case 'write_file':
          return await this.writeFile(args, callId)
        case 'run_command':
          return await this.runCommand(args)
        case 'todo_write':
          return this.todoWrite(args)
        default:
          return { ok: false, error: `Unknown tool "${name}".` }
      }
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, error: err.message }
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { ok: false, error: `No such file or folder: ${String(args.path ?? '')}. Use glob or list_directory to find the right path.` }
      if (code === 'EISDIR') return { ok: false, error: `${String(args.path ?? '')} is a folder; use list_directory.` }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private root(): string {
    if (!this.o.root) throw new WorkspaceError('This task has no workspace folder, so there are no files to work with.')
    return this.o.root
  }

  private async listDirectory(args: Record<string, unknown>): Promise<ToolboxResult> {
    const root = this.root()
    const dir = resolveInside(root, args.path)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort()
    const lines: string[] = []
    for (const d of dirs) lines.push(`${d}/${IGNORED_DIRS.has(d) ? '  (skipped by searches)' : ''}`)
    for (const f of files) {
      if (lines.length >= LIST_MAX) break
      const size = await fs.stat(`${dir}/${f}`).then((s) => s.size).catch(() => null)
      lines.push(size === null ? f : `${f}  ${formatSize(size)}`)
    }
    const more = dirs.length + files.length - lines.length
    return {
      ok: true,
      output: `${relPath(root, dir)}/\n${lines.join('\n') || '(empty folder)'}${more > 0 ? `\n… and ${more} more` : ''}`
    }
  }

  private async glob(args: Record<string, unknown>): Promise<ToolboxResult> {
    const root = this.root()
    const pattern = String(args.pattern ?? '').trim()
    if (!pattern) return { ok: false, error: 'Give a pattern, like "src/**/*.ts" or "*.md".' }
    const start = resolveInside(root, args.path)
    const re = globToRegExp(pattern)
    const hits: string[] = []
    const { truncated } = await walkFiles(start, (abs) => {
      const rel = relPath(start, abs)
      if (re.test(rel)) hits.push(abs)
    })
    const withTimes = await Promise.all(
      hits.map(async (abs) => ({ abs, t: await fs.stat(abs).then((s) => s.mtimeMs).catch(() => 0) }))
    )
    withTimes.sort((a, b) => b.t - a.t)
    const shown = withTimes.slice(0, GLOB_MAX).map((h) => relPath(root, h.abs))
    if (shown.length === 0) return { ok: true, output: `No files match ${pattern}${truncated ? ' (the search stopped early: the folder is very large — narrow it with path)' : ''}.` }
    const notes = [
      withTimes.length > GLOB_MAX ? `${withTimes.length} files match; the ${GLOB_MAX} newest are shown — narrow the pattern.` : '',
      truncated ? 'The search stopped early: the folder is very large. Narrow it with path.' : ''
    ].filter(Boolean)
    return { ok: true, output: [...shown, ...notes].join('\n') }
  }

  private async grep(args: Record<string, unknown>): Promise<ToolboxResult> {
    const root = this.root()
    const source = String(args.pattern ?? '')
    if (!source) return { ok: false, error: 'Give a pattern to search for.' }
    const flags = args.ignore_case === true ? 'i' : ''
    let re: RegExp
    let literalNote = ''
    try {
      re = new RegExp(source, flags)
    } catch {
      // A pattern that is not a valid regex is almost always a literal the
      // model forgot to escape — `foo(` — so search for it as written.
      re = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
      literalNote = ' (the pattern was not a valid regular expression, so it was searched for literally)'
    }
    const mode = args.output_mode === 'files_with_matches' || args.output_mode === 'count' ? args.output_mode : 'content'
    const context = Math.max(0, Math.min(5, Math.floor(Number(args.context) || 0)))
    const filter = typeof args.glob === 'string' && args.glob.trim() ? globToRegExp(args.glob) : null
    const start = resolveInside(root, args.path)
    const stat = await fs.stat(start)
    const files: string[] = []
    let truncated = false
    if (stat.isFile()) files.push(start)
    else {
      ;({ truncated } = await walkFiles(start, (abs) => {
        if (!filter || filter.test(relPath(start, abs))) files.push(abs)
      }))
    }
    files.sort()
    const out: string[] = []
    let matches = 0
    let filesWith = 0
    let capped = false
    for (const abs of files) {
      if (capped) break
      let bytes: Buffer
      try {
        const s = await fs.stat(abs)
        if (s.size > GREP_MAX_FILE_BYTES) continue
        bytes = await fs.readFile(abs)
      } catch {
        continue
      }
      if (looksBinary(bytes)) continue
      const lines = bytes.toString('utf8').split(/\r?\n/)
      const hitLines: number[] = []
      lines.forEach((l, i) => {
        if (re.test(l)) hitLines.push(i)
      })
      if (hitLines.length === 0) continue
      filesWith++
      const rel = relPath(root, abs)
      if (mode === 'files_with_matches') {
        out.push(rel)
        continue
      }
      if (mode === 'count') {
        out.push(`${rel}: ${hitLines.length}`)
        continue
      }
      const shown = new Set<number>()
      for (const i of hitLines) {
        if (matches >= GREP_MAX_MATCHES) {
          capped = true
          break
        }
        matches++
        for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
          if (shown.has(j)) continue
          shown.add(j)
          const text = lines[j]!.length > 240 ? `${lines[j]!.slice(0, 240)}…` : lines[j]!
          out.push(`${rel}:${j + 1}${j === i ? ':' : '-'} ${text}`)
        }
      }
    }
    if (out.length === 0) return { ok: true, output: `No matches for /${source}/${literalNote}.` }
    const notes = [
      literalNote ? `Note${literalNote}.` : '',
      capped ? `Stopped at ${GREP_MAX_MATCHES} matches — narrow the pattern, path or glob.` : '',
      truncated ? 'The search stopped early: the folder is very large. Narrow it with path.' : '',
      mode === 'content' ? `${matches} match${matches === 1 ? '' : 'es'} in ${filesWith} file${filesWith === 1 ? '' : 's'}.` : ''
    ].filter(Boolean)
    return { ok: true, output: [...out, ...notes].join('\n') }
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolboxResult> {
    const root = this.root()
    const abs = resolveInside(root, args.path)
    const s = await fs.stat(abs)
    if (s.isDirectory()) return { ok: false, error: `${relPath(root, abs)} is a folder; use list_directory.` }
    if (s.size > READ_MAX_BYTES) return { ok: false, error: `${relPath(root, abs)} is ${formatSize(s.size)} — too large to read whole. Use grep to find the part you need.` }
    const bytes = await fs.readFile(abs)
    if (looksBinary(bytes)) return { ok: false, error: `${relPath(root, abs)} is a binary file (${formatSize(s.size)}); it cannot be read as text.` }
    this.readPaths.add(abs)
    const text = bytes.toString('utf8')
    if (text === '') return { ok: true, output: `${relPath(root, abs)} is empty.` }
    const lines = text.split(/\r?\n/)
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
    const limit = Math.max(1, Math.min(2_000, Math.floor(Number(args.limit) || READ_DEFAULT_LINES)))
    if (offset > lines.length) return { ok: false, error: `${relPath(root, abs)} has only ${lines.length} lines.` }
    const end = Math.min(lines.length, offset - 1 + limit)
    const width = String(end).length
    const body = lines
      .slice(offset - 1, end)
      .map((l, i) => `${String(offset + i).padStart(Math.max(5, width))}\t${l.length > READ_LINE_CHARS ? `${l.slice(0, READ_LINE_CHARS)}… [line cut]` : l}`)
      .join('\n')
    const more = end < lines.length ? `\n(lines ${offset}–${end} of ${lines.length}; read on with offset ${end + 1})` : offset > 1 ? `\n(lines ${offset}–${end} of ${lines.length})` : ''
    return { ok: true, output: `${body}${more}` }
  }

  /** The approval-and-write half shared by edit_file and write_file. */
  private async commit(abs: string, original: string | null, next: string, callId: string, verb: 'Edited' | 'Wrote'): Promise<ToolboxResult> {
    const root = this.root()
    const rel = relPath(root, abs)
    await assertWritableInside(root, abs)
    const isNew = original === null
    const { diff, stats } = unifiedDiff(original ?? '', next, rel)
    const summary = describeStats(stats, isNew)
    const approved = this.o.permission === 'acceptEdits' ? true : await this.o.host.reviewEdit({ callId, path: rel, isNew, diff, stats })
    if (this.o.signal.aborted) return { ok: false, error: declinedCall('the task was stopped before this change was written, so nothing changed.') }
    if (!approved) {
      const error = declinedCall(
        `the user discarded this change to ${rel}, so the file is unchanged.`,
        'Do not propose the same change again; ask what they want instead, or take a different approach.'
      )
      return { ok: false, error, display: `${error}\n\n${diff}` }
    }
    // Checkpoint before the first change this task makes to the file.
    if (!this.o.state.checkpoints.has(rel)) this.o.state.checkpoints.set(rel, { path: rel, before: original, after: null })
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, next, 'utf8')
    this.o.state.checkpoints.get(rel)!.after = next
    this.readPaths.add(abs)
    this.o.host.emit({ type: 'files_changed', paths: [...this.o.state.checkpoints.keys()] })
    return {
      ok: true,
      output: `${verb} ${rel}: ${summary}.`,
      display: `Applied to ${rel}: ${summary}.\n\n${diff}`
    }
  }

  private async editFile(args: Record<string, unknown>, callId: string): Promise<ToolboxResult> {
    const root = this.root()
    const abs = resolveInside(root, args.path)
    let original: string
    try {
      original = await fs.readFile(abs, 'utf8')
    } catch {
      return { ok: false, error: `${relPath(root, abs)} does not exist. To create it, use write_file.` }
    }
    if (!this.readPaths.has(abs)) {
      return { ok: false, error: `Read ${relPath(root, abs)} with read_file before editing it, so the change is made against what the file actually says.` }
    }
    const match = applyEdit(original, String(args.old_string ?? ''), String(args.new_string ?? ''), args.replace_all === true)
    if (!match.ok) return { ok: false, error: match.error }
    const result = await this.commit(abs, original, match.text, callId, 'Edited')
    if (result.ok && match.how !== 'exact') {
      const how = { 'line-endings': "the file's line endings", 'line-numbers': 'read_file line numbers removed', 'trailing-space': 'trailing spaces ignored' }[match.how]
      result.output = `${result.output} (matched with ${how} — quote the file exactly next time.)`
    }
    if (result.ok && match.count > 1) result.output = `${result.output} ${match.count} occurrences replaced.`
    return result
  }

  private async writeFile(args: Record<string, unknown>, callId: string): Promise<ToolboxResult> {
    const root = this.root()
    const abs = resolveInside(root, args.path)
    if (typeof args.content !== 'string') return { ok: false, error: 'Give the complete file as content.' }
    let original: string | null = null
    try {
      original = await fs.readFile(abs, 'utf8')
    } catch {
      original = null
    }
    if (original !== null && !this.readPaths.has(abs)) {
      return { ok: false, error: `${relPath(root, abs)} already exists. Read it with read_file first, then use edit_file for a change or write_file to replace it whole.` }
    }
    if (original === args.content) return { ok: true, output: `No change: ${relPath(root, abs)} already has that content.` }
    return this.commit(abs, original, args.content, callId, 'Wrote')
  }

  private async runCommand(args: Record<string, unknown>): Promise<ToolboxResult> {
    const root = this.root()
    const command = String(args.command ?? '').trim()
    if (!command) return { ok: false, error: 'Give the command to run.' }
    const warning = dangerousCommandWarning(command)
    const approval = await this.o.host.approveCommand({ command, cwd: root, warning })
    if (approval === 'declined') {
      return {
        ok: false,
        error: declinedCall('the user declined to run this command, so nothing ran.', 'Do not run it again; carry on without it or ask the user.')
      }
    }
    const requested = Number(args.timeout_seconds)
    const seconds = Math.min(600, Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : this.o.commandTimeoutSec))
    const r = await runCommand(command, root, this.o.shell, seconds * 1000, this.o.signal)
    const status = r.aborted
      ? 'stopped with the task'
      : r.timedOut
        ? `stopped at the ${seconds} s time limit`
        : `exit code ${r.exitCode ?? '?'}`
    const text = `$ ${command}\n${r.output || '(no output)'}\n(${status}, ${(r.ms / 1000).toFixed(1)} s${approval === 'granted' ? ', run under a standing grant' : ''})`
    return r.exitCode === 0 && !r.timedOut && !r.aborted ? { ok: true, output: text } : { ok: false, error: text }
  }

  private todoWrite(args: Record<string, unknown>): ToolboxResult {
    const raw = Array.isArray(args.todos) ? args.todos : null
    if (!raw) return { ok: false, error: 'Give todos: an array of { content, status }.' }
    const todos: TodoItem[] = []
    for (const t of raw) {
      const item = t as Record<string, unknown>
      const content = String(item?.content ?? '').trim()
      if (!content) continue
      const status = item?.status === 'completed' || item?.status === 'in_progress' ? item.status : 'pending'
      todos.push({ content: content.slice(0, 200), status })
    }
    this.o.state.todos = todos
    this.o.host.emit({ type: 'todos', todos })
    const done = todos.filter((t) => t.status === 'completed').length
    const active = todos.filter((t) => t.status === 'in_progress')
    const nudge =
      active.length > 1
        ? ' More than one item is in progress — keep exactly one.'
        : active.length === 0 && done < todos.length
          ? ' Mark the item you start next as in_progress.'
          : ''
    return {
      ok: true,
      output: `Checklist updated: ${done} of ${todos.length} done${active[0] ? `; now: ${active[0].content}` : ''}.${nudge}`
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
