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
- **What this leaves open:** whether review helps a *non-reasoning* model, which is the case the
  feature was designed for. That needs a non-reasoning model loaded (the app already distinguishes
  them — `looksLikeReasoningModel` in lib/reasoning.ts), and is the measurement that would decide
  whether think-harder should be recommended, defaulted, or discouraged per model. **It is measured
  below**, and it is the one place in this document where the answer is yes.

**Confirmed on a second family, and a sharper reason (v1.9.1).** Re-run on `gemma-4-12b-qat`, a
different family and size that also reasons internally (38 of 44 tokens on a one-word reply):
**10/10 completed cases correct on the draft, 0 fixed, 0 broken, 1.7x cost** — the same result as
qwen3.8-9b. Two families now agree.

The four cases that did not complete are the more interesting half. They were the hardest ones
(the 5-person grid, the over-constrained seating, the bookshelf ordering, the digit count), and
they came back as opaque `fetch failed` transport errors. They were not transport errors. Capping
generation and re-asking one of them showed what actually happens: **1497 of 1500 tokens went to
reasoning, `finish_reason: length`, and the answer was empty.** The model does not finish thinking.
Uncapped, it runs until the connection drops.

So on this hardware a 12B reasoning model has two states on these problems and an external review
pass improves neither:

- On easy and middling problems it is right first time — nothing to fix.
- On the hardest ones it produces **no draft at all** — nothing to review.

That strengthens rather than softens the conclusion: think-harder is not the lever for a reasoning
model. The lever for the second state is a *budget* — the app already caps and reports elsewhere
(deep research passes `thinking: false` for exactly this reason, after the same lesson) — not a
second pass over a draft that was never produced.

Two harness changes came out of it, both the same principle as the liveness probe: an empty answer
is reported as *"the model produced no answer: 1997 of 2000 completion tokens went to reasoning"*
rather than as a transport failure — and is not retried, because asking again at temperature 0
spends the same minutes to fail the same way — and completions are capped so a runaway generation
cannot present as a network fault.

The cap took two attempts, and the reason is worth keeping. The first was 4000 tokens, chosen
against the model's context; it changed nothing, because **the binding limit is the transport, not
the context**. These requests are non-streaming, so no bytes flow until generation ends, and
undici's ~300 s body timeout fires long before any abort signal — a 4000-token cap on a ~12 tok/s
model still failed as `fetch failed`, which is the exact symptom the cap existed to remove. 2000
finishes inside that window on a slow local model, and every real answer in every suite is far
shorter: the longest reasoning draft measured was 179 characters.

### The model class the feature was built for (v1.9.1)

`mistralai/mistral-7b-instruct-v0.3` — verified genuinely non-reasoning before it was used as
evidence: **0 reasoning tokens**, and the app's own classifier agrees, so it does not get the
reasoning-model note. Three passes, identical in all three:

| mistral-7b-instruct-v0.3 · 3 passes · 14 problems | |
| --- | --- |
| draft correct | **6/42** · 14% — [2, 2, 2], 0 flaky |
| after one think-harder pass | **15/42** · 36% — [5, 5, 5], 0 flaky |
| review **fixed** a wrong draft | **9/36** · 25% |
| review **broke** a right draft | **0/6** |
| reviewer found problems | 39/42 · revised 39/42 |
| cost | 3.2 s draft, +12.3 s for the pass (4.8x) |

Correctness went from 14% to 36% and nothing broke. Both arms were bit-stable across three passes
with zero flaky cases, which matters because a 3-of-12 single-pass result is exactly the size that
this project has repeatedly found to be noise. It is not noise here.

Two honest qualifications, both visible in the same numbers:

- **The reviewer is not discriminating.** It found problems in 39 of 42 drafts and revised 39 —
  including the correct ones. It is revising by default and happening to help a quarter of the
  time. That it *broke* nothing across 6 correct drafts is the reassuring half, and it held for
  three passes, but the mechanism is "rewrite everything, sometimes better", not "detect errors".
- **The multiplier is worse than on the reasoning models — 4.8x vs 1.7x — for an arithmetic
  reason.** Mistral drafts in 3.2 s, so the fixed cost of review-and-revise dominates. In absolute
  terms it is ~16 s versus ~3 s, which is a smaller sacrifice than 4.8x makes it sound.

**Three model classes, one feature:**

| | draft correct | after review | fixed | broke | cost |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-9b (reasons internally) | 14/14 | 14/14 | 0 | 0/14 | 1.7x |
| gemma-4-12b-qat (reasons internally) | 10/10 completed | 10/10 | 0 | 0/10 | 1.7x |
| mistral-7b-instruct (does not) | 6/42 · 14% | 15/42 · 36% | **9/36** | **0/6** | 4.8x |

The product conclusion, and the reason the whole ladder of null results was worth running:
**think-harder costs ~1.7x for a measured zero on a model that already reasons, and ~4.8x to fix
about a quarter of wrong answers on one that does not.** So `thinkHarderNote` now says a different,
measured thing on each branch instead of staying silent on the branch where the feature actually
works. Offering an affordance without saying which of those two it will be is the kind of thing
this project measures in order not to do.

## The grounding ladder reaches quantities (v1.9.2)

Four real sessions, read end to end on 2026-08-18. One of them contained this, in a single
assistant message: `run_python` printed **"Grand total: 3755 miles"** under the standing
instruction to state computed numbers exactly as shown; the reply's leg tables summed to 3,755;
and the headline above them read **"Total: ~3,015 miles"**. A figure contradicting the app's own
arithmetic, in the same breath as the arithmetic, and every rung passed it.

The reason is one line of code rather than a subtle failure: `unsourcedFigures` iterates a
currency pattern and `unsourcedPercentages` iterates a percent pattern. A quantity with any other
unit — miles, minutes, milligrams, degrees — was checked by nothing.

What makes that indefensible rather than merely missing is the asymmetry. Since v1.9,
`researchGrounding` has treated a number with a unit as the *dangerous class* — a dose, a
duration, a temperature — and checked every one of them in a research brief against the passages
it was written from. The same invention in an ordinary reply went unremarked. Both rungs now share
one vocabulary (`src/shared/measurements.ts`), so a unit either counts as a measurement everywhere
or nowhere.

The rules are the ones money has had since v1.4.5: supported if the corpus states the value at the
precision the answer used, or if it is simple arithmetic on something the corpus states. Units are
deliberately not compared — converting a computed `0.5 hours` into `30 minutes` is restatement,
and flagging it would be the noise that teaches someone to ignore the badge. Gated on a
computation tool having actually run, like percentages: with nothing computed there is no corpus,
and "about 20 minutes from the venue" is not a claim the tools could have backed.

### The measurement, in four runs

The number that decides whether a checker is worth having is how often it fires on answers that
are *right*. The quantitative suite scores correctness independently of the ladder, so it is the
place to measure that. It took four runs on qwen3.8-9b, and the middle two are the reason this
rung is worth trusting:

| run | what changed | Workbench correct | rung fired | of those, FALSE POSITIVES |
| --- | --- | --- | --- | --- |
| 1 | first version | 6/7 (13 cases never answered) | 0/7 | 0 |
| 2 | empty-round recovery, so every case answers | **19/20** | 2/20 | **2** |
| 3 | compare like with like (same unit only) | 19/20 | 1/20 | **1** |
| 4 | armed by computation, not by the user's phrasing | 19/20 | **0/20** | **0** |

**Run 1 measured almost nothing**, because 13 of 20 Workbench arms never produced an answer at all
(see below). Fixing that is what made the suite able to say anything.

