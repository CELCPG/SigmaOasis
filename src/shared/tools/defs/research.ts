import type { ToolMeta } from '../types'

export const researchToolDefs = [
  {
    name: 'deep_research',
    label: 'Deep research (multi-step: plans, searches, reads and cites sources)',
    description:
      'Research a question thoroughly and get back a cited brief. Plans sub-questions, runs ' +
      'several searches, reads and ranks the best sources, checks what is still unanswered, and ' +
      'synthesizes an answer with numbered citations — all in one call. Returns untrusted ' +
      'external content.\n' +
      'Use when: the question needs more than one or two sources — comparisons, pros and cons, ' +
      'anything that deserves citations. It reads far more material than fits in this ' +
      'conversation and returns only the findings.\n' +
      'Do not use when: a single quick lookup suffices (web_search), or you already hold the ' +
      'one URL that matters (fetch_webpage).\n' +
      'Pass the full question in one self-contained sentence; no personal data.\n' +
      'Example: {"question": "What are the pros and cons of heat pumps versus gas furnaces in cold climates?"}',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The complete research question, self-contained — it is not answered in the context of ' +
            'this conversation. No personal data.'
        },
        depth: {
          type: 'string',
          enum: ['quick', 'standard', 'thorough'],
          description:
            'How much to spend. quick = ~4 sources, standard = ~10, thorough = ~16. ' +
            'Defaults to the user\'s configured setting.'
        }
      },
      required: ['question']
    },
    toggleDefault: true,
    untrusted: true,
    // One campaign per turn.
    turnBudget: 1,
    isSource: true,
    // v2.3: a campaign that searched and read and came back with no usable
    // source worked; it just supplied nothing. It used to return that as an
    // error, so the row wore `✗` and the "Checked against" footer said
    // `deep_research (errored)` over a row reading "No usable sources were
    // found" — one call, two accounts (FR3, `.h2h-runs/B10/FR3-20260827-224622`).
    emptyResultLead: 'No usable sources were found'
  }
] as const satisfies readonly ToolMeta[]
