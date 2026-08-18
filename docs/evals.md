# Measuring the app, not describing it

Three harnesses, all live against a locally loaded model, all gated behind `LMSTUDIO_EVAL=1`
so CI stays offline. Scoring is mechanical in every one: no model grades another model's answer.

| Harness | What it measures | Command |
| --- | --- | --- |
| Tool choice (v1.3) | correct-tool, spurious-call, arg-validity, loop rates over 24 fixtures | `LMSTUDIO_EVAL=1 npm run eval:tools -- <model>` |
| Library grounding (v1.6) | does an offline reference question get answered from the retrieved passages, cited, with no invented measurement | `LMSTUDIO_EVAL=1 EVAL_SUITES=library npm run eval:answers -- <model>` |
| Quantitative + deliberation (v1.6) | the number right or wrong, **bare vs. with the Workbench**, and the same draft after one think-harder pass | `LMSTUDIO_EVAL=1 EVAL_SUITES=quant,deliberate npm run eval:answers -- <model>` |
| Multi-turn analysis (v1.8) | follow-up questions over one dataset, **sessions vs. stateless**: per-turn correctness, whether follow-ups re-read the file, calls and seconds per turn | `LMSTUDIO_EVAL=1 EVAL_SUITES=multiturn npm run eval:answers -- <model>` |

`EVAL_CASES=1-8` runs a 1-based inclusive slice, so a slow model can be evaluated in chunks that
each fit a time budget. Results are written to `.eval-results/*.json` — including each case's
reply, the passages retrieved and the ranking mode, so a failure can be *read* rather than guessed
at. Fixtures live in `test/fixtures/{library,quant}/`; `test/answerEval.test.ts` pins both the
scoring and the fixtures' well-formedness.

`EVAL_PASSES=3` (v1.7.1) repeats each suite and reports **per-case stability**: cases that pass in
every pass, fail in every pass, or flip — with the flaky ones named and a median over passes. This
exists because three single runs during the v1.7 retrieval work produced mostly-disjoint failure
sets at temperature 0: cases flipped with *identical retrieval*, so a ±3-case movement between two
single runs says nothing. Judge a change by the stable set; treat the flaky list as the suite's
measured noise floor.

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

### v1.7 retrieval change, re-measured

The wrong-section failure was mechanical: "### Boiling" is a ~200-character section, chunks were
~1,000 characters, so passages blended sections and their embeddings matched nothing crisply.
v1.7 makes chunking **section-aware** (no chunk spans a heading boundary) and caps lookups at
**one passage per (document, section)** — the first change alone made adjacent chunks of a strong
section crowd out other sections, which is the inverse disease; both are pinned by unit tests.

Three full 28-case runs, same model, temperature 0:

| run | answered | cited | unsupported |
| --- | --- | --- | --- |
| baseline (pre-v1.7) | 25/28 | 26/28 | 1/28 |
| section chunks only (run overlapped other LM Studio use) | 22/27 | 21/27 | 1/27 |
| section chunks + per-section cap, clean | 23/28 | 22/28 | **0/28** |

What actually changed, case by case, matters more than those totals:

- **Both recorded wrong-section failures were fixed.** The nosebleed case passes in every v1.7
  run; the boil-water case stopped stating unsupported figures (the chlorination bleed-through it
  was recorded for), and unsupported measurements went to **0/28**.
- **The aggregate did not improve, and the reason is variance, not retrieval.** The three runs'
  failure sets are mostly disjoint: cases 07, 19 and 26 passed twice and then failed with
  *identical retrieval*, at temperature 0 — one reply emitted a tool call as prose text, one
  summarized half the retrieved section and stopped, one echoed the app's own turn-notes header
  and asked a question instead of answering. A ±3-case movement on this suite is within
  run-to-run noise; treat single runs accordingly.
- **The suite again earned its keep by failing things that are not retrieval:** the stroke case
  fails whenever the model quotes the pack *verbatim* — as the grounding rules demand — because
  the pack document itself reads "F ace drooping" (the pack builder split the styled FAST
  letters). A model doing the right thing against a defective document; the defect is the
  builder's, filed separately, along with a reply-echo guard for the turn-notes header.

**Quantitative + deliberation — all 20 cases, with the sandbox verified before the run:**

| arm | all cases | same cases, both arms | s/case |
| --- | --- | --- | --- |
| bare (no tools) | 10/18 · 56% | 10/18 · 56% | 29.5 |
| with the Workbench | **20/20 · 100%** | **18/18 · 100%** | 39.9 |
| bare + one think-harder pass | 9/14 · 64% | 9/14 (no change) | 76.4 |

Split by kind, which is where the shape of it lives:

| | bare | with the Workbench |
| --- | --- | --- |
| arithmetic, units, dates (14) | 10/12 · 83% | 14/14 · 100% |
| over a 400-row CSV (6) | **0/6 · 0%** | **6/6 · 100%** |

The CSV row is the whole argument for the Workbench in one line: not a single one of those six
questions is answerable without executing something, and every one of them is answerable with it.
The model used 1–3 tool calls per case. The cost is **+10 seconds a case**.

Deliberation revised 7 of 14 drafts and changed no score — and, importantly, **broke nothing**: no
case that was right bare became wrong after review. On this suite it is a null result at 2.6× the
latency, which is worth knowing before recommending it as a default; the cases it might help
(reasoning, not arithmetic) are not what this suite measures.

Denominators differ because an arm that errored is excluded rather than scored as a failure: six
calls hit a transport drop, each retried once, and two still failed. The first case pays a cold
model load (31.6 s against a 28.6 s median).

**Multi-turn analysis (v1.8) — 5 cases × 3 turns, sessions vs. stateless.**