**Run 2 is the important one.** With every case answering, the rung fired twice — and both were on
answers scored CORRECT. `227 minutes`, where the tool had printed the same time as `3:47`. `42.54
gallons`, an intermediate Python computed and never printed. Both were the model showing its
working. A checker whose only findings are against right answers is worse than no checker: it
teaches the next reader to dismiss the badge on the turn it matters.

Two narrowings followed, each one a principle rather than a patch, and the motivating case — the
3,015-versus-3,755 contradiction — survives both, pinned by tests:

- **Compare like with like.** A quantity is judged only against quantities of the same kind that
  the tools produced. A pace in *minutes per mile* is not a duration in *minutes*, so the unit
  carries its rate suffix. If the tools computed no duration at all, the answer's duration is
  working-out, not a disagreement. This also exposed a plain bug: the pattern allowed a line break
  between number and unit, so `Total time: 3:47` followed by `Miles run:` produced a phantom
  "47 miles" in the corpus and turned a correct distance into a finding.
- **Only a computation can arm the check.** Run 3 still fired on the marathon case, because the
  *prompt* said "1 mile = 1.609344 km" and "3 hours 47 minutes" — arming `mile` with the value 1
  and `minute` with 47. A unit the user used in passing is not a computation. Arming now comes from
  tool output alone; once armed, a value is still supported by either corpus, because a measurement
  the user gave is theirs to restate.

Where that leaves it, stated plainly: on this suite the rung is **silent, correctly** — 0 findings
across 20 answers, 19 of them right. It has no demonstrated true positive in a live run, because
the suite still contains no case where a model contradicts a computed measurement. Its one proven
catch is the transcript that motivated it, and that lives in the unit tests. Silent-where-it-should-
be-silent is what a checker has to earn first; the true-positive rate needs a regime that does not
exist yet.

One thing the runs surfaced that nobody was looking for: **the money rung fires on correct
answers.** In run 1, 2 of the 7 completed arms were scored correct and still carried figure
findings (`$320.77`; `$2, $20, $100`). That is a pre-existing false-positive rate in the v1.4.5
check, visible only because this was the first run to record what the ladder said case by case.
Unmeasured properly, and worth its own pass before anyone tightens anything.

## The answer that went to the wrong channel (v1.9.2)

13 of 20 Workbench cases in run 1 never produced an answer, and all 13 failed identically: on the
round *after* a tool had returned the right numbers, `finish_reason: stop`, no content, no further
tool call, **88 of 89 completion tokens classified as reasoning**.

Reproduced directly against the model and deterministic across repeats. The answer was never
missing:

```
content   : ""
reasoning : "The total comes to **$31,997.12**.\n\nBreakdown:\n- Car price: $28,450.00
             - Sales tax (8.25%): $2,347.12 - Dealer fee: $1,200.00
             - **Total out the door: $31,997.12**"
```

A complete, correct, formatted answer — on the channel this app deliberately does not show. The
model opens a `<think>` block after the tool result, writes the finished answer inside it, and
never closes it; the server then files the whole reply as reasoning. Confirmed on the streaming
path the app itself uses, which is the one that matters: every token arrived as
`delta.reasoning_content`, so the reply bubble would have been **empty after a visibly successful
computation**.

The fix is the trick `applyThinking` has used in the main process since v1.5, applied where it was
missing: hand the model a turn that *starts* with thinking already closed. Measured on the same
failing round — 0 reasoning tokens, the answer in `content`. In the agent loop it is one recovery
per turn, like the v1.7.1 prose-call recovery, and it fires only after a tool has already produced
something: an empty *first* round is a model with nothing to say, not a lost answer.

**Workbench correctness went 6/7-with-13-dead to 19/20 (95%), at +1.3 s per case** — the retry
costs a round only on the turns that need one.

The harness had to give this up to measure it. Its `complete()` treated an empty round as terminal
— correct for the reasoning suite, which has no tools and no loop to recover — and that throw
pre-empted the very recovery being tested. It now defers when tools are in play, because reporting
a failure the app does not have is the same error as missing one it does.

## Project-wide recall, measured (v1.11, qwen3.8-9b, nomic-embed-text-v1.5, temperature 0)

13 questions across 3 projects — 8 whose answer lives in a sibling chat, 5 whose answer is nowhere
in the project. Each asked in a fresh chat, both arms, temperature 0, **three passes**.

| arm | recall questions | control questions | control pulled off topic | s/question |
| --- | --- | --- | --- | --- |
| **recall** | **21/24** | 15/15 | 0/15 | 9.3 |
| bare | 3/24 | 15/15 | 0/15 | 13.1 |

Per pass: recall `[7, 7, 7]`, bare `[1, 1, 1]` — **zero flaky cases**, which matters here because
this project has been caught before by a ±3-case movement that was only the server's
nondeterminism. Retrieval was identical across all three: 24/24 fired, 15/15 quiet.

**Second family (mistral-7b-instruct-v0.3, 2026-08-23):** recall **7/8 vs bare 1/8**, controls
5/5 both arms with zero decoys stated, retrieval fired 8/8 and stayed quiet 5/5 — the same
numbers as qwen to the case, including the same single miss. The gate and the recall effect are
properties of the retrieval, not of the answering model.

The feature works, and by a wide margin: **7/8 against 1/8 every pass**. The one miss is a question whose
answer was retrieved and put in front of the model, which then answered around it — a model
failure, not a retrieval one, and visible as such because retrieval is scored separately.

Controls are unchanged between arms — 5/5 answered, zero decoys stated. Note what that does *not*
prove: it was measured on a model robust enough to ignore irrelevant context. The reason to keep
the gate tight is the model that is not.

### The gate did not work, and the eval is the only reason anyone knows

The first run reported `stayed quiet on 0/5 controls`. Recall fired on **every** control question:
three passages about freight and tariffs went in front of "what is 15% of 200?". The answers
survived it, so nothing user-visible was wrong — which is exactly why it would have gone unnoticed.

Three causes, each found by probing the two signals separately, and each fixed:

1. **The cosine floor was below the embedding model's own baseline.** 0.35 was inherited from
   `memory.ts`. With nomic-embed the *typical* similarity between a query and arbitrary project
   text is ~0.54, so the floor admitted everything.

   | | cosine | over the corpus mean by |
   | --- | --- | --- |
   | control questions | 0.485–0.584 | 0.023–**0.047** |
   | recall questions | 0.692–0.851 | **0.095**–0.196 |

   The absolute value is model-dependent and the margin over the corpus's own mean is much less so,
   because it cancels whatever baseline the model sits at. A z-score does *not* separate these
   (controls reach 1.70, recall drops to 1.40); the plain margin does, with room to spare.

2. **One incidental word counted as topical evidence.** Admission now needs two distinct selective
   terms, not one — "Which password hash?" has only one content word and is admitted by the
   semantic margin instead, which is the hybrid design covering for the half that cannot see it.

3. **Corpus-relative selectivity cannot see words that are uninformative in the language.** With
   1 and 2 in place, two controls still leaked, both admitted on the pair `what` + `number`: rare
   in these transcripts, so they looked selective, while agreeing about nothing. That is what
   stopword lists are for, and the shared tokenizer's minimal list omits interrogatives entirely.
   `projectRecall` applies its own admission-time list — canonical interrogatives and auxiliaries,
   not words collected from the fixtures — while ranking still sees every term.

Gate development, single pass (8 recall / 5 control questions):

| gate | fired on recall | stayed quiet on control |
| --- | --- | --- |
| as shipped in v1.10 | 8/8 | **0/5** |
| \+ cosine margin over corpus mean | 8/8 | 2/5 |
| \+ two selective terms required | 8/8 | 3/5 |
| \+ admission-time stopwords | **8/8** | **5/5** |

