# Head-to-head: round 8

Part of the [evals index](../evals.md).

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

<!-- FOLD IN: the coverage line, and the ranking that was not built. Not yet a round heading. -->

### Pending fold-in — the checker spent its attention on the wrong number

The round-8 blind critic, on task V3, reading **both** builds:

> Both apps check the wrong numbers. The question asked how much water is wasted; the
> headline answers are `"105 gallons (400 liters)"` (run-1) and `"35 gallons (130 liters)"`
> (run-2) — differing by a factor of three, invented, and flagged by neither strip. Both
> checkers spent their attention on incidental repair-cost literals (`$10`, `$25`, `$40`,
> `$80`) while the one figure the user came for passes unmarked.

Replayed against the round-9 build, the two runs produce **byte-identical chrome** — the
badge is blind to the only thing that differs between them:

| | round 9 | this change |
| --- | --- | --- |
| run-1 | `⚠️ 4 figures ($10, $25, $40, $80) …` / `Checked against: no tool output …` | *unchanged*, plus `Covered 0 of the 2 measurements in this reply. Not compared against anything: 105 gallons, 400 liters.` |
| run-2 | **the same two lines** | *unchanged*, plus `… Not compared against anything: 35 gallons, 130 liters.` |

The mechanism is an asymmetry, not a weak checker. `unsourcedFigures` has an *unprompted*
path — `MIN_UNPROMPTED_FIGURES`, so several unsupported prices are worth saying so about
even with no pricing tool. The quantities rung has none: with nothing computed and nothing
retrieved it does not run, so the volumes were never candidates. Four named figures then
read as a completed scan of the reply.

#### The ranking was not built, and this is why

The brief's first question is whether the user's own question can rank which stated
quantities matter. The honest answer is **no**, and the reasoning is worth recording
because the alternative is attractive.

`buildSearchQuery` offers nothing to build on: it flattens whitespace, caps at 240
characters, and optionally prepends the previous user message when the current one is short
and back-referring. It performs no topical analysis of any kind. Ranking therefore means a
new noun→dimension lexicon, and the app's **own shipped packs** break it:

| question | the dimension a lexicon must return |
| --- | --- |
| how much **water** should I store per person | volume |
| how much **water weight** will I lose | mass |
| how much can my landlord raise the **rent** | money, or a percentage |
| how long do **leftovers** last | duration |
| how much does it **cost** to fix a dripping faucet | money |

The last row is the same reply as V3. Asked what the repair costs, `$10`–`$80` *is* the
headline and `105 gallons` is the incidental — two questions a hair apart, opposite
answers, and no mechanical signal in this codebase separates them.

The cost of guessing wrong is not a miss, it is a new way to mislead. A line reading "the
figure that answers your question is unsupported" pointing at `$25` asserts that the app
understood the question, in the one place the reader has no way to check it. Round 4's
stricter quote checker was judged *worse* than the gap it closed, and that finding was at
least falsifiable by eye; this one would not be. **A design that cannot fail safely is not
shippable**, so it was not shipped.

#### What was built instead: the pass reports its own coverage

`GroundingReport` gains `coverage` — the one field on it that is not a fault found.
`quantityCoverage` is the same walk `unsourcedQuantities` always did, with its two
`continue`s named instead of silent: a measurement is **checked** when a corpus quantity of
the same kind was genuinely put beside it, and **unchecked** when the dimension was never
armed, or was armed and the corpus holds nothing of comparable magnitude (a passage's
"3 minutes" cannot rule on "4 days"). `flagged` ⊆ `checked`, which is the asymmetry the
field exists to disclose. **No verdict moves**: `unsourcedQuantities` is now a one-line
wrapper returning `flagged`, and all 239 pre-existing `toolGrounding` cases pass unchanged.

Three properties keep it honest, each pinned:

- **It is not a finding.** `groundingFindingCount` stays 4 on the V3 shape and
  `groundingFindingLabels` stays `["$10","$25","$40","$80"]` — the `labels.length === count`
  invariant does not learn a fourteenth category. It never enters
  `describeGroundingFindings`, so it never goes back to the model: we do not know these
  numbers are wrong, and a correction prompt naming them invites the deletion of correct
  figures — the harm this document already records on this very task.
- **It rides an existing badge.** `checkToolGrounding` still returns `null` when nothing is
  faulted, so a reply the pass faults nowhere shows no coverage line. Measurements appear in
  ordinary prose constantly; a permanent grey line under every "8 to 10 minutes" is round
  4's cry-wolf in a quieter ink. That turn is the `unverified` badge's business —
  `needsVerification` covers the reference domains, the leaking faucet included.
- **It reads as provenance, not as an accusation.** It renders at the `Checked against`
  rank rather than the warning's, pinned in `chromeContrastCheck.ts` as its own scraped row
  (6.66:1 light, 10.98:1 dark) plus a check that its ink equals the provenance ink and
  differs from the warning ink, in both themes.

#### The noise it would have made, and the gate that removes it

The first version said "compared against nothing" the moment a dimension was unarmed. That
is true and it was still wrong to print. Measured while building it:

    passage: "A faucet that drips once per second wastes about 2,000 gallons per year."
    reply:   "A dripping faucet wastes about 2,000 gallons a year."
    line:    "Covered 0 of the 1 measurement in this reply.
              Not compared against anything: 2,000 gallons."

