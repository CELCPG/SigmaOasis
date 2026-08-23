import type { ToolMeta } from '../types'

export const memoryToolDefs = [
  {
    name: 'memory_save',
    label: 'Save to long-term memory',
    description:
      'Save information to long-term local memory so it can be found by semantic search in ' +
      'future conversations. Re-saving with the same title replaces the previous entry.\n' +
      'Use when: the user states a preference, fact, or decision worth keeping ("remember ' +
      'that…"), or asks you to keep something across conversations.\n' +
      'Do not use when: they are drafting a note to read back verbatim (create_note) or saving ' +
      'text to a file (write_file).\n' +
      'Example: {"title": "favorite band", "text": "The user\'s favorite band is Phish."}',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for this memory' },
        text: { type: 'string', description: 'The information to remember' }
      },
      required: ['title', 'text']
    },
    toggleDefault: true,
    alwaysOn: true
  },
  {
    name: 'memory_search',
    label: 'Search long-term memory',
    description:
      'Search long-term local memory (saved memories, notes, indexed documents) semantically. ' +
      'Returns the most relevant text chunks with similarity scores.\n' +
      'Use when: the answer might depend on something the user told you before — preferences, ' +
      'history, prior decisions ("what do you remember about…").\n' +
      'Do not use when: they name a note\'s exact title (read_note), or the question needs ' +
      'current facts from the web (web_search).\n' +
      'Example: {"query": "music preferences"}',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        topK: { type: 'number', description: 'How many results to return (default 3)' }
      },
      required: ['query']
    },
    toggleDefault: true,
    alwaysOn: true
  },
  {
    name: 'memory_forget',
    label: 'Delete a memory',
    description:
      'Delete a long-term memory source by its exact title.\n' +
      'Use when: the user asks you to forget or delete something you remembered.\n' +
      'Do not use when: they want a note removed — there is no note-deletion tool; say so ' +
      'instead of guessing.\n' +
      'Example: {"title": "favorite band"}',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Title of the memory to delete' } },
      required: ['title']
    },
    toggleDefault: true,
    alwaysOn: true
  }
] as const satisfies readonly ToolMeta[]
