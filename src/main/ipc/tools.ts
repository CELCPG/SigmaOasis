import { BrowserWindow, dialog, ipcMain } from 'electron'
import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, resolve, sep } from 'path'
import { getSettings, readNotes, writeNotes } from './store'
import type { ToolToggles } from './store'
import { addToMemory, deleteFromMemory, searchMemory } from './memory'

/**
 * Agentic tool implementations. Every tool runs here in the main process —
 * never in the renderer. The renderer's useLMStudio hook lists the enabled
 * tool schemas (`tools:list`), hands them to the model, and dispatches the
 * model's tool calls back through `tools:execute`.
 */

interface ToolResult {
  ok: boolean
  output?: string
  error?: string
}

interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const MAX_OUTPUT_CHARS = 8000
const TERMINAL_TIMEOUT_MS = 30_000

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length > max
    ? `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`
    : text
}

/** The configured working directory, resolved — or null when none is set. */
function workingRoot(): string | null {
  const root = getSettings().workingDirectory.trim()
  return root ? resolve(root) : null
}

/**
 * Relative paths resolve against the configured working directory (fallback:
 * home). When a working directory is set it is also a boundary — absolute
 * paths and `..` escapes outside it are refused, so the models can only touch
 * the tree the user scoped them to. (Symlinks inside the root are followed as
 * the OS resolves them; the root is a scoping tool, not a sandbox.)
 */
function resolvePath(p: string): string {
  const root = workingRoot()
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root ?? homedir(), p)
  if (root && resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(
      `"${resolved}" is outside the working directory (${root}). Change or clear it under Settings → Tools.`
    )
  }
  return resolved
}

/** Writes outside a scoped working directory need explicit user approval. */
async function confirmWrite(
  sender: Electron.WebContents,
  target: string,
  chars: number
): Promise<boolean> {
  const win = BrowserWindow.fromWebContents(sender)
  const { response } = await dialog.showMessageBox(win!, {
    type: 'warning',
    title: 'Confirm file write',
    message: 'A model wants to write to a file outside any scoped working directory:',
    detail: `${target}\n\n${chars} character(s) — this overwrites the file if it exists.`,
    buttons: ['Write', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  })
  return response === 0
}

const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a local file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path (absolute, or relative to the working directory)' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write (or overwrite) a local file with the given content. Writes are confined to the user\'s configured working directory; if none is configured, the user is shown a confirmation dialog first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute, or relative to the working directory)' },
          content: { type: 'string', description: 'Full file content to write' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the entries in a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path (absolute, or relative to the working directory)' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
      description:
        'Run a shell command on the user\'s machine. The user is shown a confirmation dialog before anything executes.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web (DuckDuckGo instant answers) for a query.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description: 'Get the current local date and time.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: 'Save a note to the local notes store. Overwrites any note with the same title.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title' },
          content: { type: 'string', description: 'Note content' }
        },
        required: ['title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_notes',
      description: 'List the titles of all saved notes.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read a saved note by title.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Note title' } },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description:
        'Save information to long-term local memory so it can be found by semantic search in future conversations. Use for facts, decisions, and preferences worth remembering. Re-saving with the same title replaces the previous entry.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for this memory' },
          text: { type: 'string', description: 'The information to remember' }
        },
        required: ['title', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description:
        'Search long-term local memory (saved memories, notes, indexed documents) semantically. Returns the most relevant text chunks with similarity scores.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for' },
          topK: { type: 'number', description: 'How many results to return (default 3)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget',
      description: 'Delete a long-term memory source by its exact title.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Title of the memory to delete' } },
        required: ['title']
      }
    }
  }
]

