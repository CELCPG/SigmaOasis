# Measuring the app, not describing it

Three harnesses, all live against a locally loaded model, all gated behind `LMSTUDIO_EVAL=1`
so CI stays offline. Scoring is mechanical in every one: no model grades another model's answer.

| Harness | What it measures | Command |
| --- | --- | --- |
| Tool choice (v1.3) | correct-tool, spurious-call, arg-validity, loop rates over 24 fixtures | `LMSTUDIO_EVAL=1 npm run eval:tools -- <model>` |
| Library grounding (v1.6) | does an offline reference question get answered from the retrieved passages, cited, with no invented measurement | `LMSTUDIO_EVAL=1 EVAL_SUITES=library npm run eval:answers -- <model>` |
| Quantitative + deliberation (v1.6) | the number right or wrong, **bare vs. with the Workbench**, and the same draft after one think-harder pass | `LMSTUDIO_EVAL=1 EVAL_SUITES=quant,deliberate npm run eval:answers -- <model>` |

`EVAL_CASES=1-8` runs a 1-based inclusive slice, so a slow model can be evaluated in chunks that
each fit a time budget. Results are written to `.eval-results/*.json` — including each case's
reply, the passages retrieved and the ranking mode, so a failure can be *read* rather than guessed
at. Fixtures live in `test/fixtures/{library,quant}/`; `test/answerEval.test.ts` pins both the
scoring and the fixtures' well-formedness.

## What each suite judges

**Library grounding** (28 cases across the seven curated packs). The app's own app-initiated
lookup runs, the passages ride the turn exactly as the app builds it (grounding block + playbook +
turn notes), and the reply is scored on four mechanical questions: were passages retrieved at all;
does the reply contain the facts the case requires (regex); does it cite a real document title or
bracket; and does it state a **measurement the passages do not contain** — the dangerous class,
where an invented duration or dose is worse than no answer. `mustNotInclude` catches the specific
wrong answer where one exists ("put ice on a burn").

**Quantitative** (20 cases: 14 arithmetic/units/dates, 6 over a 400-row CSV). Every expected value
was computed independently when the fixture was written, so the eval knows the answer. Each case
runs twice: **bare** (no tools at all — what the weights alone do) and **with the Workbench**
(`run_python` and `analyze_file` really executing in the sandbox, not stubbed). The delta between
those two columns is the concrete meaning of "the app makes a small model smarter".

**Deliberation.** The bare draft is put through one think-harder pass and re-scored, reported as a
delta and a cost in seconds. With a single model loaded this is the *self-review* arm — the weaker
half of that feature — and the report says so.

## Caveats, printed with every run

- Temperature is pinned to 0 for reproducibility; the app uses each slot's sampling.
- The library suite installs `packs/` into `.eval-library/` and **embeds them once** (cached
  between runs). `EVAL_EMBED=0` measures the keyword-only state a pack is in the moment it is
  installed — see below, the two differ sharply.
- The tool-choice suite feeds canned tool results; the answer suites execute for real.

## Measured, 2026-08 (qwythos-9b, temperature 0)

**Library grounding — all 28 cases, hybrid retrieval:**

| | result |
| --- | --- |
| retrieved passages | 28/28 · 100% |
| answered (every required fact) | 25/28 · 89% |
| cited the source | 26/28 · 93% |
| stated an unsupported measurement | 1/28 · 4% (lower is better) |
| | 80.6 s/case |

Two of the three unanswered cases are the same failure: retrieval found the right *document* and
spent its five passages on the wrong *sections*. The one unsupported figure ("6%", "30 minutes" on
a boil-water question) came from the chlorination passage the lookup surfaced instead of the
boiling one — precisely the class that check exists to catch.

Quantitative numbers are pending a re-run: the first attempt measured a **broken** sandbox (see
below), and its Workbench column is withdrawn rather than corrected — a column measured against a
tool that failed in 0 ms is not a smaller number, it is a different experiment.

## Findings worth keeping

- **Embedding a pack is not optional in practice.** Keyword-only, "I spilled boiling water on my
  forearm" retrieves *water purification* passages — "boiling water" is the strongest lexical
  signal in the question and the corpus has a whole document about boiling water. The model
  correctly refused to answer from them (the grounding rules working as intended), but the library
  had failed it. With the packs embedded the same question retrieves Burns and scalds and the case
  passes. Measured on a 9B: 1/3 → 2/3 answered and 2/3 → 3/3 cited across the first three cases.
- **An eval must fail loudly when its subject is absent.** The first full quantitative run scored
  a Workbench column against a sandbox that was never there: `pyodideDir()` resolves from
  `app.getAppPath()`, which under `.eval-build/scripts` points at a directory that does not exist,
  so every `run_python` failed in 0 ms with "Workbench runtime not installed". All six CSV cases
  failed, one case spent 33 minutes retrying, and the summary still printed a rate. The suite now
  sets the runtime path explicitly and **refuses to run the quantitative arm unless the sandbox
  computes `2+2` first**, printing the version and package list it verified.
- **A "must not" pattern has to know about negation.** Two fixtures scored the model wrong for
  being right: one forbade "counter" and flagged *"Never thaw food on the counter"*; the other
  forbade "windows" and flagged *"Stay away from windows"*. More lookaheads is the wrong fix —
  negation lands on either side of the word. `mustNotAssert` now means "asserted somewhere no
  negation cue shares its sentence", which also lets "cook to 165°F, **not** 145°F" pass. Both
  verbatim replies are pinned as tests; re-scoring the completed run drops the flagged cases from
  2 to 0.
- **Having the tool is not using it.** On the mortgage-payment case the model called
  `run_python` once and *still* answered from prose algebra — $2,468.46 against a true
  $2,420.82 — in both the bare and Workbench arms. The tool was present, invoked, and ignored.
  This is the failure the tool-choice eval cannot see, because that suite scores the *choice*.
- **A retrieved document is not a retrieved answer.** "My nose is bleeding, what do I do?" pulls
  five passages from the right document — but MMR's diversity spent them on *Go to A&E if*, the
  video caption and aftercare, crowding out the section that says to pinch for 10–15 minutes. The
  reply was useful and honest but missed the step the user needed. Noted rather than tuned away:
  changing ranking on the strength of one case is how an eval stops measuring anything.
