# Measuring the app, not describing it

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
- **v1.8.1 tried the mechanical lever too, and it did not move.** With session variables present
  the ledger now rides from turn 2, leads with the variables, and says plainly: *use them
  directly; do not read the data file again unless a variable you need is missing.* Three
  passes: session follow-up re-reads **22/30 · 73%** (vs 67% with the playbook step alone —
  within noise, not an improvement). Reading the code that ran settled it: turn 1 defined `df`,
  the ledger listed it, and on turns 2 and 3 the model — with "you have `df`, do not read the
  file again" in front of it — still wrote `df = pd.read_csv("/work/expenses.csv")`. Turn 2's
  run took **22 ms**: pandas cached the read, so the re-read costs the model nothing observable,
  and nothing observable is what a habit answers to. Instruction and mechanical nudge have both
  been measured against it now; the honest conclusion is that a 9B's re-read on follow-up is not
  a prompting problem, and the ledger's session line stays because it is *true* (and it is what
  lets a recall turn answer directly), not because it changes this number. The multi-turn runner
  now records each turn's tool code and results so this kind of finding is read, not inferred.
- Denominators vary because errored turns (transport drops, retried once) are excluded, never
  scored as misses. The eval also now **refuses to start** unless the model answers a probe: a
  3-pass baseline whose first call hit a stopped LM Studio server ran for 90 minutes and
  produced 0/0 across the board — correctly excluded, but an hour and a half to learn what one
  probe learns in a second.

**Conversation ledger (v1.9) — ledger vs. bare, three passes each, two regimes.**

Turn 1 establishes a fact with a tool (a total via `run_python` or `analyze_file`; or a stated
budget and deadline), off-topic turns bury it, then one or two turns ask for it back — or for
arithmetic on it — without restating it. Both arms are identical (sessions on, playbook on) except
that one receives the ledger block from the fourth turn on. Only `recall` turns are scored, and
only where the fact was actually established.

*Short regime* (5 turns, the establishing turn still in the wire history): **15/15 vs 15/15** —
a null result, and the reason it was null taught the regime: the bare model reads the turn-1 tool
result back out of history, or simply re-runs the Python. Nothing was lost, so there was nothing
to fix. Kept as the do-no-harm pin.

*Long regime*: six filler turns, and before each recall turn the runner applies the **app's own
`planHistory`** with a budget that fits everything after the establishing exchange and nothing
before it, and asserts the establishing exchange landed in `drop` — the fact is genuinely gone
from what the model can see, exactly as compaction does it. The ledger, as in the app, is built
from the full conversation and is never truncated. That is the property under test.

| long regime, 3 cases × 3 passes | established | recall | stable across passes |
| --- | --- | --- | --- |
| **ledger** | 9/9 | **15/15 · 100%** | 5/5 stable-pass, 0 flaky |
| bare | 9/9 | **3/15 · 20%** | 0 stable-pass, 2 flaky |

Bare's three successes are all case 04 in one pass, and they are not memory: it re-ran the Python
against the still-attached `sales.csv` (69 s on that turn) — a recomputable fact survives
compaction through the *file*, not the history. Where nothing is recomputable (case 06, a stated
budget and deadline) bare said *"I don't have any record of a project with a budget or deadline
in this conversation"* three passes out of three, while the ledger arm said *"You told me at the
start that your budget for this analysis project is $2,000 and the deadline is Friday."*

The first long-regime run scored the ledger 12/15, and reading its one stable miss found a real
gap rather than noise: on the expenses data the 9B never ran Python — it read the total off
`analyze_file`'s profile (`sum 84,284.63`) — and the ledger, which read only `run_python` and
the calculators, recorded no fact. On the recall turn the model then said, truthfully about its
own ledger, "I haven't computed any totals." That the model told the truth about an empty ledger
instead of inventing is the design working; the extractor was too narrow. `analyze_file`'s
per-column stats are now facts, and the re-measurement above is with that fix. The harness also
now stores the injected block and every turn's tool results, because that miss could only be
inferred, not read.

*Decisions* (v1.8.1): the ledger also records the user's choices — "use the median", "go with
West" — verbatim, superseding on the same subject. A long-regime case establishes two decisions
on turn 1 and, after compaction, asks for them back; nothing is recomputable, so bare has no
fallback of any kind. Three passes: **ledger 3/3, bare 0/3**, both perfectly stable. Ledger:
*"You chose to use the median rather than the mean for every summary statistic, and you selected
the West region as the focus."* Bare: *"Nothing yet — I haven't loaded any CSV or computed
anything in this session."*

