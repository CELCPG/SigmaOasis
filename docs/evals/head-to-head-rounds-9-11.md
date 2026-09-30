# Head-to-head: rounds 9–11

Part of the [evals index](../evals.md).

## Round 9: what both builds get wrong (v2.1)

**Blind verdict: 3 won · 0 lost · 14 tied · 1 void**, over 18 tasks. Both sweeps 18/18
VALID after three re-runs.

The second same-generation comparison, and the first judged with critic prompts
**generated mechanically** from the task set. Round 8's prompt-writer disclosed its own
contamination — reading `probes` had given it "a full inventory of the weaknesses at
least one build is known to have". There is now no writer to contaminate: the prompts are
assembled from each task's `question` / `measure` / `decide` fields plus one
self-consistency question asked of every task.

### The three wins, measured

| task | what decided it |
| --- | --- |
| VC2 | obscured Tab stops **24–30 of 70 → 0 of 70**, identical in both themes and on both routes. The focus indicator itself tied at 70/70 visible in every file, so the entire margin is occlusion. |
| VC3 | the **same warning sentence** at **3.11:1** in one build and **6.09:1** in the other; the same failed-call line at **3.59:1** against **6.19:1**. Both below AA in light theme only — which is the defect a single raw palette step cannot avoid across two themes. |
| V3 | a coverage line naming what the pass never reached. Credited to the application rather than the sampler because the older build's extractor demonstrably reduced the same ranges and printed nothing. |

The third win came from the builder that **refused the feature it was asked for**. Asked to
rank findings so the figure the user actually asked about gets checked first, it argued
that "how much does it *cost* to fix a dripping faucet" would make `$10–$80` the headline
on the very same reply, and that such a line asserts the app understood the question in the
one place a reader cannot check it. It shipped the narrower true thing instead. A blind
critic scored the refusal a win.

### The void, and why it is mine

V2 went to round 9 on the other arm's generation failing with a context overflow. The
critic flagged its own uncertainty — *"if that failure is environmental, this is a tie"* —
and lacked the evidence to settle it. Same prompt, same settings, same retrieval, single
turn, and **round 9 changed no context code**: a server condition is not the change under
test. Voided rather than banked. Precedent is round 3, which voided a task for the same
reason.

### What both builds still get wrong

A same-generation comparison mostly returns ties, and what the ties surface is the shared
defect. Round 9's most important finding is one neither build fixes and neither critic was
asked about:

**The turn reports itself over while the answer is still arriving.** Three independent
observations, in both arms:

- an answer reaching the screen as `"(pet"` where the model wrote `"(pets, seniors, infants)."`
- the same shape on a different task in the other arm
- a `stream-edge` span still present **263 ms after** the app reported the turn idle,
  painted at `opacity: 0.2` — which measures **1.49:1**

The word left illegible in that capture was `"safe"`, in an answer about food safety.

It also gives round 7's `reply.md` comparison a **false-positive mode**: that artifact was
added so a critic could catch the renderer deleting characters, and it found two real
defects that way. A critic diffing raw markdown against rendered text will now periodically
see a renderer that dropped nothing. The instrument needs to settle on a paint before
reading, or record a `textSettledMs` so a lag is distinguishable from a loss.

Also unfixed in both: plan blocks carry **no accessible names at all** (`aria-label`,
`role`, `title` all empty across the cancelled and stopped captures) — round 9 contained
focus in five modal surfaces, and the plan block is not one. The post-stop message still
blames the model (`"nothing came back from the model"`) for what the fixture record shows
was a transport stall. And a context-overflow message sits on the same screen as the app's
own meter reading `~1.7K / 8.2K`.

### What this round does not measure

- **Two round-9 improvements scored nothing**, both visible in the artifacts, neither the
  task's question: the older build draws one fact in two amber ramps on one screen where
  round 9 uses a single token, and the older build lost an answer's tail where round 9 did
  not. Builder E's rewrite improved the questions; the tension it was sent to resolve
  stands. A question neutral enough not to leak can still be blind to a real repair.
- **FR3 sits close to its own timeout by construction** — the empty-review fixture plus a
  60-second checking budget. It failed the capture guard in both arms before re-running
  clean, which is symmetric but marginal.
