# The Workbench — sandboxed Python (v1.6)

`run_python` lets a model compute instead of estimate: arithmetic, unit conversion, dates,
statistics, parsing, and checking a result it is about to state. It is the *computation* leg of
the small-model strategy (STRATEGY-depth-and-reasoning.md, Feature B).

## How it is sandboxed

Python runs as **Pyodide** — CPython compiled to WebAssembly — inside a hidden, sandboxed Electron
window (`src/main/ipc/workbench.ts`):

- `sandbox: true`, context isolation, no Node integration. The page has a DOM and nothing else;
  Python's `js` bridge reaches only that page.
- Its own session, whose every request not on the app's `sigma-workbench://` scheme is refused,
  and a CSP saying the same (`connect-src 'self'`). No permissions are granted. The check suite
  proves it: `urllib` cannot reach even loopback, and `js.fetch` is blocked.
- A virtual filesystem. Inputs the app provides appear under `/work`; files the code writes there
  come back (bounded: 24 files / 8 MB). The host's disk is never mounted — `/Users`, `/etc/passwd`
  do not exist inside.
- One job at a time; a job over its budget (default 60 s, max 180 s) has its window destroyed
  and the next job gets a fresh sandbox.
- **Sessions (v1.8):** `run_python` runs in a session scoped to the conversation — globals and
  `/work` persist between calls with the same key, like a REPL, so a follow-up filters the
  dataframe already loaded instead of re-writing the preamble. A different conversation (or the
  newest one — only one session lives at a time), a sandbox restart, or the idle teardown resets
  it, and a reset is *disclosed in the tool result* so the model re-runs its setup instead of
  hitting NameError blind. Each result also lists the session's defined variables. Everything
  else — `analyze_file` profiles, the verification recompute and code checks, docx extraction —
  runs sessionless with fresh globals by construction: a check that could see session state
  would not be checking the reply.
- The idle sandbox is torn down after ten minutes (it holds ~150 MB) and never keeps the app
  alive after the last real window closes.

## The runtime files

`resources/pyodide/` — fetched once by `bash scripts/fetch-pyodide.sh` (pinned version, ~30 MB:
the core runtime plus offline wheels for **numpy, pandas and matplotlib** and their dependency
closure, resolved from the release's lock file; `WORKBENCH_PACKAGES` changes the set). Packaged
builds ship it as an extra resource; the app never downloads anything at run time. Packages load
lazily per job from the local files (`loadPackagesFromImports`), matplotlib runs headless (Agg),
and a module that is not bundled fails as a plain `ModuleNotFoundError` plus a note naming what
is. Measured: numpy ~0.3 s and pandas ~1.2 s on first import in a sandbox, then cached; a
matplotlib figure saved as `.png` appears in the chat as a figure.

## Attachments and analyze_file

Every file attachment keeps its original path; at tool time the conversation's files are staged
under `/work/<name>` (bytes copied into the virtual FS — the disk is never mounted; 40 MB per file,
64 MB per run). A CSV/TSV/JSON attachment inlines only its first lines so the model sees the
columns; `.xlsx` attaches as a data file with no inline text. On the turn a tabular file arrives
the app runs **`analyze_file`** before the model speaks: a stdlib-only Python profile (rows,
columns, inferred types, nulls, min/max/mean/median/sum, top values, duplicates, a head; XLSX read
via `zipfile` + shared strings, sheet selectable), formatted as facts with the rule *"compute
anything further with run_python; do not eyeball totals from the head."* When a data file is in
the conversation, `run_python` and `analyze_file` are forced onto the turn's tool set whatever the
embedding rank says — measured: without that, a 9B model spent five minutes reasoning that it had
no way to compute. Percentages a reply states after a computation ran are checked against the
tool output (stated or derivable as a ratio) by the tool-grounding pass.

Measured in the built app with a 9B model: 400-row `sales.csv` dropped → profiled automatically →
the model called `run_python` → "East, 37,907.39" — exactly right; ~50 s end to end.

## What the model sees

`toolHandlers/workbench.ts` → `workbenchFormat.ts`: stdout, the last expression's `repr`, stderr,
files written (small text files inlined, images handed to the chat gallery), and the standing
rule *"Numbers above were computed, not recalled: state them exactly as shown, with units, and say
they came from running code."* A traceback comes back as a failure the model can read and fix —
*"do not guess at the value it would have produced"*. Computed numbers count as a consulted
source for the grounding badge and as sourced figures for the tool-grounding check.

## Verifying

`bash scripts/test-render.sh` runs `test/workbenchCheck.ts` in Electron proper: round-trip,
tracebacks, fresh globals for sessionless jobs, session persistence/isolation/reset disclosure, `/work` I/O, no disk, no network (two ways), timeout kill and recovery.
It self-skips when the runtime is not fetched.