**What the ledger is worth, in one line:** on conversations long enough for the establishing
turn to have been compacted away, a 9B recalls established facts **100% vs 20%** — and the 20%
is recomputation, not memory.

**Deep research under the ladder (v1.9) — 4 cases × 2 arms × 3 passes, fixture corpus.**

`deep_research` writes its brief with a model from the passages it read, and that brief then
becomes tool output — which every downstream check trusts as its corpus. So a figure the
synthesizer invented passed tool grounding, passed recompute, passed the claim check, and reached
the user wearing a citation. The new rung checks the brief mechanically against its own evidence
inside the tool: every figure, measurement and `[n]` must appear in a passage the run read; one
revision; disclosed first among the tool's notes.

Measured without the live web: a loopback server answers `/search` SearXNG-style over six fixed
pages and serves them; the app's search provider is pointed at it, and its origin is named in
`SIGMA_RESEARCH_FIXTURE_ORIGIN` — the one explicit seam the fetch guards recognize (exact origin,
inert when unset). Everything else is the real pipeline. Cases carry required facts and *decoy*
figures absent from the corpus.

| arm | ran | all facts stated | stated a decoy | unsupported figure | fabricated citation | s/case |
| --- | --- | --- | --- | --- | --- | --- |
| rung on | 12/12 | 12/12 | 0/12 | 0/12 | 0/12 | 125 |
| rung off | 12/12 | 12/12 | 0/12 | 0/12 | 0/12 | 136 |

Stable across all three passes (0 flaky either arm) — and, on this corpus, a **null result on
correctness**: the 9B synthesizer, told to cite only from numbered sources, invented nothing in
24 briefs. The rung flagged 0/12 first drafts because there was nothing to flag. Recorded as
that, not spun: on a six-page corpus of clean facts a well-instructed synthesizer stays honest,
and the rung's value — like the ledger's before its long-regime suite — is in the regime this
suite does not reach: thin or contradictory sources, a model tempted to fill a gap. It is now
*measurable* there, which it was not before, and its unit tests pin exactly what it catches
(invented figures, invented doses, `[7]` when only `[1]`–`[4]` were read).

What the suite *did* find, both real:

- **A product bug in deep research itself.** Instrumenting a run phase by phase: retrieval was
  instantaneous, and 50 of 112 s were two replan rounds that re-asked a sub-question the provider
  had already answered "nothing" — zero fresh candidates each, each a full 9B call taken out of
  the synthesis budget. A round with no new sources now ends the loop and synthesizes from what
  was read (`no new sources` in the disclosure). Same run afterwards: one round, six pages, 92 s.
  On the live web an empty round is rarer; when it happens the same waste applied.
- **A fixture bug, caught by reading a "failure".** Case 04 flagged decoy `5 minutes` in every
  arm, every pass — while the rung said "all supported". The brief said *"2.5 to 3.5 minutes"*,
  verbatim from the corpus; the decoy regex matched the tail of `3.5`. The rung was right and the
  scorer was wrong — the same class as v1.6's "Never thaw on the counter". Decoys are now
  boundary-anchored, and a fixture test fails if any decoy regex matches the corpus itself.

The first two full runs were void — 16 of 24 arms produced no brief, clustered at the wall
clock — because `quick` and `standard` depth leave a 9B on this hardware no room for three model
calls (plan, synthesize, revise). The suite runs `thorough`; the wall clock must not be what it
measures.

### v1.9.1: the thin-sources regime, and what switching models found

The claim above — that the rung's value lies in *thin or contradictory* sources — was unmeasured,
so a second corpus was built for it: a question the pages only partly answer (warranty terms
present, field failure rates explicitly absent), and **two sources that disagree** (30% vs 45%
savings), where a model reconciling helpfully produces 37.5% — a figure in no source, and the
decoy. Each case names its corpus; search only ever offers that corpus.

Measured on `qwen3.8-9b` (the model that was loaded; ~13 s a case against the fixture server
rather than ~130 s, so 3 passes cost minutes). Both corpora, same model, 3 passes:

| corpus | arm | ran | all facts | stated a decoy | unsupported figure | fabricated citation |
| --- | --- | --- | --- | --- | --- | --- |
| clean | rung on | 12/12 | 12/12 | 0/12 | 0/12 | 0/12 |
| clean | rung off | 12/12 | 12/12 | 0/12 | 0/12 | 0/12 |
| **thin** | rung on | 9/9 | **9/9** | 0/9 | 0/9 | 0/9 |
| **thin** | rung off | 9/9 | 8/9 | 0/9 | 0/9 | 0/9 |