Every word accurate — `gallon per year` and `gallon` are different units here on purpose, so
a pace never meets a duration — and a reader looking at the passage directly above it would
have called the app broken. `coverageWorthSaying` now gates the line on at least one skipped
measurement whose **value** appears nowhere in what the turn produced or the user said. That
is the V3 shape exactly (nothing ran, so 105 and 400 are in nothing) and not the shape above.

The gate is on the *line*, not on the items, deliberately: filtering item by item would
leave `checked + unchecked` short of the measurements the reply states, so "covered 1 of 4"
would name two things and silently drop a third — a count the reader cannot reproduce from
the screen, which is the defect `describeRevisionOutcome` was fixed for in round 4.

#### The cases

True positive and true negative beside each other, in `test/toolGrounding.test.ts`:

| | case | verdict |
| --- | --- | --- |
| **TP** | the V3 shape, no tool ran | `Covered 0 of the 2 … : 105 gallons, 400 liters` |
| **TP** | the same, run-2's numbers | the two runs' chrome now *differs* |
| **TP** | temperature armed and faulted, a duration nothing retrieved | `Covered 1 of the 2 … : 9 days` |
| **TN** | nothing faulted (`Boil the pasta for 8 to 10 minutes.`) | no report at all |
| **TN** | reply's `2,000 gallons a year` over a passage's `2,000 gallons per year` | no line |
| **TN** | `3 drips per second`, the number the user supplied | no line |
| **TN** | a turn whose passage covers both dimensions | `coverage` field absent |
| **TN** | the gap is not a finding | count 4, labels 4, prompt names no volume |
| **TN** | a revision dropping every price still `resolved` | coverage never blocks it |

Plus the sentence itself: singular/plural agreement, and `and N more` computed from the
count rather than the capped array (six named, ten unchecked → "and 6 more").

#### The third copy of the measurement vocabulary

Recorded in this document at the end of round 8 and now closed. `answerEval.ts` carried a
hand-rolled alternation; `shared/measurements.ts` says in its own header that it exists
because "two copies would drift, and the drift would be silent". There were three, and the
drift had already happened. Differential over 265 files — every fixture, every shipped pack,
and the recorded strings in the two test files — old regex vs shared vocabulary, **31
occurrences changed in each direction, all of them repairs**:

| what changed | example | why the new reading is right |
| --- | --- | --- |
| rate suffixes | `8.66 minutes` → `8.66 minutes per mile` | a pace is not a duration; the old form let a running time support a split |
| line breaks | `"3:47\nMiles run: 26.2"` → **no match** (was `47 Miles`) | the exact trap `shared/measurements.ts` documents; the copy still had `\s*` |
| concentrations | `40 mg` → `40 mg/m` | from the shipped home-safety pack; a CO exposure limit could support an invented dose |
| unknown units | `800 watts`, `250 kcal`, `400 mcg` now matched | the copy knew none of `mcg`, `µg`, `mph`, `km/h`, `kwh`, `watt`, `volt`, `amp`, `calorie`, `kcal` |

One divergence survives and is now a named flag rather than a second regex:
`MeasurementOptions.percent`. The eval scorer counts `5%` as a measurement — a reference
answer stating a rent cap is exactly what the library suite scores — and **no shipped rung
sets it**, because `unsourcedPercentages` already checks percentages with a better rule (the
*ratio* of two corpus numbers, not merely presence) and a `%` in the shared alternation
would produce two findings for one claim and change what `amountsIn` treats as money
support.

Suite: **2128 passing, 0 failing** (from 2106), `./scripts/test.sh` exit 0, chrome-contrast
60 → 64 checks, `npm run build` and both `--noEmit` typechecks clean.

#### What this does not fix

- **Nothing here was re-run against a model.** The before/after strings are produced by the
  shipped modules against a reconstruction of the V3 turn from the critic's quoted strings —
  the run directory is not in this repository. No win/loss claim attaches to any of it.
- **The library suite's scores were not re-measured.** Folding the vocabulary in makes the
  scorer strictly stricter, and the four repairs above will move cases. There are no
  recorded library eval outputs in the repo to re-score against, so the differential over
  fixture and pack text is the strongest evidence available and it is not a score.
- **Money has no coverage line.** `unsourcedFigures` runs on every turn and only its
  *reporting* is gated by `checkFigures`, so a report can exist alongside money figures
  nothing supports that were suppressed. That is "a suppressed finding", a different fact
  from "never compared", and it wants its own sentence and its own sweep.
- **The gate can hide a real gap.** A reply with five unchecked measurements, four of whose
  numbers appear coincidentally in the corpus and one of which does not, shows the line and
  names all five. The reverse — every unchecked number coincidentally present — hides the
  line entirely. Both are suppression-only and fail toward quiet, which is the safe
  direction, but the second is a miss and nothing detects it.
- **`researchGrounding` has no coverage notion.** It compares a measurement against every
  number in its corpus and arms no units at all, so it can neither over- nor under-state
  coverage in the way fixed here. It also remains the rung that would fault "500 mg" from a
  passage's "500 km".
- **"Which claim the reply is about" is still unknown to the app.** This change discloses
  the gap; it does not close it. A reader who does not read the quieter line still sees four
  prices named above an unmarked headline.

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
