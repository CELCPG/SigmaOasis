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
