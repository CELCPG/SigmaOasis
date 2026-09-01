# Sigma Oasis v2.2.0 — five rounds against our own ties

v2.1.0 made the interface move; this release is five adversarial rounds — rounds 9 through 13
of the head-to-head bench — run against the defects the judging itself surfaced. The method
matured mid-stream: a same-generation comparison mostly ties, and a tie is where the defects
BOTH builds share live, so each round was built from the previous round's ties. Every win
below was found by blind critics who never saw the changelog, from prompts generated
mechanically from the task set. Cumulative verdict across the five rounds: **20 task wins,
1 loss, and the ties that pointed at the next round's work**. Pinned by 2,574 node cases plus
the render, style, contrast, modal-focus, plan-accessibility, markdown, workbench and
transport suites.

## Round 9 — defects both builds shared (3–0–14, one void)

- **Focus stays on the overlay that has it.** With Settings open, 24–30 of 70 Tab stops
  landed on controls behind the modal, in both themes. Focus is now contained by the covering
  surface; the page behind stops taking Tab. Pinned by 177 modal-focus checks.
- **The app's bad news is legible.** The status red used for warnings and errors measured
  3.63:1 against its background — the least legible text in the app was its own warnings, and
  the one new sentence round 8 shipped was in that ink. Status colour is an ink token now,
  contrast-checked like every other ink.
- **A fold in a copy-me token is cut, not hyphenated.** Long unbroken tokens wrapped at
  hyphens, so a reader copying by eye could not tell a wrap point from a character. Folds no
  longer prefer hyphens; a wrap is visibly a cut.
- **The checker says what it did not check.** A turn that consulted nothing no longer lets
  its headline figure pass silently while incidental figures get flagged.

## Round 10 — the turn said it was over while the answer was still arriving (6–1–11)

The round's namesake defect and its relatives: end-of-turn claims that raced the content.
This round also recorded the bench's first loss since round 5 — kept, not relitigated — and
introduced two cross-cutting columns (`self-consistency`, `record-consistency`) scored beside
every task and never summed, which immediately caught one fact per build a single verdict
would have missed.

## Round 11 — a false "unverified" on a cooking temperature (2–0–16)

The verification badge fired on a correctly-sourced figure. Fixed, along with a guard against
a harness mistake round 10's own record disclosed. Sixteen ties, and the critics said plainly
that on several tasks the behaviour under test was never exercised — recorded as the honest
result it is.

## Round 12 — the checker never read what the reply said about the app (4–0–14)

A reply saying "I did not call any search or reference lookup tools" sat directly above three
green-ticked `reference_lookup` blocks — in both builds — because the grounding ladder checked
a reply's claims about the world and never its claims about the application. Now it checks
both. Also: a backing checker that flagged a correctly-sourced temperature over one space
character; an unbacked-figures count silently capped at five, uncapped; two failure banners
that now describe what the server actually did; and two plan headers that stop reporting
in-flight progress once a plan is over. Two verdicts were overruled after reporting — in
opposite directions, both by experiment rather than argument.

## Round 13 — six defects from round 12's ties (5–0–13)

A reply that invented the retrieval whose true account the app printed directly above it —
the round's highest contested count, three record contradictions per run in both arms. A
ledger line that miscounted the session variables listed beneath it. "Checking stopped at its
60s limit" printed beside "114.1s checking" — the limit now bounds what checking *starts*,
not what it finishes. A coverage line claiming "in this reply" over a scan that had no unit
for "876 drops per day". Fetch internals reaching the reader past the boundary built to stop
them. And the plan header's "N/N steps done" — the most prominent claim in plan mode —
brought into agreement with the record. Three verdicts overruled after reporting, both
directions, all three by the same test: whether the winning behaviour is code the two arms
share.

## The instrument itself

The task set was rewritten to describe **tasks, not builds**: every rationale and critic
question now names what a task makes happen, never what a build does with it — no source
paths, class names, glyphs, or measured constants, enforced by a suite test on the source
file rather than by convention. `prompt` and `setup` are frozen (eight rounds of recorded
runs are comparable only because they never moved), critic prompts are generated mechanically
so no prompt-writer can be contaminated by the changelog, and every round's verdict now lives
in `docs/head-to-head/verdicts/` with `score-round.mjs` aggregating the three columns.

## Caveats, which are real

- All verdicts are one machine, one local model class (qwen3.8-9b), same-generation
  comparisons. Ties dominate by design; the wins are narrow and specific.
- Round 10's loss stands in the record. Overruled verdicts (rounds 12 and 13) are recorded
  as overruled, not erased.
- Nothing here is claimed against a reference product — every automated route to one remains
  closed on the bench machine.

## Upgrade notes

Auto-update from v2.1.0 or v2.0.0. No new settings, no migrations. The fixes are to what the
app displays, records, and claims about itself; no tool, model, or privacy behaviour changed
meaning.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v2.1.0...v2.2.0