- **A tie is not proof of equivalence.** On several tasks neither build was exercised, and
  the critics said so rather than deciding on something incidental.

## Round 10: three columns, and the first loss since round 5 (v2.2)

**Blind verdict, scored in three columns reported side by side and never added:**

| column | round-10 build | round-9 build | tied |
| --- | --- | --- | --- |
| task | **6** | 1 | 11 |
| self-consistency | 2 | 2 | 14 |
| record-consistency | 3 | 1 | 14 |

`seen only by a cross-cutting column: B 1 · A 1` — one fact for this build and one against
it that a single verdict per task would have missed. That symmetry is the point: a column
that can only add wins is a column that flatters.

### The two losses

**V1 — a false "unverified" on a cooking temperature.** This build printed
`⚠️ 1 measurement (165 °F) in this reply is not backed by the tool output` on a turn whose
own retrieved passages state it **seventeen times**, including
`| Chicken, turkey, and other poultry | … | 165°F (74°C) |`. The other build's identical
warning is a *true* positive — its single lookup genuinely returned no temperature.

The distinguishing fact is the lookup count: **three against one**. The measurement corpus
does not span every lookup in a turn. Demonstrated in this build; **untested in the other**,
which was never handed a multi-lookup turn — the same "untested rather than earned"
distinction round 8's critics insisted on.

A false unverified on a poultry temperature is the most damaging cry-wolf this app can
produce, and round 4 established that a checker crying wolf costs more than the gap it
closes.

**FR3 — the expiry line denies what it displays.**

```
⏱ Checking stopped at its 60s limit. Ran: the code check. Not run: the recomputation.
🧮 Recomputed the stated figures in Python; the reply's numbers were compared against that output.
```

The round-9 build gets the same line right: `Ran: the code check, the recomputation.`

**Neither loss would have been recorded before this round.** Both tasks tied on their own
question; only a column that can take a claim away found them.

### What the round fixed

- **The turn reported itself over while the answer was still arriving.** `composer-idle` was
  keyed on the last byte off the socket rather than the last paint. The still-arriving tail
  was painted below AA on **71 of 73 frames** at the real cadence — not transient, as both a
  critic and I had assumed, because the span is recreated on every paced flush.
- **A failed plan step announced itself with an accessible name byte-identical to a finished
  one.** So did running against pending. Worse than the reported defect, which was that
  "never ran" reached the reader only as a glyph.
- **The app blamed the reader for a budget it had mostly spent.** Of 6,508 tokens against an
  8,192 window, **2,725 were the tool list the app adds** and 2,048 the reply reservation —
  neither on the meter, which read 1,735.

### Two instruments that were wrong about themselves

- **The plan-accessibility check reported 9 failures on its first draft and 128 on its
  second.** It located the block by the role it was adding, so every per-row assertion sat
  behind `if (!found) continue`. *A locator must not be one of the things being located.*
- **The round-10 sweep ran with `main`'s harness, not round 10's.** `textSettledMs`,
  `textGrewAfterTurnEndChars` and `streamEdgeAtTurnEnd` are absent from all 36 `run.json`
  files, so the paint-lag-versus-renderer-loss test this round built was never exercised.
  Both arms used the same harness, so the comparison is unaffected — the improvement is
  simply unmeasured. Caught by a critic reporting it unanswerable rather than inventing a
  reading.

### What this round does not measure

- **`trace/audit.jsonl` exists for only 2 of 18 tasks.** On the rest, tool statuses rest on
  the transcript alone, and record-consistency counted those statements *unsettled* rather
  than agreed — which is why its contested count is 4 of 18 rather than higher.
- **A tie at a low statement count is not equivalence.** VC2's traversal snapshots are
  byte-identical between the runs; several other ties are two screens making four statements
  each and agreeing with themselves.
- **From this round, `docs/head-to-head/verdicts/round-10.json` is the record.** Round 9's
  cross-cutting answers were given on all 18 tasks and written down nowhere.

## Round 11: the narrowest result, and the one I got wrong first (v2.2)