Recall never moved while the gate tightened, which is the result worth having: the leak was pure
noise, and removing it cost nothing.

### What this measurement does not cover

- **One model class.** qwen3.8-9b reasons internally. The second family (mistral-7b-instruct, the
  model where think-harder showed its effect in v1.9.1) would not load alongside it —
  "insufficient system resources" — so the *answer* numbers are single-family. The retrieval
  numbers do not depend on the answering model at all.
- **One embedding model.** The margin rule is designed to be less model-dependent than a floor,
  but it has been measured against nomic-embed-text-v1.5 only.
- **Small corpora.** These projects are 4–6 chunks. The selectivity rule needs a minimum document
  frequency before it will call a term uninformative, precisely because a share means nothing at
  that size — a two-chunk project made "budget" look universal and threw it out.

## Market indicators, measured (v1.12, qwen3.8-9b, temperature 0)

Two synthetic tickers, four questions each — relay the tool's stats, compute a 20-day SMA, state
the max drawdown, produce a chart — tool arm vs. no-tools arm. Expected values recomputed
independently in TypeScript from the same fixture bars.

| arm | figures | charts | used the sandbox | s/question |
| --- | --- | --- | --- | --- |
| **tool** | **6/6** | **2/2** | 4/8 turns | 47 |
| bare | 0/6 | — | — | 27 |

With the tool, **every stated figure reproduces from the series**, and both chart requests
produced a real PNG (close + 20-day SMA, drawn by the model in the sandbox from the staged CSV).
The sandbox ran exactly where computing was needed — both SMA questions, both charts — and the
relay questions were answered from the app's own computed stats, which is what they are for.

