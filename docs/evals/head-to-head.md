# Head-to-head: six dimensions, rounds 2–6

Part of the [evals index](../evals.md).

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
| everywhere | `⚠️ 3 figures (…) in this reply **is** not backed` — the verb agrees with the number of *categories*, not the number of items ([`MessageBubble.tsx:166`](../../src/renderer/src/components/MessageBubble.tsx)). Every plural case is ungrammatical, on the one sentence carrying the verifiability claim. |

The generalisation holds and sharpens: it is not only *enumeration* that fails. It is any
check that reads a quantity **adjacent to** the one it means — the categories instead of
the items, one direction of a set difference instead of both, the figures instead of the
reply.
