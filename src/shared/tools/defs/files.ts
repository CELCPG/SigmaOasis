import type { ToolMeta } from '../types'

export const fileToolDefs = [
  {
    name: 'read_file',
    label: 'Read file',
    description:
      'Read the contents of a local file.\n' +
      'Use when: the user names a file path or asks what a file says.\n' +
      'Do not use when: they ask what is inside a directory (list_directory), want the file ' +
      'created or changed (write_file), or the content is on the web (fetch_webpage).\n' +
      'Example: {"path": "notes/todo.md"}',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path (absolute, or relative to the working directory)' } },
      required: ['path']
    },
    toggleDefault: true
  },
  {
    name: 'write_file',
    label: 'Write file (confirms when no working directory is set)',
    description:
      'Write (or overwrite) a local file with the given content. Writes are confined to the ' +
      'user\'s configured working directory; if none is configured, the user is shown a ' +
      'confirmation dialog first.\n' +
      'Use when: the user asks to save text to a file, create a file, or export something to disk.\n' +
      'Do not use when: they want a note in the notes store (create_note) or a fact remembered ' +
      'across conversations (memory_save).\n' +
      'Example: {"path": "groceries.txt", "content": "milk\neggs\ncoffee"}',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the working directory)' },
        content: { type: 'string', description: 'Full file content to write' }
      },
      required: ['path', 'content']
    },
    // Off by default: mutates the machine. Opt in under Settings → Tools.
    toggleDefault: false
  },
  {
    name: 'propose_patch',
    label: 'Propose a patch (the user reviews the diff before it is applied)',
    description:
      'Propose a change to a file as edits the user reviews as a diff before anything is written. ' +
      'Give the path and a list of edits, each a `search` string that occurs exactly once in the file ' +
      'and the `replace` text for it (an empty search appends at the end); or give `content` to propose ' +
      'the whole new file. The app computes the diff, shows it in the chat with Apply and Discard, and ' +
      'writes only on Apply — you are told which happened.\n' +
      'Use when: changing an existing file, or creating one the user should see before it lands — code, ' +
      'config, prose. Prefer small, exact edits over rewriting the file.\n' +
      'Do not use when: reading a file (read_file), or the user asked for a raw overwrite of a scratch file ' +
      'and write_file is enabled.\n' +
      'Example: {"path": "src/app.ts", "edits": [{"search": "const limit = 5", "replace": "const limit = 10"}]}',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the working directory)' },
        edits: {
          type: 'array',
          description: 'Search-and-replace edits applied in order; each search must match exactly once',
          items: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Exact text to find (empty to append at the end)' },
              replace: { type: 'string', description: 'Text to put in its place' }
            },
            required: ['search', 'replace']
          }
        },
        content: { type: 'string', description: 'The whole new file, instead of edits' }
      },
      required: ['path']
    },
    toggleDefault: true,
    turnBudget: 3
  },
  {
    name: 'list_directory',
    label: 'List directory',
    description:
      'List the entries in a directory.\n' +
      'Use when: the user asks what is in a folder, or whether a file exists somewhere.\n' +
      'Do not use when: you need a file\'s contents (read_file). Never use run_terminal_command ' +
      'just to list files — this tool already does it.\n' +
      'Example: {"path": "~/Downloads"}',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (absolute, or relative to the working directory)' } },
      required: ['path']
    },
    toggleDefault: true
  },
  {
    name: 'run_terminal_command',
    label: 'Run terminal command (asks to confirm)',
    description:
      'Run a shell command on the user\'s machine. The user is shown a confirmation dialog ' +
      'before anything executes.\n' +
      'Use when: the task genuinely needs a shell — building, running scripts or tests, git, ' +
      'package managers.\n' +
      'Do not use when: a typed tool does the job — reading a file (read_file), listing a ' +
      'directory (list_directory), searching the web (web_search), fetching a page (fetch_webpage).\n' +
      'Example: {"command": "npm test"}',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run' } },
      required: ['command']
    },
    // Off by default: mutates the machine. Opt in under Settings → Tools.
    toggleDefault: false
  }
] as const satisfies readonly ToolMeta[]
