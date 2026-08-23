import type { ToolMeta } from '../types'

export const noteToolDefs = [
  {
    name: 'create_note',
    label: 'Create note',
    description:
      'Save a note to the local notes store. Overwrites any note with the same title.\n' +
      'Use when: the user asks to save or jot down something as a note they will read back later.\n' +
      'Do not use when: they want a file on disk (write_file), or a fact recalled by topic in ' +
      'future conversations (memory_save).\n' +
      'Example: {"title": "gift ideas", "content": "vinyl records, a chef\'s knife"}',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title' },
        content: { type: 'string', description: 'Note content' }
      },
      required: ['title', 'content']
    },
    toggleDefault: true
  },
  {
    name: 'list_notes',
    label: 'List notes',
    description:
      'List the titles of all saved notes.\n' +
      'Use when: the user asks what notes they have, or you need a note\'s exact title before ' +
      'read_note.\n' +
      'Do not use when: you are searching memory by topic rather than title (memory_search).\n' +
      'Example: {}',
    parameters: { type: 'object', properties: {} },
    toggleDefault: true
  },
  {
    name: 'read_note',
    label: 'Read note',
    description: 'Read a saved note by title.\n' +
      'Use when: you know the note\'s exact title — call list_notes first if you do not.\n' +
      'Do not use when: you are searching by topic rather than title (memory_search), or the ' +
      'content lives in a file (read_file).\n' +
      'Example: {"title": "gift ideas"}',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Note title' } },
      required: ['title']
    },
    toggleDefault: true
  }
] as const satisfies readonly ToolMeta[]
