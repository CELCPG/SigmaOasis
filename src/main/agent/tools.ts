import { promises as fs } from 'fs'
import { basename, dirname, join, relative, sep } from 'path'
import { describeStats, unifiedDiff } from '../../shared/patch'
import { declinedCall } from '../../shared/tools/outcomes'
import { commandNotices } from '../../shared/commandDanger'
import { applyEdit } from './editMatch'
import { changedSpan, digestCommandOutput, editedWindow, groupGrepOutput } from './digests'
import { runCommand } from './command'
import { documentKind, readDocument, writeDocument, type Sheet } from './documents'
import { ensureSigmaIgnore } from './worktree'
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
import type { AgentExperiments, AgentHost, Checkpoint, PermissionMode, ShellSpec, SubagentType, TodoItem, ToolResult, ToolSchema } from './types'

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
/** v3.1 (M2): files a single read_file may add beside its path. */
export const READ_MORE_PATHS = 3
const GLOB_MAX = 200
const GREP_MAX_MATCHES = 120
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024
const LIST_MAX = 300
/** v4.1 (A6): edits one multi_edit call may carry. */
export const MULTI_EDIT_MAX = 20

/** Tools that change the workspace or run something; not offered read-only. */
export const WRITING_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file', 'run_command', 'write_document', 'move_file', 'copy_file', 'make_directory', 'delete_file'])
/** v4.2: the writing tools that change files (all but run_command) — what a check or a read must follow. */
export const CHANGE_TOOLS: ReadonlySet<string> = new Set([...WRITING_TOOLS].filter((n) => n !== 'run_command'))
/** v4.2: the workspace's readers — a read after a change is evidence of it. */
export const READ_TOOLS: ReadonlySet<string> = new Set(['read_file', 'list_directory', 'glob', 'grep', 'read_document', 'read_spill'])

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSchema => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
})

export function workspaceToolSchemas(shell: ShellSpec, commandTimeoutSec: number, experiments?: Partial<AgentExperiments>): ToolSchema[] {
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
        limit: { type: 'number', description: `How many lines to read (default ${READ_DEFAULT_LINES}).` },
        // A1 (v4.0): offered only while the multi-read experiment is on; the chat's pinned tool list never moves either way.
        ...(experiments?.multiRead
          ? {
              more_paths: {
                type: 'array',
                items: { type: 'string' },
                description: `Up to ${READ_MORE_PATHS} more files to read in the same call, each from its first line — for a first look at several files at once.`
              }
            }
          : {})
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
    // v4.1 (A6): several changes to one file as one step — one review, one
    // checkpoint, and none lands unless all do, so a half-applied rename
    // never leaves a file that does not build.
    fn(
      'multi_edit',
      'Make several changes to one file in one step. Each edit is an exact old_string → new_string, as in edit_file, applied in order to the result of the one before. All land or none do; the user sees one diff. Read the file first.',
      {
        path: { type: 'string', description: 'File path relative to the workspace.' },
        edits: {
          type: 'array',
          description: `The changes, in order (at most ${MULTI_EDIT_MAX}).`,
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'The exact text to replace.' },
              new_string: { type: 'string', description: 'The text to put in its place.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one.' }
            },
            required: ['old_string', 'new_string']
          }
        }
      },
      ['path', 'edits']
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
    ),
    // C1 (v4.0, an experiment): documents — the files people actually have.
    ...(experiments?.documents
      ? [
          fn(
            'read_document',
            'Read a document as text: .docx (headings, paragraphs, bullets, tables), .xlsx (every sheet as a table), .pptx (slide by slide), .pdf, .csv, .md, .txt. For source and other text files use read_file.',
            { path: { type: 'string', description: 'File path relative to the workspace.' } },
            ['path']
          ),
          fn(
            'write_document',
            'Create or replace a document whole. .docx from Markdown content (headings with #, bullets with -, tables with |); .md and .txt from content; .xlsx from sheets ([{ name, rows }], rows as arrays of text, numbers or booleans) or from CSV content; .csv from sheets or content. Read an existing document first. The user sees the diff of what the document says.',
            {
              path: { type: 'string', description: 'File path relative to the workspace, ending in .docx, .xlsx, .csv, .md or .txt.' },
              content: { type: 'string', description: 'Markdown (.docx, .md, .txt) or CSV text (.xlsx, .csv).' },
              sheets: {
                type: 'array',
                description: 'For .xlsx or .csv: the sheets, each { name, rows }.',
                items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array' } } } }
              }
            },
            ['path']
          )
        ]
      : []),
    // C2 (v4.0, an experiment): folder chores, typed so no command is needed for them.
    ...(experiments?.chores
      ? [
          fn(
            'move_file',
            'Move or rename a file or a folder inside the workspace. The destination must not exist yet. The user sees it; Undo reverses it.',
            { from: { type: 'string', description: 'The path now, relative to the workspace.' }, to: { type: 'string', description: 'The new path, relative to the workspace.' } },
            ['from', 'to']
          ),
          fn(
            'copy_file',
            'Copy one file inside the workspace. The destination must not exist yet.',
            { from: { type: 'string', description: 'The file to copy.' }, to: { type: 'string', description: 'Where the copy goes.' } },
            ['from', 'to']
          ),
          fn('make_directory', 'Create a folder (and any missing parents) inside the workspace.', { path: { type: 'string', description: 'Folder path relative to the workspace.' } }, ['path']),
          fn(
            'delete_file',
            'Send one file to the trash. It is never removed outright, and Undo restores it. For a folder, delete its files one by one or move it.',
            { path: { type: 'string', description: 'File path relative to the workspace.' } },
            ['path']
          )
        ]
      : [])
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

