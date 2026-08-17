# Sigma Oasis v1.6.0 — the Workbench

v1.5 gave a small model something to read: an offline reference library it cites instead of guessing. This release gives it something to **compute with** — and then turns that against its own answers. A 9–30B model is unreliable at arithmetic and exact at writing the program that does the arithmetic; the Workbench closes that gap with a Python runtime that is sandboxed by construction, wired into attachments, disclosed in the chat, and used by the app as a *verifier*, not just a tool. Every claim below was verified in the built app against a 9B model, and this time there is a number: on 20 quantitative questions that model went from **56% to 100%** with the Workbench, and from **0/6 to 6/6** on the ones that need a 400-row spreadsheet aggregated. Pinned by 1,273 node checks (101 new since v1.5.1) plus 29 real-window Workbench checks.

## Python, sandboxed by construction

- **`run_python`.** The model writes Python; the app runs it and returns stdout, the last expression, and any files the code wrote — a saved matplotlib `.png` appears in the chat as a figure. Python 3 with the standard library plus **numpy, pandas and matplotlib**, all bundled offline (~30 MB, fetched once at build time — the app never downloads anything at run time).
- **The sandbox is a property, not a policy.** Python runs as Pyodide (CPython compiled to WebAssembly) inside a hidden, fully sandboxed window: its own session refuses every network request that is not the app's own scheme serving the runtime files — the check suite proves `urllib` cannot reach even loopback, and neither can the JS bridge — and the filesystem is virtual: inputs are copied in, outputs copied out, and `/Users` does not exist inside. Fresh globals per run; one job at a time; a runaway loop is killed at its budget and the next job gets a fresh sandbox; the idle sandbox is torn down after ten minutes.
- **Settings → Tools says what the runtime is.** A status line with the Pyodide version, whether a sandbox is running or idle (with a *Start now* button to pay the cold start before you need it), and the packages available offline — plus, when the runtime is missing, the path it looked in and the one command that fixes it. What the sandbox can and cannot reach is stated there rather than left to the release notes.
- **The "Ran code" block.** What ran is not hidden behind a collapsed row: the code appears syntax-highlighted with a Copy button, with output, errors, and files written beneath — open by default, because the computation *is* the evidence.

## Attached data files are computed on, not read at

- **A CSV, TSV, JSON or XLSX attachment lands in `/work`** for every run, and the moment a tabular file is attached the app profiles it — **`analyze_file`**, a mechanical pass computed by code with no model call: rows, columns, each column's inferred type, null counts, min/max/mean/median/sum, top values, duplicate rows, and the first rows. The model starts from facts about the file, with the standing rule: *compute anything further with `run_python`; do not eyeball totals from the head.* Spreadsheets are parsed inside the sandbox (`zipfile` + XML — still no new dependency); a CSV inlines only its first lines so the columns are visible without spending the context window.
- **Measured:** a 400-row sales file, "total revenue by region, exact, and a bar chart" → profiled automatically → the model wrote pandas, got told `seaborn` isn't available, rewrote without it, and produced **all four regional totals and the grand total exactly** (checked independently) with the chart inline.
- Three fixes this exercise forced, each now pinned: a request that outgrows the model's loaded context is a stated error instead of a silently empty reply (LM Studio streams the failure *inside* a 200); the Workbench tools are **forced onto the turn's tool list** whenever a data file is attached — without that, the embedding rank once dropped `run_python` and the model spent five minutes reasoning, in its own words, that it had no way to compute; and percentages are now checked too, because a correct computed total came decorated with an invented "about 45% of revenue" (true share: 25.6%).

## The Workbench as a verifier

- **Recompute.** When a reply states figures that nothing computed — or a tool ran and does not support them — the app asks the model for one small Python program that recomputes every stated figure from the question's inputs, runs it (visible as an app-initiated "Ran Python" record), and checks the reply against that output exactly as it checks prices against a pricing tool. Unsupported figures go through the existing one-revision gate, and the revision is handed the recomputed `label: value` lines to substitute.
- **Code check.** A reply containing self-contained Python is run before you trust it. A syntax error, an undefined name, a failed assertion — the model's own errors — become findings sent back for one revision, kept only if the revised code actually runs. Failures that are the sandbox's fault (a file it doesn't have, a module that isn't bundled) are never blamed on the code. Both passes are disclosed under the reply: *🧮 Recomputed the stated figures in Python…*, *🧪 Ran the Python in this reply — it runs without error.*
- **Measured, end to end:** asked for a car's out-the-door total "from your head", the 9B model answered **$31,796.25** — wrong. The app recomputed ($2,347.12 tax; **$31,997.12** total), flagged the model's figures against that output, and the revision substituted the correct number. The reply the user saw was right, said what had been checked, and carried no warning — because after correction none was needed.
- Three small-model failure modes surfaced live and are now guarded mechanically: a recompute program returned without its code fence (accepted by shape); a revision that "fixed" flagged figures by deleting every figure and disclaiming (refused — a flagged answer beats a non-answer); a revision that pasted the checker's own instructions into the chat (refused; the guard shares its markers with the prompt so they cannot drift).

