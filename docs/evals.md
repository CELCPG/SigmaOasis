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

### ADDENDUM — V3's missing dollars: the product, and the blind spot that hid it

*(Written after the round; fold into the round-6 body. It settles the open question the
next section used to carry, so that bullet is now a pointer rather than a question.)*

The verdict is **the product**. `latexToPlainText` was deleting currency from replies, and
had been since the module shipped. The instrument was not at fault — but the instrument is
why nobody could tell for four rounds, and that is the other half of this entry.

**Why it was undiagnosable.** Every text artifact a run directory held — `reply.txt`,
`transcript.txt`, `transcript.json` — came from `innerText`. That is deliberate and stays:
`innerText` is what the reader saw. But it is post-render *by construction*, so a run
recorded a rendering defect's output and never its input. Asked "did the model write `$36`
or did the app eat it?", a completed run had nothing to say. The four statements the round
left standing included *"`latexToPlainText` preserves all five dollars on the real
paragraph"* and *"so does the full `renderMarkdown` path"*. Both were true of the string
they were run on and both were false of the reply, because that string was a
**reconstruction** of the raw markdown — the only thing available — and the reconstruction
was wrong in exactly the two characters that mattered.

The harness now writes `reply.md` and `messages-raw.json` beside the rendered text, read
through `window.api.listConversations()` — the app's own sidebar API, reached the way the
audit export already is, with no product code path added for the bench. Nothing that was
scored before is scored differently; this is an addition.

**What the diff showed.** One V3 reproduction, first run with the new artifact:

| | `$` count |
| --- | --- |
| `reply.md` (what the renderer was handed) | **6** |
| `reply.txt` (what the reader saw) | **0** |

`$5–$20 for parts` reached the screen as `5–20 for parts`; `$150–$400+` as `150–400+`;
`$10–$20 repair kit` as `10–20 repair kit`. Not a subtle degradation — every price in a
reply about what a repair costs, gone, in prose that still read as fluent English.

**The mechanism.** `$` is both the inline-math delimiter and the dollar sigil, so
`latexToPlainText` has to decide which each one is. `looksLikeMath` decided wrongly in two
ways, and round 6's V3 hit both in one reply:

- `if (/[\\^_{}~]/.test(inner)) return true` had **no multi-word guard**. The guard the
  module documents — "multi-word spans are currency text" — was wired only to the *other*
  branch. So any two dollars on one line paired into "math" if the prose between them
  contained a stray `~`, `_`, `^` or brace. `~` is the common one: it is prose for "about"
  and it sits directly in front of money. `at $0.01 per gallon that's ~$36/year` became
  `at 0.01 per gallon that's36/year` — the missing space is `texToPlain`'s closing `.trim()`
  eating the one that the `~` left behind.
- `return /^\S+$/.test(inner) && inner.length <= 24` accepted **any** single token. Between
  `$5–$10` the token is `5–`, so a price *range* passed as an expression: `often a 5–10 part`.

Both observed strings reproduce character-for-character from those inputs, and the
surviving dollars corroborate rather than contradict: `for under $10.` lived because it was
unpaired, and V2's four all lived because the prose between `$30,000` and `$800` carries no
TeX marker at all. The rule was never "strip dollars" — it was "pair them, if something
between them looks like TeX", which is why it looked random.

The fix makes a marker count across whitespace only when it is a **backslash**, because TeX
that spans words always names a command (`214 \text{ atm}`, `a \leq b`); anything else must
be one short token carrying a script marker or a letter. Inline `$E = mc^2$` now renders as
written instead of as `E = mc²`. That is the right way to be wrong: this module's stated
contract is that what it cannot recognize is left close to the source, and a caret on
screen costs a reader nothing while two deleted prices cost them the answer.

**The case.** `test/mathPlaintext.test.ts`, "currency that inline math used to swallow":
the two captured sentences pinned verbatim in both halves, the six-dollar count from the
reproduction, `foo_bar` and `unit^2` for the other two weak markers, and `$5~kg$` to hold
the line that tightening the marker set must not cost a genuine single-token span its
tilde. The failure was silent — the reply read fluently and only the grounding warning,
naming figures no reader could find, disagreed — so the outputs are pinned exactly.

**What this cost.** Four rounds scored V2 and V3 on replies whose figures had been deleted
between the model and the screen, and scored them as wins. The grounding warning was
*correct* every time it named `$0.01, $36, $10`; it was read as a cry-wolf because the
figures were genuinely not on screen. A check disagreeing with the page was treated as the
check being wrong, when the page was wrong — which is the round-5 species inverted, and
worth adding to that list: **when a check and the screen disagree, the screen is a
measurement too, and it can be the one that is broken.**

### What this round does not measure

- **The reference-app comparison is still absent.** These are 17 tasks against this
  build's own baseline on `qwen3.8-9b`. Nothing here is a claim about Claude Desktop or
  ChatGPT Desktop.
- **Dark theme has never been captured by the bench.** The 45-check chrome-contrast suite
  covers both themes in the render harness, but no head-to-head run has ever screenshotted
  dark, so `N_fail` and `MIN_RATIO` for dark are unmeasured on both arms. The VC3 numbers
  quoted anywhere in this document are light theme only.
- ~~**One critique may be the instrument, not the product, and is unresolved.**~~
  **Settled — it was the product.** `looksLikeMath` was pairing two dollar sigils into a
  math span and converting the prose between them, deleting both figures. Two of the four
  statements were wrong, and wrong for the same reason: `latexToPlainText` and
  `renderMarkdown` were both exonerated against a *reconstruction* of the raw markdown,
  because no run directory contained the real thing. See the addendum above; the harness
  now captures `reply.md`, and the fix ships with pinned cases in
  `test/mathPlaintext.test.ts`.
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

## Round 7: five checks that read the quantity next to the one they meant (v1.17.1)

Round 6 won 16 of 17 tasks and lost none, and its critics still found the same species in
six new places. Round 7 took five of them, one builder each, and the round's own work
turned up two more — one in the shipped renderer and one in the gate that certifies every
round in this document.

**Blind verdict: 18 won · 0 lost · 0 tied**, over 18 tasks — the full set for the first
time, because VC2 had never had a baseline capture to pair against. Both sweeps were 18/18
VALID with 0 failed.

**Read the caveat before the number.** This is the widest margin of the seven rounds and
also the round whose judging was most biased toward it, for a reason that is mine. The
critic prompts named the specific checks this round had just built — *"compare the forecast
IN BOTH DIRECTIONS"*, *"does the collapsed row say why"*, *"measure the pixels, not the
declared colour"*. A critic told to measure the thing we optimised will find that we win.
Earlier rounds' prompts stayed closer to each task's own `probes` field; this round's
drifted toward the changelog. **So 18–0 is not comparable with rounds 1–6 and must not be
read as a trend.** Round 8 derives its critic prompts from `tasks.json` alone, written
without sight of what changed.

Two further limits on what the number means. The baseline is seven rounds old, so a sweep
against it measures accumulated distance rather than this round's work — the informative
comparison is round N against round N−1. And the critics found real defects in *every*
winning run, several of them self-inflicted: the VC1 layout fix set
`overflow-wrap: anywhere` on all markdown, and it now breaks the word "Passage" across
three lines as "Pas / sag / e" in a table header sized to a `[1]` cell.

### The renderer was deleting money from answers

Round 6 recorded, under "what this round does not measure", an unresolved question: the
grounding warning named `$0.01, $36, $10` while the captured screen read
`at 0.01 per gallon that's36/year`. It is resolved, and it was the product.

`looksLikeMath` in `mathPlaintext.ts` decides whether a `$…$` span is TeX. Its first
branch — `if (/[\\^_{}~]/.test(inner)) return true` — carried **no multi-word guard**;
the guard the module documents was wired only to the other branch. `~` is ordinary prose
for "about", and it sits directly in front of money. Its second branch accepted *any*
token under 24 characters, so the fragment `5–` between `$5–$10` passed as an expression.

Run against the pre-fix code, on the exact strings the capture recorded:

| written by the model | shown to the reader |
| --- | --- |
| `at $0.01 per gallon that's ~$36/year` | `at 0.01 per gallon that's36/year` |
| `$5–$20 for parts` | `5–20 for parts` |
| `$150–$400+ for a plumber` | `150–400+ for a plumber` |

Every price in an answer about repair costs, deleted, in prose that still reads fluently.
`for under $10.` survived because it was unpaired; V2's four survived because the prose
between them holds no TeX marker — which is why it looked random rather than systematic.

Two things about this are worth more than the fix.

**The warning was right every time it fired.** It was read as a cry-wolf because the
figures genuinely were not on screen. When a check and the screen disagree, the screen is
a measurement too, and it can be the broken one.

**The instrument could not see the string it needed.** Every text artifact the bench
writes comes from `innerText`, which is post-render by construction, so the raw assistant
markdown existed nowhere in a run directory and a rendering defect was undiagnosable from
a completed run. Two exclusions written into the round-6 section — that `latexToPlainText`
was clean, and that the full `renderMarkdown` path was clean — were both **wrong**, and
wrong for the same reason: they were run against a *reconstruction* of the raw markdown,
which differed from the real thing in exactly the two characters that mattered. The
capture now writes `reply.md` and `messages-raw.json` beside the rendered text, read
through an already-exposed production API, scrubbed and arm-anonymised like every other
artifact.

### The gate typechecked a list, not the project

`scripts/test.sh` compiles a hand-maintained list of 66 files, grown one entry at a time
as tests needed things. `MessageBubble.tsx` — which renders the entire verification
banner — was never on it. A merge this round left a dangling `parts` reference in that
file and the script exited **0** on it; `npm run typecheck` failed. The gate that
certifies "all node checks green" every round did not cover the file carrying the claim.

That is the enumeration failure inside the instrument that grades the enumeration
failures. The list is replaced by both tsconfigs under `--noEmit`, which describe the
project rather than a selection.

### PT1: the half of the set difference nothing checked

The row above is confirmed against the raw audit log rather than taken from the critique. The
plan on screen at the approval moment forecast `Tools — may use: list_notes` on one step and
`Tools — may use: read_note` on another; `trace/audit.jsonl` for that run holds `memory_search`
×1 and `reference_lookup` ×3 and nothing else. **Neither forecast tool ever ran.** Worse, the two
steps that did reach for tools were the ones whose forecast read `Tools — none planned; this step
reasons only`, so every tool disclosure in that block was wrong and the block's only verdict was
about the pair that had run.

Everything the block said about it, **before**:

```
📋 Plan — 4/4 steps done                                 finished
✓ 1. List the stored notes
     Tools — may use: list_notes
✓ 3. Recall what was established                         🔧 1 tool call
     Tools — none planned; this step reasons only
     ⚠️ Ran memory_search, which this step did not disclose.
```

**After**:

```
📋 Plan — 4/4 steps done · 4 of 4 steps diverged from their forecast    finished
✓ 1. List the stored notes
     Tools — may use: list_notes
     Forecast list_notes, which this step never ran.
✓ 3. Recall what was established                         🔧 1 tool call
     Tools — none planned; this step reasons only
     ⚠️ Ran memory_search, which this step did not disclose — it planned no tools at all.
```

Written against the class rather than the instance: `reconcileStepTools` returns the whole
symmetric difference from one place — `undisclosed`, `unrun`, and whether the forecast was
*empty* — and the row reports every member of it. Adding a direction later means adding it there,
not remembering to.

Three decisions that could each have gone the other way:

- **The unrun half is deliberately not a warning.** A tool that ran unannounced is work the reader
  did not authorise; a tool that was offered and turned out not to be needed is often the step
  doing its job. The defect was never that the forecast over-reached — it was that nothing said
  so, so a reader could not tell an informed approval from an uninformed one. It gets the step's
  own body ink and no glyph: measured at **5.05:1 light / 6.26:1 dark**, clear of AA, and strictly
  below the amber warning's **6.04:1 / 9.34:1**. Round 4's lesson is the reason — two failures at
  one volume teach the reader to discount both.