async function executeTool(
  sender: Electron.WebContents,
  name: keyof ToolToggles,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read_file': {
        const content = await fs.readFile(resolvePath(String(args.path ?? '')), 'utf-8')
        return { ok: true, output: truncate(content) }
      }

      case 'write_file': {
        const target = resolvePath(String(args.path ?? ''))
        const content = String(args.content ?? '')
        // A working directory means the user already scoped where writes may
        // land; without one, every write is confirmed.
        if (!workingRoot() && !(await confirmWrite(sender, target, content.length))) {
          return { ok: false, error: 'The user declined this file write.' }
        }
        await fs.mkdir(dirname(target), { recursive: true })
        await fs.writeFile(target, content, 'utf-8')
        return { ok: true, output: `Wrote ${content.length} characters to ${target}` }
      }

      case 'list_directory': {
        const entries = await fs.readdir(resolvePath(String(args.path ?? '')), {
          withFileTypes: true
        })
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return { ok: true, output: truncate(lines.join('\n') || '(empty directory)') }
      }

      case 'run_terminal_command': {
        const command = String(args.command ?? '')
        const win = BrowserWindow.fromWebContents(sender)
        const { response } = await dialog.showMessageBox(win!, {
          type: 'warning',
          title: 'Confirm terminal command',
          message: 'A model wants to run this terminal command:',
          detail: command,
          buttons: ['Run', 'Cancel'],
          defaultId: 1,
          cancelId: 1
        })
        if (response !== 0) {
          return { ok: false, error: 'The user declined to run this command.' }
        }
        const cwd = getSettings().workingDirectory || undefined
        return await new Promise<ToolResult>((resolvePromise) => {
          exec(
            command,
            { cwd, timeout: TERMINAL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
              const combined = [stdout, stderr].filter(Boolean).join('\n').trim()
              if (error && !combined) {
                resolvePromise({ ok: false, error: `Command failed: ${error.message}` })
              } else {
                resolvePromise({
                  ok: true,
                  output: truncate(combined || '(command completed with no output)')
                })
              }
            }
          )
        })
      }

      case 'web_search': {
        const query = String(args.query ?? '')
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
        const res = await fetch(url, { headers: { 'User-Agent': 'OpenMind/0.1' } })
        if (!res.ok) return { ok: false, error: `DuckDuckGo returned HTTP ${res.status}` }
        const data = (await res.json()) as {
          AbstractText?: string
          AbstractURL?: string
          Answer?: string
          RelatedTopics?: { Text?: string; FirstURL?: string }[]
        }
        const parts: string[] = []
        if (data.Answer) parts.push(`Answer: ${data.Answer}`)
        if (data.AbstractText) {
          parts.push(`${data.AbstractText}${data.AbstractURL ? `\nSource: ${data.AbstractURL}` : ''}`)
        }
        const related = (data.RelatedTopics ?? [])
          .filter((t) => t.Text)
          .slice(0, 5)
          .map((t) => `- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ''}`)
        if (related.length > 0) parts.push(`Related:\n${related.join('\n')}`)
        return {
          ok: true,
          output: truncate(parts.join('\n\n') || 'No instant answer found for this query.')
        }
      }

      case 'get_current_datetime': {
        const now = new Date()
        return {
          ok: true,
          output: `${now.toLocaleString()} (ISO: ${now.toISOString()})`
        }
      }

      case 'create_note': {
        const title = String(args.title ?? '').trim()
        if (!title) return { ok: false, error: 'Note title is required.' }
        const content = String(args.content ?? '')
        const notes = await readNotes()
        const existing = notes.findIndex((n) => n.title === title)
        const note = { title, content, createdAt: Date.now() }
        if (existing >= 0) notes[existing] = note
        else notes.push(note)
        await writeNotes(notes)
        // Auto-index into long-term memory (best effort — never fails the note).
        void addToMemory(`note: ${title}`, content).catch(() => undefined)
        return { ok: true, output: `Note "${title}" saved.` }
      }

      case 'list_notes': {
        const notes = await readNotes()
        return {
          ok: true,
          output: notes.length > 0 ? notes.map((n) => `- ${n.title}`).join('\n') : '(no notes saved)'
        }
      }

      case 'read_note': {
        const title = String(args.title ?? '')
        const notes = await readNotes()
        const note =
          notes.find((n) => n.title === title) ??
          notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
        return note
          ? { ok: true, output: truncate(note.content) }
          : { ok: false, error: `No note titled "${title}".` }
      }

      case 'memory_save': {
        const title = String(args.title ?? '').trim()
        if (!title) return { ok: false, error: 'Memory title is required.' }
        const { chunks } = await addToMemory(title, String(args.text ?? ''))
        return { ok: true, output: `Saved "${title}" to long-term memory (${chunks} chunk(s)).` }
      }

      case 'memory_search': {
        const topK = typeof args.topK === 'number' ? args.topK : getSettings().memory.topK
        const results = await searchMemory(String(args.query ?? ''), topK)
        if (results.length === 0) {
          return { ok: true, output: 'No relevant memories found.' }
        }
        return {
          ok: true,
          output: truncate(
            results
              .map((r, i) => `${i + 1}. [${r.source}] (score ${r.score})\n${r.text}`)
              .join('\n\n')
          )
        }
      }

      case 'memory_forget': {
        const title = String(args.title ?? '')
        const { removed } = await deleteFromMemory(title)
        return removed > 0
          ? { ok: true, output: `Forgot "${title}" (${removed} chunk(s) removed).` }
          : { ok: false, error: `No memory titled "${title}".` }
      }

      default:
        return { ok: false, error: `Unknown tool "${String(name)}".` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerToolHandlers(): void {
  // Only enabled tools are exposed to the models at all.
  ipcMain.handle('tools:list', () => {
    const toggles = getSettings().tools
    return TOOL_SCHEMAS.filter((t) => toggles[t.function.name as keyof ToolToggles])
  })

  ipcMain.handle(
    'tools:execute',
    async (event, name: keyof ToolToggles, args: Record<string, unknown>) => {
      if (!getSettings().tools[name]) {
        return { ok: false, error: `Tool "${String(name)}" is disabled in Settings → Tools.` }
      }
      return executeTool(event.sender, name, args ?? {})
    }
  )
}
