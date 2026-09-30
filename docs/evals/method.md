# Measuring the app, not describing it

Part of the [evals index](../evals.md).

Three harnesses, all live against a locally loaded model, all gated behind `LMSTUDIO_EVAL=1`
so CI stays offline. Scoring is mechanical in every one: no model grades another model's answer.

| Harness | What it measures | Command |
| --- | --- | --- |
| Tool choice (v1.3) | correct-tool, spurious-call, arg-validity, loop rates over 24 fixtures | `LMSTUDIO_EVAL=1 npm run eval:tools -- <model>` |
| Library grounding (v1.6) | does an offline reference question get answered from the retrieved passages, cited, with no invented measurement | `LMSTUDIO_EVAL=1 EVAL_SUITES=library npm run eval:answers -- <model>` |
| Quantitative + deliberation (v1.6) | the number right or wrong, **bare vs. with the Workbench**, and the same draft after one think-harder pass | `LMSTUDIO_EVAL=1 EVAL_SUITES=quant,deliberate npm run eval:answers -- <model>` |
| Deep research (v1.9) | the research brief checked against the passages it was synthesized from — figures, measurements, citations — **rung on vs. off**, against a loopback fixture corpus, never the live web | `LMSTUDIO_EVAL=1 EVAL_SUITES=research npm run eval:answers -- <model>` |
| Reasoning + think-harder (v1.9.1) | multi-step problems with one checkable answer, no tools: **draft vs the same draft after review-and-revise**, counting how often review *fixed* a wrong draft and how often it *broke* a right one | `LMSTUDIO_EVAL=1 EVAL_SUITES=reasoning npm run eval:answers -- <model>` |
| Multi-turn analysis (v1.8) | follow-up questions over one dataset, **sessions vs. stateless**: per-turn correctness, whether follow-ups re-read the file, calls and seconds per turn | `LMSTUDIO_EVAL=1 EVAL_SUITES=multiturn npm run eval:answers -- <model>` |
| Long documents (v2.6) | twelve document-shaped requests with required sections, **bare vs. outlined first then written a section at a time**: every section present, the length reached, the token cap not hit, and no two sections restating one another (highest pairwise cosine over section embeddings) | `LMSTUDIO_EVAL=1 EVAL_SUITES=longform EVAL_LONGFORM_ARMS=bare,outline npm run eval:answers -- <model>` |
| Mid-turn steering (v2.7) | the multi-turn suite with a steer queued at the second turn's first round boundary, through the loop's own hook: **delivered** (the turn reached a boundary), **honoured** (the reply obeyed it), and still answered the question | `LMSTUDIO_EVAL=1 EVAL_SUITES=multiturn EVAL_STEER=1 npm run eval:answers -- <model>` |
| Code Mode (v2.7) | the fact-ledger fixtures with a third arm, `code`: no app-run search and one tool, `run_code`, whose program reaches the web tools through the bridge — answered, searches, programs written and inner calls made, against `bare` | `LMSTUDIO_EVAL=1 EVAL_SUITES=claims EVAL_CLAIMS_ARMS=bare,code npm run eval:answers -- <model>` |
| Fact ledger (v2.6) | twenty questions about fictional entities asked twice in fresh chats against a loopback corpus, **bare vs. with the ledger**: searches and seconds on the second ask, whether it answered from a dated verified claim, and whether the six cases whose page changed (and whose entry expired) surfaced the contradiction | `LMSTUDIO_EVAL=1 EVAL_SUITES=claims EVAL_CLAIMS_ARMS=bare,ledger npm run eval:answers -- <model>` |
| The agent (v3.1) | twenty small repositories, each a task for the shipping agent engine: **solved** (hidden tests, or what the report must say), **false claims** (tests said to pass when the last test run did not), collateral edits, whether Undo restores the folder, and the cost in rounds and minutes | `LMSTUDIO_EVAL=1 npm run eval:agent -- <model>` |

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

**Project-wide recall** (v1.11, opt-in: `EVAL_SUITES=projects`). Each fixture is a project of
sibling chats holding facts, and questions asked in a *fresh* chat in that project — the real shape
of the feature. Two arms, identical but for one thing: the **recall** arm runs the app's own
retrieval over the sibling transcripts and puts the passages on the turn exactly as the app builds
them; the **bare** arm does not.

Half the questions are `control`: their answers are nowhere in the siblings (arithmetic, a
definition). A good result there is the gate staying *shut* and the reply unchanged — injecting
other conversations into a small model's context is exactly the failure `MEMORY_SCORE_FLOOR` exists
to prevent, and a feature that lifts recall while dragging unrelated answers off topic is not a win.
Controls carry `decoys`: project-specific terms whose appearance in a reply means the model was
pulled off the question it was asked.

Retrieval is scored separately from the model, because the two fail differently: **fired on recall**
(did the gate open where the answer was?) and **stayed quiet on control** (did it stay shut where
there was nothing to find?). Those two judge the ranking without the model's competence in the way.

**Market indicators** (v1.12, opt-in: `EVAL_SUITES=market`). Two synthetic tickers whose daily
series are deterministic fixtures in the provider's own payload shape — the provider is never
contacted. Four questions each: relay the tool's computed stats, compute a 20-day SMA, state the
max drawdown, produce a chart. The **tool** arm runs `market_data` (the fixture served through the
app's real parser, formatter and CSV staging) plus `run_python` against the real sandbox; every
expected value is recomputed by the eval in TypeScript from the same bars, so a hit means the
model's number *reproduces from the series*. The **bare** arm gets no tools — and since the tickers
are synthetic, the honest bare answer is "I cannot know": its `declined` rate is the honesty
measure, and any confident figure is a fabrication.

**Deliberation.** The bare draft is put through one think-harder pass and re-scored, reported as a
delta and a cost in seconds. With a single model loaded this is the *self-review* arm — the weaker
half of that feature — and the report says so.

## Caveats, printed with every run

- Temperature is pinned to 0 for reproducibility; the app uses each slot's sampling.
- The library suite installs `packs/` into `.eval-library/` and **embeds them once** (cached
  between runs). `EVAL_EMBED=0` measures the keyword-only state a pack is in the moment it is
  installed — see below, the two differ sharply.
- The tool-choice suite feeds canned tool results; the answer suites execute for real.