| column | round-11 build | round-10 build | tied |
| --- | --- | --- | --- |
| task | **2** | 0 | 16 |
| self-consistency | 0 | 0 | 18 |
| record-consistency | 0 | 0 | 18 |

Sixteen ties, and on several tasks the critics said outright that the behaviour under test
was never exercised — TTU3's claim check could not run because every search failed, VC1's
token was repeated back by neither model, PT3 never completed a step. **A tie is not
evidence of equivalence and this round is mostly ties.**

### I briefed the round's main task wrongly

Round 10 lost V1 for printing `⚠️ 1 measurement (165 °F) … is not backed by the tool output`
on a turn whose passages state it seventeen times. I briefed the fix as *the measurement
corpus does not span every lookup in a turn*. It spans all of them and always did — handed
all three lookups, the checker returns **no finding at all**:

| corpus | flagged |
| --- | --- |
| **lookup 1 only** | `165 °F` — reproduces the shipped text character for character |
| all three | none |

Lookups two and three were the **correction pass's own** — their queries are the findings
turned into search terms. The 60-second deadline cut the revision off, and the app published
a verdict older than the evidence. So every rung shared it: the invented link, the dangling
citation and the "in no tool output" quotation were all wrong for the same reason. Fixing it
where I pointed would have repaired one symptom of four.

### V1 is recorded twice, and the difference is the protocol's own rule

As reported, V1 took both cross-cutting columns for this build. But the same critic **tied
V1's task column** because the whole delta was one space character the model typed:

```
round-10 arm:  165 °F     flagged
round-11 arm:  165°F      not flagged
passage:       165° F  and  165°F
```

The protocol says a difference that would vanish under identical tokens is not a difference.
Applied uniformly, V1 ties in all three columns — which is how it is scored here.
`verdicts/round-11.json` carries both readings.

### Two builders refused what they were asked

- **Audit exports everywhere.** Declined: the audit records what was *said* and reaches one
  of twenty statement classes, and turning it on for both arms would make the bench measure
  an app configured unlike the shipped one — the fault that silently handicapped a baseline
  arm for three rounds. Built a record from already-public APIs instead. **Settleable
  statements 9 → 55; runs where nothing was settleable 31/36 → 6; no file under `src/`
  touched.** Its enumeration also showed why `record-consistency` had been contested on only
  4 of 18 tasks: *the four contested tasks were not where the app talked most — they were
  where the audit happened to be on.*
- **The obvious harness guard.** Proved it would have **passed** the sweep it exists to stop:
  round 10's checkouts predate any manifest, so both sides would declare nothing and a subset
  test holds trivially. Reads each harness's vocabulary structurally out of its own source
  instead — and found a **fourth** instrumentation field, `streamEdgeClearedMs`, that two
  hand-written lists in this document had been omitting.

### What both builds still get wrong

- **No checking pass reads what the reply says about the application.** A reply stating *"I
  did not call any search or reference lookup tools"* sits directly above three green-ticked
  `reference_lookup` blocks. The ladder checks a reply's claims about the world and never its
  claims about its host.
- **The backing checker matches literally** — it over-warns on `165 °F` against `165° F`, and
  under-warns on `3 to 4 days (whole)` whose only occurrences are ham rows.
- **The unbacked-figures line is capped at five and never says so** (`maxClaims: 5`), while
  its sibling line on the same screen discloses truncation with "and 2 more". Found only
  because this round put the cap into the artifact.
- **`The runtime reported:`** is a label introducing nothing in the collapsed view. Recorded
  in round 6 as probably a capture artifact; it is not.
- **Round 10's own new sentence contradicts the error it quotes** — *"the reply ran to its
  end — it was simply empty"* printed directly above the refusal, in both arms.

### What this round does not measure

- **Both cross-cutting columns came back 0-0-18.** That is either two clean builds or two
  columns with nothing to bite on. The statement counts the critics reported beside each
  verdict are what distinguishes those, and they live in the reports.
- **Round 11's own new sentence may assert more than the app can see.** *"Not even the reply
  headers have come back"* — a critic could not settle it, noting a status chosen by a
  handler that never writes a body is routinely never flushed.
