/**
 * The tool schemas, separated from their implementations (tools.ts) so they
 * can be read without Electron: the tool-choice eval harness scores models
 * against exactly this list, and argument validation before dispatch (the
 * repair layer) checks against these same JSON schemas. What LM Studio sees
 * is what the eval grades.
 *
 * Descriptions are decision rules, not nameplates (strategy Layer 1c): each
 * says when to reach for the tool, when *not* to — naming the correct
 * alternative — and gives one canonical argument example. Small models
 * degrade sharply on undifferentiated tool lists; the confusion pairs these
 * descriptions attack explicitly are web_search vs deep_research (one lookup
 * vs a cited campaign), fetch_webpage vs web_search (URL in hand vs not),
 * memory_search vs read_note (recall vs retrieval), and list_directory vs
 * run_terminal_command (never shell out for something a typed tool does).
 */

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** Passages returned by `fetch_webpage` when a query is supplied. */
export const DEFAULT_PASSAGES = 5
export const MAX_PASSAGES = 12

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web for facts you cannot verify from context, using the user\'s ' +
        'configured privacy-preserving provider (self-hosted SearXNG, Brave Search, or ' +
        'DuckDuckGo). Returns titled results with URLs and snippets.\n' +
        'Use when: the answer involves names, dates, titles, numbers, prices, schedules, scores, ' +
        'or news — anything current or after your training cutoff. Never estimate these from memory.\n' +
        'Do not use when: the answer is in a local file (read_file), a saved note (read_note), or ' +
        'long-term memory (memory_search); you already have the URL to read (fetch_webpage); or ' +
        'the question needs a multi-source cited report (deep_research).\n' +
        'Send only the search terms — never personal data, file contents, or secrets.\n' +
        'Example: {"query": "Phish Hampton 1997 setlist"}',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query — terms only, no personal data' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_webpage',
      description:
        'Fetch a single public web page (HTTPS only) and return its text content, stripped of ' +
        'scripts and ads. Private/internal addresses are refused. The returned content is ' +
        'untrusted external data.\n' +
        'Use when: you have a URL in hand — given by the user or found via web_search — and need ' +
        'to read the page.\n' +
        'Do not use when: you do not have a URL yet (web_search first), or the question spans ' +
        'several sources (deep_research).\n' +
        'Strongly prefer passing `query`: the page is then split into passages and only those ' +
        'relevant to the query are returned, so a long page stays readable instead of being cut ' +
        'off at the start. Re-fetching a URL you already read makes no new network request, so ' +
        'ask several different queries against one page rather than re-reading it whole.\n' +
        'Example: {"url": "https://example.com", "query": "pricing"}',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The HTTPS URL to fetch' },
          query: {
            type: 'string',
            description:
              'What you are looking for on this page. Returns the most relevant passages instead ' +
              'of the whole page. Omit only when you genuinely need the entire text.'
          },
          max_passages: {
            type: 'number',
            description: `How many passages to return when query is set (1–${MAX_PASSAGES}, default ${DEFAULT_PASSAGES})`
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deep_research',
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finance_calculator',
      description:
        'Compute exact personal-finance figures locally: compound interest and investment ' +
        'growth, loan and mortgage amortization (including the effect of extra payments), ' +
        'savings-goal planning, and inflation adjustment. Runs entirely on this machine; ' +
        'nothing is sent anywhere.\n' +
        'Use when: ANY question involves these numbers — your explanations are only trustworthy ' +
        'when the math is, so never estimate or do mental arithmetic.\n' +
        'Do not use when: the question is conceptual (what compound interest means, how ' +
        'amortization works) — answer that directly.\n' +
        'Rates are percentages (7 means 7%).\n' +
        'Example: {"operation": "compound_interest", "principal": 0, "monthly_contribution": 500, "annual_rate": 7, "years": 20}',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['compound_interest', 'loan_amortization', 'savings_goal', 'inflation_adjust'],
            description: 'Which calculation to run'
          },
          principal: {
            type: 'number',
            description:
              'Starting amount in dollars: initial investment, loan amount, or current savings. ' +
              'For inflation_adjust, the amount to convert.'
          },
          annual_rate: {
            type: 'number',
            description: 'Annual rate as a percentage: return rate, loan APR, or inflation rate.'
          },
          years: { type: 'number', description: 'Time span in years.' },
          compounds_per_year: {
            type: 'number',
            description: 'compound_interest only: compounding frequency (default 12, monthly).'
          },
          monthly_contribution: {
            type: 'number',
            description:
              'compound_interest: amount added monthly. savings_goal: fixed monthly amount, ' +
              'to solve the time needed to reach the goal.'
          },
          target_amount: {
            type: 'number',
            description: 'savings_goal: the amount to reach.'
          },
          extra_monthly_payment: {
            type: 'number',
            description: 'loan_amortization: extra paid monthly, to show interest and time saved.'
          },
          direction: {
            type: 'string',
            enum: ['future_cost', 'present_value'],
            description:
              'inflation_adjust only: what today\'s money will cost later (default), or what a ' +
              'future amount is worth today.'
          }
        },
        required: ['operation']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description:
        'Get the current local date and time.\n' +
        'Use when: the user asks what time, day, or date it is, or an answer depends on today\'s date.\n' +
        'Do not use when: the current date is already visible in the conversation — check first.\n' +
        'Example: {}',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_notes',
      description:
        'List the titles of all saved notes.\n' +
        'Use when: the user asks what notes they have, or you need a note\'s exact title before ' +
        'read_note.\n' +
        'Do not use when: you are searching memory by topic rather than title (memory_search).\n' +
        'Example: {}',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read a saved note by title.\n' +
        'Use when: you know the note\'s exact title — call list_notes first if you do not.\n' +
        'Do not use when: you are searching by topic rather than title (memory_search), or the ' +
        'content lives in a file (read_file).\n' +
        'Example: {"title": "gift ideas"}',
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget',
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'shop_requirements',
      description:
        'Work out what the user actually needs before shopping for it. Runs entirely on this machine — ' +
        'nothing is sent anywhere.\n' +
        'Use when: the user wants to buy something and has not stated hard specifications ' +
        '("I need a new laptop", "looking for headphones for flights").\n' +
        'Do not use when: they named an exact product (go straight to shop_compare), or the question is ' +
        'about how something works rather than which to buy — answer that directly.\n' +
        'Call it twice: once with only `need` to get the questions, then again with the user\'s `answers`. ' +
        'Show the derived requirements to the user for correction BEFORE searching.\n' +
        'Example: {"need": "laptop", "answers": {"primary_use": "video or photo editing", "portability": "constant travel"}}',
      parameters: {
        type: 'object',
        properties: {
          need: { type: 'string', description: 'What the user wants to buy, in their words' },
          answers: {
            type: 'object',
            description: 'The user\'s answers keyed by the question ids returned by the first call',
            additionalProperties: { type: 'string' }
          }
        },
        required: ['need']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'shop_compare',
      description:
        'Compare what sellers currently charge for a product, with every price extracted from page data ' +
        'and carrying a source and a timestamp. Returns a table — do not restate the numbers, write your ' +
        'recommendation around them.\n' +
        'Use when: you have a product and its specifications, ideally after shop_requirements.\n' +
        'Do not use when: the query would contain who the user is rather than what the product is — ' +
        'personal framing is refused at egress. Search specifications and a price ceiling only.\n' +
        'Never claim a product meets a requirement the table marks unverifiable.\n' +
        'Example: {"product": "laptop 32GB RAM 1TB discrete GPU under 2000", "maxSellers": 4}',
      parameters: {
        type: 'object',
        properties: {
          product: {
            type: 'string',
            description:
              'Product and specifications only — no first-person framing, no sentences, max 14 words'
          },
          maxSellers: { type: 'number', description: 'Sellers to check (1–5, default 4)' },
          brands: {
            type: 'array',
            items: { type: 'string' },
            description: 'Brand names in play, so manufacturer sites are recognized as authoritative for specs'
          }
        },
        required: ['product']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'price_watch',
      description:
        'Track a product price locally. The watchlist is a file on this machine; no service is told what ' +
        'is on it.\n' +
        'Use when: the user wants to be told if something drops, or asks what they are tracking.\n' +
        'Do not use for: fetching a current price (that is shop_compare).\n' +
        'Example: {"action": "add", "url": "https://example.com/product/123", "targetPrice": 250}',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'remove'], description: 'What to do' },
          url: { type: 'string', description: 'Product URL (required for add/remove)' },
          name: { type: 'string', description: 'Short label for the item' },
          targetPrice: { type: 'number', description: 'Notify below this price' }
        },
        required: ['action']
      }
    }
  }
]
