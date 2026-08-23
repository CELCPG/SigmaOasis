import type { ToolMeta } from '../types'

export const workbenchToolDefs = [
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