## A Data Analyst role, and routing that reaches it

- **A fifth slot template** (Settings → Models, off by default like the others): a persona that
  starts from `analyze_file`, computes with `run_python`, reports every figure with its unit and
  denominator, says which rows it excluded, and keeps measurement apart from interpretation.
- **A `data` specialty the pre-flight router uses.** Attach a spreadsheet and the turn goes to that
  slot — *"🔀 routed to Data Analyst — data file attached"* — so a data question can be answered by
  a different, usually larger model than the one handling chat. A data file outranks a code or
  finance signal in the same message, because a file genuinely cannot be read by eye; an image still
  outranks everything, because vision is a harder requirement. With no such slot enabled the router
  abstains rather than mis-routing, exactly as it does for the other specialties.
- **Honest limit, found while testing this:** the routed model got every revenue figure in a
  400-row file exactly right and one figure wrong — it summed a price column and labelled the total
  a per-unit price. The grounding check passed it, correctly by its own rule: the number *was* in
  the tool output. Execution makes a figure traceable, not meaningful. There is now a rule against
  it in the prompt and the playbook, and `docs/evals.md` records that a rule is a preference, not a
  guarantee.

## Measured, not asserted

Three eval harnesses ship with this release (`npm run eval:answers`, `npm run eval:tools`), all
scored mechanically — no model grades another model's answer. Against a 9B, temperature 0:

**The Workbench, on 20 questions whose answers were computed independently when the fixtures were written:**

| arm | result | s/case |
| --- | --- | --- |
| bare — no tools | 10/18 · 56% | 29.5 |
| **with the Workbench** | **20/20 · 100%** | 39.9 |
| bare + one think-harder pass | 9/14 · 64% | 76.4 |

| | bare | with the Workbench |
| --- | --- | --- |
| arithmetic, units, dates (14) | 10/12 · 83% | 14/14 · 100% |
| over a 400-row CSV (6) | **0/6 · 0%** | **6/6 · 100%** |

The CSV row is this release in one line: not one of those six questions is answerable without
executing something — the model cannot sum four hundred rows from memory and did not pretend to —
and all six are answerable with it, at one to three tool calls and **ten extra seconds a case**.

**The Almanac, on 28 offline reference questions across the seven curated packs:** passages
retrieved for 28/28, every required fact present in 25/28, a real source cited in 26/28, and
exactly **1 case in 28** stated a measurement its passages did not support — the class where an
invented dose or duration is worse than no answer at all.

**Think harder is reported as the null result it was here:** 7 of 14 drafts revised, no score
changed, and nothing broken — no correct draft became wrong. At 2.6× the latency that is worth
knowing before leaving it on, and this suite measures arithmetic, which is not what a review pass
is for.

Both suites also found faults in *themselves*, which is the point of running them rather than
describing them: a floating-point tolerance that failed a model for answering correctly, a
"must not" pattern that flagged *"Never thaw food on the counter"*, and a whole run scored against
a sandbox that was never loaded — the suite now refuses to start unless it can compute `2+2`
first. `docs/evals.md` has the tables, the caveats and the withdrawals.

## Also in this release (from the v1.5.1 line)

- **🧠 Think harder** — draft → review by a different role (or labelled self-review) → one gated revision, on demand from the composer or any reply.
- **Model profiles** — Settings → Models states each model's family, size, reasoning handling, sampling recipe and tool-calling reliability (measured when the eval has run, otherwise a stated prior).
- **Almanac relevance floor** — a lookup with no close match now says so instead of injecting a lone weak passage normalized to 1.00.

## Upgrade notes

- **New tools, on by default:** `run_python` and `analyze_file` (Settings → Tools) — sandboxed, local, no network. **New setting, on by default:** *Workbench checks* (Settings → Models). Off switches exist for all of it.
- **Building from source:** run `bash scripts/fetch-pyodide.sh` once (CI and the release workflow do this themselves). The evals are developer-facing and need a live LM Studio: `LMSTUDIO_EVAL=1 npm run eval:answers -- <model-id>`. Without the runtime the tools report themselves unavailable and the check suite self-skips; nothing else changes.
- **Disk/size:** the runtime adds ~30 MB to the installed app, loaded into memory only while the sandbox is warm and freed after ten idle minutes.
- **macOS:** signed and notarized; Apple Silicon and Intel DMGs. Also `brew tap CELCPG/tap && brew install --cask sigma-oasis`. **Windows:** unsigned installer, SmartScreen will warn. **Auto-update** from v1.5.x.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.5.1...v1.6.0