/** v4.0 (A6, an experiment): a question for the user; the task pauses on it. */
export const ASK_USER_SCHEMA: ToolSchema = fn(
  'ask_user',
  'Ask the user one question when the task cannot go on without their answer — a choice between real alternatives, or a fact only they know. The task pauses and their answer arrives as your next message. Do not ask what you could find out with your tools, and do not ask for permission to do what the task already says.',
  {
    question: { type: 'string', description: 'The question, in one or two sentences.' },
    choices: { type: 'array', items: { type: 'string' }, description: 'Optional: up to six short answers to pick from.' }
  },
  ['question']
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
  /** v4.0: the experiments on for this task; absent means none. */
  experiments?: Partial<AgentExperiments>
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
    const all = workspaceToolSchemas(this.o.shell, this.o.commandTimeoutSec, this.o.experiments)
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
        case 'grep': {
          // A2 (v4.0, an experiment): hits grouped by file, the busiest first.
          const r = await this.grep(args)
          return this.o.experiments?.digests && r.ok && r.output ? { ...r, output: groupGrepOutput(r.output) } : r
        }
        case 'read_file':
          return await this.readFile(args)
        case 'edit_file':
          return await this.editFile(args, callId)
        case 'multi_edit':
          return await this.multiEdit(args, callId)
        case 'write_file':
          return await this.writeFile(args, callId)
        case 'read_document':
          return await this.readDocument(args)
        case 'write_document':
          return await this.writeDocument(args, callId)
        case 'move_file':
          return await this.moveFile(args, callId, false)
        case 'copy_file':
          return await this.moveFile(args, callId, true)
        case 'make_directory':
          return await this.makeDirectory(args)
        case 'delete_file':
          return await this.deleteFile(args, callId)
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

  /**
   * v3.1 (M2): `more_paths` reads several files in one call, each windowed as
   * a single read is, each under its own header; one that cannot be read says
   * why in its place and does not fail the others. Only the agent's own schema
   * changes — the chat's pinned tool list does not move.
   */
  private async readFile(args: Record<string, unknown>): Promise<ToolboxResult> {
    const more =
      this.o.experiments?.multiRead && Array.isArray(args.more_paths)
        ? args.more_paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '').slice(0, READ_MORE_PATHS)
        : []
    if (more.length === 0) return this.readOneFile(args)
    const parts: string[] = []
    let anyOk = false
    for (const [i, path] of [args.path, ...more].entries()) {
      const one = await this.readOneFile(i === 0 ? args : { path }).catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }))
      anyOk ||= one.ok
      parts.push(`=== ${String(path)} ===\n${one.ok ? one.output : `(not read: ${one.error})`}`)
    }
    return anyOk ? { ok: true, output: parts.join('\n\n') } : { ok: false, error: parts.join('\n\n') }
  }

  private async readOneFile(args: Record<string, unknown>): Promise<ToolboxResult> {
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
    this.recordAfter(rel, Buffer.from(next, 'utf8'))
    this.readPaths.add(abs)
    this.o.host.emit({ type: 'files_changed', paths: [...this.o.state.checkpoints.keys()] })
    // A2 (v4.0, an experiment): the lines around the change, numbered as
    // read_file numbers them, so the model sees what landed without a re-read.
    const span = this.o.experiments?.digests && original !== null ? changedSpan(original, next) : null
    const window = span ? `\n\n${editedWindow(next, span.from, span.to)}` : ''
    return {
      ok: true,
      output: `${verb} ${rel}: ${summary}.${window}`,
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
      result.output = `${result.output} (matched with ${FORGIVEN[match.how]} — quote the file exactly next time.)`
    }
    if (result.ok && match.count > 1) result.output = `${result.output} ${match.count} occurrences replaced.`
    return result
  }

  /**
   * v4.1 (A6): multi_edit — each edit through the same matching as edit_file,
   * in order, on the text the one before left; the first that fails fails
   * the call with the file untouched, and the whole lands as one commit.
   */
  private async multiEdit(args: Record<string, unknown>, callId: string): Promise<ToolboxResult> {
    const root = this.root()
    const abs = resolveInside(root, args.path)
    const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : []
    if (edits.length === 0) return { ok: false, error: 'Give edits: an array of { old_string, new_string }.' }
    if (edits.length > MULTI_EDIT_MAX) return { ok: false, error: `${edits.length} edits in one call; at most ${MULTI_EDIT_MAX}. Split them over two calls.` }
    let original: string
    try {
      original = await fs.readFile(abs, 'utf8')
    } catch {
      return { ok: false, error: `${relPath(root, abs)} does not exist. To create it, use write_file.` }
    }
    if (!this.readPaths.has(abs)) {
      return { ok: false, error: `Read ${relPath(root, abs)} with read_file before editing it, so the change is made against what the file actually says.` }
    }
    let text = original
    const forgiven = new Set<string>()
    let replaced = 0
    for (const [i, e] of edits.entries()) {
      const match = applyEdit(text, String(e?.old_string ?? ''), String(e?.new_string ?? ''), e?.replace_all === true)
      if (!match.ok) {
        return { ok: false, error: `Edit ${i + 1} of ${edits.length} failed, so none was applied and the file is unchanged. ${match.error}` }
      }
      text = match.text
      replaced += match.count
      if (match.how !== 'exact') forgiven.add(FORGIVEN[match.how])
    }
    if (text === original) return { ok: true, output: `No change: the edits leave ${relPath(root, abs)} as it was.` }
    const result = await this.commit(abs, original, text, callId, 'Edited')
    if (result.ok) {
      result.output = `${result.output} ${edits.length} edit${edits.length === 1 ? '' : 's'}${replaced > edits.length ? ` (${replaced} occurrences)` : ''}.`
      if (forgiven.size > 0) result.output = `${result.output} (matched with ${[...forgiven].join('; ')} — quote the file exactly next time.)`
    }
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
    // v4.1 (F2): the destructive warning and the network notice, from one shared list.
    const approval = await this.o.host.approveCommand({ command, cwd: root, ...commandNotices(command) })
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
    // A2 (v4.0, an experiment): a test runner's output with its totals and failures first.
    const shown = this.o.experiments?.digests && r.output ? digestCommandOutput(r.output) : r.output || '(no output)'
    const text = `$ ${command}\n${shown}\n(${status}, ${(r.ms / 1000).toFixed(1)} s${approval === 'granted' ? ', run under a standing grant' : ''})`
    return r.exitCode === 0 && !r.timedOut && !r.aborted ? { ok: true, output: text } : { ok: false, error: text }
  }

  // ---- C1 (v4.0, an experiment): documents ----------------------------------------

  private async readDocument(args: Record<string, unknown>): Promise<ToolboxResult> {
    const root = this.root()
    const abs = resolveInside(root, args.path)
    const rel = relPath(root, abs)
    const s = await fs.stat(abs)
    if (s.isDirectory()) return { ok: false, error: `${rel} is a folder; use list_directory.` }
    if (s.size > READ_MAX_BYTES) return { ok: false, error: `${rel} is ${formatSize(s.size)} — too large to read whole.` }
    const bytes = await fs.readFile(abs)
    let text: string
    try {
      text = await readDocument(abs, bytes, this.o.host.readPdf)
    } catch (err) {
      return { ok: false, error: `${rel}: ${err instanceof Error ? err.message : String(err)}` }
    }
    this.readPaths.add(abs)
    if (!text.trim()) return { ok: true, output: `${rel} has no text.` }
    const clipped = text.length > DOCUMENT_MAX_CHARS ? `${text.slice(0, DOCUMENT_MAX_CHARS)}\n… (${(text.length - DOCUMENT_MAX_CHARS).toLocaleString('en-US')} more characters)` : text
    return { ok: true, output: `${rel} (${documentKind(abs).slice(1)}, ${formatSize(s.size)}):\n${clipped}` }
  }

  private async writeDocument(args: Record<string, unknown>, callId: string): Promise<ToolboxResult> {
    const root = this.root()
    const abs = resolveInside(root, args.path)
    const rel = relPath(root, abs)
    let next: Buffer
    try {
      next = writeDocument(abs, { content: typeof args.content === 'string' ? args.content : undefined, sheets: Array.isArray(args.sheets) ? (args.sheets as Sheet[]) : undefined })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    let original: Buffer | null = null
    try {
      original = await fs.readFile(abs)
    } catch {
      original = null
    }
    if (original !== null && !this.readPaths.has(abs)) return { ok: false, error: `${rel} already exists. Read it with read_document first, then write it whole.` }
    if (original !== null && original.equals(next)) return { ok: true, output: `No change: ${rel} already says that.` }
    const says = async (bytes: Buffer | null): Promise<string> => (bytes === null ? '' : readDocument(abs, bytes, this.o.host.readPdf).catch(() => '(unreadable)'))
    return this.commitBytes(abs, original, next, callId, 'Wrote', await says(original), await says(next))
  }

  /**
   * The bytes door of `commit`: a document, checkpointed as base64 and
   * reviewed as the diff of what it says rather than of its bytes.
   */
  private async commitBytes(abs: string, original: Buffer | null, next: Buffer, callId: string, verb: 'Wrote', beforeText: string, afterText: string): Promise<ToolboxResult> {
    const root = this.root()
    const rel = relPath(root, abs)
    await assertWritableInside(root, abs)
    const isNew = original === null
    const { diff, stats } = unifiedDiff(beforeText, afterText, rel)
    const summary = describeStats(stats, isNew)
    const approved = this.o.permission === 'acceptEdits' ? true : await this.o.host.reviewEdit({ callId, path: rel, isNew, diff, stats })
    if (this.o.signal.aborted) return { ok: false, error: declinedCall('the task was stopped before this change was written, so nothing changed.') }
    if (!approved) {
      const error = declinedCall(`the user discarded this change to ${rel}, so the file is unchanged.`, 'Do not propose the same change again; ask what they want instead, or take a different approach.')
      return { ok: false, error, display: `${error}\n\n${diff}` }
    }
    this.checkpointBytes(rel, original)
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, next)
    this.recordAfter(rel, next)
    this.readPaths.add(abs)
    this.o.host.emit({ type: 'files_changed', paths: [...this.o.state.checkpoints.keys()] })
    return { ok: true, output: `${verb} ${rel}: ${summary}.`, display: `Applied to ${rel}: ${summary}.\n\n${diff}` }
  }

  /** Checkpoint a file's bytes (base64) before its first change this task; an existing checkpoint, text or bytes, is kept. */
  private checkpointBytes(rel: string, original: Buffer | null): void {
    if (this.o.state.checkpoints.has(rel)) return
    this.o.state.checkpoints.set(rel, { path: rel, before: original === null ? null : original.toString('base64'), after: null, encoding: 'base64' })
  }

  /** What the task last wrote at `rel`, in the checkpoint's own encoding. */
  private recordAfter(rel: string, bytes: Buffer | null): void {
    const cp = this.o.state.checkpoints.get(rel)
    if (!cp) return
    cp.after = bytes === null ? null : cp.encoding === 'base64' ? bytes.toString('base64') : bytes.toString('utf8')
  }

  // ---- C2 (v4.0, an experiment): folder chores ---------------------------------------

  /** Approval for a chore in *Ask first*: shown through the edit review, as one line saying what moves. */
  private async approveChore(callId: string, path: string, line: string): Promise<boolean> {
    if (this.o.permission === 'acceptEdits') return true
    return this.o.host.reviewEdit({ callId, path, isNew: true, diff: line, stats: { added: 0, removed: 0, hunks: 0 } })
  }

  private async moveFile(args: Record<string, unknown>, callId: string, copy: boolean): Promise<ToolboxResult> {
    const root = this.root()
    const from = resolveInside(root, args.from)
    const to = resolveInside(root, args.to)
    const relFrom = relPath(root, from)
    const relTo = relPath(root, to)
    const verb = copy ? 'Copy' : 'Move'
    if (from === to) return { ok: false, error: 'from and to are the same path.' }
    let st: import('fs').Stats
    try {
      st = await fs.stat(from)
    } catch {
      return { ok: false, error: `${relFrom} does not exist. Use glob or list_directory to find the right path.` }
    }
    if (await exists(to)) return { ok: false, error: `${relTo} already exists; choose another name, or delete it first.` }
    await assertWritableInside(root, to)
    if (st.isDirectory()) {
      if (copy) return { ok: false, error: `${relFrom} is a folder; copy_file copies one file. Copy its files one at a time.` }
      const files = await filesUnder(from)
      if (files.length > MOVE_MAX_FILES) return { ok: false, error: `${relFrom} holds ${files.length} files; move at most ${MOVE_MAX_FILES} at once (move its sub-folders one at a time).` }
      if (!(await this.approveChore(callId, relTo, `Move ${relFrom}/ → ${relTo}/ (${files.length} file${files.length === 1 ? '' : 's'})`))) return this.declinedChore(`${verb.toLowerCase()} ${relFrom}`)
      for (const f of files) {
        const bytes = await fs.readFile(join(from, f))
        this.checkpointBytes(`${relFrom}/${f}`, bytes)
        this.recordAfter(`${relFrom}/${f}`, null)
        this.checkpointBytes(`${relTo}/${f}`, null)
        this.recordAfter(`${relTo}/${f}`, bytes)
      }
      await fs.mkdir(dirname(to), { recursive: true })
      await fs.rename(from, to)
      this.o.host.emit({ type: 'files_changed', paths: [...this.o.state.checkpoints.keys()] })
      return { ok: true, output: `Moved ${relFrom}/ → ${relTo}/ (${files.length} file${files.length === 1 ? '' : 's'}).` }
    }
    if (!(await this.approveChore(callId, relTo, `${verb} ${relFrom} → ${relTo}`))) return this.declinedChore(`${verb.toLowerCase()} ${relFrom}`)
    const bytes = await fs.readFile(from)
    if (!copy) {
      this.checkpointBytes(relFrom, bytes)
      this.recordAfter(relFrom, null)
    }
    this.checkpointBytes(relTo, null)
    this.recordAfter(relTo, bytes)
    await fs.mkdir(dirname(to), { recursive: true })
    if (copy) await fs.copyFile(from, to)
    else await fs.rename(from, to)
    this.readPaths.add(to)
    this.o.host.emit({ type: 'files_changed', paths: [...this.o.state.checkpoints.keys()] })
    return { ok: true, output: `${copy ? 'Copied' : 'Moved'} ${relFrom} → ${relTo}.` }
  }

  private declinedChore(what: string): ToolboxResult {
    return { ok: false, error: declinedCall(`the user declined to ${what}, so nothing moved.`, 'Do not try it again; ask what they want instead.') }
  }

  private async makeDirectory(args: Record<string, unknown>): Promise<ToolboxResult> {
    const root = this.root()
    const abs = resolveInside(root, args.path)
    const rel = relPath(root, abs)
    await assertWritableInside(root, abs)
    if (await exists(abs)) return { ok: true, output: `${rel}/ already exists.` }
    await fs.mkdir(abs, { recursive: true })
    return { ok: true, output: `Created ${rel}/.` }
  }

  private async deleteFile(args: Record<string, unknown>, callId: string): Promise<ToolboxResult> {
    const root = this.root()
    const abs = resolveInside(root, args.path)
    const rel = relPath(root, abs)
    let st: import('fs').Stats
    try {
      st = await fs.stat(abs)
    } catch {
      return { ok: false, error: `${rel} does not exist.` }
    }
    if (st.isDirectory()) return { ok: false, error: `${rel} is a folder; delete_file takes one file. Delete its files one by one, or move the folder.` }
    await assertWritableInside(root, abs)
    const bytes = await fs.readFile(abs)
    if (!(await this.approveChore(callId, rel, `Delete ${rel} (to the trash; Undo restores it)`))) return this.declinedChore(`delete ${rel}`)
    this.checkpointBytes(rel, bytes)
    this.recordAfter(rel, null)
    let where: string
    if (this.o.host.trash) {
      await this.o.host.trash(abs)
      where = 'the system trash'
    } else {
      const trashDir = join(root, '.sigma', 'trash')
      await fs.mkdir(trashDir, { recursive: true })
      // v4.3: what the agent deleted is not new work for the user's git status.
      await ensureSigmaIgnore(root)
      await fs.rename(abs, join(trashDir, `${Date.now()}-${basename(abs)}`))
      where = '.sigma/trash/'
    }
    this.o.host.emit({ type: 'files_changed', paths: [...this.o.state.checkpoints.keys()] })
    return { ok: true, output: `Deleted ${rel} (to ${where}; Undo restores it).` }
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

/** How a forgiving match is named back to the model, so it quotes exactly next time. */
const FORGIVEN: Record<'line-endings' | 'line-numbers' | 'trailing-space' | 'indentation', string> = {
  'line-endings': "the file's line endings",
  'line-numbers': 'read_file line numbers removed',
  'trailing-space': 'trailing spaces ignored',
  indentation: "indentation moved to the file's"
}

/** What read_document hands the model at most; a longer document says how much more there is. */
const DOCUMENT_MAX_CHARS = 60_000
/** Files a single folder move may carry. */
const MOVE_MAX_FILES = 500

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const abs = join(d, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile()) out.push(relative(dir, abs).split(sep).join('/'))
    }
  }
  await walk(dir)
  return out.sort()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