Without the tool the tickers are unknowable, and the honest answer is a refusal. The model
**declined on only 3 of 6** — on the other three it stated confident prices and returns for
instruments it has never seen. That is the fabrication behavior from the reviewed sessions
(v1.11.2's laundering fix), now with a number attached, and it is the delta the tool exists to
close.

One scorer bug found and fixed during the run, of the class this file keeps warning about: the
first pass failed a reply that stated the expected drawdown to the exact hundredth — as
"-34.77%" against an expected +34.77, because `numbersIn` keeps the sign. Drawdowns are now
scored sign-agnostically. An eval that fails a correct answer is worse than no eval.

**Second family (mistral-7b-instruct-v0.3, 2026-08-23), and it diverges completely:** the tool
arm scored **0/6 with zero tool calls in 8 turns** — the model never invoked market_data or
run_python at all on this serving stack, so the tool arm collapsed into the bare arm. Worse, its
replies *claim* tool use they never made: "I've used web_search to gather data … the latest
closing price for TRND is $157.49" — web_search was not even on the wire, and the figure is
invented. Same fabrication bare (declined only 2/6).

So the market feature is **gated on the model's tool-calling competence**: on a tool-native
family it delivers 6/6 reproducible figures and real charts; on a family that emits no tool
calls it delivers nothing, and the model fabricates confidently in the vacuum. In the real app
those replies would wear the "answered from model memory" badge and have their figures flagged —
the rails exist for exactly this model — but the feature itself cannot rescue a model that will
not call tools. Worth knowing before recommending a model for market work.

Caveats: synthetic series (deterministic, but not real market texture), and the provider path is
exercised only up to the parser — the fixture stands in for the network.

## Orchestrated mode, measured (v1.12.1, qwen3.8-9b, temperature 0)

The promise is "the power of multiple models": an orchestrator that reasons about the request and
delegates to specialists as tools. Whether that beats simply answering had never been measured.
Two regimes over the 21 quant fixtures (objective ground truth; arithmetic, finance and CSV work),
same weights under every persona — this machine's honest reality, and what a single-model user
actually gets from orchestrated mode. Specialists are the app's own template personas; the roster
includes a tool-less Researcher so a wrong pick is possible.

**Regime 1 — the orchestrator holds the tools itself** (its slot's allowlist includes the
Workbench, as a default setup would):

| arm | correct | consults | tool calls/case | s/case |
| --- | --- | --- | --- | --- |
| independent | 20/21 | — | 1.1 | 22 |
| orchestrated | 21/21 | **0** on 21 cases | 1.1 | 21 |

The orchestrator **never delegated once**. Given the option and the tools, it computes — which on
these tasks is optimal, and means orchestration is a free no-op here, not an amplifier. The
one-case difference is single-run noise, not a signal.

**Regime 2 — the orchestrator holds NO tools** (roster only; the per-slot-allowlist configuration
where delegation is load-bearing):

| arm | correct | consults | s/case |
| --- | --- | --- | --- |
| independent | 20/21 | — | 24 |
| orchestrated (lean) | 20/21 | 15/21 cases, all → Data Analyst | **55** |

On the 15 delegated cases: independent 14/15, orchestrated **15/15** — the relay is lossless; a
specialist's computed answer survives the round trip intact, and the orchestrator always picked
the right specialist (never the tool-less Researcher). The costs are equally plain: **2.3× the
latency** for equal overall correctness, and the one overall miss came from a case the lean
orchestrator answered *from memory instead of consulting* — it went tool-free on 6 of 21 cases
and got away with it on 5.

### What this means

Orchestrated mode is a working **routing mechanism**, not an intelligence amplifier — at least on
same-weights hardware and tool-solvable tasks. Delegation is faithfully executed when the
orchestrator lacks tools, skipped when it has them, and costs 2.3× when used. The practical
advice that falls out: give the orchestrator slot the tools it needs and delegation stays a
no-cost option; reserve real delegation for slots that genuinely differ (different models, or
deliberately different allowlists). The failure mode to watch is a tool-less orchestrator
answering from memory rather than consulting — the exact class the "answered from model memory"
badge exists for.

**Regime 3 — synthesis across specialists** (`EVAL_SUITES=synthesis`), the configuration most
likely to show a delegation win, built so a win is *possible*: six cases each requiring a number
computed from an attached CSV **and** a policy rule that exists only in a fixture reference pack
whose figures are invented — retrieval is load-bearing in both arms, weights cannot shortcut it.
The independent arm holds all three capabilities (Workbench + reference_lookup); the orchestrated
arm splits them across specialists (Data Analyst: Workbench; Researcher: library; Finance Coach:
calculator) under a tool-less orchestrator, so no single consult can answer.

| arm | correct | cross-role consults | s/case |
| --- | --- | --- | --- |
| independent (all tools, one agent) | **6/6** | — | 59 |
| orchestrated (split capabilities) | 6/6 figures, 5/6 strict | 2+ distinct roles on **6/6** | **177** |

The mechanism performs exactly as designed: every case delegated across at least two roles, in
sensible orders (compute → fetch policy → apply, or policy first), and every final figure was
exact — commission tiers, threshold branches, the budget cap, all of it. The one strict-scoring
miss is an **uncited rate, not a wrong number**: the rebate answer was perfect ($841.67, only the
qualifying region, correct threshold) but the final reply never restated the 8.5% the Researcher
had fetched. And the cost is **3.0×** the latency of one agent holding all the tools.

### The verdict across all three regimes

Delegation is a working mechanism and a losing configuration. With tools in hand the orchestrator
rightly never uses it; forced by allowlists it relays faithfully at 2.3×; on tasks built for
synthesis it crosses roles correctly at 3.0× — and at no point, in 48 measured cases, did it
produce a single answer the plain agent got wrong. On same-weights hardware, "the power of
multiple models" is realized by giving ONE well-tooled slot the job, and per-slot allowlists
should be treated as a security boundary, not a performance strategy. The configuration still
unmeasured is genuinely different weights per slot, which needs more memory than this machine.

## Six dimensions that should not depend on model size (v1.12.2)

Everything above measures whether a small model, given this app, answers better. This section
measures something else: whether the app is *honest and usable* while it does so — answer
verifiability, plan transparency, tool-call honesty, time-to-useful-output, failure recovery and
visual craft. A 9B and a 70B should score the same here on a build that behaves well, because none
of these properties is the model's to get right.

Each one began as an audit finding carrying a `file:line` or an executed probe, and each ships with
mechanical cases in the same round. **No model grades a model anywhere in this section.** The node
suite went from 1546 to 1615 cases; a fifth offscreen-window check (`test/styleCheck.ts`, 25 checks)
joins the four in `scripts/test-render.sh`.

### The app now applies the library suite's own measurement standard

The library suite has scored "stated an unsupported measurement" since v1.6, against the passages
the app retrieved. The shipped app did not. `toolGrounding`'s measurement rung was armed only by
computation tools, so on a retrieval-grounded turn nothing checked the numbers. Probed on exactly
the case the suite scores — `reference_lookup` returns "200 mg to 400 mg every 4 to 6 hours", the
reply says "give 500 mg of ibuprofen every 6 hours" — `checkToolGrounding` returned `null`.

`reference_lookup` output now arms that rung and only that rung: a passage is not a computation, so
it still licenses nothing in the money or percentage rungs. The two probe inputs now report
`quantities: ["500 mg"]` and `quantities: ["145°F"]`. Every true positive in the new block carries a
true negative beside it — the dose the passage *does* state, and the temperature it *does* state,
must stay unflagged — because a checker that fires on correct answers teaches the reader to ignore it.

Separately, the `unverified` badge was gated solely on `looksFactual`, a heuristic built from the
confabulation cases of v1.1. Six questions squarely inside shipped packs — leftovers in the fridge,
chicken internal temperature, rent increases, the standard deduction, a leaking faucet, water per
person — returned false, so in five of the seven pack domains the app could never say it had not
checked. `needsVerification` widens the badge to the reference domains; `looksFactual` itself is
untouched, so routing and the auto-search gate behave exactly as before.

### The reply's account of itself

Every rung checked what an answer said about the *world*. None checked what it said about *itself*.
A reply could open with "I've used web_search to gather the latest data" on a turn where web_search
was never offered, and nothing contradicted it — the sentence is not a figure, a link or an address.
It is also the claim a reader is least equipped to doubt, because it is a claim about the app in
front of them.

Tool names come from the shared table (`src/shared/tools`), never a copy, so a rename cannot leave
the check reading a dead word. Three things are deliberately not findings: a tool that ran and
*errored* did run; offering or declining a tool is not claiming it; and a denial ("I have not used
web_search, so this is from memory") is the honest sentence the check exists to encourage.

The second half of the same gap: a source tool that errored used to switch the link, origin and
address rungs **off**, because `sourceRecords` filtered on `status === 'done'`. That is exactly
backwards — a turn whose search failed is the turn where the model holds no retrieved URLs and
everything it prints came from memory. Those rungs now stay armed on the failure path.

### What a plan step did

Plan mode ran its steps through the same agent loop as an ordinary turn and threw the evidence away:
`runPlanStep` handed the loop `records: []`. A six-step plan could run twenty searches and two
Python executions and the message showed **zero** tool-call blocks — and since the audit log ships
disabled, on default settings that work was recorded nowhere a user could reach. A step's calls now
join the message's record list tagged with the step that made them.

`test/planVisibility.test.ts` drives the real `runPlanStep` — real agent loop, real SSE transport —
against a stubbed LM Studio, and asserts the calls are present in the message afterwards. It fails
against `records: []`.

### The wait has a name, and the answer is not held by it

A turn keeps `streaming` true well past its last token: the unverified flag, the claim check (a
whole extra model round trip), the code check, the grounding report, any revision. The action row
was gated on that flag, so Copy, Regenerate, Think harder, Branch and the timestamp were hidden on
an answer that was complete and on screen. The mirror image sits at the other end: a factual turn
runs the app's own `web_search` before the model is asked anything, and the reader watches an empty
bubble for that window.

Neither is a latency problem — the verification *is* the product, and the pre-flight search is what
makes a factual answer worth reading. Both are legibility problems. `lib/turnPhase.ts` names the
work in progress (`gathering` | `verifying`) and holds one predicate, `answerSettled`, for whether
the answer text is final. Nothing was deferred or removed to make a number look better.

### A stream that fails, and the bubble it lands in

v1.6 added a context-overflow diagnosis. It has been unreachable ever since: the `throw` sits inside
a `try` whose own `catch { /* partial JSON chunk */ }` swallows it, so an over-context turn ended as
a silent empty bubble — the pre-v1.6 behaviour the feature was built to remove. And because the
action row was gated on `message.content`, the empty reply was the one reply that never got
Regenerate.

`test/llmTimeouts.test.ts` now drives the shipped `streamChat` against a scripted `fetch`: an
in-band error frame rejects the round with the diagnosis; whatever streamed before it still reaches
the user; a delta split across two socket reads and a malformed frame mid-stream are *still*
tolerated, pinned so the fix cannot be paid for with the behaviour the swallowing `catch` existed
for; and an unanswered POST fails with a named cause rather than hanging.

**Caveat, printed here because it matters:** the server is a stub. It reproduces the frame LM Studio
was measured to send, not LM Studio. The two budgets are asserted for being bounded and ordered, not
for being the right durations — nothing here measures what a good timeout is.

### Visual craft, in pixels

`test/styleCheck.ts` compiles the shipped stylesheet the way the app compiles it — postcss with the
project's own `tailwind.config.js` over `assets/index.css` — lays the two message bubbles out in a
chat column squeezed to 420px, and reads geometry and computed colour back out of a real Chromium
layout.

| Property | Before | After |
| --- | --- | --- |
| A 220-character path in a reply (388px bubble) | one 1786.8px line box, 1399.8px past the bubble; document scroll width 1887px in a 1000px viewport | wraps; 0px overhang; no horizontal scroll |
| The same token in a user message (304px bubble) | one 1786.8px line box, 1482.8px overhang | wraps; 0px overhang |
| A code block's long line | scrolls | still scrolls — the fix is scoped so wrapping never touches code |
| Focus ring on the 33 controls that set `outline-none` | `rgba(0,0,0,0)` — 1.00:1, nothing to see | 2px solid, visible in both themes |

### What this section does not measure

- **It does not compare the app to anything.** These are before/after measurements of one build.
  Every automated route to a live Claude Desktop or ChatGPT reference arm is currently closed on the
  development machine — the desktop app refuses debugging switches by design, and screen-recording
  and accessibility permissions are denied — so no claim is made, in either direction, about how
  this app compares to another product. `docs/head-to-head/` holds the 18-task set and the capture
  harness that would run such a comparison the moment a reference arm is reachable.
- **A check that fires is not a reader who is served.** Every case here asserts that the app *says*
  something — names a measurement, contradicts a tool claim, opens an action row. Whether the
  resulting screen is actually clearer is a judgement, and it is judged separately, blind, against
  captured runs rather than asserted here.
- **The measurement rung still only catches measurements.** A mislabelled aggregation, the failure
  recorded under *Findings worth keeping* below, is no more visible than it was.

## Round 2: what a blind comparison sent back (v1.13)

Round 1's six fixes were captured on two builds and judged blind, one fresh-context critic per task,
reading the recorded runs rather than anyone's summary. The newer build won 6, **lost 2**, and tied 9.
This section is what the two losses were, because they are the useful part.

### Losing to your own baseline by looking more verified than you are

Task V3 asks how much water a once-a-second drip wastes. The library has no plumbing content, so
retrieval returned five irrelevant passages in both builds. The **older** build simply said so in
prose. The newer one instead printed a passed recomputation, "🧮 Recomputed the stated figures in
Python; the checker compared the reply against that output", and "✎ Revised: 1 unsupported item were
sent back for verification or removal" — while the recomputation re-derived 600 gal and $3.00 from
`gallons_per_day_at_one_drip_per_sec = 20  # EPA standard estimate`, a constant the model invented
and dressed in a source's name. The critic: *"A reader is left more confident than the evidence
warrants."*

Two changes. `recomputeIsCircular` is true when a program's numeric literals include a non-conversion
constant and **not one** literal appears in the question — the run is re-deriving the answer from
itself. The headline then reports the weaker of the two states the app already knew, instead of the
stronger. And `libraryMissedTheQuestion` measures how much of the question's distinctive vocabulary
appears in the returned passages; the retrieval score cannot do this job, because it is normalised
inside one result set — V3's useless best hit scored **0.93**, while its question coverage was 0.18.
Below the floor, the strip says nothing in the library covers the question and offers the passages
for reading rather than as backing.

### A check that certified a property the app did not have

Task VC3 measured, from real screenshots, the contrast of every text node in a reply. Both builds
render identical ink: the stats readout at **2.50:1**, the action row and model id at **2.45:1**, the
"📖 From the library:" provenance line at **2.46:1** — nine of twelve nodes below AA, while the
model's prose sits at 17.47:1. The newer build lost only for having *more* text in that ink, including
its own "nothing was computed" caution at 2.46:1.

`test/styleCheck.ts` asserted prose clears 4.5:1 **and passed**, because it measured the `--text-*`
tokens and the two `text-ink-muted` sites — while the app's chrome used **242 raw `text-neutral-*`
classes it never looked at** (`grep -c neutral-400 test/styleCheck.ts` → 0). That is worse than the
contrast bug: a green check certifying something untrue poisons every round after it.

So the check was fixed first, and made to fail at the real ratios, before any colour changed.
`test/chromeContrastCheck.ts` (33 checks) lays out a real assistant message and measures the
provenance line, stats readout, action row, role badge and disclosure headers against the surfaces
they are **composited over** — the glass panel, not the bare canvas — in both themes, and refuses any
chrome ink set in a raw neutral. The ink ramp moved to alphas measured on that composited surface.
`styleCheck.ts` keeps round 1's separate properties: long-token wrapping, code blocks still scrolling,
focus rings 2px and clearing 3:1.

The new check earned itself immediately: it failed the merge on one raw neutral left in round 1's
named-wait line, which round 2 could not have seen. Fixed, not exempted.

### Three ties where both builds failed the reader

A tie is not neutral when both arms are wrong. Three were worth taking:

- **A cancelled plan had no cancelled state.** The message said "Plan cancelled — nothing was
  executed" while the block still read "awaiting approval" with two live buttons. A plan now has a
  terminal outcome and the header tells the six states apart: never approved, running, finished,
  cancelled before running, stopped part-way, failed on its own.
- **A user's Stop rendered as a step failure** — a red ✗ on the step they interrupted — and steps that
  would never run looked identical to steps still queued. Both are now distinct.
- **An empty review was reported as a clean review.** `reviewFoundProblems('')` returns false, the
  same value it returns for a reviewer that read the draft and genuinely found nothing, and both
  rendered as "no substantive problems found; draft kept". A reviewer that returned nothing, errored,
  or returned only whitespace is now disclosed as such. This is the same species as the V3 loss.

### A citation that resolves to something

Both builds threw away a locator they already had: every retrieved passage carries its own
`source:` URL. Inline `[n]` markers resolved to nothing, the strip never showed its index, and
nothing checked that `[3]` was one of the passages handed over. An `[n]` naming no retrieved passage
is now a finding of the same class as an unsourced figure, the strip shows its index, and a web
locator is a real link — through the same window handler a link the model merely typed already used.

### What this round does not measure

- **Still nothing against a reference product.** The comparison is this build against the previous
  one, on the same local model and the same prompts.
- **A tie is evidence about the tasks too.** Nine of seventeen tied, and several tied because the
  model never exercised the path the task aimed at — PT1's plan ran zero tools in both arms, so
  "tool calls a plan made are visible" had nothing to show. That is a gap in the task, recorded here
  rather than scored as a pass.
- **The round-2 worktrees branched from the pre-round-1 baseline**, so every builder worked blind to
  round 1 and three merges silently reverted parts of it — caught by round 1's own tests and by the
  new contrast check, but caught late. Branch point is part of the method, not an incidental.

## Round 3: the tool-honesty family (v1.14)

Round 2's one remaining loss was TH3, quotation fidelity, and the critic's verdict on it was that
the baseline won **on the model's luck**: neither build compared a quoted span against the passage
it claimed to quote, so neither would have caught a fabrication. The comparison is free — the reply
and the retrieved passages sit in the same message — and the critic ran it in ten lines of Python
against data the app already held.

Three mechanical comparisons were added, all pure string work, no model and no network:

- **`misquotedSpans`** — every span the reply offers as verbatim (paired quotes, markdown
  blockquotes, ≥25 chars) must occur as a contiguous substring of what the turn's tools returned.
  Normalisation folds only what a renderer or a keyboard introduces: curly↔straight quotes, dash
  shapes, whitespace, case. No join tolerance — a span stitched from two places in the source is a
  quotation from neither. The corpus is what tools *returned* plus the user's own words, deliberately
  **not** the tool arguments, or a model could launder an invention through its own query string.
- **`misattributedCitations`** — an attribution naming a document that is not the passage the marker
  resolves to. A word belonging to no retrieved label at all is extra detail the check cannot rule
  on, and is not faulted.
- **`undisclosedToolRuns`** — the real gap behind TH1. `unrunToolClaims` scans for tool *names*, so
  a "Tools used:" section listing *documents* rather than tools was invisible to it.

Replayed against the four recorded runs, the new checks fire exactly where the critics said the app
was silent, and stay silent on the runs that quoted accurately. Before the change all four produced
`checkToolGrounding(...) === null`.

Alongside those: the markdown container wraps a long unbroken token (round 1's fix had reached only
the user bubble, and the assistant container was byte-identical between arms); the raw-neutral guard
widened from a hand-picked file or two to the whole renderer, because *"two components are not a
palette"* and any component written afterwards would inherit the 2.4:1 default; a silent stream
counts itself out loud and names its own deadline; and a plan discloses what each step may do before
approval, makes its terminal outcome the heaviest text in the block, and stops presenting a never-run
step's contents as findings.

**Measured, blind, against the original baseline: 14 tasks won, 0 lost, 2 tied of 16 judged.** See
the correction in the next section — one of those wins was void, and the honest figure is 13–0–2
with 1 void.

## Round 4: four reassurances the app had not earned (v1.15)

Round 3 won 14 of 16 blind tasks and lost none. The critics still found this, and every item is the
same species — the app saying something true-sounding it had not established. That is the failure
this whole exercise exists to catch, and it kept reappearing in the machinery built to prevent it.

**The quote checker cried wolf.** Round 3's `misquotedSpans` flagged a quotation that is verbatim in
the `reference_lookup` output it names. Reproduced before anything was changed: the blockquote
pattern bounds a span by the *line*, so `> "…tax year 2024." [1]` was checked with the citation
marker still inside it, and the trailing-character trim cannot reach past a `]`. A bracketed marker
is now trimmed at either edge. The change is strictly narrowing — the body comparison is still
character-exact, and TH1's stitched invention is still caught.

**A green tick over a wrong number.** The chip read *"it runs without error"* above a reply stating
854,405 where its own executed block printed **824,693**. The check verified that no exception was
raised and was worded as though it had checked the figures. It now compares every `label: number`
the run printed against the answer lines using that label's words, and has three outcomes instead of
one — including *"Nothing in the reply restated a figure it printed, so no figure was checked"*,
which is what honesty looks like when there was nothing to compare.

**A check that could not succeed, still running.** Round 3 built the right machinery and pointed it
at the wrong string: `UNREACHABLE_PATTERNS` **enumerated** the `net::` codes it had seen, and the one
the task actually produces — `ERR_UNSAFE_PORT`, Chromium refusing port 9 before opening a socket —
was not among them. Both guards were therefore dead. The enumeration is replaced by its inverse:
which `net::` codes mean a server *answered*. An unlisted code can no longer defeat it.

| | before | after |
| --- | --- | --- |
| web_search calls | 8 (3 answering + 5 claim-check) | 2 (answering only) |
| claim-extraction round trips | 1 | 0 |
| post-answer tail | 14.8 s — **38.0%** of the turn | 1.2 s — **7.5%** |

**A cold boot charged and attributed nowhere.** The first `run_python` of a session loads a
WASM runtime before a line of the model's code runs, and the block reported only execution time:
*"ran in 6 ms"* cold against *"ran in 20 ms"* warm — inverting the true order. `durationMs` is
stopwatched inside the sandbox page, so the load was structurally invisible to the only number the
block had. The boot is now measured around the load, named while it happens in the vocabulary round 3
gave silent streams, and reported *beside* the run time. Folding it in would claim the snippet took
8.6 s, which is false; dropping it inverts the order; so the header states both.

**A forecast nothing checked.** A plan step approved as *"Tools — may use: memory_search"* went on to
call `reference_lookup` against the user's own library, and the row said only *"🔧 2 tool calls"* — a
count that agreed with itself while the names disagreed. The forecast is deliberately still not an
allowlist (a small model that forecasts nothing would then be handed nothing); it is now reconciled
against what actually ran.

### The guard that let all of this through

`run.json` computed a run's validity from **fixture hits alone**. So a run whose declared
preconditions never held still scored as a comparison. A third guard now joins the settings
read-back and the fixture-bypass check: a task declaring a capability is INVALID when it did not
hold, probed both on disk and in the transcript, with a reason naming which precondition failed.

This was not hypothetical. It is how the following went unnoticed for three rounds.

### A flaw in the method, not the app

**The baseline arm never had the Python runtime.** When the baseline build was set up, `node_modules`
was symlinked into its worktree and `resources/pyodide` was not — and `resources/pyodide/` is
gitignored, so a worktree never inherits it. Five tasks — FR1, TTU2, V3, V2, VC1 — therefore ran
against a baseline whose sandbox failed with *"Workbench runtime not installed"* while the newer
build's worked. That is the harness handicapping one arm, not a property of the build.

Reading each critic's own reasoning for what it taints:

| Task | The verdict rested on | Status |
| --- | --- | --- |
| TTU2 | the critic wrote that the baseline *"never paid a boot at all… did not exercise the path TTU2 measures"* | **void** |
| V3 | the library-coverage line (independent) **and** the recompute disclosure (contaminated) | **partly tainted** |
| V2 | citation numbering and per-source URLs | unaffected |
| VC1 | presence of `break-words` on the bubble class | unaffected |
| FR1 | the context-overflow bubble; the critic wrote *"Neither touches the FR1 turn or the criticQuestion"* | unaffected |

So round 3's honest headline is **13 won, 0 lost, 2 tied, 1 void** — not 14–0–2 — and V3's win is
weaker than first recorded. The error ran in the flattering direction, which is exactly why the
precondition guard above exists now: a run that could not exercise its own task must not be
scoreable, and no reviewer should have to notice that by hand.

## Round 5, and the shape three rounds of checks kept failing in (v1.16)

Round 4 lost three tasks to a corrected baseline. Round 5 took all three plus the residuals, and the
individual fixes matter less than what finding them revealed.

### The pattern: a check whose vocabulary is narrower than the class it guards

Three rounds running, a check built for exactly the failing case did not fire on it, and each time
the reason was the same shape — the check enumerated the forms it had already seen, and the world
supplied one that was not on the list.

| Round | The check | Why it missed |
| --- | --- | --- |
| 3 | "is the search provider unreachable?" | It **enumerated** `net::` error codes. The task produces `ERR_UNSAFE_PORT`, which was not among them, so both guards were dead and the app burned 38% of a turn on a provider it had already been told was refusing. |
| 4 | "is this quotation in the source?" | It bounded a quoted span by the **line**, so a citation marker sitting inside the line was checked as part of the quotation — and a verbatim quote was flagged as invented. |
| 5 | "is this measurement supported?" | It armed **per normalised unit string**. `°f` and `°c` are unrelated keys to it, the passages held no Celsius, so `74°C` was never checked at all — and `165°F` was named only because one passage incidentally mentioned a refrigerator at `40 °F`. Reword that one line and the check names nothing. |

The round-3 repair is the one worth generalising: the enumeration was replaced by its **inverse** —
instead of listing the codes that mean unreachable, list the few that mean *a server answered*, and
treat everything else as unreachable. A list of known-bad cannot be defeated by an unknown; a list of
known-good can only be defeated by something that genuinely answered.

The round-5 measurement fix does the same thing one level up: temperature became one **dimension** in
two scales rather than two unrelated unit strings, so a corpus stating any temperature arms both, and
support crosses the scales but never the dimensions. Temperatures also stopped being *derivable* —
the integer-multiple rule had been certifying `80°F` from a fridge's `40 °F`.

**What this costs when it goes the other way.** The same rounds show the opposite failure. Round 4's
quote checker was made stricter and cried wolf on a correctly-sourced quotation; a critic's verdict
was that this *"teaches the user to ignore it, which costs more than the numbering gains"*. So the
rule is not "widen everything". It is that a check must be written against the **class** it guards,
with a true negative beside every true positive — which is now the standing requirement for a new
case in this document.

### Two failures that were not about vocabulary at all

**A disclosure that turned on which argument the model happened to send.** The
answered-from-memory badge was absent on a turn where every source failed. It was not a regression —
`git log -L :consultedSources:` shows one commit, ever. `lookupLibrary` returns `ok:false` for an
unknown pack and `ok:true` for an **empty library**, so the identical nothing arrived as `status:'error'`
in one arm and `status:'done'` in the other, and `consultedSources` counted the second. One arm's model
sent `pack:"home repair"`; the other omitted it. The app's own pre-flight path had honoured the right
contract all along — `contextProviders/libraryPassages.ts` refuses to record a synthetic call unless
passages came back — while the model-initiated path did not. A source tool that found nothing now
says so, on the block header (`∅ … — found nothing`) and to the badge.

**A revision certified by evidence the reader never saw.** The `✎ Revised` line claimed resolution on
a turn where the invented figure was still standing. The line is now a function of the report *before*
and *after*, names the surviving items, and is amber rather than green when a finding survives. But
the deeper cause is recorded here because it is not fixed: `reviseAgainstFindings` passes the turn's
records into the agent loop, so a tool call made **during** the correction joins the corpus the
revision is re-checked against — and `onToolExecuted` writes only the audit log, never patching
`toolCalls`. So the re-check can be satisfied by a retrieval that never appears on screen. The app was
not lying about the re-check; the re-check was reading evidence the reader had no access to.

### The verification tail, bounded

The post-answer tail was unbounded and under-reported. Measured across four recorded runs, the stat
line reported the token stream and was read as the turn: `213023` ms against `"76.6s total"`,
`80032` against `"25.7s"`, `162814` against `"51.9s"`, `42640` against `"19.6s"` — routinely 3–4×
out, and on one capture the tail exceeded a 300-second budget entirely.

The line now reads `25.7s answer · 54.3s checking · 80.0s total`, where the middle figure is the
difference of two wall clocks from one origin rather than an estimate, and a turn with no tail keeps
its single `total`. The whole tail gets one 60-second budget; on expiry it says what ran and what did
not, and leaves the answer unchanged. 60 s is longer than two of the three tails that finished at all
in the recorded runs, so this bounds the pathological case without checking less by default.

Worth recording as its own finding: both endings of the turn — the normal one and the iteration-cap
one — ran a **byte-identical copy** of the tail. That duplication is exactly how a bound added to one
path silently misses the other, and it was collapsed to a single call site as part of the fix.

## Round 6: the re-check that read what the reader could not (v1.17)

Round 5 lost exactly one task, V1, and the cause was documented as open before judging
began: `reviseAgainstFindings` passed the turn's records into the agent loop, so a
retrieval made *during* a correction joined the corpus the re-check read, while
`onToolExecuted` never patched `toolCalls`. A real passage cleared an invented figure;
the reader never saw it.

**Blind verdict: 16 won · 0 lost · 1 tied**, over 17 tasks, from a sweep that was
17/17 VALID with 0 screenshot failures. The tie is worth stating precisely rather than
counting as a wash: on TH1 neither arm's model invented a tool claim, so neither app's
tool-honesty check was put to the test, and both left the same thing on screen — nothing.

### The stat line, measured against a clock the app cannot see

This is the round's hard number, and it is an eval case in both directions. The capture
harness stamps `sendToTurnEndMs` in the page, from the same `Runtime.evaluate` that
dispatches the Enter keydown. The app has no access to it. Comparing every turn's
on-screen `"Ns total"` against that independent clock:

| | turns off by >25% | worst | median |
| --- | --- | --- | --- |
| baseline | **7 of 17** | **3.08×** — V2 claimed `32.4s total` on a turn that took 99.9 s | 1.06 |
| round 6 | **0 of 16** | **1.01×** | **1.00** |

The residual tenth of a second is the harness's own send-to-stamp offset, so 1.00 is the
floor, not a rounding.

The cause was one line. `turnStartedAt` was stamped *after* `gatherTurnContext`, so
every pre-model retrieval was billed to nobody — including the segmented line round 5
had just added, which is why round 5 fixed the tail and still under-reported the turn.
TTU1 is the clean demonstration, because its search delay is scripted to 8 s by the
loopback fixture and therefore identical in both arms:

- baseline: `13.45s to first token · 31.5s total` — measured turn **40.3 s**
- round 6: `12.80s to first token · 8.7s gathering · 31.1s answer · 39.7s total` — measured turn **39.8 s**

The baseline's "total" is arithmetically the generation phase alone (240 tok ÷ 7.6 tok/s
= 31.6 s). It deletes the eight seconds the reader actually sat through, and it is the
only number on screen labelled *total*.

### The clearance that now has to render

V1, the round-5 loss, run against the same library on the same model:

- **Round 5** showed one `reference_lookup` block, then
  `✎ Revised: 1 unsupported item was sent back (165 °F); the re-check faults none of them.`
- **Round 6** shows **three** `reference_lookup` blocks — the correction pass publishes
  its calls — and refuses the clearance:
  `⚠️ 1 measurement (165°F) in this reply is not backed by the tool output.`

Verified rather than asserted: `165` occurs in **zero** retrieved passages in that run, so
the warning is a true positive and the model's `[1], [2]` markers are a misattribution.
The check also discriminated — `3–4 days` and `1 week` are both literally present in
passage [5] and neither was flagged. One unsupported figure named, no false positives,
no misses.

### Three ways to fail, three states

An unsent call, a server error and an empty result had all rendered as one `✗`. They now
separate, with the reason on the collapsed row rather than inside a disclosure:

```
↩ 🔍 web_search — declined: the query was a sentence about you, not search terms
✗ 🔍 web_search — SearXNG returned HTTP 500.
⏱ Checking stopped at its 60s limit. Ran: the claim check, the code check.
   Not run: the revision. The answer above is unchanged.
```

with `Tool calls 3 · 1 declined` in the side panel. The baseline's three rows read
`✗ web_search`, `✗ reference_lookup`, `✗ web_search` — a decline, a missing pack and an
HTTP 500 collapsed into one indistinguishable glyph.

### The cry-wolf, and the figure that walked past the gate

Round 5's VC1 printed
`⚠️ Contact details no tool returned: 0001-0002-0003, 0004-0005-0006, …` on a turn
containing no contacts at all: the `PHONE` pattern had a trailing `\b` and nothing on the
left, so it started mid-token inside a 220-character base64 blob. Round 6 prints nothing
there, in either arm. In the other direction, `unsourcedFigures` had been finding
`$34,000` and `checkToolGrounding` was discarding it at the gate; that figure is now
reported. A true negative and a true positive from the same round, which is the standing
requirement for a new case here.

### What this round does not measure

- **The reference-app comparison is still absent.** These are 17 tasks against this
  build's own baseline on `qwen3.8-9b`. Nothing here is a claim about Claude Desktop or
  ChatGPT Desktop.
- **Dark theme has never been captured by the bench.** The 45-check chrome-contrast suite
  covers both themes in the render harness, but no head-to-head run has ever screenshotted
  dark, so `N_fail` and `MIN_RATIO` for dark are unmeasured on both arms. The VC3 numbers
  quoted anywhere in this document are light theme only.
- **One critique may be the instrument, not the product, and is unresolved.** On V3 the
  warning names `$0.01, $36, $10` while the captured on-screen prose reads
  `at 0.01 per gallon that's36/year` — the reader cannot locate the figure. The checker
  cannot be inventing the `$`: `CURRENCY` requires a literal one in the model's text.
  But `latexToPlainText` preserves all five dollars on the real paragraph, so does the
  full `renderMarkdown` path, and the harness reads bare `innerText`. One of those four
  statements is wrong and it is not yet known which. Until it is, this is recorded as an
  open question rather than a product defect — if it turns out to be the capture, it is a
  measurement fault of the same family as the handicapped baseline arm.
- **Turn totals across arms are not a speed comparison.** Several round-6 turns are
  longer than the baseline's because they run a bounded verification tail the baseline
  never ran at all (TH2: 112.8 s against 58.0 s, of which 60.0 s is the disclosed
  `checking` budget expiring). PT1's 334 s against 202 s is answer length — the round-6
  reply is multi-column tables where the baseline's is a list — which is model variance,
  not app behaviour.

### The species, in six new places

Round 5's finding was that a check whose vocabulary is narrower than the class it guards
gets defeated by a form not on the list. Round 6 won every task it was tested on, and the
critiques found the same shape again in places nobody had looked:

| Where | The sin |
| --- | --- |
| VC1 | `the checker compared the reply against that output` — it compared **figures**. The sentence is broader than the measurement, printed under a reply whose echoed string disagrees with the Python inches below it. |
| PT1 | Executed ∖ forecast is flagged; **forecast ∖ executed is silent**. A plan promised `list_notes` and `read_note`, ran neither, and the header still reads `4/4 steps done`. |
| TH3 | A quote warning fires on a span differing from its source only by curly-versus-straight quote glyphs — and the 60-character truncation stops **before** the deviation, so the reader sees a fabrication warning on a verbatim quote with nothing visibly wrong. |
| V2 | The same truncation leaks raw markdown into user-facing text: `rises to **$3…`. |
| TH1 | The reply's account of its own **arguments** is unchecked. It states `query: "ground beef safe internal temperature"`; the audit shows the whole user prompt went. |
| everywhere | `⚠️ 3 figures (…) in this reply **is** not backed` — the verb agrees with the number of *categories*, not the number of items ([`MessageBubble.tsx:166`](../src/renderer/src/components/MessageBubble.tsx)). Every plural case is ungrammatical, on the one sentence carrying the verifiability claim. |

The generalisation holds and sharpens: it is not only *enumeration* that fails. It is any
check that reads a quantity **adjacent to** the one it means — the categories instead of
the items, one direction of a set difference instead of both, the figures instead of the
reply.

<!-- FOLD IN: cases for the next round's section. Three of round 6's critiques, answered. -->

## Pending fold-in — the sentence, the verb and the ink (v1.17.1)

Three of the round-6 critiques above, taken in one pass. Two of them are the same defect
in two registers: a sentence broader than the measurement behind it. The third is the
same thing in pixels — the banner that admits the answer is unsupported was the least
legible chrome in the app.

### VC1: what the recompute line is entitled to say

The critique was `the checker compared the reply against that output` — printed under a
reply whose echoed token disagrees with the Python inches below it. Re-run against the
recorded turn, the pipeline reports something sharper than "it missed one":

| | on the recorded VC1 reply |
| --- | --- |
| `unsourcedFigures` | `[]` — all **thirteen** digit groups in the pasted token occur in the run's output |
| `checkToolGrounding` | `null` — **no finding at all** |
| the two tokens | `sigma-oasis-…` decoded, `sign-my-as-is-…` echoed |

So the numbers genuinely were compared, and genuinely did agree. The four characters that
were wrong were letters, and no rung in `checkToolGrounding` reads a letter. The old
sentence was true of the one dimension that was right and false of the only one that was
wrong, which is the whole of the complaint.

**Widening was considered and rejected on the same recording**, which is the part worth
keeping. The obvious widening — compare non-numeric `label: value` lines the reply
restates — has nothing to read here: the program printed its decoding *one character per
line*, so the token occurs contiguously in that output in neither form, and there is no
string-valued printed line at all (`compareToOutput` returns `{agreed: 0, mismatches: []}`).
The blunt version — every long token in the reply must occur in the output — fires
**identically on the correct answer**, because `sigma-oasis-…` is equally absent from a
character dump. That is round 4's cry-wolf in a new costume, and round 4's verdict on it
stands. The check that would catch this does not exist yet; until it does the sentence
says what the app did:

- before: `🧮 Recomputed the stated figures in Python; the checker compared the reply against that output.`
- after: `🧮 Recomputed the stated figures in Python; the reply's numbers were compared against that output. Numbers only — text it copies from the run, such as a decoded string or an identifier, was not checked.`

The pinning assertion changed with it, and strictly upward: `test/unearnedVerification.test.ts`
used to assert `/compared the reply against that output/` — it pinned the defect — and now
pins the claim and its limit together, so the claim cannot widen again without failing.

### The verb, and the quantity next to the one it meant

`parts.length > 1 ? 'are' : 'is'` counted the **categories** the banner names. The sentence
now lives in `describeUnbackedItems` (`lib/toolGrounding.ts`), where it has a test, and the
verb agrees with the items.

| | before | after |
| --- | --- | --- |
| true positive | `2 measurements (165°F, 74°C) … **is** not backed` | `… **are** not backed` |
| true positive | `3 figures ($0.01, $36, $10) … **is** not backed` | `… **are** not backed` |
| true positive | `4 links … **is** not backed` | `… **are** not backed` |
| **true negative** | `1 measurement (165°F) … **is** not backed` | unchanged — still `is` |
| **true negative** | `1 figure ($36) and 1 link … **are**` | unchanged — plural, now for the right reason |

The last row is the one that made this hard to see: a compound subject is plural however
its halves count, so the wrong quantity happened to cross the threshold with the right one
in exactly the case a reader was most likely to check. Three categories also stopped
reading as `A and B and C`.

### The banner that admits the answer is unsupported

A critic measured `Checked against: reference_lookup.` at **3.06:1**. The chrome-contrast
suite said 4.78:1 and passed it, because it read `getComputedStyle(el).color` and the line
was dimmed with `opacity-75`. Opacity is not a colour: it composites the ink *and the
surface under it* against everything behind them, so the tone chosen is not the tone
rendered. The suite now walks the opacity chain root→node. Reproduced, in the harness, on
the shipped v1.17 markup:

| light theme, over the banner's own wash `#fcf7f0` | v1.17 as read before | v1.17 as it rendered | v1.17.1 |
| --- | --- | --- | --- |
| warning line | 4.78:1 | 4.71:1 | **8.52:1** |
| list of invented links (`opacity-90`) | 4.78:1 | **3.99:1** ✗ | **8.52:1** |
| `Checked against:` footer (`opacity-75`) | 4.78:1 | **3.10:1** ✗ | **6.66:1** |

Dark went 10.98 / 9.06 / 6.61 → 12.71 / 12.71 / 10.98. The ranks are ink tokens now —
`amber-900` over `amber-800` in light, `amber-300` over `amber-400` in dark — each measured
over the surface actually composited beneath it, and a static guard fails the build if any
ink in that banner is dimmed with `opacity` again (it catches the states no fixture renders:
a report carrying contacts, or addresses, or quotes).

- **True positive:** with the v1.17 banner restored, the suite exits **1** with
  `light: "grounding link" clears AA — 3.99:1` and `light: "grounding provenance" clears AA — 3.10:1`.
- **True negative:** under the same opacity-aware reading, all 45 pre-existing checks still
  pass and every one of the 36 ink rows they read reports a **byte-identical** ratio and
  colour. Nothing else in the app dims ink with opacity, so the strengthening added no
  findings anywhere else. The suite is 45 → 54 checks.

### What this does not measure

- **Nothing here was re-run against a model.** These are three chrome defects, fixed and
  pinned against recorded output and a real offscreen window. No new head-to-head sweep was
  taken, so there is no win/loss claim attached to any of it.
- **The gap the recompute sentence now admits to is still a gap.** A reply that restates a
  *string* from its own tool output — a decoded token, an identifier, a filename — is
  unchecked, and VC1 is a recorded instance of that going wrong. The sentence stops
  claiming otherwise; it does not close it. Closing it needs a run whose output holds the
  string contiguously, which is a change to what `RECOMPUTE_INSTRUCTION` asks for, and that
  is a behaviour change nothing has measured yet.
- **The contrast numbers are the fixture's, not a screenshot's.** They come from the render
  harness compositing the app's real stylesheet, which is still the only place dark theme is
  measured at all — the head-to-head bench has never captured it.
- **Entry animations are now suppressed in the contrast fixture.** `oasis-enter` fades
  opacity over 0.4 s, and once opacity is measured a screenshot taken mid-fade reports a
  ratio nobody sees for longer than a blink. The suite measures the resting state and says
  so; the transient is unmeasured.

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
- **A feature can be measured working and still be broken.** Project-wide recall answered 7/8
  against a bare arm's 1/8 on its first run — and in that same run the gate meant to keep it quiet
  on unrelated questions fired 5 times out of 5, injecting freight passages into "what is 15% of
  200?". Nothing user-visible was wrong; the model ignored them. A headline delta is not a
  verdict on the parts, which is the argument for scoring retrieval separately from the answer.
- **A floor borrowed from another retrieval path is a guess.** The 0.35 cosine floor came from
  long-term memory, where it works. Embedding models sit at different baselines, and nomic-embed's
  is ~0.54 — above the floor — so it admitted everything. A threshold expressed as a margin over
  the corpus's own mean survives the change of model; an absolute one does not.
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