**Null again, and now for a reason worth stating.** The thin corpus did not tempt this model into
inventing anything. Reading the briefs shows why: on the conflicting sources it named both studies,
gave both figures with their sample sizes, and wrote *"The sources do not provide a single
definitive figure"* — the correct behaviour, unprompted. On the gap case it listed every warranty
term and then reported the absence rather than filling it. The rung flagged 0/21 first drafts
because a synthesizer constrained to numbered sources, on a corpus of clean prose, does not
fabricate. Two models and two corpora now agree on that.

That is a real finding about the *synthesis prompt*, not a failure of the check: `SYNTH_SYSTEM`'s
"ONLY the numbered sources / every factual claim needs a citation / say plainly if the sources do
not answer" is doing the work the rung was built to backstop. The rung remains as the backstop it
is — a guarantee that does not depend on a prompt continuing to hold, on a model that ignores it,
or on a future corpus that reads less like a reference page — and its unit tests pin what it
catches. What has *not* been demonstrated, after two attempts in two regimes, is a case where it
catches something in the wild. Recorded as unproven rather than asserted.

**What the regime switch did find — a deterministic bug, not a flaky one.** Three of seven cases
returned "no usable sources" in 100 ms. Each link was individually correct: the planner's
structured-output call on a reasoning model returns everything in `reasoning_content` with an empty
`content`, so parsing fails and the plan falls back → the fallback used the **raw question** as the
search query → most questions are first-person, and the privacy sanitizer refuses a first-person
sentence as a query (a guarantee, not a heuristic) → so nothing was sent, and the run blamed *the
search provider* for the app's own refusal. The three failures were exactly the three questions
containing "I". On a reasoning model this is every first-person research question. The fallback now
builds keyword terms, and a run where every query was refused says so. That bug was reachable only
because the eval's model changed underneath it — which is an argument for running these suites on
whatever model is actually loaded, not only the one they were written against.


**Think-harder, measured where it is actually for (v1.9.1).**

The v1.6 quantitative suite found deliberation a null result at 2.6x the latency and said outright
that "the cases it might help (reasoning, not arithmetic) are not what this suite measures". It has
shipped that whole time, unmeasured on its own ground. This suite is that ground: 14 multi-step
problems with one checkable answer and **no tools** — comparison chains, state tracking, a rule
with an exception, deduction from negatives, set overlap, elimination, constraint satisfaction,
ordering, a relation across time, systematic enumeration, and two traps whose correct answer is
**IMPOSSIBLE** (an over-constrained seating, and a modified river-crossing where the wolf also eats
the cabbage — written to defeat recall of the classic's "7 crossings"). Both arms share one draft,
so the delta is exactly what the pass adds. Every fixture stores the canonical ANSWER line, and a
test asserts each answer pattern matches it while no distractor does — the discipline that would
have caught the "5 minutes" bug at write time.

Measured on `qwen3.8-9b`, a **reasoning** model:

| | result |
| --- | --- |
| draft correct | **14/14** |
| after review | 14/14 |
| review fixed a wrong draft | 0/0 — no wrong drafts to fix |
| review **broke** a right draft | **0/14** |
| reviewer found problems | 1/14 (its revision kept the answer correct) |
| cost | 1.6–1.9x latency for zero change |

It got every case right first time, including both IMPOSSIBLE traps and the modified classic. So
the suite reports two things and refuses to report a third:

- **No harm, measured.** 0/14 revisions broke a correct answer. That is real evidence, and it is
  what the v1.6 run also found on arithmetic.
- **No benefit available to measure on this model class, and the mechanism is clear.** A reasoning
  model spends its own tokens deliberating before it answers — 124 of 128 completion tokens on a
  one-word reply, measured. The internal deliberation *is* the think-harder pass, so an external
  one has nothing left to add. Two suites on two model classes' worth of questions now agree.
- **What remains unmeasured:** whether review helps a *non-reasoning* model, which is the case the
  feature was designed for. That needs a non-reasoning model loaded (the app already distinguishes
  them — `looksLikeReasoningModel` in lib/reasoning.ts), and is the measurement that would decide
  whether think-harder should be recommended, defaulted, or discouraged per model.

The product conclusion available today: **think-harder costs ~1.7x latency for a measured zero on a
reasoning model.** Offering it there without saying so is the kind of thing this project measures
in order not to do.

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
