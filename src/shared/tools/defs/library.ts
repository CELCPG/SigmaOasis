import type { ToolMeta } from '../types'

export const libraryToolDefs = [
  {
    name: 'reference_lookup',
    label: 'Reference library (offline packs and your own documents — fully local)',
    description:
      'Search the user\'s offline reference library — installed reference packs (first aid, ' +
      'preparedness, personal finance, health, home repair, legal basics) and any folders of ' +
      'their own documents they added. Fully local: reads only this machine, works with no ' +
      'internet. Returns passages with a citation (pack › document › section) and the source.\n' +
      'Use when: the question is about first aid, emergencies, health, medication, nutrition, ' +
      'personal finance or tax rules, home repair, legal or civic basics, or the user\'s own ' +
      'manuals/notes — anything a reference book would answer. Prefer this over web_search for ' +
      'such questions, and always when offline.\n' +
      'Do not use when: the question needs current events, prices, live availability or news ' +
      '(web_search); or something the user told you in conversation (memory_search).\n' +
      'Quote steps, figures and dosages from the passages rather than paraphrasing; if the ' +
      'passages do not answer it, say so — never invent a reference.\n' +
      'Example: {"query": "how long to cool a burn under running water"}',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, phrased as the topic or question' },
        pack: {
          type: 'string',
          description: 'Optional pack id to search only that pack (from a previous result); omit to search all'
        },
        max_passages: { type: 'number', description: 'How many passages to return (default 6, max 12)' }
      },
      required: ['query']
    },
    // v1.5: on by default — it reads only the user's own installed packs and
    // never touches the network, so there is nothing to consent to.
    toggleDefault: true,
    // Local and cheap, but a model that keeps rephrasing the same lookup is looping.
    turnBudget: 3,
    isSource: true
  }
] as const satisfies readonly ToolMeta[]