- **`4/4 steps done` stays, and stops standing alone.** It is true; every step reached the end of
  its sub-turn. Shrinking the count would trade one false impression for another. What it gets is
  a clause at *its own* weight and ink, so the qualification cannot be read without the claim.
  The outcome badge remains the heaviest thing in the block (asserted on this fixture, extending
  PT2's rule to it).
- **"Reasons only" and then two tools is not the same as adding one to a list.** The reader was
  told in as many words that this step would touch nothing. That row now ends `— it planned no
  tools at all`; a step that merely added a tool to a real forecast keeps the plain wording, and
  a test asserts the two do not read alike.

The gate on the unrun half is `status === 'done'`, and the distinction is *did not* versus *could
not have*: only a step that reached the end of its own sub-turn can be said to have finished
without touching what it forecast. A failed, stopped or skipped step never got that far, and its
row already says so — pinned for all five non-`done` statuses.

| Case | Forecast | Ran | What the row says |
| --- | --- | --- | --- |
| **TP** — the measured run | `list_notes` | — | `Forecast list_notes, which this step never ran.` |
| **TP** — the measured run | *none planned* | `memory_search` | `⚠️ Ran memory_search, which this step did not disclose — it planned no tools at all.` |
| **TP** — both at once | `memory_search` | `reference_lookup` | both lines, quiet one first |
| **TN** — accurate forecast | `list_notes`, `read_note` | `list_notes`, `read_note` ×2 | nothing, and the header stays `3/3 steps done` with no clause |
| **TN** — partial match | `list_notes`, `read_note` | `read_note` | `list_notes` only; `read_note` is never faulted |
| **TN** — never reached it | `read_note` | — (step `failed`/`stopped`/`skipped`/`pending`/`running`) | nothing; the row's own status already says it |

24 new cases in `test/planBlock.test.ts`, seven of them a table walk over
forecast × executed asserting that a name is faulted **iff** it is in the symmetric difference —
the class, not the two instances that were found.

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

### TH1: the reply's account of its own arguments

The TH1 row above is the gap. This is the rung built for it, and the two directions it was
measured in — fold it into whichever round ships it.

**The failure.** TH1 asks, explicitly, *"Answer it, then tell me exactly which tools you used
to get that and what each one gave back."* The reply named the right tool, disclosed it under a
`Tools used` heading, and stated its argument as `query: "ground beef safe internal temperature"`.
The audit log and the tool block both show what was actually sent:

```
reference_lookup({"query":"What internal temperature does ground beef need to reach? Answer it,
then tell me exactly which tools you used to get that and what each one gave back."})
```

Every rung of the ladder passed it, each for a good reason of its own. `unrunToolClaims` checks
the tool's *name*, and the name is right. `undisclosedToolRuns` checks that the account names
every call, and it does. `misquotedSpans` is the near miss: it strips code spans before it looks
— deliberately, since a string literal in a snippet is not a citation claim — which is exactly
where a model writes a tool argument, and where it does see one it accuses it of the wrong thing
(a query string was never offered as something a tool *returned*). The critic scored the task a
tie because neither build was ever put to the test on it.

It is not cosmetic. A reader told the query was four targeted keywords reads the passages under
it as responsive to *that* query. What happened is that a 151-character sentence, second clause
and all, went to a keyword-ranked local library, which ranks on whichever words dominate it.

**Where the line falls, and why it generalises.** A reply that paraphrases — "I looked up the
safe temperature for ground beef" — is describing its own work in its own words and is making no
checkable claim. A reply that puts a string in quotation marks and hands it to a named parameter
has quoted the call, so **an argument in quotes is a quotation** and is judged exactly as
`misquotedSpans` judges one: against the string the call actually carried, with an explicit
ellipsis the only permitted cut. A stated value that is a contiguous part of what went is clean
— understatement, not invention.

Round 5's repair applied twice: both vocabularies point at known-good rather than known-bad. The
parameter names are read off the shipped tool schemas, so renaming a parameter moves the check
with it; and the supported set is *what the turn actually sent*, never a list of the shapes a
fabrication takes. A phrasing the scanner does not recognise costs a miss, and cannot manufacture
a finding.

**Scope, and the argument for it.** String parameters of the source and retrieval tools only —
`query`, `pack`, `url`, `question`, `depth`, `need`, `product`, `action`, `name`. Those arguments
decide what the tool went and got, they are short human-readable text a reader can compare by
eye, and for a reader who does not open the call block the reply is the only place they appear.
A `run_python` body or a note's text is a different animal — long, structured, already rendered
verbatim in its own block — and a reply quoting a fragment of one is making no claim about what
was retrieved. Numbers are out for a sharper reason still: `max_passages: 6` is not something a
reader reads the results through.

**True positive**, on the TH1 reply, with the `reference_lookup` record carrying the real query:

```
⚠️ This reply states an argument the call never received: query: “ground beef safe internal
temperature” — the call sent “What internal temperature does ground beef need to reach? Answer
it, th…”.
```

Naming what went beside what was claimed is the whole point: the reader can settle it without
opening anything. Both values are stripped of markdown before display, which is round 6's V2
sin (`rises to **$3…`) not repeated, and the cut is the app's own ellipsis.

**True negatives**, all four measured on the same reply and the same record, all producing
silence — no badge at all, not merely a smaller one:

| The reply says | Verdict |
| --- | --- |
| `I passed your question to reference_lookup as it stood, rather than reducing it to keywords.` | silent — a paraphrase is not a quotation |
| `query: "What internal temperature does ground beef need to reach? Answer it, then tell me exactly which tools you used to get that and what each one gave back."` | silent — verbatim |
| `query: "What internal temperature does ground beef need to reach? …"` | silent — the cut is marked |
| `query: "internal temperature does ground beef need to reach"` | silent — a fragment of what went |

Plus two structural negatives: a `query: "…"` inside a Python snippet with no call attributed to
it says nothing, and a parameter *no call passed* says nothing — with nothing sent there is
nothing to contradict, and a claim about a call that never happened is `unrunToolClaims`' business.

This is the round-4 lesson taken seriously. That round's stricter quote checker was judged
**worse** than the gap it closed because it fired on a correctly-sourced quotation; a rung that
reads prose about a JSON value is the same risk in a new place.

**Swept for cry-wolf.** Every recorded reply fixture in `test/toolGrounding.test.ts` — the car
loan, the cycling route, V1, V2, VC1, the tools-used table, the passage blobs, 18 in all — was
re-run against eight armed tool records (a `reference_lookup` with a real `query` and `pack`, a
`web_search`, a `fetch_webpage` with `url` and `query`, a `deep_research` with `question` and
`depth`, a `price_watch` with `action`/`url`/`name`, a `shop_compare`, an `image_search`, a
`shop_requirements`) across five different real queries — 90 reply×query runs, each seeing all
eight records and all nine parameters at once. **One finding came back, and it is TH1's.**

**One claim earns one finding.** A stated argument in straight quotes is also a quoted span, so
`misquotedSpans` sees it too — and "quoted as exact but in no tool output" is the wrong
accusation against a query string, which was never offered as something a tool returned. The
gate now drops a quote finding that duplicates an argument finding: the specific rung wins, and
the count stays equal to the number of things actually wrong.

Node cases: 1911 → 1927.

### The quote warning that hid the difference it warned about

Two round-6 critics, on two different tasks, found the same defect from opposite sides. Every
string below is the round-6 checker's own output, replayed against the round-6 code, not a
paraphrase of it.

**The cry-wolf (TH3).** `packs/food-safety/docs/refrigerator-thermometers.md` reads
`the simple rule is: “When in doubt, throw it out.”`. The reply quoted the sentence *around*
that, so its own outer pair took the double marks and the source's nested pair came back out as
`‘When in doubt, throw it out.’`. Two glyphs out of a hundred and four, not one word different.
`flattenQuote` had folded curly to straight since v1.14 and never folded single to double, so:

```
⚠️ Quoted as exact but in no tool output this turn: "If you're not sure or if the food
   looks questionable, the simple rule is…"
```

The 72-character clamp stops *two characters short* of the first glyph that differs. The critic
checked the flagged span against the pack, found it verbatim, and wrote that this
*"trains them to ignore it"* — which is round 4's lesson, arriving for the second time.

**The same clamp, leaking its own source (V2).** The reply bolded the figure inside a passage it
had copied word for word — `rises to **$30,000**, an increase of $800` — and the badge printed
`…the standard deduction rises to **$3…`. The critique was that raw markdown had reached
user-facing text and *"the reader cannot see which words were altered"*. Both true, and there was
a third thing wrong underneath: `**` is not a word either, so this too was a fabrication warning
on a verbatim quotation.

**What the clamp cost, stated exactly.** Feed the round-6 checker the correct quotation and the
falsified one, and it prints the *same string* for both — the cut lands on the character before
the one that differs:

| Reply | Round 6 printed | Round 7 prints |
| --- | --- | --- |
| `rises to **$30,000**` — verbatim | `…rises to **$3…` | *nothing* |
| `rises to **$32,000**` — invented | `…rises to **$3…` | `…jointly, the standard deduction rises to $3⟪2⟫,000, an increase of $800 from tax year…` |
| `…the simple rule is: ‘When in doubt, throw it out.’` — verbatim | `…the simple rule is…` | *nothing* |
| `…the simple rule is: ‘When in doubt’, throw it out.` — the source's sentence made to end early | `…the simple rule is…` | `…or if the food looks questionable, the simple rule is: 'When in doubt⟪'⟫, throw it out.` |

A warning that is byte-identical whether the quotation is honest or invented carries no
information at all. Both halves had to move: the fold, so it stops firing on the honest one, and
the excerpt, so the reader can see what is wrong with the other.

**Where the normalisation stops.** Widening a fold is how a checker is quietly turned off, so the
line is drawn at one rule: **fold how a mark is drawn, never whether it is there or where.**

- Every quotation glyph — `' ‘ ’ ‚ ‛ " “ ” „ ‟ ′ ″ « » ‹ ›` — folds to one character, and the
  dash family to one hyphen. Swapping `«` for `"` cannot change which words are quoted.
- Paired markdown emphasis and link syntax are removed from **both** sides and from the displayed
  span, under CommonMark's flanking rule (no space just inside the delimiters, `]` against `(`).
  The rule matters more here than in a renderer: the fold runs over the corpus and the reply
  separately, so a delimiter that pairs on one side and not the other would manufacture the very
  false positive it exists to remove. A lone `*` in a footnoted source line stays put, and a
  single `_` is never emphasis — `use_by_date` is ordinary tool output.
- Nothing is deleted or moved. `"when in doubt", throw it out` and `"when in doubt, throw it out"`
  are different claims about where the source's sentence ended, and they stay different strings
  through the fold — which is the fourth row of the table above.

**The excerpt.** The reported span is now a window centred on the break rather than the first 72
characters, with `⟪⟫` marking where the quotation stops matching. The break is found by growing
the longest run from each end that occurs in the corpus; a run under five characters is discarded
as coincidence (`s.` and `, and` are in every English paragraph), and the tail end rounds out to
the end of the word it lands in, while the head is reported exactly — `check⟪ing⟫ leftovers daily`
is precisely how far the reply and the source agree. The same window rule now governs the
48-character label on the `✎ Revised` line, which would otherwise have re-introduced the original
bug one line lower down.

**The cases, with a true negative beside every true positive** (10 new, `test/toolGrounding.test.ts`;
suite 1911 → 1921, `./scripts/test.sh` exit 0):

| True negative — must stay silent | True positive — must still fire |
| --- | --- |
| The TH3 sentence with the nested pair re-drawn as single quotes, and again curly throughout | The same sentence with `looks questionable` → `smells strange`, reported as `⟪smells strange⟫` |
| The V2 blockquote with `**$30,000**` bolded inside it, and the same quotation inline | `**$32,000**` in the same blockquote, reported as `$3⟪2⟫,000` with no asterisk in the output |
| A footnoted line quoted with its unpaired `*` intact | The same line with `2 hours*` → `4 hours*` |
| The TH3 turn end-to-end through `checkToolGrounding` — no report at all | A wholly invented CPSC-style quotation, flagged whole and unmarked, because none of it matches |

Seven existing assertions moved, every one of them by demanding more: the span they already
pinned, *plus* where the break inside it is. Nothing was relaxed and no case was dropped — the
TH1 stitched quotation (`Ground meats, such as beef and pork — 160°F`, two separate lines of
passage [2] joined by a dash the reply supplied) is still flagged and now names the join,
`pork ⟪—⟫ 160°F`; the wrong-figure case that used to assert the truncated `…rises to $32,…` now
asserts the digit itself.

**What this does not fix.** A quotation containing inline code is still stripped to a space before
the comparison runs (`INLINE_CODE` is applied to the whole reply so that a string literal in a
snippet is not read as a citation), so a quoted line with a backticked word in it can still be
faulted for a word it does say. Nothing in the round-6 runs exercised it, and it is recorded here
rather than fixed.

### The approximation that became an exact figure

`reply.md` was added to settle the currency bug. The first independent critic to use it
found a **second** character-eating defect, unrelated in mechanism and identical in
consequence.

GFM lets a *single* tilde open a strikethrough, and marked implements that. In technical
prose `~` means "about", and models write it constantly. Two approximations in one
paragraph pair up: the run between them renders struck through and both tildes are eaten.

| written by the model | shown to the reader |
| --- | --- |
| `| Total system flow | **~51 GPH (~0.9 GPM)** |` | `Total system flow   51 GPH (0.9 GPM)` |
| `Target: ~84,000 calories (~2,100 cal/person/day)` | `Target: 84,000 calories (2,100 cal/person/day)` |

An estimate reaching the reader as an exact figure, in the line a reader is most likely to
quote. Strikethrough is now `~~text~~` only, pinned by four checks in the render harness,
one of them the true negative that real strikethrough still works.

**Recorded because I got it wrong first.** The round-7 sweep showed zero tildes lost in the
new build, and I reported that as the earlier `latexToPlainText` fix covering the class. It
does not — the mechanisms are unrelated, and no reply in that sweep happened to put two
tildes in one paragraph. Absence of a symptom in a sample is not evidence of a fix. It is
the same error as reading a summary line instead of an exit code, which this document
already records once.

### The blind pairs named their arm on one task

`make-blind-pairs.mjs` scrubbed the run root and the arm directory — the two paths inside
the run tree, which are the two anyone thinks of. The build being driven is not inside it.
`h2h-preconditions` records the absolute path of every file it probes, so TTU2 — the only
task declaring `python-runtime` — shipped

```
.../scratchpad/baseline-app/resources/pyodide/pyodide.js
```

inside `run.json`. **Both** arms were identifiable, not one: the other run carried the
working repo's own path.

The app root is now read out of the run's own `_arm.json`. That is still a list of things
someone remembered, so the half that matters is its inverse: `assertBlind` searches every
staged text file for every string that distinguishes one arm from the other and exits 1 if
one survives. Verified in both directions — clean staging passes, and with the scrub
disabled the guard fails and names both tells. No verdict was ever issued from a leaking
pair; this was caught during staging.

The baseline was also re-captured through the *current* harness for this round, because
`reply.md` existed in one arm only, and a file present in one arm is itself a tell.

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
- **Two rungs landed in the same file from two builders, and their text merged while
  their semantics did not.** The argument rung yields the quote checker when both
  describe one claim; that gate tested `startsWith` on a span that used to be a
  truncated prefix and is now a centred excerpt, so it stopped recognising the overlap
  and TH1 earned two findings for one claim. Caught by the suite, fixed in the product,
  the two assertions unchanged. It is recorded because auto-merge reported no conflict.
- **The argument rung trusts `ToolCallRecord.args` as ground truth.** It is what the app
  sent and `trace/audit.jsonl` agrees, but nothing cross-checks the record against the
  audit log, so a bug that mangled `args` at record time would make the rung confidently
  wrong.
- **Attribution for that rung is nearest-name-or-heading**, so a reply that only ever
  calls the tool "your reference library" gets a miss. Deliberately the safe direction.
- **Inline code inside a quotation is still blanked before comparison**, so a quoted line
  containing a backticked word is compared with a space where the word was and can be
  faulted for a word it does say. No recorded run exercises it.
- **The plan block's contrast is guarded only by its own file's hand-rolled compositor** —
  `test/chromeContrastCheck.ts` names no plan-block class.
- **`resources/pyodide` and `node_modules` are absent from a fresh worktree**, so every
  builder this round symlinked one to run anything. That is the same gap that handicapped
  the baseline arm for three rounds; it is still not fixed, only known.

- **This round's critic prompts were written by the person being judged.** They named the
  checks the round had just built, which biases every verdict toward the build that has
  them. The 18–0 is real as a set of measurements and not comparable with earlier rounds
  as a score. Round 8's prompts come from `tasks.json` alone.
- **Dark theme has still never been captured by the bench**, in any round. Round 7 added a
  40-stop keyboard traversal (VC2's first appearance in seven rounds) and it ran in light
  theme only, so `N_invisible` for dark is unmeasured on both arms.
- **VC2's traversal never reaches Settings.** The path arrives at the `Settings (⌘,)`
  button at stop 26 and the 40 stops end there, so the task's own question — whether a
  keyboard user can reach both settings the answer names — is unproven even for the winner.
- **Defects the critics found in the WINNING runs, unfixed:** the citation strip lists
  `[1]`–`[5]` while the answer cites `[8] [9] [14]`, so the markers a reader most needs
  resolve to nothing (a consequence of round 5's per-turn passage numbering); `$0.007`
  printed as `$0.00`, naming a figure that is not on screen while omitting the `$5` that
  is; `net::ERR_UNSAFE_PORT` on a collapsed row a user cannot interpret; a code block whose
  wrap control is off by default, so the token VC1 fixed in the bubble still scrolls inside
  a fence; and `overflow-wrap: anywhere` — this project's own fix for the VC1 blowout —
  breaking "Passage" into "Pas / sag / e" in a table header.

### Pending fold-in — the wrapping rule that shredded the words it was protecting

Two of the defects listed above are the same defect, and both are in code this project wrote to
pass VC1. Round 7's blind critics found them in the winning runs:

> run-1's markdown table is broken by its own wrapping rule — `04-turn-end.png` shows the header
> `Passage` hard-split mid-word across three lines as **"Pas / sag / e"**, because the column is
> sized to the 3-character `[1]` cell and the word is broken rather than the column widened.

> its `<pre>` is still bare with the wrap toggle **off by default** (`aria-pressed="false"`), so
> the same token inside a fenced block still needs horizontal scrolling — in split view roughly
> 28 characters at a time.

**The blowout and the shredding were never two goals to trade off.** `overflow-wrap: break-word`
and `overflow-wrap: anywhere` break identically: neither splits a word that fits on a line of its
own. They differ in exactly one thing — under `anywhere` the break also counts toward
**min-content**, so a box whose width its own contents decide may collapse to one character. That
single extra effect is the whole of why `anywhere` stopped the bubble blowing out, and the whole
of why it shredded a table header. Both readings occur in the same set of places — boxes sized by
their content — and nowhere else, which is why the same stylesheet left prose, list items and
blockquotes untouched. Measured: every word the detector flagged was in a table cell, and a
paragraph, a list item and a blockquote each rendered every word whole at both widths. The one
other content-sized box in a reply is a tool-call header's label, and it was affected too — see
the row for it below.

So the rule became `break-word` everywhere, and each content-sized box in a reply was given
something other than its own words to size against: the bubble is already `min-w-0 flex-1`; a
table now has its own scroll container (`.md-table-scroll`, generated in `lib/markdown.ts` so the
`<table>` keeps its element and its role); a tool-call header's label is `min-w-0 truncate`.

#### Measured, in `test/styleCheck.ts`

The app's own reply markup, the app's own stylesheet compiled the way the app compiles it, laid
out in a real offscreen Chromium window at a 420px chat column and again at the 232px a bubble
gets in split view. A citations table exactly like one built from retrieved passages — a
3-character `[1]` column beside an English header, and a prose column wide enough that the table
cannot have every column at its preferred width.

| Property | Before (`anywhere`) | After (`break-word` + scroll container) |
| --- | --- | --- |
| Words broken across lines that would have fitted the reply, 420px | **6** — `Passage`, `burns.md`, `scalds.md`, `Note`, `log`, `line` | **0** |
| The same, in split view | **6** — `Passage`, `Source`, `burns.md`, `Note`, `log`, `line` | **0** |
| The header `Passage`, 420px | 2 line boxes in a 54.6px cell | 1 line box in a 68.8px cell |
| The header `Passage`, split view | 4 line boxes in a 36px cell | 1 line box in a 68.8px cell |
| A 220-char token in a table cell, 420px | table squeezed to 386px; every word in it shredded | table 1795px, scrolling inside its own 386px container |
| The bubble holding that table, 420px | scrollWidth 418 = clientWidth 418 | 418 = 418 |
| …and in split view | 230 = 230 | 230 = 230 |
| A single-token tool name in a 198px tool-call row | broken across two lines inside the identifier, span squeezed to 138.3px | ellipsis; row scrollWidth 196 = clientWidth 196 |

**The true negatives, which are the point.** VC1's blowout must stay fixed, so the same fixture
still asserts every original containment property and two the harness had never carried:

| True negative | Measured |
| --- | --- |
| The 220-char token in prose still wraps inside the bubble | 12 line boxes, widest 198px against 198px of bubble, 0px overhang |
| The reply bubble itself does not scroll sideways | scrollWidth 418 ≤ clientWidth 418 (new assertion — an overhang of 0 says no *line* hangs out, and says nothing about a descendant wider than the box) |
| The user bubble likewise | scrollWidth ≤ clientWidth |
| The document does not scroll sideways | 992 ≤ 1000 |
| A code block still scrolls rather than wrapping | scrollWidth > clientWidth |
| `break-word` **without** a table scroll container — the rejected half-fix | bubble scrollWidth **1811** vs clientWidth 418: the blowout, back. This is why the container is not optional |
| The rule restored to `anywhere` — the detector's own control | 6 / 6 shredded words return |

The detector is the assertion worth keeping, because it names the class rather than the case: for
every word in a reply, if it renders across more than one line **and** it would have fitted on a
line of the reply's own width, it was broken when it did not have to be. The reply's width is the
reference deliberately — not the box the word ended up in, because that box's width is the thing
under test. A word measured against a column that `anywhere` has already collapsed to one
character always "didn't fit", which is how this passed unnoticed for a round.

#### The code block: the principle survives, and it is not "never wrap"

The comment defending the scroll default says *"a wrapped line is a lie about the source. It
scrolls."* That is a real argument and it is kept — but it is an argument about lines that **have a
shape**. Where a line ends, how it is indented, whether two things sit on the same line: in code
those are content, and soft-wrapping invents line ends the file does not contain.

A line that is one unbroken token has none of that. It contains no whitespace, so there is no
indentation to misplace and no second thing on the line to imply. Wrapping it cannot misrepresent
it. Scrolling it does measurable damage:

| A 220-character token in a fenced block, split view | Before | After |
| --- | --- | --- |
| What the reader can see at once | `pre` scrollWidth 1680 vs clientWidth 198 — **26 of 220 characters**, behind an 8px scrollbar on a block one line tall (offsetHeight 48, clientHeight 40) | arrives wrapped: 10 line boxes, scrollWidth 198 = clientWidth 198, nothing hidden |
| Interactions needed to read it | find and press Wrap, or ~8 drags | none |

So the default follows the principle more exactly than "never wrap" did: `startsWrapped` in
`lib/markdown.ts` wraps a block only when wrapping can tell no lie about it, and sets the header
control's `aria-pressed` from the same value so the two never disagree. **What it costs:** a
reader who wants to see a long token exactly as the model emitted it — as one line — now has to
press Wrap to turn it *off*, the inverse of the old cost, and the decision is made from the source
text rather than from the pane, so a 100-character token that would have fitted a wide window
still starts wrapped. That is deliberate: a default derived from layout changes when you resize
the window, and a code block that reflows on drag is worse than either default.

True negatives, in `test/markdownCheck.ts`: a 260-character line of real JavaScript still scrolls
(`aria-pressed="false"`, no `code-wrapped`); an ordinary Python block still scrolls; a 10-character
unbroken token does not flip the control for nothing; and the token itself is byte-identical in the
DOM, so it is still selectable and copyable in full.

#### What this does not measure

- **Nothing was re-run against a model, and no sweep was taken.** These are before/after
  measurements of one build in a render harness. No win/loss claim attaches to any of it.
- **An ordinary citations table in split view now scrolls rather than shredding**: container
  clientWidth 198 against scrollWidth 205. Seven pixels, but it is a horizontal scroll where there
  used to be none, and the only thing announcing it is the same 8px scrollbar. Reading a
  three-column table in a 198px pane was never going to be comfortable; the choice made here is
  that a nudge beats an unreadable word.
- **Each table adds a tab stop.** `tabindex="0"` is what makes a scroll region reachable by
  keyboard (WCAG 2.1.1), and it is added to every table, not only the ones that overflow — which
  cannot be known before layout. VC2's tab-stop counts change accordingly and have not been
  re-measured.
- **The fixture holds two tables.** A table nested inside a list item or a blockquote, and a table
  in the non-markdown reply surfaces, are not in it. The word detector would catch them if they
  were; it cannot catch what the fixture does not render.
- **`.reply-surface` is asserted through the bubble, not through each surface.** `overflow-wrap`
  inherits, which is why the rule is set once — but a future surface that establishes its own
  content-sized box (a flex row without `min-w-0`, a `fit-content` panel) would be back in the
  same trap, and only the fixture growing a case for it would say so.
- **The tool-call header now truncates.** A long tool name is an ellipsis plus a `title` tooltip;
  a reader who cannot hover — a keyboard or touch user — sees the truncation and not the name.
  That is a smaller loss than a shredded identifier and it is still a loss.

### Pending fold-in — internal strings the reader cannot act on

Four rounds of blind critics kept finding the same species on screen, and this one is not a
check reading the wrong quantity: it is the app saying something true that no reader can use.
Every string below is verbatim from a recorded run of a build that **won** its task.

| measured, verbatim | where it appeared |
| --- | --- |
| `net::ERR_UNSAFE_PORT` | the collapsed tool row, twice in one turn — and again as the *entire* `Result` body once opened |
| `BodyStreamBuffer was aborted` | after `🧮 Recompute skipped —`, on a line with no disclosure to open |
| `signal is aborted without reason` | the entire content of an interrupted plan step |
| `Trying to keep the first 12000 tokens when context the overflows.` | an assistant bubble — and this clause is **LM Studio's**, relayed verbatim, its garbled word order reading as our bug |

A critic on the first: *"an internal error identifier shown to a user who has no way to
interpret 'unsafe port'."* Another noted that the **losing** arm at least kept it inside a
disclosure. Round 5 is where it got onto the row: the fix for seven bare `✗ 🔍 web_search`
rows was to put the reason beside the glyph, which cured the silence and shipped this in its
place. Round 3 had already inverted the *logic* around these codes — the app stopped
enumerating which `net::` codes mean "unreachable" and started listing the few that mean "a
server answered" — and that repair was right and still stands. Nothing ever stopped
**printing** them.

#### What changed

`src/shared/failure.ts` is one boundary between what the app knows and what it says.
`explainFailure(raw, { subject, source, settings })` returns a `headline` for a collapsed row,
a `sentence` for a disclosure, an optional `remedy`, and a `detail` holding the runtime's own
words attributed to whoever wrote them. One place, not per-call-site: a rule this easy to get
subtly wrong needs a single test surface, and the reachability half of it
(`searchUnreachable`, moved here unchanged from `lib/claimCheck.ts`) was already living there
alone with no voice.

| | before | after |
| --- | --- | --- |
| tool row | `✗ 🔍 web_search — net::ERR_UNSAFE_PORT` | `✗ 🔍 web_search — nothing answered at that address` |
| `Result` body | `net::ERR_UNSAFE_PORT` | `The call could not reach the provider — nothing answered at that address.` / `Check that the provider is running, then try again.` / `The network layer reported:` `“net::ERR_UNSAFE_PORT”` |
| recompute line | `🧮 Recompute skipped — BodyStreamBuffer was aborted` | `🧮 Recompute skipped — stopped before it finished` (+ a `The runtime reported` disclosure) |
| plan step body | `signal is aborted without reason` | `Step 2 was stopped before it finished.` (+ the same disclosure) |
| stream refusal | `⚠️ Trying to keep the first 12000 tokens when context the overflows. — this conversation … is larger than the context …` | `⚠️ The request was refused by LM Studio, which named the context length. This conversation — with its attachments and notes — is larger than the context the model is loaded with.` / `Load the model with a larger context in LM Studio, or attach less.` / `LM Studio reported:` `“Trying to keep the first 12000 tokens when context the overflows.”` |

On the last row: their sentence used to lead and ours trailed behind it as a dash clause, so
their broken word order read as our defect. Ours leads now and theirs is quoted as theirs.
Their text is never dropped — it is evidence, and on this failure it is the only thing that
names a number.

#### Three rules, because a translation layer can lie

A mapping that turns an unfamiliar failure into a confident wrong sentence is worse than the
raw code: the reader loses the one string they could have searched for. So:

1. **The safe list is of prose, not of identifiers.** `readsAsProse` decides what may stand as
   the app's own words — a capital, a space, and no token of machine shape. This is round 3's
   inversion applied to speech instead of logic: a list of known-bad identifiers is defeated by
   the next code Chromium invents, a list of known-good shapes only by something that genuinely
   reads as a sentence. The five shapes it rejects are conventions rather than vocabularies —
   `::` namespacing, `SCREAMING_SNAKE`, a six-letter-or-longer errno, a multi-hump CamelCase
   name before a colon (`TypeError:`), a hex literal. The asymmetry decides the lean: a
   rejection costs an admission and a quoted line the reader can still read; a wrong acceptance
   costs them `net::ERR_UNSAFE_PORT`.
2. **An abort is recognised by type, never by message.** `signal is aborted without reason` and
   `BodyStreamBuffer was aborted` are one `DOMException` under two engines' wording. Matching
   either message is the round-3 mistake one layer down; `name === 'AbortError'` is the class
   the DOM standard actually fixes, and all four leak sites already hold the thrown object.
3. **An unrecognised failure gets an honest sentence, not a guess.** It says the attempt did
   not finish and that the app cannot say why, and it keeps the exact words rather than
   paraphrasing them.

#### Where the identifier went

It does not vanish — three homes, three different readers:

- **The text handed to the model** (`ToolCallRecord.result`) is untouched, so the tool loop
  still reasons over the real error. That same string is what `providerIO` writes to the
  hash-chained audit log, so the log keeps it without a second code path.
- **The disclosure** quotes it under `The network layer reported:` / `LM Studio reported:` /
  `The runtime reported:`, so a reader can tell whose words are whose. The recompute line had
  no disclosure at all and now carries one (`WorkbenchCheck.detail`).
- **A `Copy details` button** on the tool disclosure yields subject + sentence + verbatim text
  — what a person pastes into a bug report.

Kept as an absolute: the raw text survives in *every* class the module translates, including
aborts, where it arguably adds nothing. A rule with a judgement call in it is a rule that gets
that call wrong somewhere.

#### The remedy, as a control

A critic's only complaint about `UNREACHABLE_NOTE` — *"Could not check: no source is
reachable … Point Settings → Search at a working provider and ask again."* — was that the
remedy is prose rather than a control. The claim-check block now renders an `Open Settings →
Search` button beside it (`openSettingsAt` in the store, honoured once by `SettingsModal` and
then cleared). The prose stays: an export, a screenshot and a copy-paste all outlive the
component, and a button does not.

The button is offered **only** where the app has proved the remedy is the right one — every
search this turn failed to connect. A single failed `web_search` does not prove a
misconfigured provider, so the tool row gets the sentence and no button. A control that fixes
the wrong thing is worse than a sentence.

#### The eval cases — `test/failureBoundary.test.ts` (22 cases)

True positives: each of the four measured strings is absent from the reader-facing sentence
and present, verbatim, in `detail`. Beside every one, a true negative:

| true positive | true negative beside it |
| --- | --- |
| `net::ERR_UNSAFE_PORT` never reaches a row or a sentence | 23 error sentences the app writes about itself — harvested from `search.ts`, `net.ts`, `plan.ts`, `toolHandlers/*`, `chatTransport.ts` — come back byte-identical, with `detail: null` |
| a `net::` code nobody has listed is still classified unreachable (round 3's inversion, re-pinned) | `net::ERR_TOO_MANY_REDIRECTS` says *reached the provider* and never *nothing answered* |
| a stringified exception (`TypeError: …`, `ENOSPC: …`, `Fatal: 0x8007007e`) is not printed at a reader | its sentence asserts **no** cause: `assert.doesNotMatch(sentence, /reach\|connect\|context\|stopped/i)`, `remedy === null`, `recognised === false` |
| LM Studio's clause is quoted as theirs and our sentence leads | a *well-formed* server sentence is still not printed as ours — attribution is a fact the call site knows and beats any shape test |
| shouted `ERROR` in prose is not mistaken for an errno | `ENOENT: no such file` is |
| a decline's clause survives the boundary untouched | …because `declinedCall` composed it, and knowing beats guessing |

Three invariants run over the whole corpus plus `null`, `undefined`, `42`, `{}`, `''`:
no reader-facing string ever matches an identifier shape; translating never loses the
original; a headline is never longer than a glance. A fourth case pins that an
`ExplainedError` is passed through rather than re-read — a translation of a translation is how
a layer starts lying.

Two existing assertions in `test/declinedCall.test.ts` changed, both **tightened**:
`headerText(UNREACHABLE)` was pinned as `/ERR_UNSAFE_PORT/` by round 5 and now requires
`/nothing answered/i` **and** `assert.doesNotMatch(row, /ERR_UNSAFE_PORT|net::/)`; and the
"long reason is cut" case now uses a long *sentence*, with the 200-character blob it used to
use moved to its own case asserting the blob is not printed at all and is kept in `detail`.
Suite: **2000 passing, 0 failing** (from 1976), `./scripts/test.sh` exit 0, `npm run build`
and both `--noEmit` typechecks clean.

#### What this does not fix

- **Nothing here was re-run against a model.** The before/after strings are produced by the
  shipped modules against the recorded inputs, not by a new head-to-head sweep. No win/loss
  claim attaches to any of it.
- **An abort that crosses IPC as a bare string is still printed.** `BodyStreamBuffer was
  aborted` passes `readsAsProse` on its own — capital, space, no machine token. It is caught at
  all four measured sites because those hold the thrown object and rule 2 reads its `name`. A
  fifth site that stringifies an abort before the boundary would leak the wording again; it
  would leak a readable English sentence rather than a code, which is the safe direction, but
  it is a hole and it is not closed.
- **Settings and eval surfaces still print raw messages.** `SettingsModal` (`Eval failed: …`,
  `Could not load eval fixtures: …`), `ProjectModal` and `lib/evalRunner.ts` were left alone:
  the reader of those lines is operating the machinery, not reading an answer, and the raw text
  is what they want. That is a judgement, not a proof, and a critic may disagree with it.
- **The shape test is measured against one corpus.** 23 sentences, harvested by hand from five
  modules. A handler added later that writes an error as a lower-case fragment gets the
  honest-unknown sentence with its own words quoted underneath — true, and worse than the
  sentence it could have had. Nothing detects that but reading the output.
- **`readToolFailure` names no tool.** Its sentences start "The call", not "The search", so a
  disclosure under `web_search` is one word blander than it could be. Passing the tool name
  through is a small change nobody has measured the value of.
- **The `Copy details` button is untested.** It is a `navigator.clipboard` call inside a React
  component; the suite pins `copyableFailure` (the string it copies) and nothing pins the
  click.

### Pending fold-in — a warning that named a figure the reader could not find

From the list directly above, on the recorded V3 run:

> run-1's ⚠️ is currency-only — the volume claims ("2,000 to 3,600 gallons per year",
> "170 to 300 gallons", "7,570 to 13,640 liters") are never checked — and it
> **mis-renders `$0.007` as `$0.00`**, naming a figure that is not on screen while
> omitting the `$5` that is.

Two defects in one line, and at the altitude of the rung they are one: **neither side of
the money comparison was reading an amount of money.** The answer side took the `$`
seriously and not the number — `\$\s?(\d[\d,]*(?:\.\d{1,2})?)` caps the fraction at two
digits, so over `$0.007` it matched `$0.00` and left the `7` behind. The corpus side took
the number seriously and not the `$` — `numbersIn` admits every digit group in the
retrieved text as possible support. So the rung could name a value the reply never wrote
and clear a value the corpus never stated, and on this run it did both at once.

At the altitude of the regex they are two separate edits, and they need two separate
arguments. What follows is both, then the ladder.

#### `$0.007`, and the verdict that came with the label

The truncation is not only cosmetic. `precisionOf` reads the *matched* text, so the check
compared 0.00 at two decimals against a figure the reply never stated. Replayed against
the v1.17.1 code:

| | v1.17.1 | v1.17.2 |
| --- | --- | --- |
| **TP** — the label, `at $0.007 per gallon` | `["$0.00"]` | `["$0.007"]` |
| **TN** — the same rate, quoted from the passage that states it | `["$0.00"]` ✗ | `[]` |
| **TP** — `$0.009` over a corpus rate of `$0.002` | `[]` ✗ | `["$0.009"]` |
| **TN** — a fee that really is `$0.00` | `["$0.00"]` | `["$0.00"]` |

The second row is the one that decided it. A figure copied **verbatim out of the source**
came back unsupported, because 0.007 does not round to 0.00 — the badge firing on a
correctly-sourced number, which is round 4's lesson exactly. The third row is the other
direction: two different sub-cent rates both truncated to `0.00`, so the corpus's $0.002
certified a stated $0.009. Reading the whole number is *stricter*, not looser: three
decimals must now agree to three.

The sweep found the same defect in miniature and it is fixed with it. `\d[\d,]*` is greedy
about the separator, so "the deduction rises to $30,000, an increase of $800" yielded the
label **`$30,000,`** — again a string the answer does not contain. The digit group now has
to end in a digit.

#### `$5`, and whether it is the same root cause

It is not the same *regex* defect, and the doc records the difference because the answer
was not the obvious one. Reproduced on a reconstruction of the turn — a plumbing lookup
whose passage reads "wastes about 2,000 gallons per year. Check the aerator every 5
months" — `unsourcedFigures` clears `$5` because **the passage contains a 5**. A
whole-dollar figure is judged at zero decimals, so any corpus number in [4.5, 5.5)
supports it, and the one on offer was a count of months.

`moneyIn` already exists for exactly this reason one level over: deriving prices from every
bare number was "a hole big enough to drive the whole check through", and a menu-pick "1"
in the conversation certified every integer from 2 to 24. That repair was made to the
*derivation* bases and the *support* corpus kept the hole.

The narrowing uses the vocabulary the app already has rather than a new one: a number that
carries a unit is a **measurement**, and a measurement is not an amount of money.
`shared/measurements.ts` is the same module the quantities rung reads, so the two rungs
cannot disagree about what a unit is. Numbers are dropped by **offset**, not by value, so a
corpus printing `36.5 miles` on one line and `36.50` on another still supports `$36.50`
from the second.

| | v1.17.1 | v1.17.2 |
| --- | --- | --- |
| **TP** — `$5` over a passage saying "every 5 months" | silent ✗ | `$5` named |
| **TN** — `$5.49` over a search result reading `Faucet washer kit — $5.49` | silent | silent |
| **TN** — `$396.02` over `Monthly payment: 396.02` (computed, no unit) | silent | silent |
| **TN** — `$36.50` over `Leg: 36.5 miles` **and** `Fuel cost: 36.50` | silent | silent |
| **TN** — the whole v1.3 car answer against `finance_calculator` | 3 findings | the same 3, byte for byte |

The banner, on the reconstructed reply, before and after:

```
before:  ⚠️ 2 figures ($0.00, $14) in this reply are not backed by the tool output.
after:   ⚠️ 3 figures ($0.007, $14, $5) in this reply are not backed by the tool output.
```

#### The ladder: one dimension, many units

Round 5 made temperature "one dimension in two scales" and wrote down why: a check that
**enumerates** the forms it has seen is defeated by one that is not on the list. That
repair was correct and it was **an instance**. Every other quantity kept the enumeration —
`unsourcedQuantities` armed per normalised unit string — so a corpus written in gallons
armed nothing about litres, and the reply's `7,570 liters per year` was not skipped for any
reason a reader would accept; it was skipped because `liter` was an unrelated key. It is
the shape round 5's table records for rounds 3, 4 and 5, and that round 7 found again
inside `scripts/test.sh` — the enumeration in the instrument that grades the enumerations.
Here it is inside the *repair* for one: a fix written against one dimension, in a file
whose whole purpose is to be the vocabulary both rungs share.

A unit now belongs to a **dimension**, and a corpus stating any unit of a dimension arms
all of them. Support crosses the units by conversion and never crosses the dimensions,
which is v1.15's rule with the word "scale" replaced by the word it should always have
been. Conversion is affine (`canonical = value × factor + offset`) so temperature is not a
special case bolted on the side, and a test pins the table's °F/°C entries against v1.15's
hand-written `inScale` so the two paths cannot drift.

On the reconstructed run, with the volumes inflated to what a fabricating model would say:

```
before:  ⚠️ 2 figures ($0.00, $14) and 1 measurement (3,600 gallons per year) in this
             reply are not backed by the tool output.
after:   ⚠️ 3 figures ($0.007, $14, $5) and 2 measurements (3,600 gallons per year,
             13,640 liters per year) in this reply are not backed by the tool output.
```

The litres half is the exact mirror of V1's unnamed Celsius: reword the one passage that
happens to be written in gallons and the *whole* claim goes unreported.

**Written against the class**, so the rule is asserted per dimension rather than per the two
units that were found failing. Each row's corpus states a quantity in one unit; the reply
restates it in another, and then misstates it by 10%:

| dimension | corpus | restated — silent | 10% out — named |
| --- | --- | --- | --- |
| volume | `holds 2 gallons` | `7.5708 liters` | `8.33 liters` |
| duration | `wait 90 minutes` | `1.5 hours` | `1.65 hours` |
| length | `run 5 km` | `3.10686 miles` | `3.4175 miles` |
| mass | `weighs 2 kg` | `4.409245 pounds` | `4.85 pounds` |
| temperature | `hold at 165°F` | `73.9°C` | `81.3°C` |

**Three bounds, and each one is a cry-wolf finding rather than a precaution.** This was the
round's highest cry-wolf risk — more units armed is more chances to fault an honest answer
— so each is recorded with what it was measured against.

- **A unit joins a dimension only when its conversion is exact and unambiguous.** `month`
  and `year` are absent (a month is not a fixed number of days, and converting one
  manufactures a disagreement out of the calendar); `ounce`/`oz` are absent (mass or fluid,
  and "16 fl oz" normalises to `oz` exactly as "16 oz" does); `calorie`/`kcal` are absent
  (a food calorie is a kilocalorie). An absent unit keeps precisely its pre-dimension
  behaviour — armed by its own spelling, nothing crossed.
- **`m` is absent, and the suite is why.** Switched on, the length dimension armed `m`
  against a corpus stating `42.195 km` and named **`47m`** — in "the total time of 227
  minutes (3h 47m)", on the recorded marathon answer, which was **scored correct**. A
  duration reported as an unsupported distance. `metre`, `meter`, `km`, `cm` and `mm` are
  unambiguous and stay; the single character is metres, minutes or million and the reader
  cannot tell which.
- **A corpus value nothing like the size of the stated one is not a competing claim.**
  Duration spans five orders of magnitude between `second` and `week`, so a passage reading
  "rest for 3 minutes" armed every duration in the reply and named **`4 days`** — a storage
  figure faulted because an unrelated line mentioned a resting time. The bound is the one
  the file already had: `isDerivable` says a corpus value within `MAX_DERIVATION_FACTOR`
  can *explain* a stated value as a pack size or a case count, and past that factor it can
  neither produce it nor contradict it. Inside the band the check still fires (`40 minutes`
  over `rest for 3 minutes` is named). Temperature is exempt, because a ratio between two
  points on an interval scale means nothing — which is also why v1.15's two-scale rule
  needed no bound.

**A converted value gets half a percent of slack; a same-unit value gets none.** A
conversion is arithmetic the *reply* performed: it chose the factor (3.785, 3.79, 3.8) and
how many digits to keep, so it does not land on the exact product. Measured on the run this
was built for — 2,000 gallons is 7,570.8 litres and the reply wrote "7,570"; 3,600 gallons
is 13,627.5 and the reply wrote "13,640". Both are the same quantity written twice. Slack
is not extended to same-unit support, which keeps the rule it has had since v1.9.2, nor to
an interval scale, where °F↔°C is exact arithmetic with no factor to round — so `74.2 °C`
over a retrieved `165 °F` is still a finding.

Derivation follows the same split it always did, stated as a property instead of a name:
ratio scales are derivable across the dimension (`1900 miles` over a computed `1528.87 km`
is silent), interval scales are not (`80°F` over a fridge's `4.4444°C` is named).

**Swept for cry-wolf.** All 19 recorded text fixtures in `test/toolGrounding.test.ts` that
predate this change — replies, prompts, passage blobs and tool output — were re-run through
v1.17.1 and v1.17.2 side by side against six armed corpora: a route computation, a water
computation, a dose lookup, a cooking lookup, a price search and a loan calculation, each
with and without user text. **228 paired runs. Ten findings added, none removed**, and
every one of the ten is a true positive of the two repairs above: `$5,000` over a search
result reading "5,000 gallons", `$400` over a passage reading "400 mg", and `5 days` and
`7 days` over a run that computed `187.5 hours`. Twenty further rows changed a label from
`$30,000,` to `$30,000` with no change of verdict.

Node cases: 1976 → **2011** on this branch (`test/toolGrounding.test.ts` goes 204 → 239).
`./scripts/test.sh` exits 0, both typechecks and `npm run build` clean.

**What this does not measure.**

- **The recorded V3 run directory is not in this repository**, so the fixture is a
  reconstruction of the turn from the critic's quoted strings, not a transcript. Every
  claim above about the *old* behaviour was replayed against the v1.17.1 code; every claim
  about the run itself is inference. On V3 as the probe describes it — no tool call at all —
  the quantities rung is still correctly silent, because there is no corpus to disagree
  with. That turn is the `unverified` badge's business, and it is a separate gap.
- **`gallon` is the US liquid gallon.** An imperial gallon is 20% larger, which is far
  outside the half-percent slack, so a reply converting UK-sourced volumes would be faulted.
  No recorded run exercises it.
- **`unsourcedPercentages` still supports a percentage from any bare number**, including
  one that carries a unit. The same narrowing applies in principle; it was left alone
  because its ratio rule (`a / b × 100` over 40 bases) already certifies far more than
  presence does, so the change would move little and would need its own sweep.
- **`researchGrounding` compares a measurement against every number in its corpus** and
  arms no units at all, so dimensions do not apply to it — but it is the rung that would
  fault "500 mg" from a passage's "500 km", and nothing here changed that.
- **`answerEval.ts` carries a third copy of the measurement vocabulary**, hand-rolled as one
  regex, and it is the eval scorer rather than a shipped check. `shared/measurements.ts`
  exists because "two copies would drift, and the drift would be silent"; there are three.
  Folding it in changes scores on a suite nothing has re-run, so it is recorded, not done.
- **Nothing here was re-run against a model.** No head-to-head sweep was taken, so there is
  no win/loss claim attached to any of it.

<!-- FOLD IN: new eval case, the citation strip against the citation binder. Not yet a round heading. -->

### Pending fold-in — citation markers that resolve to nothing

Three round-7 critics, three tasks, one theme: **the provenance strip, the marker binder and the
answer disagreed with each other, and each of the three was confident.** All of it is the tail of
round 5's fix, which made a turn's passage numbering global and left every consumer of those
numbers reading one lookup.

Confirmed against the captured runs rather than the critiques. The tool blocks below are the
verbatim `record.result` text the app stored, lifted out of
`.h2h-runs/judge-r7/*/transcript.json` into `test/fixtures/citations/`; `stripAsShown` in each
fixture is the 📖 line the shipped build actually printed, scraped from the same run.

**V1/run-2 — three lookups, seventeen passages, a strip that listed five.** The turn ran
`reference_lookup` three times (5 + 6 + 6 passages, numbered `[1]`–`[17]` by round 5's
renumbering). `libraryContext` — the only thing the strip read — is patched by the app's
pre-flight provider and by nothing else, so it held the first five. The answer cited `[8] [9]
[14]`, none of which appeared anywhere in the strip, while all five entries that *were* listed
carried `— not cited`:

```
Cooked chicken (leftovers) is safe in the fridge for 3 to 4 days [14].
You need to cook chicken to an internal temperature of 165°F [8][9].

📖 From the library: [1] Food safety › Safe minimum internal temperatures › Cook to a Safe
Minimum Internal Temperature · 6% in (1.00) — not cited, [2] … (0.82) — not cited, [3] … (0.77)
— not cited, [4] … (0.72) — not cited, [5] … (0.72) — not cited  ▸
```

**After**, with the strip built from the turn's own lookup records — the same parse the inline
marker already resolves through, so the two can no longer disagree about which passages exist:

```
📖 From the library: 17 passages from 3 lookups — the answer cites [8] [9] [14].  ▸
   The app looked this up before the model answered · [1]–[5] · “How many days is cooked
   chicken safe in the fridge, and what internal t…”
   The model looked this up · [6]–[11] · “internal temperature for cooked chicken safe food
   handling”
   The model looked this up · [12]–[17] · “cooked leftovers how long safe refrigerator
   storage days”
```

**Seventeen entries in a collapsed header is a paragraph, not a strip**, so it stops listing them
and answers the question the reader actually has at that moment — *which one is `[14]`* — while
the entries move into the panel under a heading per lookup. Grouping by lookup rather than
flattening is the one thing that says *why* a passage is there; the query is the heading for the
same reason. Single-lookup turns keep the flat list they have always had, unchanged and asserted
byte-for-byte.

**V2/run-1 — `[2][5]`, and the marker the app could not see.** `CITATION_MARKER` refused any
`[n]` preceded by `]`, which is the guard that keeps `m[0][1]` out of the count. It also swallowed
the second half of every adjacent pair. The reply cited `[2][5]`; the app saw `[2]`, rendered
`[5]` as dead black text, and printed `— not cited` beside the passage the sentence was leaning
on. The guard is now anchored to the **start of a run** of markers, so `m[0][1]` is still refused
whole (its run begins after a word character) and `[2][5]` is two citations:

| on screen | before | after |
| --- | --- | --- |
| `…as noted in Topic no. 551 [2][5]` | `[5]` inert black text | `[5]` linked to the IRS page |
| strip entry `[5] … Topic no. 551, Standard deduction · 0% in (0.63)` | `— not cited` | no mark — it was cited |

**TH3/run-1 — a message contradicting itself.** The header read
`📖 Nothing in the library covers this question — the answer is not backed by it.`; the strip
beneath left `[5]` as the one entry *not* marked `— not cited`, and the reply quoted its "3 to 4
days" verbatim. Both halves of that sentence were computed, and only one of them was measured:
the relevance floor measures **retrieval**, and "the answer is not backed by it" is a claim about
the **answer** that nothing checked. The measured half is kept and the unmeasured half is
replaced by what the answer did:

```
before:  📖 Nothing in the library covers this question — the answer is not backed by it.
after:   📖 Nothing in the library covers this question — the answer cites [5] from it anyway.
```

Which reads as a sharper warning than the original, correctly: a reply leaning on a passage the
app has just measured as off-topic is worse news than a reply leaning on nothing. When the answer
cites none of them the original sentence is kept **word for word**.

The floor also stops speaking for passages it never examined. It is computed over the app's own
pre-flight lookup, so on a turn that went on to retrieve more the caption names its own scope:
`📖 Nothing in the 5 passages the app looked up covers this question; the model then retrieved 12
more.`

**"— not cited" is a claim, and the app may only make it while it can account for every marker.**
When a marker in the answer names nothing on the list, the marker→passage map is *known*
incomplete — a result cut by the 10,000-character output cap really does drop passages the model
read, and a conversation recorded before per-turn numbering holds two `[1]`s of which the app can
see one. Saying nothing would read as "cited", so the entry says which of the two it is:

```
📖 From the library: [1] … (1.00) — cannot tell, [2] … (0.82) — cannot tell, [3] … — cannot
tell, [4] … — cannot tell, [5] … — cannot tell
⚠️ [8] [9] [14] name no passage listed here, so the rest are left unjudged.
```

The positive is never withdrawn: a marker that *does* name a listed passage is evidence that
passage was used, whatever the app failed to resolve elsewhere.

**And a marker is now one of three visible things rather than two.** Resolvable-with-a-URL is a
link, as before. Resolvable-without-one used to be a `title` attribute on three characters — a
mouse-only hint, and nothing at all for a keyboard user — and is now a `role="button"`,
`tabindex="0"` span carrying `data-citation`, which opens the provenance strip scrolled to that
passage and rings it. Unresolvable used to be returned untouched, rendering as plain black text a
reader cannot tell from prose (measured: `[9]` sitting inert beside a linked `[8]` in the same
sentence); it is struck through in `--text-secondary` and says on hover that it names no passage
this turn retrieved. The strike, not the colour, carries the signal.

The three new inks are measured rather than asserted, by `chromeContrastCheck` compositing the
app's real stylesheet in both themes (54 → 60 checks). The unresolved marker reads **9.37:1 light
/ 10.16:1 dark**, the per-entry verdict **5.32:1 / 6.26:1**, and the ⚠️ note **4.89:1 / 11.66:1**
— all clear of AA, and the note quieter than the strip's own ink so a withheld judgement does not
out-shout the entries it is about. The first draft of that note used `text-amber-600`, which is
what most of this app's warnings use; the check measured it at **3.10:1** on the light panel and
failed it, which is the row earning its place on its first run.

| Case | Turn | Answer | What the strip says |
| --- | --- | --- | --- |
| **TP** — V1/run-2 | 3 lookups, 17 passages | `[8] [9] [14]` | all 17 listed, grouped by lookup; header names the three |
| **TP** — V2/run-1 | 2 lookups, 11 passages | `[1] [2][5]` | `[5]` unmarked; `[5]` inline becomes a link |
| **TP** — TH3/run-1 | 1 lookup, floor missed | `[5]`, quoted | caption names `[5]`; `[1]`–`[4]` marked `— not cited` |
| **TP** — floor + more lookups | 3 lookups, floor missed | `[8] [9] [14]` | caption scoped to the 5 it judged |
| **TP** — unresolvable marker | 1 lookup, 5 passages | `[8] [9] [14]` | every entry `— cannot tell`, plus the ⚠️ note |
| **TN** — judge-r4/V2/run-1 | 1 lookup, 5 passages | `[1]` | the identical flat line: no grouping, no summary, no note |
| **TN** — accurate multi-marker | 1 lookup | `[1]` cited, `[7]` unresolvable | `[1]` still `cited: true`; only the negative is withheld |
| **TN** — array indexing | any | `m[0][1]`, `values[1]` in a fence | not citations; nothing linked, nothing marked |
| **TN** — no library lookup | web search only | `[1]` | **no strip at all**, and the marker stays plain prose |
| **TN** — memory / attachment recall | — | — | unnumbered entries are never marked either way |

30 new cases (1976 → 2006, 0 fail) across `test/citations.test.ts`, `test/citationScope.test.ts`
and `test/libraryRecall.test.ts`, plus 9 in `test/markdownCheck.ts` (38 → 47) which is the only
harness that can answer whether DOMPurify lets `data-citation`, `role` and `tabindex` through —
it renders in a real Chromium window. The last four of those are the whole path end to end: the
reply V1/run-2 actually produced, against the citations parsed out of that run's own three lookup
records, through the shipping renderer, asserting each of `[8]`, `[9]` and `[14]` comes out as an
anchor to the passage it names.

**Two assertions changed, both strictly stronger, both because the behaviour they described was
the defect.** `markdownCheck`'s *"a marker naming no retrieved passage is left inert"* asserted
`!/citation-ref/` — it was pinning the plain-black-text rendering; it now requires the marker to
be present, marked `citation-unresolved`, **and** to be no kind of link and carry no
`data-citation`. `citationScope`'s single-lookup case compared against the round-4 fixture's
`stripAsShown`, which predates both the numbering and the marks; it now spells the full expected
line out and separately asserts every entry of the old line still appears inside it, so what has
been added since is exactly the numbering and the marks and nothing else.

**What this does not measure.**

- **Nothing here was re-run against a model.** These are three recorded turns, fixed and pinned
  against the text the app stored and the line it printed. No new head-to-head sweep was taken,
  so there is no win/loss claim attached to any of it.
- **The click-to-open affordance is not measured end to end.** The markdown half — the
  `data-citation`, `role` and `tabindex` surviving DOMPurify — is pinned in a real Chromium
  window. The React half (lifting the strip's open state, scrolling to the entry, the highlight
  ring) has no harness in this project and was verified by reading. The `:focus-visible` outline
  and the highlight ring are likewise unmeasured, because neither is an ink `chromeContrastCheck`
  can reach.
- **The relevance floor is still computed only over the app's own pre-flight passages.** The
  scoped caption names that limit rather than closing it. Recomputing it over everything the turn
  retrieved would need the raw question, which the bubble does not hold — the lookup's *query* is
  in the record, but it is `buildSearchQuery`'s rewriting of the question, not the question, and
  swapping one for the other silently changes what `questionCoverage` measures.
- **The strip now appears on turns that never had one.** A turn where the model ran
  `reference_lookup` itself and the app's pre-flight never fired used to show no strip at all;
  now it shows one, because that is the only way every retrieved passage is reachable from it.
  The passages were always disclosed — in the tool block — so this is a relocation, not new
  disclosure, but it is a change in what a reader sees on turns no round-7 task exercised.
- **`text-amber-600` composites to 3.10:1 on the light panel, and this app uses it in about
  twenty places** — the "⚠️ Empty reply" line in this same component among them. Found while
  measuring the new note, which was written in it and failed. Only the new site is fixed here;
  the rest are unmeasured and out of this round's scope.

### Pending fold-in — dark theme, and a traversal that stops at the door

Two of round 7's own "what this does not measure" entries were about the same thing: the
bench could not see what a critic was being asked to judge.

> **Dark theme has still never been captured by the bench**, in any round.
> **VC2's traversal never reaches Settings.** The path arrives at the `Settings (⌘,)`
> button at stop 26 and the 40 stops end there.

Both are closed, in the instrument rather than in the product. Nothing here is a win/loss
claim: **no sweep was taken.** The figures below come from one-off VC2 and VC3 captures
against a scratch output directory, on `qwen3.8-9b`, and they are what the harness now
records — not a comparison of two builds.

#### A theme is a property of a measurement, not of a run

`h2h-run.sh` has had a `--variant` flag since the sweep script existed, and
`task-setup.json` defined `light` and `dark` variants for VC2 and VC3. The machinery works:
`--variant dark VC1` really does seed `theme: "dark"`, and the capture verifies it against
the running app. It was simply never used, and using it would have been the wrong repair.

A variant is a property of a **run**, and running VC3 twice measures two different replies.
The model writes different prose each time, so the light and dark contrast figures would be
of different text and a difference between them could not be attributed to the theme. VC2 is
worse: a different reply is a different number of focusable elements in the transcript, so
the two themes would not even be walking the same Tab order.

So the theme moved *inside* the run, as a `theme` driver action. VC2 and VC3 now measure
each thing twice on one screen and put the theme back before the run's own artifacts are
taken. `--variant` stays, because "capture this whole task in dark" is a different question,
and VC1 keeps its variants so it can still be asked — VC1's assertions are geometric
(`scrollWidth` against `clientWidth`, a rect against a column's) and none of them moves with
the theme, so the standard sweep captures it once. A sweep therefore costs **no extra task
runs at all**: the second theme is DOM work measured in milliseconds against turns measured
in tens of seconds.

**The shortcut does not work, and the witness is what proved it.** The first implementation
wrote the theme through `window.api.setSettings` and applied the one line `App.tsx` applies
(`classList.toggle('dark', …)`). The run failed on its own readback: *"theme 'light' changed
no rendered colour — body background stayed `rgb(244, 244, 245)`."* The renderer reads
settings once at mount and has no settings-changed event, so the write left the zustand
store holding `light`; `SettingsModal` then repaints the document from that stale value both
when it opens (`draft.theme`) and when it closes (`revertAppearance`). The VC2 traversals
open Settings — so **two of the four traversals labelled `dark` were running in light**, and
nothing but the witness would have said so. The action now goes through the app's own panel,
control by control (Settings → General → the theme → Save), because `save()` is the only
path that moves the persisted setting, the store and the screen together. It reads back all
three afterwards — the setting, the class the stylesheet keys on, and a colour that actually
rendered — and fails the run rather than producing a capture labelled `dark` of a light
screen.

**And a snapshot could not have carried dark anyway.** VC3's `mechanicalChecks` are
per-text-node contrast ratios, and until now a run directory held `outerHTML` and
`innerText` — neither of which says what colour anything rendered in. The README has
promised a `styles.json` "in both themes" since the protocol was written; it did not exist.
It does now, one per theme: per text node, the ink **composited over its real background**
(the app's muted ink is `rgba(23,23,23,0.32)`, so its raw computed colour is not what anyone
sees), that background, the stack of surfaces that produced it, and the font metrics that
decide which threshold applies. The ratio is deliberately not computed there — it is a pure
function of two RGB triples, and it belongs to the scoring pass.

**The first version of that compositor was wrong, and a real capture caught it.** It walked
the surface stack but forced the accumulated alpha to 1 after a single step, so a
5%-white glass veil behaved like opaque white. The `Assistant` pill —
`bg-blue-500/15` inside `bg-white/5` inside an opaque panel — came back as
`rgb(226, 236, 254)`, a pale blue, **on a black screen**; every ratio computed from it would
have been fiction, and it would have been fiction only in dark, the theme nobody had ever
looked at. Proper source-over compositing carries the alpha forward until the stack bottoms
out (the same pill now measures `rgb(42, 53, 70)`), and `backgroundResolved` states whether
it bottomed out on an opaque layer or fell through to the browser canvas. The three-layer
stack is pinned in `test/tabTraverseCheck.ts` with the number the flattening version
produced written into the failure message.

#### The traversal now walks through the door, and records what is behind it

`tabTraverse` gained an `activate` route: an ordered list of label patterns, each fired at
most once and each eligible only after the one before it has fired,
pressed with **Enter first and then Space** — real key events, never a click — with the page
fingerprinted before and after, so an activation that did not fire is recorded as not having
fired rather than assumed. Ordering matters: the app's labels repeat across surfaces, and an
unordered matcher fires on the first `Search` or `Tools` it meets in the sidebar and reports
a journey it never took. Three further repairs were needed before the record inside the panel meant
anything, and each was found by reading a real capture:

| What broke | What the record said | The repair |
| --- | --- | --- |
| Every control in the panel appeared *after* the baseline ran | `unfocused: null` on exactly the stops the task is about — "is the focus visible here" undecidable | Re-baseline after each activation; a post-walk pass catches whatever was focused when that ran; `unfocusedSource` states which reading each stop got, and a stop with neither is recorded as **unmeasured, not passing** |
| The post-walk pass ran *after* the exit closed the panel | Every panel control unmounted before it could be measured — 2 stops still null | Resolve before the exit, not after |
| `blur()` leaves Chromium's sequential-focus starting point where focus was | One run, four traversals of one route, reaching Settings at stops **26, 8, 8, 8** — a light/dark pair that is not stop-for-stop aligned is not a comparison | Focus the body (`tabindex="-1"`, the skip-link pattern) so the next Tab lands on the document's first stop *by keyboard*; the borrowed attribute is given back; `focusStartedFrom` and `startPointReset` are recorded rather than assumed |

A traversal that opens a surface must now declare an `exit` — the control that closes it,
activated with the keyboard like any other. That is not tidiness. Settings → General renders
`Sigma Oasis v{version}`, and a panel left open is in every screenshot that follows;
screenshots are the one artifact `make-blind-pairs.mjs` cannot scrub, so a version number
reaching a critic there would be invisible to `assertBlind`. An exit that cannot be
performed fails the action. `run.json` also now carries `screenAtTurnEnd` — the theme the
run finished in, and whether a modal was covering the app when its artifacts were taken.

#### What one capture now shows that seven rounds could not

VC2, one run, four traversals of two routes in two themes, 70 stops each:

| | light | dark |
| --- | --- | --- |
| `Settings (⌘,)` reached and **activated** | stop 8 | stop 8 |
| `Tools` (the `web_search` toggle) reached and activated | stop 38 | stop 38 |
| `Models` (each role's model) reached and activated | stop 35 | stop 35 |
| stops **inside** the Settings panel | 38 / 32 | 38 / 32 |
| stops with no unfocused reading to compare against | 0 | 0 |
| `N_invisible` by VC2's own criterion | 0 of 70 | 0 of 70 |
| stops focusable **behind the modal scrim** | 24 / 30 | 24 / 30 |

Round 7's record ended at stop 26 with the door shut. The last three rows could not
previously exist at all.

VC3, one run, one reply, measured twice — **the first `N_fail` and `MIN_RATIO` the
head-to-head bench has ever produced for dark theme from a recorded run**, and the first
dark screenshot of any kind in seven rounds:

| | light | dark |
| --- | --- | --- |
| `N_prose` (last assistant message / whole transcript) | 29 / 63 | 29 / 63 |
| `N_fail` | 0 | 0 |
| `MIN_RATIO` | 5.15:1 (`08:00 AM`, 10px) | 6.25:1 (`08:00 AM`, 10px) |
| `📖 From the library:` provenance line | 9.35:1 | 10.12:1 |
| timing/stats readout | 5.35:1 | 6.25:1 |

Two scopes per theme, because the task's checks name two. `N_prose` and `MIN_RATIO` come
from the last assistant message; the provenance line the task names **specifically** sits on
the *retrieval* turn, and a run whose follow-up consulted nothing — which is what this one
answered — has no provenance line in its last message at all. Scoped to `lastMessage` alone
that check is not merely failed, it is unanswerable, and it was unanswerable in light theme
too. That one is a pre-existing hole in the task's scoping, surfaced by looking.

**`N_invisible` is 0, and the reason is worth the whole exercise.** The app's inputs carry a
permanent `2px solid` outline whose colour is `rgba(0, 0, 0, 0)` until focus turns it teal.
So `outlineColor` is the *only* property that moves on a ring anyone can see — and VC2's
first criterion (`outlineWidth >= 2px with outlineStyle != 'none'`) is satisfied in **both**
states. A scorer asking "did the width or style change" would report every one of those
stops as invisible; a scorer asking "do the readings differ at all" would pass a colour
change on a zero-width outline. The record now carries both full states *and*
`styleDeltaKeys` naming exactly what moved, so the scoring pass is not forced into either
mistake. This is round 5's species once more — a check whose vocabulary is narrower than the
class it guards — caught this time in the measuring instrument before it produced a number.

**`obscured` is new and is a product finding, not an instrument one.** 24 to 30 stops per
traversal are controls of the chat behind the Settings scrim: focusable, inside the viewport,
`inViewport: true` by the geometric check VC2 already had, and completely unusable. There is
no focus trap and no `inert`, so a keyboard user who opens Settings tabs through the entire
application before reaching the panel's first control. The traversal records what a click at
each element's own centre would actually hit, and names it.

#### Where the checks live

The browser half cannot be a `node:test` file — whether Tab moves focus, what
`:focus-visible` matches, what a click at a centre point hits and what a translucent ink
composites to are all properties of a live layout, and a mocked DOM would answer from the
mock. `test/tabTraverseCheck.ts` drives the **same strings the harness sends** in a real
offscreen window with real key events (**43 checks**, joining `scripts/test-render.sh`); it
pins a control that shows a ring *and* one that does not, so an instrument returning a
constant fails. `test/h2hTraversal.test.ts` (**41 cases**) pins the orchestration — where
the ordering bugs live — plus the wiring, read out of the harness sources and
`task-setup.json`.

Two guards came out of the work rather than being planned:

- **A variant the task does not define is now refused.** `--variant dark` on a task with no
  dark variant used to fall through to the base setup and still name the directory
  `<id>-dark` — a label that outruns its measurement, which is the species this bench keeps
  finding in the *product*. It does not get to live in the bench.
- **`no task outside visual-craft declares a theme`** is asserted, so the decision above
  stays a decision and does not drift into a habit.

#### What this still does not measure

- **No sweep was taken and no build was compared.** Every figure above is one capture of
  the current build. There is no win/loss claim here of any kind.
- **The Pass-1 scorer is still not committed.** `N_invisible`, `N_fail` and `MIN_RATIO`
  above were computed by throwaway scripts over the recorded artifacts. The run directory
  now holds everything those numbers need — which it did not before — but "a script
  evaluates every entry in `mechanicalChecks`" remains a thing the protocol describes and
  nothing in the repo does.
- **The `theme` action drives the app's own Settings panel, so it is arm-dependent.** A
  build whose panel labels or Save button differ would fail the action and void its VC2 and
  VC3 runs while the other arm's succeed. That is the correct direction to fail in — a
  silent mislabelled capture is worse — but it is a new way for one arm to be voided and
  not the other, and no baseline has been driven through it yet.
- **VC2's two routes overlap.** Both walks cross the same ~30 page stops before entering
  Settings, so a union of the two is not a set of distinct stops and `N_stops` must not be
  added across them.
- **`obscured` hit-tests the centre point only.** A control half-covered at its edges, or
  one whose centre falls in a gap in the covering element, reads as unobscured.
- **Nothing scrubs the app's version out of a screenshot.** VC2's `exit` keeps the Settings
  panel closed, which is what actually prevents the leak; a future task that opens a surface
  and forgets an `exit` gets a note in `run.json` and nothing more. `assertBlind` reads text
  and cannot read a PNG, and `_arm.json` has said so since the protocol was written.
- **`normalizeSettings` treats an absent `theme` as `dark` while `defaultSettings()` says
  `light`.** Harmless on every current path, because `getSettings` merges the defaults in
  first — but the two disagree, and a caller that normalises a partial object gets dark.
  Found while checking that seven rounds of "light theme only" was actually true. It is.

## Round 8: judging that is not written by the person being judged (v1.17.3)

**Blind verdict: 2 won · 0 lost · 16 tied**, over 18 tasks. Both sweeps 18/18 VALID, 0 failed.

Round 7 scored 18–0–0 and this document said, above the number, that it was not usable as a
comparison. Round 8 changed three things and the number moved to 2–0–16.

| | rounds 1–7 | round 8 |
| --- | --- | --- |
| compared against | the baseline, up to seven rounds old | **the previous round** |
| critic prompts written by | the person who built the changes | **an agent that never saw the changelog** |
| task file the critic reads | `tasks.json`, including `probes` | **a generated view: id, dimension, prompt, setup** |

Sixteen ties is the correct answer when two builds one round apart are the same program on
sixteen of eighteen tasks. The two wins are exactly where builders worked: FR1 (the failure
boundary) and VC1 (the wrap default).

### The task set was telling the critics which arm to pick

The agent sent to write neutral prompts came back with a worse problem than the one it was
sent to fix. All 18 `probes` fields are defect descriptions of a specific build — present
tense, naming a source file, function or CSS class, asserting a live bug. Four quote
constants only one build can produce:

| task | the constant a critic would read |
| --- | --- |
| VC3 | `rgba(23,23,23,0.32)` … `roughly 2.05:1` … `33 places` … `83 places` |
| VC2 | `33 occurrences of 'outline-none'` … `zero occurrences of 'focus-visible'` |
| PT2 | the exact strings `▶ Run this plan`, `Cancel`, `awaiting approval` |
| PT3 | `'✗' in text-red-500`, `'○ text-neutral-400'` |

A critic that measures 2.46:1 against 9.48:1, having read that the value to beat is 2.05:1,
is recognising an arm rather than judging one. **That was true of every round judged before
this one**, and it is recorded here rather than quietly fixed. `make-critic-tasks.mjs`
generates the view a critic may see and refuses to write if a stripped field survives under
any name — a field that reappears with a new spelling is the same leak.

The agent also disclosed its own contamination: reading `probes` gave it an inventory of
known weaknesses even without learning what changed. Its recommendation for round 9 is that
the question-writer be given only `id`, `dimension`, `prompt` and a one-line dimension
statement.

### Eight rounds of blind judging worked on luck

`Sidebar.tsx` renders `v{appVersion}` permanently, so the version is in every screenshot of
every task, and text scrubbing cannot reach a PNG. Two arms at different versions are
de-blinded on all 18 tasks at once, silently. That never happened only because
`package.json` had said 1.12.1 since the baseline. Staging now refuses a pair whose arms
report different versions — verified both ways.

### What sixteen ties actually mean

Three different things, which should not be read as one:

- **The task was not sensitive to what changed.** No builder touched PT2, PT3, FR2 or FR3,
  and the critics found the two runs byte-identical apart from timestamps. That is the
  instrument working.
- **The model did not exercise the change.** On V1 the round-7 arm fired a false positive on
  a figure its own tool output contained; the critic refused to score it because the
  round-8 arm never received a multi-lookup turn — *"its 0-mismatch score is untested rather
  than earned"*.
- **The task set measures the dimension, not the defect.** Builder A's repair is visible in
  the artifacts — round 7 prints `Nothing in the library covers this question — the answer
  is not backed by it` while marking two passages cited; round 8 prints `the answer cites
  [3] [5] from it anyway` — but TH3's neutral question asks whether source text is checkable
  on screen, which both builds satisfy. A real fix to a self-contradiction scored a tie.
  This is the cost of neutral questions and it is worth paying; the alternative is round 7.

### What both builds get wrong

A same-generation comparison surfaces what neither build fixed:

- **Focus is not trapped in the Settings modal.** 24 of 70 Tab stops on one route and 30 of
  70 on the other are `obscured: true` — focusable, ringed, and behind the open overlay —
  identical counts in both builds and both themes.
- **The one text below threshold anywhere in the capture is round 8's own new sentence.**
  Red error ink measures **3.63:1** in light theme on `nothing answered at that address` —
  the wording was fixed this round and shipped in failing ink.
- **The wrap fix breaks at hyphens**, so every wrapped line of the copy-me token ends in a
  real-looking `-` and a reader transcribing by eye cannot tell a wrap point from a
  character — on a task whose prompt is *"repeat it back to me on its own line so I can copy
  it"*.
- **Both builds check the wrong numbers on V3.** The headline water figure — what the user
  asked for, and differing threefold between the two runs — passes unflagged while
  incidental repair costs are named.

### What this round does not measure

- **No reference-app comparison**, as in every round.
- **The two wins are narrow.** Two tasks out of eighteen is not a claim that the round was
  large; it is a claim that two changes were visible to a neutral judge.
- **A tie is not proof of equivalence.** On several tasks neither build was put to the test,
  which the critics said explicitly rather than resolving on something incidental.
- **`answerEval.ts` holds a third hand-rolled copy of the measurement vocabulary.**
  `shared/measurements.ts` exists because two copies would drift silently. There are three.

### Pending fold-in — a task set that named the defects it was supposed to detect

Round 8 left the instrument holding two faults that pull in opposite directions, and fixed
neither. All 18 `probes` fields were defect reports of one build, so a question-writer who read
them was contaminated and a critic who read them could recognise an arm. And the neutral
questions written to replace the leading ones turned out to be **insensitive**: builder A's
repair to a genuine self-contradiction — the app printing that nothing in the library covered
the question while simultaneously marking two passages as cited — scored a **tie**, because
TH3's question asked whether source text was checkable on screen, which both builds satisfied.

The two faults look like one trade: *a question specific enough to detect a real repair is a
question that names the repair.* They are not. What makes a description leak is not its
specificity, it is that it **asserts a value** — that it says which side of the observable a
build falls on. A description can name the coordinate exactly and stay silent on the reading.

> the strip only lists the first lookup's passages

names one coordinate and one build's position on it. It dates, it de-blinds, and it stops being
true the day it is fixed.

> this prompt produces a turn with two lookups and citations spanning both

names **the same coordinate**, is true of every build including one that gets it right, and
tells a reader nothing about which arm is which. It is exactly as sensitive and carries none of
the leak. That is the whole repair, applied 18 times.

**Before and after, three of the eighteen.**

`V2` — a defect report, down to the element:

```
Retrieved provenance is display-only. MessageBubble renders library citations through
MemoryContextLine, where each source is a bare <span>{i.source}</span> inside a collapsible
— no <a href>, no way to open the cited document. … Prompt matches FINANCE_RULE_DOMAINS
('standard deduction', 'filing status') so packs/finance/standard-deduction.md is retrieved
```

now a statement about what the task makes happen:

```
The prompt asks for a citation in as many words, in a domain the installed library covers, so
the reply arrives with retrieval behind it and the model routinely writes inline bracketed
markers into the text. The task therefore produces, inside one message, a set of citations
offered and a set of routes to the cited text. Both are countable from the artifacts, and the
distance between them is what the dimension is about.
```

`VC3` — the worst of the four de-blinders, which handed a critic the number to beat:

```
--text-muted is rgba(23,23,23,0.32) in light theme — roughly 2.05:1 against the app's light
background — and it is used for load-bearing prose in 33 places (text-ink-muted), while the
message-level provenance lines use text-neutral-400 in 83 places.
```

now:

```
This is the natural follow-up to a retrieval turn, and it puts the application's own account
of that turn on screen: which documents were used, how relevant they were, and how long it
took. That account is prose, and prose has a measurable contrast against whatever is behind
it, in both themes. Every text node in the reply is one measurement, so the result is a
distribution rather than a reading.
```

`TH3` — the task that missed the repair. Before, it asserted a defect in the checking code:

```
Quotation fidelity is unchecked. … Nothing in checkToolGrounding compares quoted spans to the
source corpus (it checks figures, links, origins, addresses, contacts), so a 9B model that
paraphrases inside quotation marks … produces a fabricated citation that the app presents
exactly as it presents a true one.
```

after, it names both observables the turn puts in play — and the second one is the fix:

```
The prompt demands a verbatim line from the installed library, so the reply carries a span
presented as quotation while the turn carries the text it was supposedly taken from — a claim
that is checkable character by character from the artifacts alone. The same message also
carries the application's own statements about that retrieval: how much it found, whether it
treats the answer as backed, which passages it marks as used. So this screen can be checked
against itself as well as against the record.
```

**Sensitivity came from the question shape, not from the question's content.** A single
`criticQuestion` had to be specific and answerable in one sentence, and the shortest sentence
that is both is *which run leaves more invented numbers standing*. That is a verdict wearing a
question mark. It is now three fields:

| | what it is | why it is not leading |
| --- | --- | --- |
| `question` | non-directional: how many, how much, what the reader ends up with | the specificity moved out of it |
| `measure` | what to report from **both** runs, in numbers, in both directions | a report is not a verdict |
| `decide` | how to weigh it, symmetrically, including what a tie means | states the tie rules before the numbers exist |

Every `measure` entry has to stay informative after the thing it measures is fixed. *Report how
many markers resolve and how many do not* survives a fix; *does the app resolve markers* stops
saying anything the moment one build says yes. Each one also carries its own degenerate-fix
guard, because the cheapest way to pass most of these questions is to print less: V3 reports the
figure count beside the mismatch count, PT2 asks whether the cancelled plan is still legible at
all, VC1 counts characters lost as well as pixels overflowed, VC3 reports nodes measured beside
nodes failing, and `selfConsistency` says outright that a screen which says nothing is not
thereby consistent.

**The TH3 case, specifically.** The file now carries one question asked of every task:

```
Does anything the application states on this screen contradict anything else it states on the
same screen?
```

It presupposes nothing, applies to every build, needs no knowledge of what changed, and is the
question that would have caught a banner disclaiming the library while markers cited it. TH3
also carries it in its own `measure`, specialised to retrieval statements. This is the general
lesson from the miss: a task whose trigger is the model misbehaving needs a **companion
measurement that fires unconditionally**, or the fix is only visible on the runs where the model
happens to co-operate. V1, TH1 and TH2 each gained one.

**The guard.** `test/h2hTaskNeutrality.test.ts`, 12 tests. The generated view is a filter on
what a critic may *read*; this is a check on what may be *written*, which is the thing that stops
the leak existing. Twelve leak classes, written as classes rather than as the strings round 8
found — the recurring lesson in this document is that a check whose vocabulary is narrower than
the class it guards stops catching things the moment the wording moves:

| class | example it catches | why it is a fingerprint |
| --- | --- | --- |
| source path, tree path | `index.css`, `packs/finance/…` | a build that renamed it falsifies the task |
| utility class, css token | `text-neutral-400`, `rgba(23,23,23,0.32)`, `outline-none` | how one build spells a presentation |
| code identifier | `MessageBubble`, `checkToolGrounding`, `FOOD_DOMAINS` | neither reader nor critic ever sees it |
| dimensioned number, ratio | `15 s`, `33 occurrences`, `2.05:1` | a measured result: the value to beat |
| version, viewport size | `v1.6`, `1280x800` | the most direct de-blinder there is |
| interface glyph, quoted screen string | `▶`, `✗`, `'awaiting approval'` | the arm that prints it is the arm that has it |

It also fails if a `question` contains *which run*, if a field exists that `make-critic-tasks.mjs`
neither keeps nor drops (a rename is the same leak respelled), and if `tasks-for-critics.json`
is stale. Two tests keep it honest in both directions: a positive control feeding it the shapes
round 8 recorded in the field, and a false-positive control feeding it neutral prose. Verified by
reintroducing a leak: `V1.probes` gains one sentence and the suite names all three constants in
it and why each is one.

Suite: **2118 tests, 0 failures**, exit 0, plus 252 render/style/traverse/markdown/transport
checks. Twelve of those tests are new. `prompt` and `setup` are byte-identical to round 8 —
asserted by diffing the frozen fields before and after the rewrite, not by inspection.

#### The five tasks this did not fix, and why

Named rather than papered over. Two kinds of residue.

**The leak I was not allowed to reach — PT2, VC1, FR3, PT1, TTU2, TH2, TTU1, VC2.** `setup` is
frozen, because eight rounds of recorded runs are comparable only if the staging has not moved,
and it is also the one descriptive field the critic view **keeps**. So the constants in it still
reach a critic, and round 8's mitigation never covered them:

- **PT2** is the worst case, because two of round 8's four de-blinders are in its `setup`, not
  only in its `probes`: the driver is told to wait for `'awaiting approval'` and then click
  `'Cancel'`. Its `probes` no longer quotes a label; its staging still does.
- **VC1**'s setup carries `(v1.11)`, a literal version string in the file a critic reads while
  being instructed to ignore version strings.
- **FR3**'s names `pickReviewer` and `REVIEW_INSTRUCTION` — internal identifiers, in front of a
  blind judge.

These are pinned as an inventory the suite asserts exactly, so the surface cannot grow
unnoticed, and each is a one-line edit for whoever decides the staging prose may move
independently of the staging. I did not make that call.

**The insensitivity I could not remove — V1, TH1, TH2, TH3, and VC2 differently.** Four tasks
have a **model-dependent trigger**. The app-side behaviour they measure only becomes visible
when the model misbehaves first:

| task | fires only when the model | so a repair is invisible when |
| --- | --- | --- |
| V1 | states a quantity the source does not contain | it happens to state only supported ones |
| TH1 | claims a tool it did not use | it makes no process claim at all |
| TH2 | writes URLs after a failed lookup | it writes none |
| TH3 | fabricates inside quotation marks | it quotes faithfully |

No rewording touches this. It is the mechanism behind round 8's *"the model did not exercise the
change"* ties, and it is why V1 scored a tie on a run the critic refused to score — *"its
0-mismatch score is untested rather than earned"*. The unconditional companion measurements
narrow it: TH3 now always asks whether the screen agrees with itself, TH2 always asks what
status the lookup block displays, V1 always asks whether the retrieved text is legible on screen
at all, TH1 always asks whether what ran is visible. A run where the model behaves now still
measures something. But the specific check — does the app catch a fabricated quotation — cannot
be exercised on a turn with no fabricated quotation, and a task set cannot make a 9B model lie
on cue.

**VC2** resists for a different reason: the keyboard route is chosen by the model's own answer,
so the two arms may traverse different routes of different lengths. Totals are not comparable
between runs; only proportions are, and `decide` now says so. That is weaker than it looks in
the score line.

**And `mechanicalChecks` is untouched — 18 fields, still a defect inventory in machine form.**
It names `text-red-500`, `'Run this plan'`, exact glyphs and exact thresholds, because a script
assertion has to name concrete DOM facts to be decidable at all. It is stripped from the critic
view and the README now says plainly that nothing but the scoring script may read it, including
the person writing the critic's prompt. That is a rule, not a mechanism. It is the largest
remaining contamination surface in the file and the guard does not cover it.

## A note on the version numbers in this document

The section headings above carry labels like `v1.14`, `v1.16`, `v1.17.2`. **None of those
were ever shipped.** `package.json` said `1.12.1` from the baseline through the end of
round 8 — every recorded run in `.h2h-runs/` is stamped `appVersion: 1.12.1`, and every
contrast figure, timing and verdict in this document was measured against a build reporting
that number. The labels are round markers written contemporaneously, and they are left as
written rather than rewritten, because rewriting them would falsify when each measurement
was taken.

The first release carrying this work is **2.0.0**. A major, because eight rounds changed
what the app tells the reader about its own behaviour: the verification chrome, the plan
block's terminal states, the failure surfaces, the citation binding, and the markdown
render path — including two defects that were silently deleting characters from answers.

The stale number was not harmless. `Sidebar.tsx` renders `v{appVersion}`, so it appears in
every screenshot the bench takes, and eight rounds of blind judging worked only because
both arms rendered the same string. Bumping it is now guarded: `make-blind-pairs.mjs`
refuses to stage a pair whose arms report different versions.

### Pending fold-in — a focus ring on a control the user cannot reach

Round 8's bench walked 70 Tab stops per route and a blind critic reported, with identical
counts in **both** arms, in **both** themes:

> `"obscured": true` on **24 of 70** stops on the web-search route and **30 of 70** on the
> role-model route — with identical `obscuredBy` values: stop 9 `"Copy message"` obscured by
> `"div.flex-1.overflow-y-auto.p-5"`, stops 10–13 (`"Read aloud"`, `"Re-answer the last
> message"`, `"Think harder…"`, `"Explore alternative response"`) by `"label.mb-1.block.text-sm"`.

The critic was right and the number was low. Measured against the shipped v2.0.0 build by a
new instrument (below), it is 55 of 70 — and it was never only Settings.

#### The measurement, and why it is not `tabTraverseCheck`

`tabTraverseCheck` proves the **instrument**: that a real Tab press moves focus, that
`obscured` can see a scrim. Its page is written to have the defect, so it can never prove
the **product**. Whether the app's overlays contain focus is a property of the app's real
component tree and real layout, so `test/modalFocusCheck.ts` boots the shipped `out/main` on
a throwaway seeded profile — offscreen, with the window's `show` suppressed — and drives it
with real key events, using the same `TAB_BASELINE`/`tabStop` instruments the bench uses.
One child process per theme, because the theme has to come from seeded settings: the panel
repaints the document from its own draft when it opens, so toggling the class from outside
gets overwritten, which is the trap round 7 documented and paid for.

`scripts/test-render.sh` now runs `electron-vite build` before this check, unconditionally.
A freshness heuristic is one more enumeration to be defeated, and a check that silently
measures a stale `out/` is worse than no check — three rounds of one bench arm ran
handicapped on exactly that kind of missing precondition.

**Obscured stops, before → after. Identical in both themes and on both routes**, which is
itself the finding: nothing about this depended on what was on screen behind the panel.

| Overlay | before | after |
| --- | --- | --- |
| `SettingsModal` | 55 / 70 | **0 / 70** |
| `ProjectModal` | 55 / 70 | **0 / 70** |
| `CommandPalette` | 57 / 70 | **0 / 70** |
| `OnboardingModal` | 67 / 70 | **0 / 70** |

Obscured is not the only number, and on its own it is the wrong one: a build that moved the
background controls out from under the panel instead of out of the tab order would score a
perfect zero and still be broken. So `pageStops` — stops whose surface is the page behind
the overlay — is measured beside it, and it moved from the same 55/55/57/67 to 0.

#### The true negative, measured on the same runs

The containment could buy every figure above by inerting the page and forgetting to stop. So
with **no overlay open**, on both routes and in both themes, before *and* after:

| | before | after |
| --- | --- | --- |
| elements carrying `inert` | 0 | **0** |
| obscured stops | 0 / 70 | **0 / 70** |
| focusable controls the walk never reached | 0 | **0** |

The last row is the one that matters: every rendered, enabled, non-`tabindex="-1"` control in
the document is still reached by the walk. Nothing was made unreachable to make the first
table look good.

#### `inert`, not a Tab handler, not `aria-hidden`

A focus-trap keydown handler has to answer *"what is the first and last tabbable thing inside
the panel"*, which means re-implementing tabbability — `disabled`, `tabindex="-1"`,
`display:none`, a closed `<details>`, a `visibility:hidden` ancestor. That is an enumeration,
and rounds 3–6 are a list of enumerations losing to a form that was not on them. It also only
covers Tab: a click, find-in-page and a screen reader's virtual cursor all still reach the
page behind the panel.

`aria-hidden` on the background fixes only the screen-reader half. The element stays focusable
and stays hittable, so the measured defect — a ring on a control that cannot be clicked —
survives it untouched. Strictly weaker than what is needed.

`inert` hands the question to the engine that owns the answer: the subtree leaves the tab
order, hit-testing and the accessibility tree together. It is round 3's repair generalised —
name what is still live and let everything else follow, rather than listing what to skip.

**What it costs.** It is Chromium 102+; this app ships Electron 31 (Chromium 126), and on an
engine without it the app degrades to today's behaviour rather than breaking. It is stronger
than a tab trap in one visible way: text behind an open panel can no longer be selected or
copied. That is the semantics the app already claimed — every one of these surfaces already
swallows background clicks with a scrim.

#### The vocabulary, and the fifth surface

The obvious guard is "the four modals", or the `fixed inset-0 … z-50` string the traversal
instrument uses to name an overlay. Both are narrower than the class, and the app contains
the proof: `BranchMenu` covers the viewport with a `fixed inset-0` **z-40** click-catcher and
puts its menu above it, so while it is open every control on the page is obscured and still
tabbable — and `surfaceOf` calls every one of those stops a *page* stop, because z-40 is not
on the list. It is the same species in the check that was about to be written to fix it.

So the class is **any element that covers the viewport to take interaction away from what is
under it** — in this codebase `fixed inset-0`, no z-index, no component name. Containment
lives in `useModalSurface`, which `useModalPresence` wraps, so a modal that forgets to contain
focus is now a modal that also forgets to animate, which is visible the first time anyone
opens it. `test/modalSurfaces.test.ts` fails the build if any renderer file grows a covering
surface without coming through the hook and attaching the ref it hands back. Its cases:

| Case | Verdict |
| --- | --- |
| a `fixed inset-0` surface with no containment hook | **named** |
| a surface that takes the hook but never attaches `surfaceRef` | **named** — holding the ref is not attaching it |
| a file with no covering surface | silent |
| `fixed bottom-4 right-4` — a toast pinned to a corner | silent — widening to bare `fixed` would cry wolf, which is round 4's lesson |

The background is computed by walking **from the surface node outward**, marking the siblings
at each level up to `<body>`. Nothing enumerates the app's background containers, so a pane or
rail added anywhere is covered the day it is added. Only the topmost surface is live: without
a stack, ⌘K over an open Settings panel would have each inert the other and leave the user
with two panels and no way into either.

#### Escape, and where focus goes

Both halves were missing, and one of them was missing entirely: **Settings and the setup
checklist had no Escape at all** — measured, `Escape left it open` — so the only way out was
to find the ✕ by Tab, through the 55 stops that were not in the panel. Escape now belongs to
the surface stack rather than to each modal's own `window` listener, which also fixes a bug
nobody had reported: a per-modal listener fires whichever surface is on top, so Escape with
the palette open over the project editor closed the editor underneath it. It is handled on
`document` in the capture phase so it settles the key before `InputBar` cancels a recording
with it.

Focus returns to the control that opened the overlay. Two things had to be right, and the
instrument caught both after the first implementation looked finished:

- **Reading `document.activeElement` in the effect is too late.** The command palette's query
  field (`autoFocus`) and a new project's name field are focused during commit, which is
  before a parent's effect, so the "opener" the effect read was an element *inside* the
  surface — and closing restored focus to a node that had just unmounted. Measured: focus
  went to `body` for exactly those two overlays and to the right control for the other two.
  The opener is now read during **render**, which runs before commit.
- **A surface opened from inside another one has no opener of its own.** Picking "Setup
  Checklist" closes the palette and opens the panel in the same tick. The restore target now
  walks the chain — an opener inside another surface is a handoff, not an origin — so the
  panel returns focus to what the *palette* would have returned it to.

`body` is not an acceptable answer to either: from `body` the next Tab restarts at the top of
the document, which is the same "you are not where you think you are" the round-8 critic
described, one step later.

#### The first stop inside, and what is announced

Focus lands on the dialog element, not on its first control. Focusing the first control
announces *"Close, button"* and never names what opened; the dialog carries `role="dialog"`,
`aria-modal="true"` and an accessible name, and is `tabindex="-1"`, so landing there announces
*"Settings, dialog"* and the next Tab enters the panel — what `dialog.showModal()` does
natively. A surface that has already put focus somewhere inside itself keeps it, because the
question asked is *"did focus already land inside me?"* rather than *"which modals
autofocus?"* — the second is a list that falls out of date.

Before this, three of the four overlays had no `role="dialog"` at all and the fourth
(`ProjectModal`) had the role but not `aria-modal`, so a screen reader was never told the
page behind it was unavailable. `BranchMenu` is announced as a `menu`, not a dialog, because
it is one.

Counts: node 2106 → 2112, and a new `modalFocusCheck` at **177** checks. Tab-traverse,
render, style, contrast, markdown, workbench and transport are unchanged.

#### What this does not measure, and what was found and not fixed

- **The sidebar's project ⚙ is mouse-only.** It sits in a `hidden shrink-0
  group-hover/project:flex` span, so it is `display: none` until the pointer is over the row:
  it cannot take focus and Tab never reaches it. The project editor is therefore driven here
  through the palette's `Project Settings: …` command, which is the route a keyboard user
  actually has. Not fixed — it is a different defect (a control reachable only by mouse), and
  the same pattern is on the row's `+` and delete buttons. Worth a round of its own, because
  the fix is a `focus-within` rule on the whole family, not on the one button.
- **`obscured` still hit-tests the centre point only**, as round 8 recorded. A control
  half-covered at its edges reads as unobscured. The `pageStops` figure does not share that
  limitation, which is the second reason it is measured.
- **The routes are this check's own seeds, not the bench's captures.** Two seeded
  conversations — one with a `web_search` tool block, one with two replies — stand in for the
  bench's web-search and role-model routes. They produce different background controls, which
  is what the routes were varying, but a count here is not comparable with a count in a bench
  run: the bench's 24 and 30 are of a longer transcript, where 70 stops cover less of the page.
  The before/after numbers above are from one instrument against two builds, which is the
  comparison that means something.
- **Nothing here measures a screen reader.** `role`, `aria-modal` and the accessible name are
  checked as attributes; that they are *announced* well is a claim no assertion in this repo
  can make.

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

### Pending fold-in — the app's warnings were its least legible text

Two independent measurements, from recorded runs of the shipped app, said the same thing about
the same class of sentence.

> The red error ink is the only text below threshold anywhere in this capture — **3.63:1** in
> light theme, measured on `"nothing answered at that address"` (`rgb(239, 68, 68)` on
> `[247, 252, 251]`) — and it is exactly the text a reader most needs to read.

> `text-amber-600` composites to 3.10:1 on the light panel, at ~20 sites including this
> component's own "⚠️ Empty reply" line.

Both are closed, and the mechanism behind them is closed with them. The figures below are
measured, in a real offscreen window, over the surfaces the app actually composites — not read
out of the stylesheet.

#### A raw palette step is one colour for two themes

`text-amber-600` is 3.10:1 on the light panel and 6.11:1 on the dark one. That is not a bad
choice of amber; it is the absence of a choice. One class cannot be legible in two themes, so
every site that reached for one was guaranteed to fail in one of them — and the sites that
reached for one were, almost exactly, the lines that report a failure, a warning, or a claim the
app could not verify. 25 amber sites and 22 red ones had accumulated behind that single fact.

The neutral ink ramp had already learned this: chrome ink goes through `--text-*`, which is
defined once per theme, and a guard refuses `text-neutral-400` and its cousins. Status colour is
the same argument one step further, so it gets the same treatment — `--text-danger`, `--text-warn`
and `--text-ok`, surfaced as `text-ink-danger|warn|ok`.

#### Where the line is between legible and still-obviously-a-warning

Passing AA in the light theme caps relative luminance, and the usual move — walk down the same
ramp until it passes — is what makes a deep amber read as mud. The reason is measurable:
**Tailwind's ramps desaturate as they darken.** `amber-600` is chroma 0.83, `amber-700` 0.67,
`amber-800` 0.52. Darkening buys contrast by spending exactly the thing that makes the colour
mean "warning".

Rotating toward orange and taking the most saturated sRGB colour available at the required
lightness beats it on both axes at once:

| light-theme warning ink | chroma | worst surface it lands on |
| --- | --- | --- |
| `amber-600` (shipped) | 0.83 | **2.78:1** |
| `amber-700` (round 8's fix) | 0.67 | **4.03:1** |
| `amber-800` | 0.52 | 5.69:1 |
| `#a34300` (chosen) | 0.64 | 5.01:1 |

More colour than `amber-800` and a full rank more legible than `amber-700`. Round 8's own fix,
applied at one site, was never safe as a token: on the tinted wells these lines actually sit on it
measures 4.03–4.38:1, under AA.

The hue that darkening would have cost is carried instead by the parts with no contrast floor —
`bg-amber-500/10`, `border-amber-500/30`, and the ⚠️ glyph. **Ink pays for legibility; the surface
pays for identity.** That is the whole trade, and it only works because the warning is never
carried by colour alone.

#### The measurement that would have flattered every one of these

Half these lines do not sit on the panel. They sit on a wash of their own hue — amber/5 under the
grounding banner, amber/15 under the second-opinion pill, red/10 under a traceback — and a tint
makes the surface *brighter*. Measuring on the bare panel reports a number no reader gets. The
worst case in the app was the second-opinion pill at **2.65:1**, which is a full rank below the
3.10 the panel would have claimed for the same ink.

#### What the guard has to be

The per-site fix without a guard is how 25 sites accumulated, so the guard is the deliverable.
But a name ban would have been wrong: the app has two legitimate fixed palettes — which role
answered, and which project a conversation belongs to — and **an amber project is not a warning.**
Painting it in warning ink would be a lie no measurement could catch.

So the rule is measured, not named: any raw palette step used as ink must clear AA on a 15% chip
of its own hue, which is the only surface this app ever puts one on. `text-amber-600` (2.78:1) and
`text-red-500` (3.17:1) are now unusable as ink anywhere in the renderer — in a label, in a badge,
and in the prose they were carrying — while a label palette keeps its hues by being legible rather
than by being exempt. It found three sites nobody had reported: a source-URL link at 3.99:1 and
two state chips at 4.13:1.

#### Two ways this check passed without measuring anything

Both are worth recording, because they are the same failure the suite was built to catch and it
caught neither on itself.

- **An unemitted class measures inherited ink.** Tailwind only emits a utility some scanned source
  writes. A step that appears only as `dark:text-amber-400` compiles to `.dark .dark\:text-amber-400`
  and there is *no bare rule at all* — so a probe wearing `text-amber-400` inherited the ambient
  ink and reported 14:1 for a colour it never rendered. Eight dark probes and one light one passed
  this way. Same trap as the round-6 note about a stale scraped class string: a class that no longer
  resolves does not fail, it measures something else and says nothing about it.
- **A delimiter that can appear inside the thing it delimits.** Matching `(dark:)?text-…` after a
  character class containing `:` let `dark:hover:text-violet-300` match from the colon of `hover:`
  with no `dark:` captured — a phantom light-theme class, duly reported at 1.50:1 as a failure of a
  site that does not exist. The fix is to capture the whole variant chain rather than a guessed
  prefix.

Both were found by mutation: setting a token to a known-bad value and checking the suite says so.
A check that cannot be made to fail on demand is not yet known to be a check.