Both arms run identical fixtures through the identical agent loop, with the app's data-analysis
playbook injected per turn exactly as the app does it; the only differences are the `run_python`
session key and a truth-telling tool description per arm (the stateless arm's schema says "Fresh
globals each run", and its playbook omits the session step). Three passes each; every figure
below is aggregated over all three.

The v1.8.0 first measurement (one pass, and — corrected since — *without* the playbook, so it
measured a bare persona rather than the app) found session follow-ups re-reading the data file
6/10 times. v1.8.1 addressed that habit with one playbook step ("run_python keeps its variables …
check the Session variables list before reading a file again") and measured it properly:

| | first turn | follow-ups | follow-up re-reads | s/turn | calls/turn |
| --- | --- | --- | --- | --- | --- |
| session, before the step | 12/15 | 30/30 | **30/30 · 100%** | 48.5 | 1.58 |
| session, with the step | 14/14 | 26/27 | **18/27 · 67%** | 47.0 | 1.49 |
| stateless (control), before | 13/15 | 28/29 | 29/29 · 100% | 46.9 | 1.52 |
| stateless (control), after | 10/12 | 29/29 | 29/29 · 100% | 43.1 | 1.44 |

- **The step works and the effect is the step's**: session follow-up re-reads fell from 100% to
  67% while the stateless control stayed at 100% in both runs. In the "after" run one case
  re-read nothing on any follow-up and another re-read once.
- **Nothing broke**: 26/27 follow-ups vs 30/30 is one turn, and the stability report names it
  flaky (`04-expenses-drill.json#3`) — the ±1 that multi-pass measurement exists to catch.
- **The habit is narrowed, not closed.** 67% is not 0%: two of five cases still re-read on every
  follow-up when told not to. Instruction beat habit about a third of the time. That remains
  the honest headline, and the suite is now the arbiter for the next attempt at it.
- **A finding about the playbook itself.** With the playbook injected, the *baseline* session
  arm re-read 100% — worse than the playbook-less 60% of the first measurement. Its first step
  ("describe the data before analysing it") reads to a 9B as "re-profile every turn"; the new
  session step counters it. Net: the playbook was roughly neutral for this suite without the
  step and positive with it. The v1.8.0 table is superseded by the one above.
- Denominators vary because errored turns (transport drops, retried once) are excluded, never
  scored as misses. The eval also now **refuses to start** unless the model answers a probe: a
  3-pass baseline whose first call hit a stopped LM Studio server ran for 90 minutes and
  produced 0/0 across the board — correctly excluded, but an hour and a half to learn what one
  probe learns in a second.

**Conversation ledger (v1.9) — 3 cases × 5 turns, ledger vs. bare, three passes:**

Turn 1 establishes a fact with `run_python`, two off-topic turns bury it, then one or two turns
ask for it back — or for arithmetic on it — without restating it. Both arms are identical
(sessions on, playbook on) except that one receives the ledger block from the fourth turn.

| arm | fact established | recall | recall turns answered directly (no code) |
| --- | --- | --- | --- |
| ledger | 9/9 | **15/15** | 9/15 |
| bare | 9/9 | **15/15** | 6/15 |

Stable across all three passes (0 flaky in either arm) — and, for correctness, a **null result**.
The bare arm recalled everything too, and the results file shows why: five turns is short enough
that the turn-1 tool result (`total revenue: 139306.12`) is still sitting in the wire history, so
the model reads it back or simply re-runs the Python (41 s on that turn vs 17 s for the ledger
arm, which answered from the block). The ledger arm answered directly more often and faster on
recall turns; on correctness it had nothing to fix, because nothing was lost.

Which is the honest finding: **this suite measures the wrong regime.** The ledger's claim is
about conversations long enough for a small model to have *lost* the fact — either compacted out
of the window or drowned in twenty turns of other material. Five turns tests neither. The suite
stays (it pins that the ledger does no harm and that the wiring reaches the model), and a
long-regime variant — enough filler to force compaction, so the establishing turn is genuinely
gone from history — is the measurement that would actually decide the feature's value. Recorded
here rather than quietly re-fixtured until it flatters.

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
- **The Workbench makes numbers traceable, not meaningful — and nothing here catches the
  difference.** Routed a 400-row sales file, a 9B answered with every revenue figure exactly right
  and one figure badly wrong: *"$2,787.2 per unit"*. Its pandas had `.sum()`-ed the `unit_price`
  column along with units and revenue, then printed it as a per-unit price; the reply repeated its
  own tool output faithfully. Tool grounding passed it, correctly by its own rule — 2787.2 *is* in
  the tool output. Provenance checking cannot see a mislabelled aggregation, and no mechanical check
  in this app can. The mitigation is a rule in the Data Analyst prompt and the data playbook
  ("never aggregate a price or rate column with sum()"), which is a prompt, which is a preference —
  so this stays on the list of things only a reader catches.
- **Withdrawn: "having the tool is not using it."** An earlier run recorded the model calling
  `run_python` on the mortgage case and still answering from prose algebra ($2,468.46 against a
  true $2,420.82), which read as a finding about tool discipline. It was not. That run's sandbox
  was the broken one below: the call returned "runtime not installed" in 0 ms, so falling back to
  prose was the *correct* response to a dead tool. With a working sandbox the same case computes
  $2,420.82. Recorded here because a flattering-sounding lesson that the evidence does not support
  is exactly what an eval exists to prevent.
- **A retrieved document is not a retrieved answer.** "My nose is bleeding, what do I do?" pulls
  five passages from the right document — but MMR's diversity spent them on *Go to A&E if*, the
  video caption and aftercare, crowding out the section that says to pinch for 10–15 minutes. The
  reply was useful and honest but missed the step the user needed. Noted rather than tuned away:
  changing ranking on the strength of one case is how an eval stops measuring anything.
