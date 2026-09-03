import type { ToolMeta } from '../types'

export const workbenchToolDefs = [
  {
    name: 'run_code',
    label: 'Code Mode: a Python program that calls the app\'s tools (per-slot mode)',
    description:
      'Run a Python program in the sandbox that can call the app\'s tools as functions: the module `tools` ' +
      'in /work has one coroutine per tool — `await tools.web_search(query=...)`, `await tools.reference_lookup(query=...)`, ' +
      '`await tools.read_file(path=...)` and the rest; `print(tools.__doc__)` or `help(tools)` lists them with their ' +
      'parameters. Each call is a real tool call: the same allowlist, per-turn budget and record as calling the tool ' +
      'directly, and a refused or failed call raises tools.ToolError. Print what you want to report; stdout is the ' +
      'result.\n' +
      'Use when: the answer needs several tool calls whose results feed each other — search, then read the best ' +
      'page, then compute over what it says — and one program states the whole method.\n' +
      'Do not use when: one tool call answers the question (call it directly), or the work is pure computation on ' +
      'attached data (run_python).\n' +
      'The sandbox has no network of its own; everything reaches the outside world through `tools`, or not at all.\n' +
      'Example: {"code": "r = await tools.web_search(query=\\"Nordvik Trekker 40 price\\")\\nprint(r[:800])"}',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source; top-level await is allowed. Print the result.' },
        timeout_seconds: { type: 'number', description: 'Wall-clock limit per program segment between tool calls (default 60, max 180)' }
      },
      required: ['code']
    },
    toggleDefault: true,
    turnBudget: 3,
    isSource: true,
    emptyResultLead: 'The program printed nothing'
  },
  {
    name: 'run_python',
    label: 'Run Python (sandboxed WebAssembly runtime — no network, no access to your disk)',
    description:
      'Run Python code in a local sandbox and get back stdout, the last expression, and any files ' +
      'it wrote (images are shown to the user — save a matplotlib figure to a .png to show a chart). ' +
      'Python 3 with the standard library plus numpy, pandas and matplotlib; no internet, ' +
      'no access to the user\'s disk. Variables PERSIST between run_python calls in this ' +
      'conversation (like a REPL): a dataframe loaded once stays loaded — build on it instead of ' +
      're-reading files, and the result lists the variables currently defined. If the result says ' +
      'the session was reset, re-run your setup. Files the user attached to the ' +
      'conversation are placed under /work/<name> for every run (open("/work/sales.csv")).\n' +
      'Use when: the answer needs arithmetic beyond a single step, unit conversion, dates, ' +
      'statistics, sorting or aggregating data, parsing text, or checking a result — compute it, ' +
      'do not estimate it. Also to verify a calculation you are about to state.\n' +
      'Do not use when: finance_calculator or date_calculator already does the exact job; or the ' +
      'user needs a shell on their machine (run_terminal_command). Do not use it to reach the ' +
      'network — it cannot; for market prices call market_data, which stages the series at /work/<SYMBOL>.csv.\n' +
      'Print what you need to see, or end with an expression. Keep runs short (default limit 60 s).\n' +
      'Example: {"code": "prices=[2.40/3]*17\\nprint(round(20-sum(prices),2))"}',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source to execute' },
        timeout_seconds: { type: 'number', description: 'Wall-clock limit for this run (default 60, max 180)' }
      },
      required: ['code']
    },
    // v1.6: on by default — sandboxed by construction, touches nothing outside the app.
    toggleDefault: true,
    // Local, but each run is a model round trip; four is plenty for write → fix → verify.
    turnBudget: 4,
    isSource: true
  },
  {
    name: 'analyze_file',
    label: 'Analyze attached data files (CSV/TSV/JSON/XLSX profile, computed in the same sandbox)',
    description:
      'Profile an attached CSV, TSV, JSON or XLSX file mechanically: rows and columns, each ' +
      'column\'s inferred type, non-null and null counts, min/max/mean/median/sum for numbers, ' +
      'top values for text, duplicate rows, and the first rows. Computed by code, no guessing. ' +
      'The file is available afterwards to run_python at /work/<name>.\n' +
      'Use when: the user attached a data file and asks anything about it — start here, before ' +
      'any analysis, so you know its shape and types.\n' +
      'Do not use when: no file is attached, or the file is prose (read it instead).\n' +
      'Example: {"file": "sales.csv"}',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Name of the attached file (as attached). Optional when only one file is attached.' },
        sheet: { type: 'string', description: 'XLSX only: sheet name (default: the first sheet)' }
      },
      required: []
    },
    toggleDefault: true,
    turnBudget: 2,
    isSource: true
  }
] as const satisfies readonly ToolMeta[]
