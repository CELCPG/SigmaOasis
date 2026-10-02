# Answer suites: library, quantitative, multi-turn, ledger, deep research, think-harder

Part of the [evals index](../evals.md).

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

## The distill, measured after 4.1 and 4.2 (v4.3)

`qwen3.8-9b-distill` (68,608-token window, temperature 0), main's code (4.2.0), the default suites
plus `live`, three passes, 2026-09-30 night. No server error and no excluded case in any pass. The
first answer-suite numbers for this model; the 2026-08 table above is qwythos-9b's.

| suite | pass 1 | pass 2 | pass 3 | all three |
| --- | --- | --- | --- | --- |
| library: answered (every required fact) | 26/28 | 27/28 | 27/28 | 80/84 · 95% |
| library: cited the source | 19/28 | 18/28 | 18/28 | 55/84 · 65% |
| library: stated an unsupported measurement | 4/28 | 5/28 | 5/28 | 14/84 · 17% (lower is better) |
| quant: bare | 10/20 | 10/20 | 8/20 | 28/60 · 47% |
| quant: with the Workbench | 19/20 | 20/20 | 20/20 | **59/60 · 98%** |
| deliberate: bare → think harder | 9 → 10 of 20 | 10 → 10 of 19 | 10 → 10 of 19 | 29/60 → 30/58 |
| live: passed every line | 4/6 | 3/6 | 3/6 | 10/18 · 56% |
| live: ledger answers · wrong day | 0 · 0 | 0 · 0 | 0 · 0 | 0/18 · 0/18 |

About 5 s a library case, 3.5 s a Workbench case — the distill answers briefly.

- **Library.** Retrieval found passages for every case in every pass. Citing is where it is weak:
  a third of the replies name no source. The unsupported figures repeat (`08` "5 years", `14`
  "18°C", `21` "20 feet", `25` "30%, 15%, 10%"). `20-tornado-during` was flagged *forbidden* in all
  three passes, wrongly: the negation scoping already passed "stay away from windows"; what matched
  `\bwindows?\b` was "put your head down below the windows" — the preparedness pack's own advice
  for a car. **Fixed in 4.3 (E7):** the case forbids the unsafe advice (opening windows, sheltering
  near one), not the word, and the library summary counts forbidden hits ("asserted forbidden").
  The three passes rescored with the new fixture: 3/84 → 0/84.
- **Deliberate.** Think-harder moved one case in 60. Twice in `03-compound-monthly` the review
  spent 1,999 of its 2,000 completion tokens reasoning and returned nothing, and the case was
  excluded as an error. That was the harness: every eval request is capped at 2,000 tokens (a
  transport limit for slow models), while the app sends the review and the revision with the slot's
  cap — none — and thinking on. **Fixed in 4.3 (E6):** the two get 6,000, and a review that still
  never answers is scored as the app shows it — the draft, unreviewed — and counted on its own line.
- **Live misses its 4.1 gate (≥ 90%), and the suite is why.** Every miss searched and then gave no
  answer, and 7 of the 8 say why: the results were "local/internal pages" or "localhost URLs that
  aren't accessible". The fixture pages are `http://127.0.0.1:<port>/…`, and `fetch_webpage`'s
  description says *HTTPS only, private addresses refused* — the model declined to fetch what the
  app's own tool says it cannot. It never answered from the planted ledger entry or with the wrong
  day's figure. **Fixed in 4.3 (E4)** — below.

### After the fixes (2026-10-01, rel/4.3)

Three passes each, the same model, from `rel/4.3` with E4 and E6 in.

**Live, under an ordinary HTTPS address** (`https://www.harrowgate-dunmore-courier.com`, which the
fetch guard's test seam maps to the loopback server — `src/main/ipc/fixtureSeam.ts`; nothing sent
to it leaves the machine):

| | pass 1 | pass 2 | pass 3 | all three |
| --- | --- | --- | --- | --- |
| passed every line | 5/6 | 6/6 | 6/6 | **17/18 · 94%** |
| read a page | 5/6 | 6/6 | 6/6 | 17/18 |
| ledger answers · wrong day · wrong date | 0 · 0 · 0 | 0 · 0 · 0 | 0 · 0 · 0 | 0/18 |

