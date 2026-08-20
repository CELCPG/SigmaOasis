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

Caveats: one model class, synthetic series (deterministic, but not real market texture), and the
provider path is exercised only up to the parser — the fixture stands in for the network.

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