**The 4.1 live-world gate — ≥ 90% from a fetched page, no ledger answer — passes**, for the first
time it has been measured on the model rather than the fixture. The one miss (`01`, pass 1)
searched, did not fetch, and declined: "none of the pages were readable before I answered."

**Deliberate, with the review's room:** bare 9, 10, 10 of 20; think harder 9, 10, 11 of 20 —
29/60 → 30/60. No error and no unreviewed draft in 60 (two errors before); `03-compound-monthly`'s
review now finishes, in 2–25 s. Revised 16 drafts, changed one result (`02-mortgage-payment`,
✗ → ✓). On this model think harder is a near-wash on these 20, as v1.9.1 found for reasoning
models.

## The library's model aids, measured (v4.4, G5, 2026-10-01 night)

Re-rank (*Re-rank library passages*) and the sample-answer expansion (*Expand library questions
with a sample answer*), both 4.2 and off, had never run on a model: the suite's lookup asked "the
first chat model LM Studio lists", and `eval:diff` did not read the suite's results. Now the
lookup is given the model under test by name (as the app gives it the slot's), `eval:diff` reads
the library block (answered per pass gated; cited and unsupported banded; forbidden advice never
banded), and `EVAL_LIBRARY_ASSIST=rerank|hyde` turns the switches on in the eval's throwaway store.
`qwen3.8-9b-distill`, temperature 0, four one-pass runs a side interleaved with a same-day control.
The aids apply only to health, first-aid, finance and building questions — 5 of the 28 cases.

**First session** (`g5-library`, 44-eval-b at `15bb441`):

| arm | answered a pass (of 28) | cited | unsupported | forbidden | verdict |
| --- | --- | --- | --- | --- | --- |
| control, aids off | 26, 26, 27, 26 | 20.50 | 2.25 | 0/112 | — |
| re-rank | 26, 26, 26, 27 | 20.50 | 2.25 | 0/112 | SAME-WITHIN-NOISE (+0.00 ±0.71) — **but it never applied** |
| sample answer | 27, 27, 26, 27 | 21.00 | 2.00 | 0/112 | SAME-WITHIN-NOISE (+0.50 ±0.71) |

Two things found on the way, both fixed:

- **Re-rank had never applied.** All 20 re-ranks the four passes asked for fell back to the fused
  order. Probed directly: under the `json_schema` grammar the 9B distill spends all 80 tokens
  thinking (`reasoning_tokens: 80`, empty answer, `finish_reason: length`) — `enable_thinking:
  false` does nothing in LM Studio, and a grammar does not stop a think block there. The
  closed-think prefill does (`{"answering": []}` in 0.2 s), but LM Studio refuses a grammar beside
  a prefill (HTTP 400, as v1.9.2 found). So a `<think>` family is now asked plainly with the
  prefill and its reply parsed tolerantly; the grammar stays for the rest
  (`library/modelAssist.ts`).
- **The forbidden check flagged the right advice.** The burn case forbids ice and butter; replies
  that listed them under "**Do NOT:**" were scored as asserting both, because a list item's scope
  was its own line. A list item now inherits its lead-in's negation ("Do NOT:", "Avoid:", a heading
  that says not). The first session's files were re-scored with it, both sides alike: 5 runs
  flagged → 0, all of them `01-burn-cooling` under a "Do NOT" list (four in the arms, one in the
  control).

**Second session, re-rank working** (`g5b-library`, 44-eval-c at `ed7fe1e`; re-rank applied in 20
of 20 eligible lookups):

| arm | answered a pass (of 28) | cited | unsupported | forbidden | verdict |
| --- | --- | --- | --- | --- | --- |
| control, aids off | 25, 27, 27, 27 | 17.75 | 3.75 | 0/112 | — |
| re-rank | 26, 28, 26, 27 | 15.75 | 2.75 | 0/112 | SAME-WITHIN-NOISE: answered +0.25 (±1.41), cited −2.00 (±2.68), unsupported −1.00 (±1.78) |

The second session's first chunk (a control pass and a re-rank pass) and the re-rank pass that
opened its second shared the 9B with an agent run that outlived its chunk (ROADMAP-v4.4, *the
night's harness*); the two sides were touched alike, and the verdict does not turn on them.

Neither aid is BETTER beside its control, so both stay off. Five eligible cases a pass is little
room for a ranking aid to show; the suite would need questions where the fused order picks the
wrong section for the switch to be measured there, not only shown to cost nothing.
