# Findings worth keeping: pending fold-ins

Part of the [evals index](../evals.md).

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

### Pending fold-in — the question every critic answered and no round counted

Round 9 put two questions to every critic on all eighteen tasks. It scored one of them.

`selfConsistency` was written in round 8's fold-in precisely because a neutral per-task question
had missed a real repair — the app printing that nothing in the library covered the question while
the same screen marked two passages as cited. The question went into the file, every round-9
critic answered it with a statement count and a disagreeing-pair count for both runs, and then it
was folded into the same one-line `WINNER: run-1 | run-2 | tie` as the task's own question. A
build that reduces how often the application contradicts itself while tying the task's question
scores **nothing** — which is the defect the question was added to fix, one layer up.

So the repair is not a better question. It is a **second column**.

#### The scheme

Pass 2 now produces one verdict **per question**, not one per task, and the verdicts aggregate
into columns that are reported side by side:

```
task                A 0 · B 3 · tie 14 · void 1
self-consistency    A 0 · B 1 · tie 15 · void 1 · contested 4/17
record-consistency  A 1 · B 2 · tie 14 · void 1 · contested 6/17 · quiet wins 1
```

**The headline number is the task column, unchanged.** The six dimensions are what the app's own
audit chose; a cross-cutting question is not one of them. A round quoted as a single figure
anywhere is quoted as *the task column*, with that word in front of it.

**The columns are never added together**, for two reasons, and the second is the one that bites.
Summing would let a build that moved nothing any task asks about report a task win. And the
columns are **not independent** — one repair can win two of them, so a sum double-counts a fix and
hides that it did.

Which answers *is a tie on the task question plus a win on consistency a win?* — **no. It is a tie
and a win, which is two facts.** The steelman for merging is real: the round exists to find out
whether the newer build is better, and a build that contradicts itself less often is better.
Nothing is lost by refusing the merge, because the split reports a third figure the merge could
not:

| figure | what it is |
| --- | --- |
| **seen only by a cross-cutting column** | tasks the task column tied or voided where a cross-cutting column named a winner — the class of result rounds 8 and 9 discarded. Reported in **both directions**: a column that can only add wins is a column that flatters. |
| **scored in more than one column** | the overlap. A column whose wins all sit here has restated the task column rather than added to it, and should be retired the way a task that passes on every build should be. |
| **contested** | tasks where at least one run gave the question something to bite on. |

#### The denominator matters, twice

**Which tasks count.** Eighteen is the wrong denominator for what the win/loss/tie line *means*. A
tie on a task where neither run had anything to contradict is not evidence that two builds behave
alike; it is evidence that nothing was in play. Those two are indistinguishable in a win/loss/tie
line and distinguishable in `contested`, so `contested` is reported beside every cross-cutting
column, and a column contested on none of its tasks is read as having measured nothing.

**What each task contributes — and here the obvious argument is half wrong.** The case for this
question being ungameable is that a screen with fewer statements has fewer chances to agree *and*
fewer to disagree. That symmetry protects a **rate**. It does not protect a **count**, and the
count is what a verdict is decided on: fewer statements means fewer pairs means fewer disagreeing
pairs, so printing less does move the score. The fix is not to normalise. A rate is gameable from
the other side — add clean statements and dilute it — and it turns a quotable defect into a
fraction. So the raw count stays the score, the statement count sits beside it unnormalised, and a
win by the run that **said less** is flagged `quiet` and is **still a win**: a build that removed
one half of a contradiction has fewer statements and fewer contradictions and is right to have
won. The flag is for a reader. Nothing decides on it.

#### A third question, and three that were rejected

Round 9's critics volunteered several observations nobody asked them for. The test for whether one
belongs in this family is not whether it is countable — it is whether answering it needs a
standard from **outside the run**. `selfConsistency` needs none: it compares two things the screen
itself says. That is what makes it neutral, and it is the whole of what makes it neutral.

One candidate passes: **the screen against the run's own record.** Same shape, second term moved —
what the application says about this turn, against what the run's own artifacts show the turn did.
No standard imported, fires unconditionally on all eighteen tasks, countable in both directions (a
claim the record contradicts, and something the record shows that the screen never mentions), and
it carries the same say-less guard. It ships as `record-consistency`.

It costs two things, named here rather than discovered later. It **overlaps four task questions**
by construction — V1, V3, TH1 and TH2 each ask this in one narrow domain — which is what the
overlap figure exists to expose. And a win in it is a win for the app's account of itself,
measured against artifacts **no reader ever sees**; it is not evidence the screen is more useful.

The three volunteered ones do not pass, each for its own reason:

| candidate | why not |
| --- | --- |
| internal strings reaching the reader | *internal* is a judgement about audience, not a relation between two observables. Making it countable means handing the critic a list of what counts as internal — which is a value assertion, and the list is drawn from one build's strings, which is a fingerprint. |
| controls offered that cannot work | countable in principle, and not from these captures: the driver activates only the controls a task's `setup` names, so on most of the eighteen the artifacts cannot answer it. Where they can, it **is** V2's question and VC2's. That is two tasks twice, not a cross-cutting column. |
| warnings placed below the thing they correct | reading order is countable; *below is worse* is the value assertion. A correction after one short claim and a correction after three screens of prose are the same fact under that rule and are not the same experience. |

#### Rounds 8 and 9, rescored

Recomputed by `score-round.mjs` from `verdicts/round-8.json` and `verdicts/round-9.json`.
**Rescored, not re-judged** — no capture was re-run and no critic re-read anything.

| | task column | self-consistency | record-consistency |
| --- | --- | --- | --- |
| **round 8** | A 0 · B 2 · tie 16 | **not asked** — one verdict recoverable: **B 1** | not asked, nothing recoverable |
| **round 9** | A 0 · B 3 · tie 14 · void 1 | asked on 18, **unrecorded 18** | not asked — two verdicts recoverable, unattributed: **A 1 · B 1** |

Round 8's one recoverable verdict is the repair the round itself recorded as lost: the older arm
printed a line saying nothing in the library covered the question while the same screen marked two
passages as cited; the newer arm printed the line that reconciles them. One disagreeing pair
against none. Under the scheme it reads *seen only by a cross-cutting column: B 1*, on a task
whose own verdict stays a tie — which is the shape the whole change exists to produce.

Round 9's self-consistency column is the finding, and it is not a good one. **The question was
put, answered on all eighteen tasks, and the answers were not kept.** Round 8's three critic
prompts are in the repository; round 9's critic reports are nowhere in it. The column cannot be
recomputed from a write-up that quotes only the contradictions both builds shared, so its eighteen
entries are `unrecorded` — a verdict the scorer refuses to round into a tie, because a tie is a
measurement and this is the absence of one. From round 10 the verdicts file is the record.

Round 9's `record-consistency` line is the argument for the second column and against over-reading
it at the same time. Round 9 recorded, under *what this round does not measure*, that the older
build lost the tail of an answer where the newer did not, and booked it as an improvement that
scored nothing. Round 10's opening records the same shape **on a different task, in the other
arm**. Under this column that is one win and one loss — a draw, not an unscored improvement.
Rounds 6 through 9 recorded no losses at all; this column would have produced one, and it would
have produced it by taking a claim away rather than adding one.

#### What the scheme cannot see

Both questions are agreement relations. That is what makes them neutral, and it is exactly the
shape of what they are blind to.

- **A screen that is consistently wrong.** A build whose screen agrees with itself and with the
  record about a falsehood scores perfectly in both columns. Neither imports a standard from
  outside the run, by design, and this is the price of that.
- **Presentational inconsistency — including the repair that motivated this work.** Round 9 draws
  one fact in a single token where the older build draws it in two different ramps on one screen.
  Two liveries for one fact are not two statements contradicting each other, and nothing in the
  record says which ink. It scored nothing before and it scores nothing now. Of the two repairs
  round 9 recorded as invisible, this scheme recovers one.
- **Silence.** The volume figure makes a quiet screen visible; it does not penalise one. A reader
  decides, which is a judgement the instrument declines to automate.
- **A turn where nothing was in play.** Both columns inherit the model-dependent trigger round 8
  documented: zero against zero is a tie whether both builds were tested and passed, or neither
  was tested. `contested` shows which. It does not remove the problem.
- **Everything before round 10.** Eight rounds have no per-task cross-cutting counts, so the
  columns cannot be back-filled, and the two rows above are reconstructions from prose — marked as
  such by the scorer on every run that contains one.

#### What was not touched, asserted rather than trusted

`prompt`, `setup` and `mechanicalChecks` are **byte-identical to the previous commit on all
eighteen tasks** — diffed field by field against `HEAD`, not inspected. The self-consistency
question's own wording is byte-identical to what round 9's critics were asked, and is now pinned
in the suite, so ending that series is a deliberate act that fails a test first rather than a
tidy-up that happens quietly.

The one question asked of every task moved from a lone top-level key into `crossCutting`, beside
the second one. `make-critic-tasks.mjs` drops the new block and keeps the old name in its drop
list as a tombstone: reverting to a top-level key puts the question back somewhere the generator
has no opinion about, which is the rename-as-leak this project has now committed twice.

The neutrality guard walks `crossCutting` **structurally** rather than field by field. A
hand-written list of what to guard would have covered the fields that existed the day it was
written — an enumeration narrower than the class it guards, committed inside the guard against
exactly that, which is this document's most-repeated failure. A positive control injects a
fingerprint into the container prose, a question, a measurement step, a weighing rule, and a key
that does not exist yet, and asserts each is caught.

Counts: node **2146 → 2174**, of which 24 are the scorer's and 4 the task set's. Render 25, style
72 and 114, tab-traverse 43, modal-focus 177, markdown 62, transport 24 — all unchanged. Exit 0.

### Pending fold-in — the turn reported itself over while the answer was still arriving

Three independent observations from round 9's recorded runs, in **both** builds, are the same
defect seen from three angles.

> An answer reached the screen as `"Customize based on your household's unique needs (pet"`
> where the model had written `"…(pets, seniors, infants)."` The full text was present in a
> capture taken moments later.

> The same shape on a different task in the other arm: `"…and inspection require"` against
> `"…and inspection requirements."`

> A `stream-edge` span still present **263 ms after** `run.json` recorded
> `"endReason": "composer-idle"`, with the message ~65 characters short — painted at
> `opacity: 0.2`, which a critic measured at **1.49:1**.

Round 9's streaming work was right about the problem it named: a tail that lands in one jump
reads worse than one that flows. What it shipped was a paced display cursor, a post-paint follow
scroll, and a fade on the newest word. Nothing here removes any of that. What it did not do is
tell the rest of the app that painting takes time.

#### `composer-idle` was keyed on the last byte, not the last paint

`composer-idle` is the harness's name for the frame the composer stops carrying `.composer-live`,
which is `store.streaming` going false, which is the `finally` of `executeTargets`. Upstream of
it, `runTurn`'s own `finally` called `tail.finish()` — and v2.1's `finish()` set an `ended` flag,
requested a frame, and **returned**. The drain it started ran on afterwards with nobody waiting
for it. So the app released the composer, turned Stop back into Send, and unlocked the finished
reply's action row while up to `CATCH_UP_SNAP_CHARS` of the answer were still queued to draw.

Nothing about that is a race the reader wins. Every artifact taken at turn end — a screenshot, an
`innerText` read, a `Copy` click — samples a half-painted answer, and pressing Send lands a new
message on a turn that is still writing the last one.

`finish()` is now awaitable and resolves on the last publish, and both call sites await it. The
turn ends when the answer is on screen.

**The drain needed a deadline, not just a waiter.** While tokens are arriving the glide is
time-free: it takes a fraction of the backlog per frame and the stream keeps refilling it. Once
the stream stops there is nothing left to smooth against, and that same fraction becomes an
open-ended typewriter — measured, a 65-character backlog took ~560 ms, and 1,200 characters would
have taken ~1.3 s with the composer held throughout. The post-end drain is therefore keyed to a
clock: each frame moves the share of the backlog that fits in the frames left before
`TAIL_DRAIN_MS`, so the last character lands on the deadline whether five characters are
outstanding or twelve hundred. 0.4 s, which is exactly one `.stream-edge` fade.

**What Stop means while the tail is still painting.** It means stop. `finish(immediate)` publishes
the remainder in one flush and resolves at once — a user who pressed Stop asked for the turn to be
over, not to watch the rest of it type itself out. Every character that had streamed is still
kept, which is what makes it Stop and not Discard.

#### The 0.2 was not a fade the reader passes through — it is where the word rests

The comment on `fadeStreamEdge` says the remount is deliberate: *the leading edge of the text
holds soft for as long as it is the leading edge.* That is exactly what it does, and it is the
defect. The flush cadence is `TAIL_FLUSH_MS` = 33 ms and the span is recreated on every flush, so
the animation restarts roughly every 33 ms — while the fade needs **149 ms** to climb out of the
sub-AA band on the light panel. The leading word never once reaches legibility.

Measured in Chromium at the real cadence, 1.2 s of sampling per theme:

| | opacity range | contrast range | frames below AA |
| --- | --- | --- | --- |
| light, remounted every 33 ms | 0.20–0.31 (mean 0.249) | **1.49–1.89:1** (mean 1.84) | **71 of 73** |
| dark, remounted every 33 ms | 0.20–0.31 (mean 0.247) | **1.73–2.11:1** (mean 2.26) | **71 of 73** |
| light, mounted once and left alone | 0.20 → 1 over 0.4 s | 1.49 → 14.98:1 | 8 of 37 (first 149 ms) |
| dark, mounted once and left alone | 0.20 → 1 over 0.4 s | 1.73 → 17.53:1 | 5 of 37 (first 99 ms) |

So the question "is this transient?" has a number attached, and the answer is no on both
readings. Under the cadence the app actually runs, 97% of frames are below AA and the word rests
there. And even the un-restarted curve — the one the CSS describes — spends its first 149 ms
illegible, on *every word of every reply*, which is not a fade nobody can catch.

The word left illegible in the recorded capture was `"safe"`, in an answer about food safety.

**The floor is measured, not chosen.** Sweeping opacity against the composited reply surface:
light theme is the binding one in both directions, because dimming dark ink toward a white panel
loses contrast faster than dimming light ink toward a black one.

| floor | light | dark |
| --- | --- | --- |
| 0.20 (shipped) | **1.49:1** | **1.73:1** |
| 0.60 | 4.13:1 | 6.65:1 |
| 0.63 | 4.53:1 | 7.24:1 |
| **0.66 (chosen)** | **4.97:1** | **7.87:1** |
| 1.00 (no fade) | 14.98:1 | 17.53:1 |

0.63 is where the light panel first clears AA; 0.66 is the same measurement with margin. The fade
survives — 0.66 → 1 still visibly softens the newest word — and it also shrinks the step that word
takes when the stream moves past it and the span disappears: 0.73 → 1 rather than 0.31 → 1.

#### This defect was also an instrument fault

Round 7 added `reply.md` — the raw markdown beside the rendered text — so a blind critic could
detect the renderer deleting characters. It found two real defects that way. But `reply.txt` is
`innerText`, read at turn end, and turn end was the last byte: a paint lag counterfeits exactly
the signature of a renderer loss. The comparison had acquired a **false-positive mode** — "the
renderer dropped 65 characters" about a renderer that dropped none.

`scripts/h2h-capture.ts` now does **both** available repairs, and doing only one would have been
wrong either way:

- **Settle before reading.** After turn end, poll the assistant's rendered prose length until it
  has been unchanged for 100 ms *and* no `.stream-edge` span remains, then let two frames pass so
  the last mutation is actually on screen. Polled on a timer rather than on rAF, and the paint
  wait raced against a timeout, because frames stop in an occluded window and the whole wait
  would hang there; bounded at 2.5 s either way. This works against **any** build, which is the
  case that matters: a critic compares two arms and only one of them is ours.
- **Record what the wait cost.** `textSettledMs`, `textGrewAfterTurnEndChars`,
  `streamEdgeAtTurnEnd` and `streamEdgeClearedMs` land in every `turns[]` entry, and a non-zero
  growth raises a note in plain words. Settling alone would have quietly absorbed the very defect
  the instrument exists to expose — the harness would have started hiding a product fault it was
  built to reveal, which is a worse failure than the false positive it was fixing.

The two together give a critic a decision procedure it did not have: a shortfall against
`reply.md` with `textGrewAfterTurnEndChars` at 0 is a real loss; above 0, the build released its
composer mid-paint and that is the finding.

#### Measured, in `test/streamingTail.test.ts` and `test/chromeContrastCheck.ts`

The contrast row is composited in a real offscreen window over the surfaces the app actually
stacks, in both themes. The floor is **scraped out of the `@keyframes` block**, never restated in
the test — the same rule as `PICK`, and for the same reason: this file has twice certified ink it
never rendered because a probe stopped resolving and measured something else in silence. The
fixture disables every animation, so the scraped floor is applied inline; without that the probe
would render at full ink and pass while saying nothing.

| True positive | Before | After |
| --- | --- | --- |
| `finish()` resolves only once the whole reply has been published | resolves immediately, reply short | resolves on the last publish |
| the last word is on screen when the turn ends | `…keep them` | `…keep them safe` |
| the drain lands inside its deadline at 40 / 400 / 4,000 chars | unbounded (~1.3 s at 1,200) | ≤ `TAIL_DRAIN_MS` at every size |
| a usurped tail still resolves its waiter | never resolves — an awaited `finish()` would hang the turn | resolves |
| `finish()` resolves with frames stopped (occlusion) | — | resolves off the chunk-flush path |
| light: streaming tail edge clears AA | **1.49:1** | **4.97:1** |
| dark: streaming tail edge clears AA | **1.73:1** | **7.87:1** |

**The true negatives, which are the point.** The animation must still animate; every check above
is satisfiable by deleting it.

| True negative | Measured |
| --- | --- |
| A finished tail is still published in more than one step | ≥ 3 publishes for a 600-char backlog; fails when the glide is replaced by a snap |
| The publishes are monotonic and never overrun the buffer | max published length ≤ buffer length |
| The first publish of a burst is a fraction of it | < 400 of 400 chars |
| The newest word still arrives softer than settled ink | fails at `from { opacity: 1 }` — "the fade does nothing" |
| The fade is still an animation, not a static dimmer | `.stream-edge` still declares `animation: stream-edge-in <duration>` |
| Stop does not cost the user text that already arrived | 2,000 of 2,000 chars kept, and it does not wait out the drain deadline |

Every row above was confirmed by mutation — reverting `finish()` to fire-and-forget fails 5 of the
9 transport cases and none of the negatives; replacing the glide with a snap fails exactly the
negative and none of the positives; setting the floor back to 0.2 reproduces 1.49:1 / 1.73:1;
setting it to 1 fails the "still fades" negative alone. A check that cannot be made to fail on
demand is not yet known to be a check.

#### What this does not measure

The paint settle is verified against the app's own DOM, not against a second renderer. And the
0.4 s drain deadline is a design choice measured for boundedness, not for taste: nothing here
establishes that 0.4 s is the *right* length for a tail to land in, only that it is a length, that
it is one `.stream-edge` fade, and that the composer is held for exactly as long as text is still
appearing and not a frame longer.

### Pending fold-in — the plan block said nothing to anyone who could not see it

A blind critic, reading round 9's captures of the cancelled and stopped plan blocks in **both**
builds:

> the plan block carries no accessible names at all — `snapshots/plan-after-cancel.html` yields
> `aria-label: []`, `role: []`, `title: []` in both runs. The cancelled state is conveyed entirely
> by glyph, strikethrough and colour class; a screen-reader user gets the step text and the words
> "never ran" but no programmatic state on the row, and the disabled step buttons expose no name.

The finding is right and the instrument is wrong, in a way worth recording before the fix. Scraping
`aria-label`/`role`/`title` off a captured snapshot cannot see what a browser **computes**: an
`<ol>` is already a `list` with `listitem` children and no `role=` written anywhere, so the critic's
reading understated one thing. And it cannot see what a browser computes *wrongly* — which is where
the real damage was. So this round's check boots the shipped build, attaches CDP to the live window
and reads `Accessibility.getFullAXTree`. Every figure below is out of that tree.

#### What the tree actually said

| step state | status column | the row itself |
| --- | --- | --- |
| done | `StaticText "✓"` | `button "1. Step 1 detail 1 Tools — none planned… ▸"` |
| failed | `StaticText "✗"` | `button "2. Step 2 detail 2 Tools — none planned… ▸"` |
| running | `StaticText "◌"` | `button "2. Step 2 detail 2 Tools — none planned…"` `[disabled]` |
| pending | `StaticText "○"` | `button "3. Step 3 detail 3 Tools — none planned…"` `[disabled]` |
| stopped | `StaticText "■"` | `button "2. Step 2stopped here detail 2 …"` `[disabled]` |
| skipped | `StaticText "–"` | `button "1. Step 1never ran detail 1 …"` `[disabled]` |

**A step that failed and a step that succeeded had byte-identical accessible names.** So did a step
still running and a step not yet started. The whole of the difference was a bare glyph parked
outside the row — `✓` against `✗`, `◌` against `○` — announced as a symbol name or as nothing, plus
a colour class. That is strictly worse than the reported defect: "never ran" at least reaches the
reader in words, and a failed step reached them as a success.

Three more, from the same tree. Twelve of the sixteen rows were `<button disabled>` — a control
that was never a control, announcing "dimmed, unavailable" for a checklist entry nobody was ever
meant to press. Every disclosure the block had fought for across four rounds — the tool forecast, the
unrun-forecast note, the ⚠️ undisclosed-run warning — was **inside** that button, and so was
swallowed into its name and arrived as one run-on breath with no structure and nowhere to stop:

> `"1. Step 1🔧 1 tool call detail 1 Tools — may use: web_search Forecast web_search, which this
> step never ran. ⚠️ Ran calculator, which this step did not disclose. ▸"`

And the block had no name, no boundary and no live region: nothing announced that a plan had ended.

#### The four judgement calls

**Text where text will do; ARIA only to associate text that already exists.** The block's name is
`aria-labelledby` pointing at the header the sighted reader already gets, never a hand-written
`aria-label` — so the two cannot drift, and the count can never be announced without the outcome
that qualifies it. `group name="Plan — 1/4 steps done stopped by you"`, and for a diverged run
`"Plan — 1/3 steps done · 1 of 3 steps diverged from its forecast failed"`. `group`, not `region`:
a conversation can hold many plans and a landmark apiece would bury the document's real ones.

**The state goes on the glyph, as `role="img"` + `aria-label`.** That pair is what a meaningful icon
takes; it needs no hidden span and no CSS, and it puts the state **first** in the row's reading
order, which is the order a checklist is scanned in. Every status is labelled, with no exception for
the two that already carry a visible note — so a reader of a skipped row hears "never ran" twice.
That echo is the deliberate price of a rule with no hole in it. This project's oldest defect is the
enumeration that stops covering its class; three words of repetition is a cheaper failure than a
silent row.

**A dead row stops being a control.** `disabled` says "you cannot press this *yet*"; the truth was
that there was nothing to press. Rows render a `<button aria-expanded>` only when they have
something to open, and are plain text otherwise. A cancelled plan now renders no `<button>` at all.

**The prose moves out of the button, and `aria-describedby` is not the answer.** Text inside a
control is swallowed into that control's name; text beside it is read in document order anyway. So
the honest structure is not more ARIA, it is less markup — the button wraps the step's identity
only, and the four prose lines sit under it as prose. They become separately navigable, the ⚠️ line
can be stopped on, and as a side effect they become selectable with a mouse, which text in a button
is not. The cost is a smaller click target for expanding a row, taken deliberately.

**One live region, and only one.** `role="status" aria-live="polite" aria-atomic="true"` on the
header's status word — which is now a single element that always exists and swaps its contents,
because a region *created* when the plan ends announces nothing. Scoped to the status word alone:
a plan that runs rewrites its rows and its count continuously, and making those live would narrate
the entire run and teach the reader to tune it out. What they cannot discover by browsing, and must
know, is when control comes back. So it speaks two or three times in a plan's life — "awaiting
approval", "running", "cancelled — nothing ran" — and the steps stay silent and browsable.

#### What a screen reader now gets when a plan is cancelled

Entering the block: *"Plan — 0/3 steps done cancelled — nothing ran, group"*. The status region
announces *"cancelled — nothing ran"* on its own when the cancel lands. Then a list of three items,
each read as *"Never ran, image. 1. Step 1 never ran. detail 1. Tools — none planned; this step
reasons only."* No controls anywhere in the block.

#### The cases

`test/planAccessibilityCheck.ts` — 169 checks on this tree, read from the computed accessibility
tree of the shipped build across five seeded plans covering all six statuses, three outcomes and
two live states:

| | case | verdict |
| --- | --- | --- |
| **TP** | a running step against a queued one | `image "Running"` vs `image "Queued"` |
| **TP** | a failed step against a done one | `image "Failed"` vs `image "Done"` |
| **TP** | all six statuses, pairwise | six distinct names, no collisions |
| **TP** | an ended plan's group name | carries the count *and* the outcome |
| **TP** | a row with output or calls | `button` with `expanded=false` |
| **TP** | the unrun and undisclosed lines | each its own text node outside any control |
| **TN** | a plan still running | its name contains none of the four terminal words |
| **TN** | a row with nothing to open | exposes no control at all — not a disabled one |
| **TN** | any row, any fixture | zero controls announce themselves as disabled |
| **TN** | a control's name | contains no `detail N`, no `Tools —`, no `▸`/`▾`/`🔧`/`▶` |
| **TN** | the run control | offered on the awaiting plan and on no other |
| **TN** | a plan whose forecast held | says neither "never ran." nor "did not disclose" |
| **TN** | live regions per block | exactly one — not zero, and not the whole block |
| **TN** | the live region's text | never contains `steps done` |

The negatives are what stop the positives being bought cheaply: a build that labels every row
"step" passes "every row has a name", and one that marks the whole block `aria-live` passes "the
outcome is announced" while being unusable.

A check scoped to the rows found the rows. Widening the glyph rule to **every** control in the
block immediately turned up one more the row scope could never have seen: the approval footer named
itself `"▶ Run this plan"` — announced as "black right-pointing triangle, Run this plan", the same
defect as the wrench, one element over, on the one control in the block that authorises execution.
Fixed with it, and the assertion now runs over every control rather than over the rows that
happened to be looked at.

`test/planBlock.test.ts` gains 22 markup-level cases for the facts markup alone decides, with the
tree left as the authority — including the true negative that the prose assertions are not passing
because the lines were dropped (`detail 1` and `Tools —` must still be present in the row).

#### The check that would have flattered itself

Its first draft found the block in the tree as `role=group` with a name starting `"Plan — "`, which
is elegant and wrong. Run against the pre-fix build it reported **9 failures**; the real number was
**128**. The block was not a named group *yet*, so every per-row assertion sat behind
`if (!found) continue` and was never evaluated — one broken property masking every other
measurement, which is this project's oldest recurring defect arriving inside the check written to
close it. **A locator must not be one of the things being located.** The block is now anchored by
DOM identity, and the naming is measured as one assertion among many.

That mutation is also the proof the check is a check. Against the parent commit — same check, same
fixtures, `out/` rebuilt from the pre-fix sources — **128 of 163 fail**, spread across every
category in the table: 16 rows whose prose is unreadable as text, 16 controls named for the whole
row, 12 rows dressed as controls with nothing to open, 16 unlabelled status glyphs, 5 blocks with
no group name, 5 with no live region. The two runs execute slightly different numbers of checks —
a passing build has fewer controls to interrogate and a live region to interrogate instead — which
is why the totals are not equal on both sides.

### Pending fold-in — three checks that judged the wrong thing

All three were found by blind critics reading round 9's captures, all three were in **both**
builds, and all three share a shape: the check ran, produced a sentence, and the sentence was
about something adjacent to what it had measured.

#### A quotation checker that read the credit line as part of the quotation

Task TH3. The reply blockquoted a pack line and signed it, which is what a model does when it is
asked to quote *and* attribute in one breath:

```
> "Cold air must circulate around refrigerated foods to keep them properly chilled." [7] — FDA, Refrigerator thermometers — cold facts
```

The sentence inside the marks is word for word in
`packs/food-safety/docs/refrigerator-thermometers.md`. The straight-quote pattern matched it and
passed it. The blockquote pattern then bounded the *same claim* by the line instead — sweeping in
the closing mark, the marker and the signature — matched nothing, and printed

> ⚠️ Quoted as exact but in no tool output this turn: “…foods to keep them properly
> chilled.⟪" [7] — FDA,⟫ Refrigerator thermometers — cold…”. ⟪⟫ marks where it stops matching the
> source.

The `⟪⟫` marker was **right**: that is exactly where matching stopped, and everything inside it is
the quoter's own furniture. The headline over it was wrong. A critic put it precisely: the app
"told a reader that a quotation which is in fact verbatim inside its quote marks appears in no
tool output".

The same design was blind in the other direction. Change `FDA, Refrigerator thermometers — cold
facts` to `USDA, Cold Food Storage Chart` — a real document, retrieved as `[5]`, and not the one
`[7]` points at — and round 10 said the same thing again, because the divergence is still just the
tail:

> ⚠️ Quoted as exact but in no tool output this turn: “…refrigerated foods to keep them properly
> chilled.⟪" [7] — USDA,⟫ Cold Food Storage Chart”.

Two different failures, one sentence, and it is the wrong sentence for both. Neither build
separated "the words are invented" from "the credit line is glued on".

**The rule, and it was already written in this file.** The fold that will not delete a quotation
mark says why: `"when in doubt", throw it out` and `"when in doubt, throw it out"` are different
claims about where the source's sentence ended. **The marks are where the verbatim claim starts
and stops.** So a blockquote carrying a quotation of citation length is that quotation — already
collected at the marks — and a blockquote carrying none is still bounded by its line, with its
signature trimmed off the end the way v1.15 already trims a bare `[7]`.

v1.15 trimming *the marker* and stopping there is round 5's recurring shape once more: an
enumeration of the furniture seen so far, defeated by the next piece. Three gates keep the trim
from eating source text — the dash opens the line or is spaced, the tail ends the line, and it
passes the same `looksLikeTitle` the attribution rung uses. That last one is what keeps a recorded
true positive alive: the stitched `Ground meats, such as beef and pork — 160°F` has one word after
its dash and no capital, so nothing is trimmed and the invented join is still reported.

The other half is a fourth attribution shape. `[7] — FDA, …` puts the marker mid-line with the
document after a dash, and none of the three existing patterns could see it: two want the title in
parentheses and the third wants the marker to open the line. So the turn that stopped crying wolf
about a correct signature would still have said nothing at all about a wrong one.

| | round 10 | now |
| --- | --- | --- |
| verbatim, right credit | ⚠️ Quoted as exact but in no tool output this turn: “…chilled.⟪" [7] — FDA,⟫ Refrigerator thermometers — cold…” | *no badge at all* |
| verbatim, **wrong** credit | the same quotation warning, ⟪⟫ around `" [7] — USDA,` | ⚠️ [7] USDA, Cold Food Storage Chart — that passage came from a different document than the one named here. |
| **words changed**, right credit | the true finding **plus** a second, duplicate one carrying the signature | ⚠️ Quoted as exact but in no tool output this turn: “Cold air must circulate around refrigerated foods to keep them p⟪erfectly⟫ chilled.” |
| no marks at all, same credit | ⚠️ … “…properly chilled. ⟪[7] — FDA,⟫ Refrigerator thermometers — cold facts” | *no badge at all* |

What it gives up is a miss, not a false alarm: an invented gloss written *outside* the marks
inside a blockquote is no longer read as quoted. It was never presented as quoted, every other
rung still reads it, and round 4 settled which of the two errors costs more.

#### Nothing checked the reply's account of how MANY times a tool ran

Task TH1 — the task whose prompt is, in as many words, *"tell me exactly which tools you used to
get that and what each one gave back"*. The reply answered with a table giving `reference_lookup`
two rows, each with its own query and its own results. One call ran. The transcript holds one tool
block and `trace/audit.jsonl` holds one entry, so the screen knew the true number the whole time
and offered the reader no signal at all.

Every rung there was stops at identity. `unrunToolClaims` asks whether a *named* tool ran — it
did. `undisclosedToolRuns` asks whether the account names the calls that ran — it does. v1.17's
rung asks whether the *arguments* are the ones that went, and reads the two stated queries against
the one that went, so whichever row quotes the real query clears itself and the other reads as one
unmatched string rather than as a call that never happened. **None of them counts.**

A count is the same species as an argument and it is read the same way. Two rows say two
retrievals happened, so a reader takes the second row's passages as evidence the first did not
have, and takes the coverage of the question to be twice what it was.

> **before** ⚠️ This reply states an argument the call never received: query: “ground beef
> doneness” — the call sent “ground beef safe internal temperature”.
>
> **after** ⚠️ This reply's account of its own tool use claims more calls than the turn made:
> reference_lookup: 2 calls accounted for, 1 ran.
> ⚠️ This reply states an argument the call never received: query: “ground beef doneness” — the
> call sent “ground beef safe internal temperature”.

Two readings of "how many" are taken and the larger reported: the entries the account lays out in
rows, and the number it states outright (`2 calls to reference_lookup`, `two reference_lookup
lookups`). Three bounds keep it quiet, and each is the lenient direction:

- **Only overstatement speaks.** An account listing *fewer* entries than the turn ran is a gap in a
  disclosure — `undisclosedToolRuns`' territory, and that check deliberately stays quiet unless a
  section names *none* of the calls. Claiming work that did not happen is the direction that
  misleads, and it is the measured one.
- **One line is one entry**, however many times it says the name, so a row naming the tool in its
  "Tool" cell and again in its notes cannot invent a call out of the reply's own prose.
- **Only the first unbroken run of entry lines** after the disclosure heading is counted.
  `undisclosedToolRuns` takes the section as the whole rest of the answer, which is right for
  asking whether a name appears anywhere and wrong for counting — prose further down mentioning
  the tool twice more would otherwise become two more calls.

The noun is the gate on the spoken form: `3 reference_lookup passages` is a count of something
else and produces nothing. A tool that never ran produces nothing either — that is
`unrunToolClaims`' finding, not a miscount.

#### A quantity from the wrong row of a cited table — and why this app must not say so

The critics, on V1 and V3: *"Both screens report only literal string presence, not aptness. One
run's `3 to 5 days` and `1 week` are drawn from the **ham** rows of the cold-storage table, and
the other's `3 to 4 days` from `Fresh, uncured, cooked` — the chicken rows in the same passage
read `| Chicken or turkey, whole | 1 to 2 days |`. Neither app flagged a quantity taken from the
wrong row of a cited table."*

The observation is right. The check it asks for cannot be built honestly here, and this is the
second time in two rounds that the honest answer to a good critique is a narrower one — round 9's
only refusal-shaped win was `describeCoverage`, for the same reason.

**The app does not know which row the model read, and neither did the critic.** `3 to 4 days`
occurs in **eleven** rows of `packs/food-safety/docs/cold-food-storage-chart.md` — salads, cooked
ham, canned ham, egg substitutes, casseroles, two kinds of pie, soups and stews, leftovers,
chicken nuggets, pizza. A value repeated down a column has no unique provenance. Naming one row as
its source is a guess dressed as a measurement, in the one place a reader cannot check it.

**On the critic's own example the guess points the wrong way.** The question was how long cooked
chicken keeps in the fridge. The row that answers it is
`| Leftovers | Cooked meat or poultry | 3 to 4 days |`. So `3 to 4 days` is *correct*, and a rung
built to this specification would have fired on a right answer while attributing it to a ham. A
checker whose findings land on correct answers is worse than no checker; this file has paid for
that twice — round 4's stricter quote checker, and `quantityCoverage`'s own first version, whose
only two findings on the quantitative suite were both against answers scored CORRECT.

**And deciding it requires understanding the question.** To know that "cooked chicken in the
fridge" is the leftovers row and not the fresh-poultry row is to have comprehended the sentence —
the exact assertion `describeCoverage` refuses to make, for the exact reason set out there.

So: the smaller true thing. Say where a supported measurement was actually matched — which
numbered passage, and on how many of that passage's lines — and say plainly that the match was by
value and not by row.

> **before** ⚠️ 1 measurement (180 °F) in this reply is not backed by the tool output.
>
> **after** ⚠️ 1 measurement (180 °F) in this reply is not backed by the tool output.
> Matched by value, not by row: 4 days — [5], 3 lines. Where a value is stated on more than one
> line, only the passage itself shows which one the answer took it from.

That asserts exactly what was measured: this value occurs *here*. A figure matched on one line is
located. A figure matched on eleven is disclosed as ambiguous — which is the honest form of the
critic's finding, and the fact a reader needs in order to go and look at the rows themselves.

Two limits, stated rather than left to be discovered. Derivation does not count as a location: an
integer multiple of a corpus value can *explain* a figure but it is not a place the figure
appears, and this line's whole claim is that the reader will find the value there. And the line
rides an existing badge, exactly as `describeCoverage` does and for the same reason — a permanent
provenance line under every reply that mentions a duration is round 4's cry-wolf in a quieter ink.
Its failure mode is that it can never tell a reader a figure is *wrong*. It can only tell them
where to look, and how many places there are to look at.

#### Found while building the second: a correct quotation of a query, faulted

The count rung's own true negative turned one up. An honest two-row account — two calls, two rows,
each quoting the query that really went — drew this from **both** builds:

> ⚠️ Quoted as exact but in no tool output this turn: “ground beef ⟪safe⟫ internal temperature”.

A quotation is checked against what the tools **returned**, never what they were sent (a model
that passes its invention to a lookup as the query would otherwise find it quoted back into the
corpus and certified). So a reply quoting its own narrow query correctly has quoted a string the
corpus cannot contain. v1.17 saw this coming and wrote the rule down — *"quoted as exact but in no
tool output" is the wrong accusation against a query string* — but implemented the yield against
the **misstated** arguments only. Getting the query *right* therefore kept the wrong warning, and
there was no argument finding to replace it.

What makes the accusation wrong is the **shape** of the claim, not whether the claim is true. The
yield now runs against every stated argument. The hole the corpus rule exists to close stays
closed: a `param: "value"` context beside a call is what makes a span a stated argument, and an
invented line the model passed as its query and then blockquoted as a source is not written in
that shape — it is still a quotation claim, and still faulted.

#### What this does not fix

- **A query in a table *column* rather than beside its parameter name.** `| reference_lookup |
  "ground beef safe internal temperature" | …` under a `Query` header states an argument, and the
  argument rung cannot see it — the parameter name has to be adjacent to the value, and here it is
  a header row away. So that shape still draws the quotation warning above. It is the same
  vocabulary problem round 5 describes, one table cell further out, and closing it means reading
  markdown tables rather than matching a name beside a string.
- **Which row.** Stated above, deliberately, and it is not a gap this app can close.
### Pending fold-in — the app blamed the wrong party, and offered a control that could not work

Four findings from round 9, all present in both builds, and all one defect: **the app stating as
its own finding something it had not established.** The failure boundary (`src/shared/failure.ts`)
already refused to print a machine identifier where a sentence belongs. These are the same species
one level up — true sentences about the wrong party.

#### 1. Three events, one sentence, and it named the model in two of them

> ⚠️ Empty reply — nothing came back from the model. Use ↻ Regenerate to ask again.

That string was a constant, and it stood over a server that had accepted the POST, written nothing
for 90 s, and been stopped by the user. A critic: *"the post-stop message then blames the model for
what the fixture record shows was a transport stall"*, and *"it says neither 'the server stopped
responding' nor 'you stopped it'"*.

Every fact needed to name the right party passed through `streamChat` and was discarded at the
return statement — and on the measured case it never reached the return at all, because a user
abort leaves that function by the throw. The transport now fills in a caller-owned record
(`StreamWitness`) that survives the abort, and `explainEmptyReply` reads it:

| what the transport saw | what the reader is told |
| --- | --- |
| body arrived, no text in it | `The model produced no text. LM Studio answered and the reply ran to its end — it was simply empty.` |
| headers arrived, no body byte ever | `LM Studio accepted the request and closed the connection without sending a reply. Nothing was generated — this is not a short answer, it is no answer.` |
| the above, then Stop, after 90 s | `You stopped this turn. LM Studio had accepted the request and then sent nothing at all for 90s — the reply never started, so the model had produced nothing to stop.` |

The discriminating pair is one layer apart on purpose. **Headers arriving** means the server took
the request; **a body byte arriving** means a reply had begun. `accepted && !streamed` is the
server's silence however the turn ended; `streamed` with no text is the model's.

> Both halves of that paragraph were later measured wrong, and the first row above with them. `accepted`
> is not headers arriving — it is the transport's `fetch` resolving — and `streamed` says a reply
> *began*, never that one *finished*. See *two repairs that each shipped the defect they repaired*.

The first row is the true negative, and it is the one that decides whether any of this was worth
doing: a model that genuinely replies with nothing must still be told it replied with nothing. A
turn with no observation at all — a message stored before this shipped — gets rule 3's treatment
and says the app has no record of how it ended, rather than picking a party.

No control is offered on any of the three, and that is a finding rather than an omission. Round 8's
rule is that a control is rendered where the app has *proved* the remedy is right; here the app has
proved the opposite — the server accepted the request, so the address under Settings → Connection is
correct, and a button sending the reader there would send them to fix a working setting. The remedy
that is real (reload the model) lives in another application, so it is prose.

#### 2. Which was lying — the overflow message or the meter?

On a context refusal the app said:

> This conversation — with its attachments and notes — is larger than the context the model is
> loaded with. **Load the model with a larger context in LM Studio, or attach less.**

with a composer meter six inches below reading `~1.7K / 8.2K`. Both cannot be right. **The message
was the liar**, and not by a little: it converted "LM Studio said something containing the word
*context*" into a confident claim about the reader's conversation. Measured on the shipped tool
table and a six-turn conversation on an 8192 window:

| term | tokens | on the old meter? |
| --- | --- | --- |
| the tool list (6 priciest of 25 enabled) | **2,725** | no |
| room reserved for the reply | **2,048** | no |
| the conversation | 1,728 | yes |
| the role's instructions | 7 | yes |
| **total** | **6,508** of 8,192 | old meter showed **1,735** |

So the conversation is a fifth of the window and the message blamed it; the largest single term is
the tool list the **app** adds, and the remedy told the reader to *attach less* — sending them to
shrink a fifth of a fifth of the problem. Meanwhile the meter was not false about what it measured;
its *claim* was false, because "of 8.2K tokens used" invites the reader to conclude 6.5K are free,
and 4,773 of those were already spent by the app itself.

The repair is one arithmetic with three readers — the meter, the refusal sentence, and the gate on
Regenerate — so the app can no longer contradict itself in two places on one screen. The sentence
now reports agreement or disagreement rather than repeating the claim:

- app's count agrees → `…and the app's own count agrees: a turn in this conversation costs about 9K
  tokens against a 8.2K window. The largest part of it is the tool list, at about 2.7K tokens.`
- app's count disagrees (the measured case) → `…but the app's own count does not agree: … One of the
  two is wrong. The app's count is estimated from text length rather than tokenized, and a model can
  be loaded with less context than it reports.`
- no measurement → `The app has no measurement of this request to check that against, so it cannot
  say what is too large.`

The remedy names whichever term is actually largest and carries the control for it
(`Settings → Tools`) — the round-8 ClaimCheckBlock rule, applied to a different failure. The half of
the remedy the app cannot perform (loading a model in LM Studio) stays prose, because it is real.

**The meter's tool figure is an upper bound**, deliberately: the turn picks `TURN_TOOL_CAP` tools by
embedding rank against text the reader has not written yet, so *which* six is unknowable, but the
cost of the priciest six is exact. `contextBudget.ts` already errs this way on purpose for images —
under-counting overflows the window, over-counting drops one more old message than it had to.

#### 3. A retry that cannot succeed is worse than no retry

*"the one control that is offered would replay the same oversized conversation into the same
8192-token window."* ↻ Regenerate is now disabled — with its reason on screen, not only in a title —
exactly where the app can prove it would fail, and live everywhere else. The symmetry with round 8
is the point: **a control is rendered where the remedy is proved right, and disabled where the
action is proved futile.** Both need the proof.

The proof is harder than it first looks, and getting it wrong would have reproduced the round-9
defect one control further along. `used > total` is **not** futility: the turn compacts, and
`planHistory` summarizes the front of a conversation until the request fits. Blocking a retry that
compaction would have handled is the same false accusation in a new place. The only unfittable
request is one whose *newest* message alone is over the window — `planHistory` keeps the newest
however large — and that one stays unfittable however many times it is retried. Two true negatives
guard it: a 40-message conversation four times the window is **not** blocked, and neither is a
conversation on a model that never reported a window size, because "we cannot measure it" is not
evidence that it would fail.

Because the gate is live rather than a snapshot of the failed turn, turning a tool off re-enables
the button by itself.

#### 4. A reviewer that returned an empty 200 was not a failure anywhere

`run.json` recorded `"errorCount": 0, "errors": []` on a turn whose reviewer request was answered
with an immediately-closed empty stream. The screen was honest — `⚠️ Not deliberated — Researcher
returned nothing` — but it was **re-deriving** that from an empty `review` string, while the record
beside it said `status: 'done'`. Nothing that reads the record could learn what the screen knew.

- The record now distinguishes `'unreviewed'` (returned without reviewing) from `'done'`, and both
  it and `'error'` mean the draft was not checked. `draftWentUnchecked` is the single predicate,
  and it still consults `review` so records written before the status existed read correctly.
- The audit log said `(nothing came back)`, which reads as an output that happened to be empty. It
  now says `FAILED: the review request returned an empty reply; the draft was not checked.`
- The disclosure said *"Run Think harder again, or use 2nd opinion"* — a remedy in prose whose
  control the app was hiding. `🧠 Think harder` was gated on `!message.deliberation`, so a pass that
  failed took its own retry away with it. It returns as **🧠 Think harder again** whenever the draft
  went unchecked, and only then.

True negatives beside each: a real review — all-clear or with problems — is not a failure, and a
pass still running is not yet one.

#### One escape hatch, and why it is narrow

`ExplainedError` exists so a reading is made once and travels, because re-reading our own prose is
how a translation layer starts lying. But the transport reads LM Studio's error frame before the
turn's arithmetic exists anywhere in scope, so the one reading that most needs a number was always
made without one. The error now carries its raw ingredients, and a caller may ask for the reading
again under exactly one condition: **the same raw text, once, and only when it supplies a
measurement the first reading lacked.** The caller's subject and source are deliberately *not*
merged — the first reading knew who wrote the text, and letting an outer layer overwrite that is how
a relayed message quietly becomes ours.

### Pending fold-in — two silences and a decision, each attributed to nobody

Two findings from round 11's blind critics, and one defect between them: **the app knew who did
what and printed a sentence that did not say.** Round 10 built the machinery for exactly this —
`StreamWitness` in `hooks/chatTransport.ts` records `accepted` (response headers arrived) and
`streamed` (a body byte arrived) and survives the abort that ends a turn — and then read it in
precisely one place, the post-mortem. Both findings are places the same two facts were already
available and unspoken.

#### 1. `cancelled — nothing ran` — cancelled by whom?

> `"cancelled — nothing ran"` attributes the decision to nobody, where the same build family
> manages `"stopped by you"` elsewhere.

The question that has to be answered before the sentence is written is whether the app may name a
party at all — a badge that says "by you" over a plan the app abandoned is round 9's defect in a
new place. It may, and absolutely rather than usually:

| how a plan ends | who did it | what the badge says |
| --- | --- | --- |
| Cancel, in the plan block | the reader | `cancelled by you — nothing ran` |
| Stop, in the composer | the reader | `stopped by you` |
| a step threw | the app | `failed` |
| every step ran | the app | `completed` |

`cancelled` has **exactly one writer** in the renderer — `resolvePlan(id, false)` in
`hooks/useLMStudio.ts` — and that function's only caller is the Cancel button inside the block.
There is no fourth way in, so there is no second case to write words for, and no hedge.

That was not quite true before, and the repair is the interesting half. The approval gate resolved
a **boolean**, and the executor then worked out which kind of refusal it had been by reading
`signal.aborted` on the next line: a fact about the turn's abort controller standing in for a fact
about which control the reader pressed. That is this project's named recurring defect — reading a
quantity *adjacent to* the one you mean — and the quantity itself was in the resolver being called.
The gate now resolves a `PlanDecision` (`'approved' | 'cancelled' | 'stopped'`): the abort listener
writes `'stopped'`, the Cancel button writes `'cancelled'`, and nothing infers anything. The prose
under the block follows the badge — `You cancelled this plan — nothing was executed.` and
`You stopped this before the plan ran — nothing was executed.`

The half that was already right is kept: "nothing ran" is what tells a reader that the rows below
are a list of things that did not happen, and v1.12.3's finding — a reader lifting `Result: ~$1,080`
off a step that never executed — is why it could not be dropped to make room for the attribution.

**True negatives, asserted:** `completed` and `failed` must *not* name the reader, and a source-level
guard fails if a second writer of `cancelled` ever appears — a rendered checklist cannot catch a new
code path that ends a plan without the reader touching it, so the test reads the source.

#### 2. Ninety seconds of silence that never said what kind

> The one thing it knows and never says during the wait is that the server accepted the request and
> has sent zero bytes since — the distinction between a slow model and a dead stream, which is
> exactly what the reader needs at 60 seconds to decide whether to keep waiting.

Both builds spent ninety seconds showing `still waiting on the model · 1:31 · gives up at 5:00`.
Two things were wrong with that line and they are the same thing: it never said what the transport
had witnessed, and **"the model" was itself an attribution the app had not established** — before
response headers arrive, what the app is waiting on is the *server*, and no model is known to have
been reached at all.

The subject is now chosen from the record:

| witnessed | what the reader is told |
| --- | --- |
| a tool is running | `still waiting on deep_research` — the wait is on the tool; no witness applies to it |
| no record at all | `still waiting on the model` — a model call is in flight and nothing finer is known |
| no headers yet | `LM Studio has not answered the request yet` |
| headers, no body byte | `LM Studio took the request and has sent nothing back` |
| body bytes, then silence | `LM Studio started replying, then went quiet` |

The no-record row is the honest minimum rather than a leftover: a plan step's sub-turn, a
consultation and the claim-check pass all call the transport without a witness, and for those the
app really does know only that it asked a model something.

**When it escalates, and to what.** At sixty seconds — `STREAM_STALL_MS`, reused rather than
reinvented, because it is already the app's answer to "how long may a socket that was working go
quiet before the app stops believing in it" — a second line appears:

> `Nothing has been written back since — the app cannot tell a prompt still being processed from a
> dead stream.`

**This is the true negative, and it is the whole design.** A model that is genuinely just slow — a
30k-token prompt is most of a minute of legitimate silence on a 9B, and far more on a CPU — is
`accepted && !streamed` for the whole of it, byte for byte identical to a server that has died. The
app *cannot* tell them apart, so it must not claim to. It names both readings, innocent one first,
and leaves the decision with the reader, whose hardware and prompt it is. Asserted at 30 s, 60 s,
2 min and 10 min: no line ever says the stream is dead. A stream that produced bytes and went quiet
gets no note at all — its ceiling is the one-minute stall budget, so the transport ends that turn at
the exact instant the note would appear, and a sentence the reader cannot finish reading is worse
than none.

#### 3. `gives up at 5:00`, tested at last — and the sentence it printed was false

Eleven rounds of captures never reached the five-minute ceiling, so nobody knew whether the promise
on screen was kept. **It is** — proved now on both silences, including the one that was untested:
the abort has to travel from the watchdog through an *already-delivered* response into a pending
`read()`, which is a different path from the never-answered POST the suite already covered.

Testing it turned up the sentence it fires with. One constant covered both silences —

> `LM Studio accepted the request and then sent nothing for 300s.`

— and the suite pinned it on a `fetch` that never resolves: a request whose response headers never
arrived, i.e. one LM Studio had **not** accepted. The test's own name said so ("a POST that is never
answered") while the string it asserted said the opposite. Round 9's defect, alive inside the module
built to end it, asserted by the test that was supposed to guard it. The witness already knew which,
so the message is chosen when the timer *fires* rather than when it is armed — `accepted` being
precisely the thing that may change in between:

- never answered → `LM Studio never answered the request — no reply headers came back for 300s.`
- accepted, then nothing → `LM Studio accepted the request and then sent nothing for 300s.`

Each case asserts that it is **not** the other's sentence.

**Five minutes is left where it is, and that is a judgement, not an omission.** A stall and a slow
answer already get different patience — one minute between chunks, five before the first byte — and
that split is the right one, because it is drawn on evidence the app has: bytes arrived, or they did
not. Splitting the five further, into "no headers" versus "headers but no body", would draw a line
on something the app *cannot* read: whether a server flushes headers before its first token is an
implementation detail of the server, not a signal about the model's progress. And the silence being
budgeted is prompt processing, whose real duration scales with prompt size and hardware speed —
~300 tok/s measured on qwen3.5-9b-mlx, an order of magnitude less on CPU-only inference. Aborting a
turn that was about to answer is a worse failure than a long wait. What a long wait does not deserve
is *silence about itself*, and that is what changed.

#### 4. The deadline the line promised was the wrong one after any tool call

Found while wiring the above. `MessageBubble` picked between the two deadlines with
`(message.reasoning ?? '') !== '' || toolCalls.length > 0` — a fact about the **turn** standing in
for a fact about the **request** — so from the first tool call onward it declared the stream started
for the rest of the turn. Every later round of a tool loop arms the five-minute first-byte ceiling
afresh, so the line promised `gives up at 1:00` against a deadline four minutes further out.

The witness now carries a round-scoped pair beside the turn-scoped one, published at three
transitions — the request, the headers, the first body byte — through a small store slice only the
thinking indicator subscribes to (the `streamingTail` pattern, for the `streamingTail` reason: a
store commit per chunk is what that slice exists to avoid). The turn-scoped pair is untouched, and
`explainEmptyReply` still reads exactly what it read before.

### Pending fold-in — the instrument that was never the one the round built

Round 10 built paint-settling instrumentation into `scripts/h2h-capture.ts` — `textSettledMs`,
`textGrewAfterTurnEndChars`, `streamEdgeAtTurnEnd` — so a critic could tell a paint lag from a
renderer that actually dropped text, closing a false-positive mode round 9 had exposed. The sweep
was then launched from the repo root, which was sitting on `main`. **All 36 `run.json` files came
out without those fields.** The instrumentation was never exercised.

A critic found it, and only barely:

> the reply.md-vs-reply.txt growth test could not be applied anywhere

That is the good outcome — the question was reported unanswerable rather than answered from a
missing field. Nothing in the tooling objected, and nothing could have: both arms used the same
harness, so the comparison itself was sound. **The round's own instrument improvement went
unmeasured, and the artifacts could not say so.**

#### Two checkouts that nothing related

The arms are builds, named by `--app <dir>`. The harness is a third checkout — whichever one
`h2h-capture.sh` was invoked from. Nothing tied the two together, and nothing recorded the second
one at all. `run.json` carried `schema: 'h2h-capture/1'`, unchanged across the round that added
three measurements to it, so the schema string could not answer the question either.

Two different failures live here, and conflating them produces a guard that catches the wrong one:

| | what goes wrong | who can see it |
| --- | --- | --- |
| **asymmetry** | the arms were measured by *different* harnesses | staging — it holds both runs |
| **staleness** | both arms, same harness, and it is behind the build | the capture — it holds `--app` |

Asymmetry corrupts every figure in the round. Staleness leaves the comparison sound and silently
drops the round's new work. **Asserting the arms agree cannot catch staleness, because they do
agree — they agree on being wrong.** Round 10 was staleness, so recording-and-asserting alone would
have passed it. Both guards ship.

#### The reference is the build's own checkout

A build carries the harness it was written alongside, at `<appRoot>/scripts/h2h-capture.ts`. That is
what the harness *should have been* while measuring it. The comparison is a **subset test, and the
direction is the design**: the running harness may measure more than the build's copy, never less.

Pinning — requiring equality — was the obvious alternative and is wrong. Arm A is always an older
commit, so its copy always knows less; equality would make every baseline capture impossible.
Subset-passing *is* the arm-A exemption, and because it is structural there is no flag anyone can
set wrongly. The refusal fires before the app is launched and before a run directory exists, on the
first task rather than after thirty-six; `h2h-run.sh` treats its exit 5 as a sweep-level abort
rather than one more failed task, because the next seventeen would fail identically and bury the
message.

#### A manifest would have passed the sweep it exists to stop

The tempting design is to have the harness declare its own field list. It fails on the one case
that matters: **round 10's checkouts predate the guard**, so both sides would have declared nothing,
the subset would hold trivially, and the sweep would have gone through.

So the vocabulary is read *structurally* out of each harness's own source — `interface TurnRecord`
and the `definitions:` block, which are where a harness has always declared what it measures, back
through the baseline. Run against the real round-10 build directories, which survive:

| checkout | measures | verdict against it |
| --- | --- | --- |
| `r10-A` (baseline arm) | 13 | fit — nothing behind |
| `r10-B` (the build under test) | 17 | **behind by 4** |

The four are the three named in *Two instruments that were wrong about themselves* above, plus
`streamEdgeClearedMs`, which that note omits and round 10's own implementation notes include. **Two
hand-written lists in this very file already disagree about what the round built.** Reading the
vocabulary out of the source is how they stop being two lists.

The extractor is a heuristic over real TypeScript, so it is pinned against the actual capture source
rather than only against samples written to suit it, and it is deliberately *not* line-oriented:
reading the vocabulary correctly only while the file happens to be formatted one key per line would
make the guard depend on something nobody checks, which is the shape of the failure it exists to
prevent, one level down.

#### An absent field and a zero field are not the same artifact

The other half is legibility, and it is the half a critic actually holds. `run.json` now carries
`instrument`, with `measures` — everything that harness knew how to emit. A name there with no value
below **was measured and came back null**; a name that is not there **could never have been written
at all**, and a question about it is unanswerable from that run rather than answered in the
negative. Before this, those two were the same JSON.

#### The guard nearly became the tell it was guarding

First cut published the fit result in `run.json`. It is arm-identifying by construction: the harness
is "ahead of" the older build and level with the newer one, which labels the pair as neatly as the
version number `assertSameVersion` exists to stop. Everything derived from the build moved to
`_arm.json`; `run.json` keeps only what describes the harness, which is identical in both arms —
and `make-blind-pairs.mjs` now *asserts* that rather than assuming it, which is what licenses the
block to be staged at all.

#### What it still cannot catch

- **Round 10's own artifacts.** Runs predating the block record no instrument; staging treats a pair
  where both are silent as legacy and lets it through, the same courtesy `assertSameVersion` gives
  an unreadable sidecar. The guard is prospective.
- **A build with no sources** — a packaged `--app` — states no vocabulary, so there is nothing to
  check against. Recorded as `fit.skipped` with its reason, because "could not check" and "checked,
  fine" are different answers.
- **A harness ahead of both arms in name only.** Adding a field to `TurnRecord` and never populating
  it makes the vocabulary grow without the measurement existing. `measures` says what the harness
  *declares*, not what it proved it could produce.
- **Correctness of a measurement.** This asks whether the instrument was the right one, never
  whether its numbers are true.

### Pending fold-in — a column that was measuring its own capture

Round 10 added a `record-consistency` column — *does what the application says about this turn
agree with what the run's own record shows the turn did* — and it produced the round's most useful
findings. It was also **contested on 4 tasks of 18**, and every critic gave the same reason:

> `trace/audit.jsonl` is absent in both runs (`"auditExport": null`, `trace/` empty), so tool
> statuses rest on the transcript alone.

That is not a finding about either build. It is a finding about how much of the run got written
down, and the win/loss/tie line spells the two the same way.

#### The enumeration, from the recorded runs

Counted off `transcript-expanded.txt` in all 36 runs of `.h2h-runs/A10` and `.h2h-runs/B10` — every
line where the application states something about **its own** behaviour on the turn, the model's
prose excluded:

| what the screen states | instances | tasks | could round 10 settle it? |
| --- | --- | --- | --- |
| `📋 Method: <name> playbook` | 24 | 11 | no |
| `📖 From the library: …` / `Nothing in the library covers this` | 16 | 8 | no |
| tool-call block status (`⚙️ reference_lookup` and siblings, ✓ / ✗) | 13 | 6 | only where an audit was kept |
| `⏱ Checking stopped at its 60s limit. Ran: … Not run: …` | 13 | 9 | no |
| `🧮 Recomputed …` / `Recompute skipped …` | 8 | 5 | no |
| `⚠️ N figures … not backed by the tool output` | 8 | 6 | only where an audit was kept |
| `Plan — N/M steps done` | 6 | 3 | no |
| `started the sandbox in N s, then ran in N ms` | 5 | 3 | no |
| `⚠️ Answered from model memory — no sources consulted` | 4 | 2 | no |
| the remaining eleven classes (ledger, routing, revision, deliberation, refusal, empty reply, untrusted content, undisclosed tool, quoted-as-exact, sandbox verification, plan cancelled, stopped turn) | 23 | 12 | 3 instances |
| **total** | **120** | | **9** |

**Nine statements of a hundred and twenty.** On **31 of the 36 runs the record could settle
nothing at all.** The four contested tasks were not where the app was most talkative; they were
where the audit happened to be on.

One correction to round 10's own write-up while counting: `trace/audit.jsonl` exists for **three**
tasks (`PT1`, `TH1`, `TH2`), not the two its caveat names — six run directories, not four.

#### The refused repair

Make every task keep an audit. It is the obvious move and it is wrong twice.

**It stops measuring the shipped app.** The session audit is opt-in, off by default, and not free:
`src/main/ipc/audit.ts` encrypts every line with the machine keychain, chains it to the SHA-256 of
the previous plaintext, and appends it through a serialized queue — one entry per user input, per
assistant output, per tool call, inside the process whose latency this bench publishes as the
product's. Three rounds went into recovering from a baseline arm that was quietly not the shipped
build. Doing it evenly to both arms makes it *harder to see*, not less of a fault.

**And it would not work.** The audit's contents are what it is *for*: what was said, with none of
the layers in between — no system prompts, no recalled memory, no compaction notes. Four kinds:
session start, user input, assistant output, tool call. Of the classes above it can reach exactly
one, tool calls. There are no step boundaries in it, no playbook identity, no timings, and putting
them there means growing a **product** feature to serve the **bench** — the same fault pointing the
other way.

#### What was changed instead: the run says what its record is

`run.json` gains a `record` block (`scripts/h2h-record.ts`). The column's question names "the run's
own record" and no artifact said what that was, so each critic decided — and several decided it
meant `trace/audit.jsonl` alone.

- **`configuration`** — the switches live in the app when the turn ran, out of the `getSettings()`
  call the harness *already* makes to verify the seed. It settles **capability, not exercise**: a
  line saying a pass ran while that pass was switched off is a contradiction; a line saying it ran
  while it was on is merely possible. The tool half is derived from the product's own
  `DEFAULT_TOOL_TOGGLES`, so a tool added to the app cannot silently drop out of the record;
  `notCovered` names every settings group left out **with its reason**, and one nobody has decided
  about is stamped `UNDECIDED` in the artifact rather than being absent.
- **`library`** — the corpus the turn was given, through the already-public `libraryList()`, on
  *every* run rather than only those installing a pack. Taken **after** the turn on purpose:
  `library:list` loads every pack into memory, so reading it first would warm a cache the turn
  would otherwise have paid to fill, and the harness would become a participant in the timings it
  publishes. An empty library is what settles a claim to have retrieved from one.
- **`driverClock`** — the only clock in the directory the application did not produce. It **bounds**
  rather than measures, and says so.
- **`kept` / `notKept`** — one entry per record with what each settles. An absent audit now says
  *the app was never asked to keep one, which is a property of the staging and not of the build*;
  `auditExport: null` could not previously be told from an export that failed.
- **`beyondAnyRecord`** — the claims no artifact here can settle, in the artifact.

**Nothing here changes app behaviour.** Every value comes through an API the product already
exposes and the harness already calls; not one file under `src/` was touched. What changed is what
gets written down.

Settleable statements go from **9 of 120 to 55**, plus **41 settleable in part** (that a playbook
was applied at all — `grounding.playbooks` — not which one), **14 unsettleable by nature**, and
**10 still wanting a record the task did not stand up**. Runs where nothing at all is settleable
fall from **31 of 36 to 6**: `PT2`, `PT3`, `VC2` in both arms, whose only self-statements are plan
step boundaries.

#### The first thing the new record catches

`B10/TH2`:

> ⏱ Checking stopped at its 60s limit. **Ran: the claim check**, the code check. Not run: the revision.

`claimCheck.enabled` is `true` and `secondOpinion.enabled` is `false` in that run. `runClaimCheck`
(`src/renderer/src/hooks/verification.ts`) returns on its first line when second opinions are off —
the critic slot does the extraction and the judging, and there is no critic slot. But
`useLMStudio.ts` books `budget.ran('claims')` on `claimCheckOn && budget.admits('claims')`, without
asking whether the pass did anything. So the line names a pass that could not have run.

Round 10 counted that statement *unsettled*. It is a contradiction, and the configuration record is
what settles it. **Left unfixed deliberately** — this is the instrument's round, and changing the
build under measurement mid-round is the fault the instrument exists to catch.

#### What an honest record of a self-reported number looks like

It does not exist, and that is the finding rather than a gap to close later.

> `started the sandbox in 2.1 s, then ran in 6 ms`

The application timed itself. The sandbox starts inside the renderer and crosses no boundary
anything outside can watch. Writing 2.1 s into a record produces a record that agrees with the
screen **by construction** — the same number twice, corroborating nothing. The only honest options
are an independent clock or silence, and for a segment the app itself defines there is no
independent clock, because nothing outside knows where the segment begins.

So it is named. `beyondAnyRecord` carries five such classes: sandbox start-up and run duration, the
named timing segments, playbook *identity* (visible only inside a system prompt — settleable on the
three tasks routed through a loopback shim, and standing a shim up on all eighteen would move the
staging that eight rounds of recorded runs are comparable through), per-pass budget consumption,
and plan step boundaries. **Unsettleable is a third state, not a quiet tie.**

#### The scorer now says why a column was quiet

`contested 4/18` was two facts in one number. A column now reports the breakdown. Round 10's
verdicts file records no per-task counts, so the figures below are **illustrative** — the real
output of the real scorer over round 10's real verdicts with plausible counts filled in, kept here
for the shape of the line rather than for the numbers:

```
record-consistency  A 1 · B 3 · tie 14  ·  contested 4/18
                    uncontested: settled and agreed 3 · unsettleable, record not kept 10 · never in play 1
                    unsettleable statements, both runs: 112 for want of a record · 60 by nature
```

Three ways to be uncontested, and only one of them is about the two builds:

- **settled and agreed** — the record settled every statement and they agreed. An earned tie.
- **unsettleable** — statements were made and nothing could settle them. A fact about the capture,
  split further into *record not kept* (fixable) and *by nature* (not).
- **never in play** — neither run said anything for the question to bite on.

A round supplying volumes and contradiction counts *without* the unsettleable split is reported as
`unaccounted`, never folded into `settled` — reporting an earned tie a round never established is
the same failure one level down. And when a column's ties are mostly *record not kept*, the printout
says so in words:

> record-consistency was uncontested on 10 tasks only because the record that would settle them was
> not kept. On those tasks the column reported on how much of the run was written down, not on
> either build. Read its ties as coverage.

The arithmetic is checked rather than trusted: more unsettleable statements than statements made is
a refusal (exit 2), not a bad number — the two halves were counted from different lists.

#### What this does not fix

- **The three tasks with an audit are still the only ones whose tool statuses can be settled.**
  `task-setup.json` is frozen on purpose; eight rounds of recorded runs are comparable only because
  it does not move, and widening it is a decision for a round that is willing to pay that price.
- **The record settles capability, not exercise.** A pass that was switched on and did nothing looks
  exactly like a pass that was switched on and worked. Only the false *positive* direction is
  catchable, which is the direction the app's own warnings keep failing in.
- **None of it is exercised against a live capture.** Verified by compiling the harness exactly as
  `h2h-capture.sh` does and building the record against the settings and run descriptions of all 36
  round-10 runs; no sweep was run, and no sweep may be run while the harness is being edited.

### Pending fold-in — a food-safety temperature called unverified over seventeen passages stating it

Round 10's recorded loss, task V1, and the most damaging shape this app has shipped: the reader
asked how hot to cook chicken, the app answered `165 °F`, and then printed underneath it

> ⚠️ 1 measurement (165 °F) in this reply is not backed by the tool output.
> Matched by value, not by row: 4 days — [5], 2 lines; 1 week — [5], 6 lines. Where a value is
> stated on more than one line, only the passage itself shows which one the answer took it from.
> Checked against: reference_lookup.

Two lines above it, on the same screen, the provenance strip read **`17 passages from 3 lookups`** —
and those seventeen passages state `165` seven times — the poultry row of the foodsafety.gov chart
in passage [7], and `Poultry: Cook all poultry to an internal temperature of 165° F as measured with
a food thermometer` in passage [8]. The other build printed a byte-identical warning and was
**right**: its single lookup genuinely returned no temperature. Same sentence, opposite truth
value, and nothing on either screen distinguished them.

#### What the corpus actually spanned

Not what the hypothesis said. `checkToolGrounding` reads `outputOf(records, …)` over the whole
record list and always did — handed all three of the run's lookups it returns **no finding at all**,
which is the correct verdict. Re-run against the recorded artifacts, the corpus that produced the
shipped warning is exactly **the first lookup, alone**:

| corpus | measurements flagged | `Matched by value, not by row` |
| --- | --- | --- |
| lookup 1 only | `165 °F` | `4 days — [5], 2 lines; 1 week — [5], 6 lines` |
| lookups 1+3 | `165 °F` | `4 days — [5], [14], 3 lines; …` |
| lookups 2+3 | — | `165 °F — [7], [8], 6 lines; …` |
| **all three** | **none — no badge** | — |

Only the first row reproduces the shipped text character for character, down to the line counts. So
the question is not which lookups the corpus reads, it is **when it was read**.

The turn's own tool calls answer that. Lookup 1's query is the user's question verbatim — the app's
pre-flight `libraryPassages` provider. Lookups 2 and 3 are:

- `safe internal cooking temperature for poultry chicken`
- `how long cooked chicken lasts in the refrigerator storage time`

which are the two findings above, turned into queries. A model writes those only after it has been
handed the report. They are the **correction pass's** lookups — `reviseAgainstFindings` runs with the
turn's real tools and appends to the turn's own record list on purpose — and the 60 s verification
deadline then cut the revision off before it could rewrite anything (`Not run: the revision. The
answer above is unchanged.`). The caller published the report it had been carrying since before
those lookups existed.

So the corpus spanned **the turn as it was when the report was built**. It now spans the turn as it
finally stands: every report is re-graded against the live record list at the moment it is
published, never carried across the pass that changes that list.

#### Which rungs shared the defect: all of them

The corpus is built once per report and every rung reads it, so this was never a measurements bug —
it is the whole `GroundingReport`. On one reply against the same recorded turn, graded against the
pre-flight lookup alone versus against all three:

| rung | pre-flight corpus | the turn as it stands |
| --- | --- | --- |
| measurements | `165 °F`, `165° F` | — |
| citations | `[8]` dangles | resolves |
| links | `fsis.usda.gov/…/safe-temperature-chart` unsourced | it is passage [10]'s source line |
| quotations | the poultry line is "in no tool output" | quoted verbatim from [8] |

Four accusations, four passages on screen refuting them. A fix that repaired measurements and left
the other three is this project's recurring failure, so the repair is at the report, not at a rung.

#### The rule, and what it is not

`settleRevision` (hooks/verification.ts) now owns the whole publish decision, and the rule is one
sentence: **nothing it reads may be a report built before the revision ran.** It grades the draft
*and* the revision after the pass, which also repairs the comparison — `revisionIsAnImprovement` was
counting a "before" from five passages against an "after" from seventeen, so the difference it
measured was the corpus growing, and a rewrite that changed nothing scored as a correction the app
then took credit for.

This deliberately does **not** widen what counts as support. The corpus is still the turn's own tool
output and nothing else; a corpus that swallowed everything would make every figure supported and
the rung worthless. Every case above ships with its true negative, on the same three-lookup turn:

- `200 °F` in place of the retrieved `165 °F` — still flagged, badge text pinned in full.
- `https://www.example.gov/invented-chart` — still flagged.
- `[42]`, past the seventeen passages retrieved — still flagged.
- Stop pressed mid-revision on a reply with a real invention — still flagged, answer unchanged.
- A revision that restates the same claim in different words after retrieving its backing — **not**
  recorded as a correction, and no before/after pair claimed.
- A revision that genuinely removes an invented link — still kept.

#### Limits

Two things this does not do. The report is re-graded, not incrementally invalidated: there is no
fingerprint of the corpus a report was graded against, so nothing *detects* staleness — the fix is
that no report survives long enough to go stale. And the deadline notice is still wrong about this
turn in a second way, unrepaired here: `Not run: the revision` stood over a revision that
demonstrably ran, made two lookups, and put their twelve passages on screen. `createVerifyBudget`
counts a pass as run only if it returns before the deadline, so an aborted pass reports as never
started. Round 10 recorded the same defect on FR3 (`Not run: the recomputation`, printed directly
above the recomputation and its output); it is one defect with two sightings and wants one fix.

### Pending fold-in — three places where the screen contradicted itself

Round 10 added a `self-consistency` column — *does anything the application states on this screen
contradict anything else it states on the same screen* — and it cost this build the round. Three
findings, all from recorded runs, and all one shape: **two parts of the app answering the same
question separately, and one of them answering it from something other than the fact.**

#### 1. The expiry line denied the work it was displaying

Measured, FR3 (`.h2h-runs/B10/FR3-20260827-224622`), two lines apart, the second directly under the
first:

> 🧮 Recomputed the stated figures in Python; the reply's numbers were compared against that output.
>
> ⏱ Checking stopped at its 60s limit. Ran: the code check. **Not run: the recomputation.**

The program, its stdout and the comparison were all on screen above the denial. The footer of the
same capture reads `62.2s checking` against a 60 s budget, and that 2.2 s is the whole story: the
recomputation's `run_python` is not wired to the budget's abort signal, so a program admitted at
~57 s booted the sandbox and printed after the deadline. The turn then asked

```ts
if (!budget.signal.aborted) budget.ran('recompute')
```

— which is a question about **the clock**, not about the pass. The clock knows when the minute
passed. Only the pass knows what it got done.

The previous build got the same line right on its own FR3 run
(`.h2h-runs/A10/FR3-20260827-233154`: `Ran: the code check, the recomputation. Not run: the
revision.`) for one reason: its recompute finished a moment inside the budget. Identical code, and
the difference between a pass and a fail was timing.

**Each pass now hands the budget its own account of what it did.** `WorkbenchCheck` carries `ran`
beside `ok` — the fact its summary already stated in prose, in a field the notice can read;
`reviseAgainstFindings` returns `''` when nothing came back, so its return value is the evidence;
`runClaimCheck` and `runAutoCritic` return whether any account of themselves reached the reader — a
verdict, a budget note, a failure line. `budget.signal.aborted` is consulted for `ran` nowhere.

There was a second half, and without it the fix would have been silent rather than wrong. Both gates
that precede `admits` tested `stopped()` — which is `signal.aborted || budget.signal.aborted` — so
once the deadline fired the gate returned *before* the budget was ever asked about the pass, and the
pass the deadline actually cost went unrecorded and therefore unnamed. Only the reader's own Stop
belongs in that test, because a Stop leaves no notice by design. With both halves, FR3 reads:

> ⏱ Checking stopped at its 60s limit. Ran: the code check, the recomputation. Not run: the
> revision. The answer above is unchanged.

**True negatives.** A recomputation the deadline genuinely cut off returns `describeRecompute({ ran:
false })`, shows `🧮 Recompute skipped — cancelled`, and is still named: `Ran: nothing. Not run: the
recomputation.` A turn whose tail fits inside the minute still says nothing at all. A turn the
reader stopped still leaves no notice, because the reader who pressed Stop knows why it stopped.

#### 2. One call, reported two ways on the same screen

> ✗ 🔍 deep_research — No usable sources were found.
>
> Checked against: run_python, **deep_research (errored)**.

A search that came back empty-handed and a tool that broke are different facts about one call, and
the summary line was making up the difference. Round 8 built exactly this distinction —
never-sent (`↩`), server-failed (`✗`), returned-nothing (`∅`) — and built it **in `ToolCallBlock`
alone.** The footer classified the same records for itself, off `record.status` and nothing else: so
every non-`done` source read `(errored)`, and every `done` one read as evidence. B10/TH2 is the same
fault on the other glyph — `∅ ⚙️ reference_lookup — found nothing`, and four lines below it,
`Checked against: reference_lookup`, a bare name that has always meant *this supplied something*.

Two causes, and both had to go:

- **`deep_research` never learned the vocabulary at all.** Its "no usable sources" return was
  `ok: false` with prose, so even the row wore `✗`; its "every query was refused by the privacy
  filter, nothing was contacted" return was the same plain error. It now declares its
  `emptyResultLead` in the tool table and returns a fruitless campaign as a call that worked and
  supplied nothing — the split `web_search` has made since round 5 — while both never-sent cases (a
  refused query set, a plan the user cancelled) go through `declinedCall`, the one string `↩` reads.
- **Two classifiers, one question.** `callOutcome` in `lib/grounding.ts` is now the only place a
  record's outcome is decided, and the row and the footer both ask it. A name is listed bare only
  when one of its calls actually returned something; anything else carries the row's own word.

| | before | after |
| --- | --- | --- |
| FR3 row | `✗ 🔍 deep_research — No usable sources were found.` | `∅ 🔍 deep_research — found nothing` |
| FR3 footer | `Checked against: run_python, deep_research (errored).` | `Checked against: deep_research (found nothing), run_python.` |
| TH2 footer | `Checked against: reference_lookup, web_search (errored).` | `Checked against: reference_lookup (found nothing), web_search (errored).` |

**True negatives.** A tool that genuinely broke still reads `✗` on its row and `(errored)` in the
footer — `web_search` against the TH2 fixture's HTTP 500 is unchanged. A lookup that returned a
passage keeps `✓` and its bare name. A tool called three times, once successfully, keeps the bare
name: the answer *was* checked against what that call returned. And the line this must not cost us
is round 8's reason for naming fruitless calls in the first place — the footer must never fall back
to `nothing ran this turn` on a turn where a search did run, so a tool whose calls ended differently
carries both words (`web_search (errored, found nothing)`) rather than the app picking a winner.

#### 3. The warning arrived after the reassurance it contradicted

> ⚠️ Not deliberated — the review request to Researcher came back empty; **the draft was not
> checked.** Run Think harder again to retry it.

…the last line of a bubble that had already said `🧮 Recomputed the stated figures in Python`,
`Covered 1 of the 3 measurements in this reply`, and `Checked against: run_python`.

**Both an ordering problem and a wording problem, and they are separable.**

*Wording.* Three passes check something on that screen — a recomputation, a code run, a grounding
comparison — and none of them is this one. This pass is a second model **reading the prose**; the
other three are the app comparing figures against output. One word for both left the reader to
decide which had not happened, with the decision pre-loaded by the two reassurances above it. The
line says `no reviewer read this draft` now, and no line `describeDeliberation` produces contains
the word *check* in any form; the predicate is `draftWentUnreviewed` (round 9 shipped it as
`draftWentUnchecked`), and the audit log and tooltips moved with it.

*Ordering.* Read downward — the only way it is read — an unreviewed reply arrived as a checked one.
The unreviewed line renders **above** the checks block and the grounding banner now, and the move is
conditional on purpose. A review that *did* happen ran after the tail and can revise the text those
checks read, so a line saying it succeeded must not sit above them claiming to describe what they
saw; a review that did not happen changed nothing, so nothing is misplaced by putting it first.
`draftWentUnreviewed` is false while the pass is still running, so the live line does not jump on
its way to a verdict — only a settled failure moves.

*Not the rank.* Round 10 established that a warning carries one ink (`text-ink-warn`) and provenance
another (`text-ink-tertiary`), and that a provenance line wearing warm ink reads as a finding.
Promoting these lines to be heard would spend exactly the contrast that distinction runs on. The
ordering test asserts the two quiet lines stay quiet.

**True negative.** `🧠 Deliberated — reviewed by Researcher, revised.` still renders where provenance
lives, below the banner, and a pass still in flight still renders there too.

#### What this does not fix

- A code check that ran on the draft and was refused on the revision is still counted as lost, so
  the expiry can read `Not run: the code check` above the draft's own `🧪` line. The rule is
  deliberate and documented (*"the notice may under-claim, never over-claim"*), and the honest
  repair is to say **which** code check — the draft's or the revision's — which is a wording change
  this round did not have the recorded evidence to design.
- `Ran: the code check` appears on a reply containing no Python at all, because `runCodeCheck`
  reaches a conclusion either way and the notice reports that it ran. Defensible, and no line
  contradicts it — but there is no `🧪` disclosure on screen for the reader to tie it to.

### Pending fold-in — three lines that mislead a reader about their own completeness

Round 11's blind critics found three lines, all present in **both** arms, that are true about what
they measured and misleading about **their own scope**. Round 10's lesson — *a sentence broader than
its measurement* — with the breadth in the presentation rather than in the claim.

#### 1. The unbacked-figures count was a ceiling wearing a census's clothes

The sibling line on the same screen is what convicts this one. Verbatim, one above the other, from
`.h2h-runs/B11/V3-20260828-104955`:

> ⚠️ 5 figures ($6, $3.50, $7.00, $10, $15) in this reply are not backed by the tool output.
>
> Covered 0 of the 6 measurements in this reply. Not compared against anything: 700 gallons per
> month, 60 seconds/min, 60 min/hr, 24 hr/day **and 2 more**.

The second names four of six and says so, because `coverage` carries its totals uncapped and caps
only `uncheckedNamed`. The first took its count off `report.figures`, an array `checkToolGrounding`
had **already sliced to `MAX_REPORTED`** — so it agreed with itself perfectly and understated the
reply. `groundingFindingLabels` states the rule two hundred lines above the sentence that broke it:

> The count and the names must come from the same place. […] a line that says "3 unsupported items"
> and then names two is worse than one that names none.

The place has to be the whole of what was found. Reproduced against the shipped checker, a reply
stating nine unbacked prices:

| | line |
| --- | --- |
| before | `⚠️ 6 figures ($1, $2, $3, $4, $5, $6) in this reply are not backed by the tool output.` |
| after | `⚠️ 9 figures ($1, $2, $3, $4, $5, $6 and 3 more) in this reply are not backed by the tool output.` |

**Disclose, not raise, and not both.** Raising `MAX_REPORTED` moves the silence one figure along and
leaves the same reader with the same unreadable ceiling; the cap itself is doing real work, because
twelve prices enumerated in an amber banner is the noise round 4 established a reader learns to
scroll past. So `GroundingReport.found` records the true totals for the three categories the banner
counts, the count becomes the census and the *naming* is what is capped — the shape `coverage` has
had since v2.1 — and the phrase is the sibling's `and N more`, not a second idiom for the same fact.
`found` is written only when the cap actually dropped something, so a report that names everything
cannot claim a truncation it did not make.

Links needed the other half. They are the one counted category the sentence does not name inline —
they carry a bulleted list beneath it — so raising the count without telling that list would have
moved the silent truncation rather than ended it. `unlistedLinks` closes it with the same words, in
the list where the reader is actually looking for them.

**True negatives.** Six unbacked figures with six named produces no `found` field at all and the
line reads `6 figures ($1, $2, $3, $4, $5, $6) …` with no truncation clause — a build that hedged
every list, or appended "and 0 more", fails there. One figure still takes a singular verb
(`1 figure ($36) … is not backed`), because v1.17.1's rule now runs over v2.4's number. And two
truncated categories in one sentence keep their remainders apart, which is why the totals are
recorded per category and not as one number: `and 3 more` hung on the wrong noun is a new wrong
statement.

**What this round got wrong first, and the finding underneath it.** The brief for this work assumed
the recorded `5 figures` line had been truncated — that `$4` and `$30`, unbacked and unnamed in the
same reply, were the sixth and seventh of a list capped at five. They were not. That reply's rung
faulted exactly five figures and the line named all five; `MAX_REPORTED` is 6 and was never reached.
`$4` and `$30` were dropped one step earlier, by `unsourcedFigures`, and reproducing it takes two
strings:

```
unsourcedFigures(reply, '', '[4] CLEAN')   →  $6, $3.50, $7.00, $10, $30, $15   ($4 gone)
unsourcedFigures(reply, '', 'about 30% in') →  $4, $6, $3.50, $7.00, $10, $15   ($30 gone)
```

Both come from the retrieval strip of that very run — passage marker `[4]`, and `· 30% in ·`, the
app's own coverage percentage. `inSources` is presence-only and dimensionless by design (v1.11.2: *a
figure that appears verbatim in a page the model was handed is sourced*), and `amountsIn` returns
every number that is not part of a measurement — so a bracketed passage index certifies `$4` and a
relevance percentage certifies `$30`. **A figure is being certified by a number in the app's own
retrieval chrome.** That is a real defect of the same family — a check whose corpus is wider than
the thing it claims to have compared against — and it is not fixed here: the honest repair is to
decide what counts as *the passage* versus what counts as the app's furniture around it, and this
round has one run's evidence, not a corpus.

#### 2. A label introducing nothing

In the collapsed transcript of both arms, a section ended here:

> 🧮 Recompute skipped — stopped before it finished
>
> **The runtime reported:**

— and nothing followed. The body, `BodyStreamBuffer was aborted`, appears only when the disclosure
is opened. I recorded this in round 6 as *probably* a capture artefact of reading a closed
`<details>`; round 11's critics read it off the screen, in both arms.

`attribution()` is not wrong. It ends in a colon because both its other callers — `composeFailure`
and `copyableFailure` — put the text on the very next line and never fold. The verification banner's
disclosure is the third caller and it *does* fold, so a closed control was wearing a line's clothes.

| | collapsed | opened |
| --- | --- | --- |
| before | `The runtime reported:` | `BodyStreamBuffer was aborted` |
| after | `What the runtime reported` | `BodyStreamBuffer was aborted` |

**And not by unfolding it.** Round 8's whole argument is that a runtime string belongs behind a
disclosure, and `BodyStreamBuffer was aborted` — a DOMException's wording for a fetch the app itself
aborted — is exactly the text that boundary exists to keep off the reader's screen. What was wrong
was the promise, not the hiding. `attributionLabel` is a second *reading* of the same fact for the
one caller that is a control rather than a line; both readings still come off `detail.source`, so
there is one spelling of who spoke and not two, which is the drift `attribution` was extracted to
prevent.

**True negatives.** `composeFailure` still renders `The runtime reported:\n"Fatal: 0x8007007e"` and
`copyableFailure` still yields sentence-plus-verbatim for a bug report — both pinned. A relayed
failure keeps its speaker in both forms (`What LM Studio reported`). And the collapsed control must
not smuggle the internals up into itself: the label is asserted to contain no `BodyStreamBuffer` and
to end in no colon.

#### 3. A progress fraction on a plan that will never progress

Verbatim, `.h2h-runs/B11/PT2-20260828-110253` (and the same block in A11):

> 📋 Plan — **0/4 steps done** · cancelled by you — nothing ran
>
> – 1. Search for official smoke alarm placement guidelines from the NFPA **never ran**
> – 2. … **never ran**   – 3. … **never ran**   – 4. … **never ran**

Round 11 taught the badge to attribute the decision (`cancelled` → `cancelled by you — nothing ran`)
and the count went on describing a run in progress. Not one word of the fraction is false: no step
is done and there are four of them. A fraction is a **promise** about the steps it leaves out — the
numerator climbs, the denominator gets reached — and that is what a reader of a checklist takes from
`0/4`.

| plan | before | after |
| --- | --- | --- |
| cancelled, nothing ran | `Plan — 0/4 steps done` | `Plan — 4 steps: 4 never ran` |
| stopped part-way | `Plan — 1/4 steps done` | `Plan — 4 steps: 1 done, 1 stopped by you, 2 never ran` |
| failed | `Plan — 1/3 steps done` | `Plan — 3 steps: 1 done, 1 failed, 1 never ran` |

**The rule is not "no fractions on dead plans".** A fraction may stand as long as it is closed:
`4/4 steps done` beside `finished` leaves nothing out, says the same thing as the census, and says
it in fewer words. What needed repair is a fraction with a remainder that will never arrive. So the
census replaces it only when `done < total` on a plan that is over — and it is a census, not `4
steps` alone, because the badge speaks about the *plan* and the rows are what the reader is about to
read.

The tally walks `STATUS_LABEL` rather than naming the statuses it expects, so a status added later
is counted by construction rather than by being remembered — this project's recurring defect is the
enumeration that stops covering its class. The cost is one echo: a cancelled plan says `4 never ran`
above four rows that each say `never ran`, which is the same deliberate repetition `STATUS_LABEL`
already documents accepting.

**True negatives.** A completed plan still reads `2/2 steps done`; an approved plan mid-run still
reads `0/3 steps done`; an unapproved one still reads `0/2 steps done`. A build that simply stopped
counting fails all three. Beyond the three fixtures, the class is asserted: for *any* terminal plan
the numbers in the header sum to the number of rows below it — a tally that forgot a status would
leave rows unaccounted for, and that is what would catch it. The accessible name carries the same
contract, measured on the real Chromium tree (`planAccessibilityCheck`): a plan that will not
progress is named with no progress fraction, and the name accounts for every step it lists.

#### What this does not fix

- **`unsourcedFigures` certifies a dollar amount from a bare number in retrieval chrome** — the
  finding above. `[4]` supports `$4`; `30% in` supports `$30`. Reproduced, not fixed.
- **`GroundingReport` is declared twice** — in `types.ts` and in `lib/toolGrounding.ts` — and the
  two are kept in step by hand. `found` had to be added to both, and the node typechecks pass over
  `src/` alone, so the second copy went missing until the test build compiled `test/`. Two
  declarations of one shape is the drift this codebase keeps extracting helpers to prevent.
- **`groundingFindingCount` and `groundingFindingLabels` still count the capped arrays**, so
  `describeRevisionOutcome` can say "6 unsupported items were sent back" when nine were found, and
  `revisionIsAnImprovement` reads 9→7 as no improvement at all. Same species as §1, one rung along;
  it changes what the correction pass *does* rather than what a line says, so it wants its own
  round and its own recorded evidence.

### Pending fold-in — two repairs that each shipped the defect they repaired

Round 10 and round 11 each fixed a real thing and each left a new sentence broader than its
evidence — this project's signature defect, committed inside the boundary built to end it
(`src/shared/failure.ts`). Round 11's blind critics caught both: one counted, one unsettled.

#### 1. The sentence that contradicted the error two lines below it

Counted by both critics in **both arms** — 1 disagreeing pair in `self-consistency`, 1
contradiction in `record-consistency` — so it tied rather than lost. On a context-overflow turn:

> ⚠️ **The model produced no text. LM Studio answered and the reply ran to its end — it was simply
> empty.** Ask again, or rephrase the question.
>
> ⚠️ The request was refused by LM Studio, which named the context length …
> LM Studio reported: *"Trying to keep the first 12000 tokens when context the overflows…"*

`fixtures/lm-shim.json` records `"action": "context-overflow"`. The reply did not run to its end:
LM Studio wrote one `{"error": …}` frame and the transport threw on it.

**The distinction round 10 drew was right; the case was a third thing.** It separated *the model
produced nothing* from *the server never answered*. This is **the server answered with a refusal**,
and the sentence claimed the reply had completed — because nothing recorded whether it had.
`streamed` was carrying two meanings, *a reply began* and *a reply finished*, and only the first is
what it observes. One byte is not an ending.

The second meaning is now recorded where it happens — the reader reporting done, in `streamChat` —
as `TurnEnding.completed`. One witnessed boolean turns three endings into five:

| accepted | streamed | completed | what the reader is told |
| --- | --- | --- | --- |
| no | — | — | `This turn ended without LM Studio answering the request, and the app cannot say why.` |
| yes | no | **yes** | `LM Studio accepted the request and closed the connection without sending a reply.` |
| yes | no | **no** | `LM Studio answered the request, but the turn ended before any of the reply arrived. The reason is in the message below.` |
| yes | yes | **no** | `LM Studio started sending a reply, and the turn ended before that reply did — none of what arrived was answer text. The reason is in the message below.` |
| yes | yes | **yes** | `The model produced no text. LM Studio answered and the reply ran to its end — it was simply empty.` |

**The two new rows carry no remedy, and that is the finding.** Both are reached only by a throw,
and every throw that is not a user Stop appends the failure message the reader is about to read. A
cheerful `Ask again.` above a refusal that has just explained why asking again cannot fit is round
9's defect rebuilt one message further down.

**The fifth ending nothing named.** Row three is not the error frame — it is `!res.ok`, which throws
before the reader loop, leaving the same `accepted && !streamed` pair as an empty 200. So an
HTTP 404 from LM Studio read as `closed the connection without sending a reply. Nothing was
generated` — over a server that had replied, with a status and a body the app had already read.

**True negatives.**

- A genuinely empty completed reply must still say so, and does: `data: [DONE]` with no content
  keeps `The model produced no text … the reply ran to its end — it was simply empty.` The two
  differ by exactly one recorded fact, asserted from the transport rather than by hand.
- The empty 200 keeps its own sentence — the body ended, cleanly, having carried nothing.
- Every Stop reading comes first and is untouched: `completed` is false on all of them, and none may
  be re-read as one of the new endings.
- `completed` is the only one of the three that does not accumulate over a turn. A tool loop's first
  round finishing says nothing about the round that threw.
- **A turn stored before v1.17.5 has the other four facts on disk and not this one.** Reading that
  absence as `false` would tell an old conversation its reply was cut off and point at a failure
  message nobody ever wrote — the defect being fixed, committed by the fix. `undefined` means *not
  recorded* and gets rule 3's treatment.

Asserted over the whole input space rather than the cases someone remembered: **no sentence claims
the reply finished unless `completed` says it did.** Round 10's sentence was reachable from
`completed: false` for two versions because nothing checked that.

#### 2. The sentence a critic could not settle, and why it could not be settled

Round 11 added, at 60 seconds of silence:

> Not even the reply headers have come back — the app cannot tell a busy server from one that has
> stopped answering.

A critic tried to settle it against the record and could not: the fixture logs `"status": 200` for
the stalled request, which would put headers on the wire, *except* that a status chosen by a handler
that never writes a body is routinely never flushed. Its verdict: *"run-2's most useful sentence is
also its least verifiable, and it is stated flatly."*

**Measured, three ways.**

- The fixture's `status: 200` is bookkeeping, not evidence. `scripts/h2h-fixtures.ts` assigns
  `entry.status = 200` before it calls `writeHead`, for every injected rule.
- `writeHead` with no `write` puts **zero bytes** on the socket. Node holds the header block until
  the first body write, so on that fixture the sentence happened to be true.
- It is not true in general, because **`accepted` was never the headers.** It is set from the
  transport's `fetch` resolving — and `fetch` does not resolve on every header block. A
  `103 Early Hints` response and a `302` each put a complete reply header block on the wire and left
  `fetch` pending: a 1xx is not a response, and a redirect is followed internally. LM Studio behind
  any reverse proxy produces either.

So the witness knows *nothing the app can read has come back*, not *no headers came back*.

| | |
| --- | --- |
| before | `Not even the reply headers have come back — the app cannot tell a busy server from one that has stopped answering.` |
| after | `Nothing has come back, and nothing was refused — the app cannot tell a busy server from one that has stopped answering.` |

**The useful half is kept, and it was never the headers claim.** This line is the difference between
*be patient* and *this may never come back*; deleting it would cost the reader the one thing worth
saying at 60 seconds. What replaces the first clause is what `!accepted` establishes, plus the fact
the reader most needs and the app can actually prove: **nothing was refused.** A closed port rejects
`fetch`, and a rejection ends the turn — so while this line is on screen, the address is not the
thing to go and check.

**True negatives.**

- The sibling reading (`accepted && !streamed`) is unchanged, and the two remain different
  sentences naming different pairs — neither may borrow the other's.
- A server that has not answered is still never reported as dead, at any elapsed time, and the
  innocent reading is still offered first — the same rule as the slow-model branch.
- The line claims nothing about headers, packets or sockets. The app cannot see the wire, only its
  own `fetch`.

#### What this does not fix

- **`accepted` and `streamed` still accumulate over a turn.** On a multi-round turn whose second
  round never got a response, the turn-scoped pair still reads `accepted && streamed` from round
  one. `completed` is now last-round-scoped and pulls the reading toward the truth, but the pair
  itself cannot distinguish *this round* from *some round*, and no sentence says which round it is
  describing.
- **The two hand-off endings assert a message below them.** That is established for every path
  through `runTurn` — a non-Stop throw always appends one — but it is established by reading the
  caller, not by anything the record carries. A future call site that swallows the throw would
  leave the sentence pointing at nothing.

### Pending fold-in — a column that says nothing is unreadable

Round 11 scored both cross-cutting columns 0-0-18, and `score-round.mjs` printed the only thing it
could:

```
self-consistency    A 0 · B 0 · tie 18  ·  contested unknown — no counts kept
record-consistency  A 0 · B 0 · tie 18  ·  contested unknown — no counts kept
```

The round's own write-up said the number was ambiguous — *either two clean builds or two columns
with nothing to bite on* — and could not resolve it. **The critics could.** Every round-11 report
carried the resolving numbers in prose: *"run-1: 11 application statements, 1 disagreeing pair;
run-2: 9 statements, 0"*, *"settleable 6 and 6, agreements 6 and 6, contradictions 0 and 0,
unsettleable 3 and 3"*.

None of it reached `verdicts/round-11.json`, which stores one word per task per column. Round 10 had
already built and named the vocabulary that wanted those numbers — *never in play*, *unsettleable*,
*settled and agreed* — and the round-10 file did not carry them either. **The vocabulary existed;
the data never reached it.** So a column that was never put in play printed exactly like a column
both builds passed, twice.

#### A column declares what stands behind it

The repair is not a better question and not a better renderer. It is the file being made to say
which of three things it has, in the words the verdicts already use:

| `evidence` | means | printed as |
| --- | --- | --- |
| `counted` | the numbers are here, task by task and run by run | `contested N/M`, and why the rest was uncontested |
| `unrecorded` | the critics counted and the round did not write it down | `contested unrecorded`, plus a paragraph refusing to read the ties as agreement |
| `unasked` | the question was not put | nothing — the column already says `NOT ASKED` |

A cross-cutting column that declares none of the three is refused with exit 2. The declaration is
required and the *data* is not, which is the point: `unrecorded` is cheap to write, so a round that
lost its numbers can always be honest, and what it can no longer be is silent. The refusal runs both
ways — a column claiming `counted` with nothing in it is refused, and so is one claiming
`unrecorded` with counts in it, because a real measurement labelled as an absence is thrown away
just as thoroughly as one never taken.

#### The fourth number, and what each zero means

The count block gains `settleable` beside `volume` and `count`:

```json
"A": { "volume": 11, "settleable": 8, "count": 1, "unsettleable": { "absent": 2, "byNature": 1 } }
```

| field | zero means |
| --- | --- |
| `volume` | the application said nothing about itself — a fact about the **task** |
| `settleable` | it talked and not a word could be checked — a fact about the **capture** |
| `count` | the column looked and found none, but **only** when `settleable` is above zero |

The scorer could have derived `settleable` as `volume` minus the unsettleable split. It does not,
for the same reason the existing *counted from different lists* refusal exists: a derived number
absorbs a miscount and a stated one that has to add up exposes it. `settleable + absent + byNature =
volume` is now checked, and half a comparison, more settleable than stated, and disagreements found
among nothing settleable all land in that same exit-2 vocabulary rather than a new one. The
uncontested breakdown keeps `unsettleable, kind not stated` for a round that can count what it
settled and not why the rest was unsettleable — folding that into *settled and agreed* would report
an earned tie nobody established, which is the same failure one level down.

`contested N/M` now also reports `uncounted K`. A column counted on two tasks of eighteen was
printing `contested 1/2`, which reads like a column contested on half of what it saw — the round-11
failure hiding inside the figure built to expose it.

#### Where the numbers come from

Three options, and the answer is two of them, because **a schema nobody can fill is worse than no
schema** and the counts schema had gone four rounds unfilled.

*Parsing the prose* was rejected. Round 9's reports are not in the repository and round 11's were a
task notification, so a parser would be tested against nothing — and prose that nearly parses
produces a number instead of a refusal, which is the failure mode this whole document is about.

*Refusing a file with no counts* is the `evidence` declaration above. It makes silence visible and
makes nothing easier to keep.

*Asking for a block* is `critic-counts.mjs`. One header line and one line per run, per question, per
task, beside the prose and not instead of it:

```
COUNTS V1 self-consistency run-2
  run-1 statements 11 settleable 8 found 1 unsettleable-absent 2 unsettleable-by-nature 1
  run-2 statements 9 settleable 6 found 0 unsettleable-absent 2 unsettleable-by-nature 1
```

`critic-counts.mjs block` prints that spec for the prompt document, generated out of `crossCutting`
so a question added there gets a block without anyone remembering to add one — including the line
naming what `found` counts, which is read out of the question's own `decide` rather than a list.
`critic-counts.mjs read <report…> --key <staging>/_key.json` reads filled blocks back into a column,
checking the same arithmetic the scorer does. **The verdict rides in the header**, so the word and
the numbers behind it are written in one place at one moment; round 11's word survived and its
numbers did not precisely because they were written in two.

The blinding survives it. A critic writes `run-1` and `run-2`; turning those into `A` and `B` needs
`_key.json`, which is withheld from critics, and without it the tool stops at the run labels and
says why. The block is a new document a blind judge reads, so it is guarded for build fingerprints
in `test/h2hTaskNeutrality.test.ts` beside the task view — `make-critic-tasks.mjs` filters what a
critic may read, and there is now a second thing a critic reads.

**What it costs**, stated rather than buried: a critic emits a structure as well as an argument,
which is one more thing to get wrong; a malformed block costs a human re-read instead of yielding a
number nobody counted; a fixed vocabulary in front of a critic is a mild pull toward counting what
the block asks for rather than what the question asks for, which is why the prose stays mandatory
and the block is checked against itself and never against the prose; and none of it recovers a
number from a round already judged.

#### Corrections, counted

Round 11's file carried `columnsAsReported`, `columns`, and a paragraph explaining the difference —
V1 recorded twice, because a critic scored two columns on a difference it had itself excluded from
the task column as model variance. Nothing read the second reading, so the printout showed a
corrected column with no sign anything had been corrected. **A paragraph explaining one correction
reads exactly like a paragraph explaining nine.**

The paragraph is now a list, and the scorer reconciles the two readings in both directions: a
difference no correction names is refused, and a correction naming no difference is refused too —
the second being the appearance of rigour with no verdict behind it. A correction whose `rule` is
too short to be one is refused as a preference. Round 11 now prints:

```
verdicts overruled after reporting    2 of 54
    V1 in self-consistency: B → tie — a difference that would vanish under identical tokens is not a difference
    V1 in record-consistency: B → tie — a difference that would vanish under identical tokens is not a difference
```

#### What rounds 10 and 11 print under it

Neither round's counts are recoverable — the reports are gone, which is the finding rather than an
obstacle to it. Both files declare `unrecorded`, and both now say so where the ambiguity was:

```
round 11
  self-consistency    A 0 · B 0 · tie 18  ·  contested unrecorded — the critics counted and the round did not keep it
  record-consistency  A 0 · B 0 · tie 18  ·  contested unrecorded — the critics counted and the round did not keep it

  self-consistency kept no numbers. The critics counted statements and disagreements for both
  runs and the round wrote down only the word.
  Its verdicts stand; its ties cannot be read as agreement, because nothing here
  says the question was ever put in play on any task.
```

Round 10's two columns get the same declaration and a different closing sentence, because both named
winners and a column that named a winner was demonstrably in play somewhere:

```
round 10
  self-consistency    A 2 · B 2 · tie 14  ·  contested unrecorded — …
  record-consistency  A 1 · B 3 · tie 14  ·  contested unrecorded — …

  It named 4 winners, so it bit on 4 of 18 tasks; on the
  rest nothing here says whether the question was in play, and those ties cannot be
  read as agreement.
```

Round 9's self-consistency column keeps `unrecorded 18` on the headline and gets **no** closing
sentence: its verdicts were never recorded either, so it has no ties to describe in the first place.
Round 8's two columns are `unasked` and print what they printed before.

#### What it still cannot distinguish

- **A count nobody took from a count taken and lost.** `unrecorded` covers both. A round that never
  put the question to a critic and one whose critic answered and whose answer evaporated write the
  same word, and only the column's `note` separates them.
- **A miscount that adds up.** Every arithmetic check here is internal. A critic who under-counts
  statements consistently across both runs produces a coherent block and an unfalsifiable column,
  and the block being checked against itself rather than against the prose is a deliberate choice
  with exactly this cost.
- **Whether the two runs' statements are the same statements.** `volume 9` against `volume 9` is
  reported as an even comparison whether the two runs made the same nine claims or nine different
  ones.
- **A round already judged.** Rounds 8 through 11 gain a label and no numbers. The first column this
  can actually populate is the next round's.
- **Silence that is correct.** A screen that says nothing because there was nothing to say scores
  `never in play` beside a screen that should have spoken and did not. The volume figure makes both
  visible; neither is penalised, and that judgement is still left to a reader.

### Pending fold-in — the corpus writes one temperature four ways, and the checker read the spelling

Round 11 named this and could not test it: *"the backing checker matches literally — it over-warns
on `165 °F` against `165° F`"*. The whole measured difference between the two arms on task V1 was
one space character the model happened to type, so the critic tied the task as model variance and
the checker's behaviour went unexercised. **A defect that can only be seen when the model varies is
a defect no round can score.**

It is also not the model's variance. The pack this app ships writes the same poultry temperature
**four ways**, and nobody chose that either:

| spelling | `165` in `packs/food-safety/docs/` | what the matcher made of it |
| --- | --- | --- |
| `165°F` | 9 | `°f` |
| `165° F` | 4 | `° f` — **a different key** |
| `165 degrees F` | 5 | `degree` — **scale discarded, no dimension** |
| `165oF` | 2 | nothing at all |

The spread is the pack's, not one document's. Counted by shape across all eleven documents:
`38 °F` and `26 °C` with no space, `19` with a space *after* the degree sign, `9` with one
*before* it, `21` spelling `degrees` out, and `8` with a letter `o` for the degree sign. Every
comparison in `toolGrounding` keys off that unit *string* — `armed.has(m.unit)`,
`c.unit === m.unit`, `found.unit === stated.unit` — so how a passage happened to space its degree
sign decided whether a figure was backed.

#### The over-warn, reproduced against the shipped pack

Corpus = `refrigerator-thermometers.md` + `safe-temperature-chart.md`, both verbatim. The fridge doc
writes `40 °F` and `40° F`, which arms the temperature dimension so the rung runs. The chart states
`165 degrees F` on **five rows**, and put nothing into the temperature corpus — so the only value
165 could be compared against was 40. **Nothing in this corpus is written the way a model writes the
answer.**

| the reply writes | before | after |
| --- | --- | --- |
| `165°F` | ⚠️ `1 measurement (165°F) … is not backed by the tool output` | no finding |
| `165 °F` | ⚠️ flagged | no finding |
| `165° F` | ⚠️ flagged | no finding |
| `165` + no-break space + `°F` | not a measurement at all | no finding |
| `165 degrees F` | no finding | no finding |

Three spellings faulted a correct answer that its own passages state five times; a fourth was not
recognised as a measurement at all, so the reply's temperature was neither checked nor named and the
screen said nothing. Which arm a reader drew decided which of those they got. Round 10's recorded
loss was this sentence over a *stale* corpus; round 11 fixed the staleness and this remained
underneath it.

#### What normalises, and what deliberately does not

The unit is normalised to **value and dimension** in `shared/measurements.ts`, so all of
`°F`, `° F`, `degrees F`, `degrees Fahrenheit` — and the Celsius forms — fold to one key before
anything is compared. Three functions each knew a different subset of those spellings
(`normaliseUnit`, `unitSpec`'s `replace(/^°\s+/, '°')`, and `temperatureScale`); there is now one
`canonicalTemperature`, and the other two call it. That is the file's own rule about the fourth copy,
applied to a third copy that had appeared inside the file itself.

Deliberately **not** normalised, each with the reason:

- **Bare `degrees`.** A temperature whose scale is unstated cannot be converted, and `90 degrees
  clockwise` is not a temperature at all. It stays dimensionless: armed by its own spelling,
  supported by its own spelling, nothing crossed. `[cf]\b` cannot match the `c` of `clockwise`,
  which is what keeps the scale-bearing branch off the geometry sense of the word.
- **`165oF`** — the OCR artefact in `safe-food-handling.md`, where a letter `o` stands in for the
  degree sign (all 8 occurrences are in that one document). Reading `o` as `°` would make the
  `5 of` in "5 of the 10 rows" a temperature. A silent false positive over ordinary prose is a
  worse trade than eight unarmed values in one document.
- **°C against °F.** Still two names, converted only by the exact arithmetic `UNITS` already
  carries. `165°C` and `165°F` are not the same measurement and neither are `1,650°F` and `165°F`.
- **The reported span.** The unit is folded for *comparison*; the span shown to the reader is still
  verbatim, because a warning naming a figure the reply does not contain is the defect this file has
  paid for twice.

The no-break space is the same rule read correctly. `[ \t]` was the whole of the number-to-unit gap,
and the reason a line break must not be crossed — a number ending one line and a word beginning the
next are two claims — has nothing to do with *which horizontal space* separates a number from its
unit. U+00A0 is precisely what a typesetter, a markdown renderer and a model writing `165 °F` reach
for to keep a unit with its number, and it made the measurement vanish entirely. The class now
carries space, tab, U+00A0 no-break, U+202F narrow no-break and U+2009 thin; `\s` would have been
shorter and would have swallowed `\n`, which is the bug the class exists to keep out. The
line-break trap is pinned by its original test.

#### Every loosening has a true positive, and one is a tightening

Against the same two-document corpus, each of these must still be named — and each is:

| the reply writes | why it must fire |
| --- | --- |
| `185°F` · `185 degrees F` | a temperature no passage states, in both spellings |
| `165°C` · `165 degrees C` · `165 degrees Celsius` | right number, wrong scale |
| `1,650°F` · `1,650 degrees F` | an order of magnitude out |
| `16.5°F` | the same, downward |
| `330 degrees F` | twice a stated value: an interval scale is not derivable |

**Four of those did not fire at all before this change**, and each is the over-warn's own defect
pointing the other way — the unit was not read, so nothing could disagree with it.

| the reply writes | round 12 | now |
| --- | --- | --- |
| `165 degrees C` · `165 degrees Celsius` | **silent** — certified by the passage's `165 degrees F` | flagged |
| `1,650 degrees F` | **silent** — certified as 10 × `165 degrees F` | flagged |
| `330 degrees F` | **silent** — certified as 2 × `165 degrees F` | flagged |
| `185 degrees F` | flagged as `185 degrees` — the scale stripped off the span | flagged in full |
| `350 degrees` (bare) | **flagged** — armed by the chart's `degrees F` rows | not compared, and says so |

Dropping the scale letter made `degrees f` and `degrees c` the same key, so a passage stating
`165 degrees F` certified a reply stating `165 degrees C` — 130 °F out, on a cooking temperature.
On the same corpus `165 °C` *was* flagged and `165 degrees C` was not. And because `degree` had no
dimension it counted as a **ratio** scale, so temperature's interval-scale exemption never applied to
it and any integer multiple of a retrieved temperature was certified. The last row is the same defect
in the third direction: an oven setting drew a warning from a poultry table. The loosening and the
tightenings are one change because they were one defect: **the unit was never read.**

24 cases, in `test/toolGrounding.test.ts`. 16 of them fail against the round-12 matcher; the 8 that
pass are the controls that must not move. The corpus is read off disk rather than transcribed,
because the point of the failure is that a corpus writes one value several ways — a fixture someone
typed out would have had one spelling in it.

#### The wrong-row under-warn: still no, and the artifact says so more plainly than round 10 did

The paired critique — the arm that stayed silent on `3 to 4 days (whole)`, whose only occurrences in
its own retrieved passages are ham rows — was re-examined against the recorded run
(`test/fixtures/citations/v1-r10-revision-lookups.json`) rather than re-argued. **The verdict is
unchanged: the existing disclosure is the right amount to say, and nothing is added here.** Three
facts, and the first two are new.

**The label that makes them ham rows is not in the passage.** Passage [5] is titled
`Food safety › Cold food storage chart` and its text *begins mid-row* — the first characters are
`ths |`, the tail of a truncated `months |`. The `Ham` section heading was chunked away. A rung asked
to flag a figure taken from the wrong row would have to reconstruct a heading that is not in the
text it was handed, and neither the app nor the reader can see it. That is a stronger refusal than
round 10's — round 10 argued from ambiguity (`3 to 4 days` on eleven rows), this argues from absence.

**Both figures are correct quotations of a row.** The reply reads *"3 to 4 days (uncured, cooked) or
up to 1 week if whole and store-wrapped"*, and the passage carries
`| Fresh, uncured, cooked | 3 to 4 days |` and `| Cooked, store-wrapped, whole | 1 week |`. Value,
unit and qualifier co-occur on one line in each case. Every check that could be built from the
retrieved text — value presence, qualifier co-occurrence, quotation fidelity — **passes both**. The
error is in the subject of the table section and nowhere else.

**And the only rule that would fire, fires on correct answers.** The chicken row
`| Fresh poultry | Chicken or turkey, whole | 1 to 2 days |` *is* retrieved, so a word-overlap
contradiction rung would catch `1 week if whole` against it. It would also catch a reply that
correctly said *"cooked whole chicken keeps 3 to 4 days"*, because `whole` is shared by the raw row
and the cooked answer — and choosing that `whole` discriminates while `fresh`/`cooked` does not is
the comprehension step `describeCoverage` refuses to make. Round 4's cry-wolf, arrived at from a
third direction.

So `Matched by value, not by row: … only the passage itself shows which one the answer took it from`
remains exactly and only what is true here.

#### Found while reading the artifact, not fixed

- **The row that answers the question was never retrieved.** `| Leftovers | Cooked meat or poultry |
  3 to 4 days |` appears in **none** of the run's three lookups. `3 to 4 days` occurs in the
  retrieved text on exactly three rows: two ham rows and one salad row. So what failed on this task
  is *retrieval*, not the backing checker, and a grounding warning here would have pointed the
  reader at the wrong rung. This reframes the critique rather than answering it.
- **A retrieved passage that starts mid-table-row is detectable and undisclosed.** `ths |` is a
  visible fragment; nothing on screen tells the reader that passage [5] is a table with its headings
  cut off. That is a disclosure the retrieval rung could make and the backing rung cannot, and it is
  where the honest version of the critics' finding probably lives.
- **`165oF` and its family** (`145oF`, `160oF`, `140oF`) arm nothing and support nothing. Eight
  values in `safe-food-handling.md` are invisible to every measurement rung. The fix is not in the
  matcher — see above — it is in whatever normalises a document on the way into a pack.

### Pending fold-in — the reply denied the tool calls printed directly above it

Round 11's critics found this in **both** builds and on more than one task. From the recorded runs
(`.h2h-runs/A11/VC3-20260828-122031`), the reply:

> No documents were used in that response — it came entirely from general knowledge already in my
> training data. I did not call any search or reference lookup tools.

and, on the same screen above it, `✓ ⚙️ reference_lookup` three times over and the app's own
provenance strip reading `📖 From the library: 17 passages from 3 lookups — the answer cites [1]
[5].` And on another task (`.h2h-runs/A11/TTU1-20260828-123018`):

> I'd need to consult additional sources beyond what's in your library. Would you like me to search
> for current guidance on that?

against `✓ 🔍 web_search` with three results already returned. The critic's summary: *"neither
build's checking pass looks at what the reply says about the application itself."*

Both shapes are in **both** arms. `B-current/TTU1-20260824-084108` is the same offer from the other
build — "The reference passages I checked do not contain information about how often you should
replace a fire extinguisher… Would you like me to search for current best practices from
fire-safety organizations?" — over the same pair of finished calls.

#### Why this direction and not the other

The grounding ladder has eleven rungs and every one checks a claim about the **world** — figures,
links, quantities, origins, addresses, contacts, quotations, attributions. One near-miss checks the
host: `unrunToolClaims` catches a reply that says it *used* a tool that never ran. The recorded
failures are the reverse, and the reverse is the worse of the two:

- A **fabricated** call inflates the reply's authority, and the evidence that refutes it is on
  screen — the reader who doubts "I searched the web for this" looks at the tool blocks.
- A **denied** call tells the reader those blocks mean nothing, and there is nothing on screen to
  check *that* against. It is the failure that teaches a reader to distrust evidence sitting in
  front of them, which is what the whole ladder exists to prevent.

`unrunToolClaims` cannot be widened into it: `NOT_A_CLAIM` throws out every negation, which is
correct for that rung and is exactly the hole. So `contradictedToolAccounts` is a rung of its own,
reading the same records in the other direction.

#### Scope: the act, and only the act

The rung settles one thing — whether a call the records hold happened. Two readings:

- **Denied.** The reply says, unhedged and about this turn, that a tool did not run: `I did not call
  any search or reference lookup tools`, `no tools ran`, `I didn't use reference_lookup`.
- **Offered.** The reply puts finished work forward as something it could do next, with no
  acknowledgment anywhere in the reply that it already happened.

Three neighbouring candidates were considered and **refused**, because the app cannot establish
them and a rung built on a fact it cannot establish is worse than the gap it closes:

| candidate | why not |
| --- | --- |
| *"It came entirely from general knowledge"* | A claim about the model's reasoning over passages it was handed. The records show the passages arriving; nothing shows whether a sentence was written out of them. Only the act sentence beside it is checkable. |
| *"It took essentially zero time"* against `52.7s total` | `run.json`'s `record.beyondAnyRecord` names a self-timed figure as the type case of what no artifact settles: a record of it is the same number written down twice and agrees by construction. And "essentially zero" is qualitative — the threshold would be invented here, which is the guess `describeCoverage` refuses to make about which measurement a reply is *about*. |
| *"a single PDF in the first-aid pack"* | `record.library` does name the installed packs — and it is a **bench** artifact, read by the harness through `libraryList()` after the turn, from outside the app. This pass is synchronous, runs in the renderer, and holds the turn's records and nothing else. |

The timing claim is reached anyway, through the fact the app *can* settle. In
`.h2h-runs/A9/VC3-20260827-183015` the reply prints `**Time taken:** Effectively zero seconds, since
no tool was invoked` — and the rung fires on `no tool was invoked`, over three lookups. The false
premise is the checkable half.

#### The on-screen string

> ⚠️ This reply's account of this turn contradicts what ran: reference_lookup ran 3 times and this
> reply says it did not run.

and for the offer half:

> ⚠️ This reply's account of this turn contradicts what ran: web_search ran once and this reply
> offers to run it.

It renders second in the banner, directly under `toolClaims` — the same claim, the worse direction.

#### The cry-wolf budget, spent on the recorded corpus

Round 4 established that a checker crying wolf costs more than the gap it closes, and this is the
highest-risk rung in the ladder: a hedge is not a lie, a sentence about a previous turn is not about
this one, and an offer to search *again* is not a denial. Swept over **all 320 recorded replies** in
`.h2h-runs` (200 of them carrying tool blocks), the first version flagged **7**. Five were real
denials; two were not, and both are now true negatives in the suite:

- **`B3/VC3-20260824-171623`** — the reply says *both* "I did use reference_lookup for your cooked
  chicken question" and "I did not use reference_lookup for the cooking temperature part". One
  lookup ran. Read alone the second sentence denies a call the records hold; read together they
  divide one call between halves of a question, which is a claim about *what the passages covered* —
  and this pass can no more adjudicate that than it can decide which measurement a reply is about.
  A tool the reply affirms anywhere now goes quiet everywhere. The suppressor is deliberately wider
  than `unrunToolClaims`' `CLAIM_LEAD` (which does not match "I did use"): a detector widened
  invents findings, a suppressor widened only loses them.
- **`A7/TTU1-20260825-021621`** — a search had run; the reply said the packs do not cover
  replacement intervals and offered "a **fresh** web search", "a **targeted** web search". Naming
  what would make the second search different from the first concedes the first as plainly as
  "again" does. The qualifier family joined the repeat list.

The sweep also found the opposite defect — a **miss**, and on the very run the brief was written
from. The excerpt above is a fragment; the whole of `A11/TTU1-20260828-123018` cites `[1] [2] [3]`,
says "The passages mention…" and "The references do direct you…", and `✓ ⚙️ reference_lookup` ran
alongside the search. An answer-wide acknowledgment gate read those **library** acknowledgments as
covering the **web search** and went silent on the recorded failure. So the gate is per tool: a
generic acknowledgment ("the results above", "I searched", a bare `[1]`) still counts, because with
one tool returning there is nothing else it could be about, and stops counting only when the
sentence names a *different* tool's corpus and that tool actually ran. On the same reply with only
the search running, the passages could only be its own and the rung is correctly silent — pinned as
a test, and the conservative direction.

After all three, the sweep flags **7 of 200**, every one read by hand and every one real: five
denials (`A11/VC3`, `A2/VC3`, `A8/VC3`, `A9/VC3`, `B4/VC3`) and two offers (`A11/TTU1`,
`B-current/TTU1`) — both shapes, both arms, exactly as the critics reported.

#### The true negatives, each beside its true positive

| the finding | the silence beside it |
| --- | --- |
| The recorded denial over three lookups | The **identical reply** on a turn that really ran nothing — the records are the whole difference |
| `I didn't use reference_lookup` over one lookup | `I didn't use web_search` when only `reference_lookup` ran; `I did not run any Python here` |
| — | Hedges: `I may not have searched`, `I don't think I called reference_lookup`, `If I did not use any tools…`, `…though I could be misremembering` |
| — | Back-references: `in that response`, `earlier in this conversation`, `before now` |
| An **errored** call still ran, so denying it is still false | A **declined** call never reached its handler, so denying it is true |
| — | A reply that affirms *and* denies the same tool (`B3/VC3`) |
| — | An offer to run the tool is not an affirmation it already ran — which is what keeps all five recorded failures flagged |
| The recorded offer, on the recorded turn's own two calls — only the search is faulted | The library half of the same reply, acknowledged at length, draws nothing |
| — | Offers to search **again / another / further / else**; the qualifier family (`A7/TTU1`) |
| — | An offer beside an acknowledgment **of that tool** (`I searched and found…`, `the results above…`, a `[1]` marker) |
| — | The same reply with only the search running: the passages can only be its own, so it reads as acknowledged |
| — | Offering a tool that did not run; offering one that ran and **found nothing** or **errored** |
| — | An offer that is not this tool's work (`summarise that into a checklist`) |
| Both halves end to end through `checkToolGrounding` | The honest reply on the same turn draws **no badge at all**, from any rung |

One tool earns one line: a denial swallows the offer beside it.

#### Limits

- The denial half reads only the **first-person, unhedged** form and the impersonal `no <tool> ran`.
  Modals are excluded on purpose — "I could not use web_search to find their number" is far more
  often a sentence about what the results contained than about whether the call went, and faulting
  it is round 4's cry-wolf in a new coat. The cost is a miss on a shape nobody has recorded.
- The offer half knows four acts (`web_search`, `reference_lookup`, `deep_research`,
  `fetch_webpage`). An act vocabulary is a guess about language, and every entry that is not
  unmistakably one tool's work is a way to fault a reply for a sentence about something else.
- The per-tool acknowledgment gate settles *whose corpus a sentence is about* with a word list, not
  by understanding it. A reply that acknowledges its search in terms borrowed from the library
  ("the documents I found") will be read as acknowledging the lookup and the search will go
  unfaulted. That is a miss, and it is the direction this gate is built to fail in.
- **Found and not fixed.** A reply that both cites retrieved passages and says its content came from
  general knowledge contradicts itself using the app's own record — `danglingCitations` already
  resolves the markers, so the pair is mechanically checkable. It is not the *act*, so it is out of
  this rung's scope, and it wants its own recorded true negative (a reply may cite a passage while
  honestly saying the passage did not supply a particular claim) before it is worth building.

### Pending fold-in — the plan header was the block's word about itself

A blind critic, on plan mode in **both** builds under test in round 12, naming it the single biggest
remaining gap:

> The plan header's progress fraction is the only thing visible without interacting, and it is the
> one number no artifact in the run can check — the audit records tools, never steps. A reader who
> trusts "3/3 steps done" is trusting the block about itself.

The critic is describing the record exactly. `trace/audit.jsonl` is hash-chained, exports with
`hashChainValid: true`, and for a three-step plan holds six lines: `session_start`, `user_input`,
one `tool_call` per call, `assistant_output`. Nothing in it marks where one step ended and the next
began. Both critics counted every plan step statement **unsettleable** rather than agreed, which is
the honest reading and is why this one mattered: the app's most prominent plan claim was the one
thing its own tamper-evident record could not speak to.

#### Two different defects wearing one sentence

The brief asked for step boundaries in the audit so the fraction would have "a witness". That word
is where the work was, because this project has already written the counter-argument down, in
`scripts/h2h-record.ts`, about this exact claim:

> a plan step is a construct of the application; nothing outside it observes a step starting or
> ending […] a step boundary it drew itself — writing any of those into a record makes the record
> agree with the screen by construction. That is not evidence. It is the same number twice.

Every word of that survives this round. Sigma Oasis is local-first and writes both the screen and
the log; nothing in a local-first app can be an independent witness to it. So the two things the
critic's sentence runs together were separated, and only one of them is closeable:

| | what it is | closeable? |
| --- | --- | --- |
| **uncorroborated** | a fact about who is watching | no — and pretending otherwise is the failure the quote above names |
| **unrecorded** | a fact about what was written down | yes, and it was wide open |

The second turns out not to need the header as its justification at all. The audit's own contract,
in its module docstring since v0.9, is *"an append-only transcript of what was actually said […] so
the user can verify a session."* A plan's steps each run their own sub-turn and each produce text
the reader is shown in the checklist — and **none of it reached the log**. A three-step plan that
called no tools left a record in which nothing whatsoever happened between the question and the
answer. That is a hole in the log against its own contract before it is anything to do with a
header, and it is the ground this change stands on: the bench did not ask for the field and would
not have been entitled to.

#### What the log carries now

Four kinds, and every one of them is something the block already puts on screen. Nothing else: a
step's constructed prompt and the prior-step results spliced into it are *layers in between*, which
this log has never carried.

| kind | fields | what it holds |
| --- | --- | --- |
| `plan_start` | `planStepCount` | the checklist as it was offered for approval — titles, details, and `toolPreview`'s own sentence for each step's forecast |
| `plan_step_start` | `planStepIndex`, `planStepCount` | one step beginning; the `tool_call` lines it makes follow, until its end |
| `plan_step_end` | + `planStepStatus` | the terminal status the row shows, and the result the disclosure holds |
| `plan_end` | `planOutcome` | `OUTCOME_LABEL`'s own words, attribution included (`cancelled by you — nothing ran`) |

A step that never ran writes nothing. Its absence *is* the fact, and `planLedgersFromAudit` puts it
back through `endPlan` — the block's own rule, not a second spelling of it. So a plan cancelled at
the approval gate reconstructs as N never-ran steps from a record holding no step lines at all.

The boundaries also give the `tool_call` lines somewhere to sit. A call between a step's start and
its end was made by that step; a call after `plan_end` belongs to the synthesis, which is exactly
what the block already does with them on screen (`stepRecords` versus `answerRecords`). Before this,
a plan's twenty calls arrived in the log as one undifferentiated run.

#### The header is now counted, not asserted

`planHeaderCount` stopped counting a `ChatPlan` and started counting a **ledger** — total, one status
per step, outcome. A ledger has two sources: `planLedger(plan)` and `planLedgersFromAudit(entries)`.
One counting function, two readings. A reader with an exported log counts the `plan_step_end` lines
marked `done` for the numerator and reads `planStepCount` for the denominator, and the chain says
nobody edited those lines afterwards.

**What the log deliberately does not contain is the sentence itself.** Writing `3/3 steps done` into
`plan_end` would make the record "agree" with the screen on every run, at no cost and with no
information — which is precisely the move `BEYOND_ANY_RECORD` refuses. The lines carry the facts;
the arithmetic stays on screen, where a reader who wants to check it has to redo it. Two cases pin
that: no line matches `\d+/\d+ steps done`, and none matches the census shape either.

And one writer. Through v2.4 the executor patched the store and the log knew nothing about it; a
second pass that logged whatever the store ended up holding would be the screen agreeing with a copy
of itself. `beginStep` / `endStep` / `finish` each patch **and** record, so a status cannot reach one
place without reaching the other — read off the source, like the single writer of `cancelled`.

#### Backward compatibility, which is the part that could have gone badly

The chain hashes `JSON.stringify(entry)`. A field added unconditionally — even as `null` — changes
those bytes for every entry ever written, and **every existing log stops verifying on the first
launch after the upgrade**: a tamper-evident record that silently reports tampering it did not
suffer is a worse failure than the one this round fixes. The four plan fields are therefore spread
in conditionally, exactly as `roleName`, `modelId`, `toolName` and `ok` already were, and the case
that guards it builds a file by hand in the pre-v2.5 shape rather than one this build wrote — the
second only proves the build agrees with itself, which is this round's whole subject. A `user_input`
still serializes with the keys `at, kind, conversationId, text, prevHash`, in that order.

Two enumerations were also collapsed. `AuditEntryKind` was declared in `main/ipc/audit.ts` and again
in `renderer/src/types.ts` and kept in step by hand — the arrangement `evals.md` already calls a
defect where it happens to `GroundingReport` — and `recordAuditEntry`'s runtime guard was a *third*
hand-written copy of the same four names, where a kind added to the type and not to the guard
typechecks clean and is dropped silently on the floor. All three now read `AUDIT_ENTRY_KINDS` in
`shared/audit.ts`, and the case walks that tuple rather than a list someone remembered.

#### True negatives

- **Existing logs verify unchanged**, and a pre-v2.5 file correctly reconstructs as holding *no*
  plan rather than an invented empty one.
- **A non-plan entry's key set and order are asserted exactly** — a build that wrote
  `planStepIndex: undefined` on every line would pass a `chainValid` check on its own new files and
  fail this.
- **A closed fraction is still a closed fraction**: `3/3 steps done` rebuilt from the record is
  still `3/3 steps done`, and every v2.4 header case is untouched.
- **The reconstruction can disagree.** Drop one `plan_step_end` — what a build that marked a step
  done without running it would leave behind — and the two sentences part company. Without this the
  suite would be pinning a tautology.
- **The class, not the fixtures**: every outcome in `PLAN_OUTCOMES` crossed with every status in
  `PLAN_STEP_STATUSES` rebuilds the same sentence the header draws. A counting function walking one
  list and a writer walking another would surface here, on the combination nobody wrote a fixture
  for.
- **A run cut off mid-step** comes back as a step that started and never ended, with no outcome —
  not rounded off to finished, and not dropped for want of an end line.
- **The bench still refuses to call agreement corroboration.** `BEYOND_ANY_RECORD` keeps its plan
  entry, narrowed: the header *can* now be contradicted by the record, and that is a finding;
  agreement is consistency, because the application wrote both. The `session-audit` entry claims
  exactly that much, in the same words the `configuration` block has always used for capability
  versus exercise, and is asserted not to contain `confirms`, `corroborates` or `proves`.

#### What this does not fix

- **The audit is opt-in and off by default.** On a run that kept no log the header is exactly as
  uncheckable as it was; what changed is that asking for a record now gets you one. Turning it on
  for the bench's own tasks is still refused, for the reasons `h2h-record.ts` gives at length.
- **`done` means the sub-turn did not throw.** A step whose model produced nothing is marked `done`
  with the body `(empty result)` and counts in the numerator, on screen and in the record alike. The
  record now makes that visible to anyone who reads it — the empty body is right there in the
  `plan_step_end` line — but the header still counts it as work. Reproduced, not fixed: what a
  fraction should do with an empty step is a question about the checklist's vocabulary, not about
  the log.
- **`planLedgersFromAudit` segments by order alone.** Turns are serialized, so plans cannot
  interleave, and the entries carry `conversationId` if that ever stops being true. Nothing checks
  it today.
- **The block still renders from memory, not from the log.** Two stronger-sounding arrangements were
  considered and refused. *Rendering the header out of the audit* would make the count unavailable
  to the 99% of users who never enable an opt-in log, and would put an async IPC read inside a
  synchronous render for a number the block already holds. *Displaying "checked against the record"*
  would be the app checking its own record and reporting agreement — the same number twice with an
  extra step, and a badge that reads as corroboration to anyone who does not read this file. What is
  guaranteed instead is structural: `beginStep` / `endStep` / `finish` write both, so the two cannot
  be computed from different states. The reading-back is for the test suite and for a person with
  the exported file, which is the honest arrangement and also the one almost nobody will use.
### Pending fold-in — the disclosure quoted the runtime and never said what it meant

Third round on one disclosure. Round 11's critics read its **label** introducing nothing; round 12
named the control (`The runtime reported:` → `What the runtime reported`) and a blind critic saw the
difference. Round 13's critic **opened** it, in both arms, and read the whole of what opening it
bought:

> **What the runtime reported**
>
> `BodyStreamBuffer was aborted`

#### Why the string reaches the screen, which is not the reason it looks like it is

It is not a leak, and the boundary is not being bypassed. The call site
(`verification.ts` `runRecompute`) hands the thrown value to `explainFailure`; rule 2 catches it by
**type** (`name === 'AbortError'`, never by message); the app's own sentence is written
(`🧮 Recompute skipped — stopped before it finished`); and the raw text is kept in `detail` behind a
disclosure under a label naming whose words they are. Every one of those is the design working. The
raw text is kept on purpose, as an absolute the module states about itself: *the raw text survives in
every class the module translates, including aborts, where it arguably adds nothing.*

So the third possibility — *it is deliberately raw because it is behind a disclosure* — is the
standing position, and it is right about the **quote**. What is wrong is one structural fact nobody
had looked at:

**The verification banner is the only surface in the app that renders a `detail` with no `sentence`
anywhere near it.** `ToolCallBlock` renders *What happened* → `failure.sentence` → remedy → the
quote. `composeFailure` and `copyableFailure` both put the sentence first. `describeRecompute` is
handed `headline` and `detail` and never sees the rest of the `Failure`. So a reader who opened the
disclosure to learn more got **less than the line above it** — a fetch's name for its own response
buffer, and nothing that says what it means. Round 12 found the same fault one layer up and fixed
the half it could see: the label was a promise with nothing behind it, and the body is a quotation
with no reading beside it.

#### What changed

`FailureDetail` gains `reading` — what the app read those words to **mean**, in the app's own voice,
composed by one exported function (`readingLine`) so the speaker has one spelling and not three.

| | before | after |
| --- | --- | --- |
| collapsed | `What the runtime reported` | *unchanged* |
| opened | `BodyStreamBuffer was aborted` | `BodyStreamBuffer was aborted` — then `The runtime’s wording for: cut off before it finished — nothing crashed; either it was stopped, or the connection dropped.` |

Three properties carry the argument, and each one is a rule already in the file rather than a new
judgement:

1. **The gloss is of the CLASS, never of the message.** `BodyStreamBuffer was aborted` and `signal
   is aborted without reason` get **one** reading between them, because they are one `DOMException`
   under two engines. It glosses *aborted* — the word both of them share — and not `BodyStreamBuffer`,
   which only one of them names. A gloss keyed on a message would be rule 2's enumeration mistake
   wearing prose, and a new one would be needed for every wording an engine ships next.
2. **Present exactly when the app placed the failure.** Rule 3 says an unplaced failure gets an
   honest sentence and no guess; a gloss on words the app could not read *is* the guess. So
   `reading !== undefined` ⟺ `recognised`, asserted as an equivalence over the whole corpus rather
   than as a list of cases — a list is what gets a case added to it without the rule being
   reconsidered.
3. **The label and the body still agree.** The summary promises the runtime's own words and
   something else is now under there with them. What keeps the promise is that the second line
   *talks about* the first: it names the speaker in the possessive and then reads them, outside the
   `<pre>` and in the app's ordinary ink, so the two voices are separated by the surface as well as
   by the words. The verbatim line is still verbatim, still quoted, and still first.

Rendered on both disclosures and in both string forms — the gloss travels with the quote everywhere
the quote goes. Which surfaces "need" one is a judgement made per call site, and this module's own
rule about per-case judgements is that one of them comes out wrong somewhere; the banner is where
that already happened.

#### The eval cases — `test/failureBoundary.test.ts` (55 → 63)

| true positive | the true negative beside it |
| --- | --- |
| Opening the disclosure now buys a reading: *cut off before it finished*, *stopped, or the connection dropped* | It reads the words rather than repeating them — `assert.doesNotMatch(line, /BodyStreamBuffer/)` — and `detail.text` is still byte-identical |
| Both engines' wordings, and a wording no engine ships yet, get the **same** reading | — |
| — | **A failure the app never placed is not glossed**: `Fatal: 0x8007007e`, `ENOSPC: …`, `TypeError: …`, `write EPIPE`, and a relayed `gpu_layers mismatch: 33 != 0` all keep `reading === undefined` and `readingLine() === null` |
| — | The equivalence over the corpus: `reading !== undefined` ⟺ `recognised` on every one of 10 runtime strings. The 23 `APP_PROSE` sentences go through the same loop and are skipped by it — the app wrote them, so there is no quote to gloss and no `detail` at all, which is the behaviour their own case already pins |
| The reading is unmistakable for the quote: `“BodyStreamBuffer was aborted”` precedes `The runtime’s wording for:`, in `composeFailure` and in the pasted bug report alike | **The unglossed disclosure is byte-for-byte what it was** — round 12's two pinned assertions re-pinned with `$` anchors, so an unplaced failure's surface is provably undisturbed |
| The banner renders `readingLine(c.detail)`, and `ToolCallBlock` renders it too | No `<pre>` block in either component contains it — the gloss is never inside the verbatim block |
| — | A `WorkbenchCheck` stored **before** v2.5 has a `detail` and no `reading`: it renders the quote alone and claims no meaning nobody recorded (the rule `TurnEnding.completed` is already under) |

Suite: **2499 passing, 0 failing** (from 2491), plus 25 + 72 + 119 + 43 bespoke checks unchanged.
`bash scripts/test.sh` exit 0.

#### What this does not fix

- **The `readsAsProse` hole is still open, and it is now measured.** `readsAsProse('BodyStreamBuffer
  was aborted')` returns **true** — capital, space, no machine token — exactly as recorded when the
  boundary was built. It is not what put the string on the screen here (rule 2 fires first, on the
  thrown object), but it is live: `readToolFailure` in `shared/tools/outcomes.ts` passes a **string**
  to `explainFailure`, so every tool failure crosses the boundary with its type already destroyed
  and this shape test is the only gate. An abort stringified by a handler therefore becomes the
  app's **own sentence** with `detail: null` — the wording printed unquoted, and the evidence
  deleted rather than merely raw. That is strictly worse than what this round repaired.
- **And it cannot be closed by shape.** The obvious repair is to drop the trailing-colon requirement
  from `MACHINE_TOKEN`'s CamelCase arm, so a bare multi-hump identifier is caught and not only
  `TypeError:`. Measured against the corpus, that arm rejects three sentences the app writes about
  itself: `DuckDuckGo returned HTTP 403`, `DuckDuckGo did not issue an image-search token.` and
  `Rendered with JavaScript because …`. `BodyStreamBuffer` and `DuckDuckGo` are the **same shape** —
  three humps of concatenated common nouns — and no shape separates them, which is why the hole was
  documented and left open rather than patched. What separates them is *knowledge*, and the file
  already has the precedent for it: `declinedCall` marks the app's own clause so the translator can
  tell it wrote it, and `assert`s that knowing beats guessing. Closing this properly means either
  preserving `name` across the tool-result IPC (so rule 2 can fire where it currently cannot) or
  marking the app's own handler prose the way declines are marked. Both are real changes to a
  boundary the app crosses on every tool call, and neither is a regex.
- **`ToolCallBlock` still hand-rolls its attribution** (`{failure.detail.source} reported`, no
  capital, no colon) instead of calling `attribution`. That is the third spelling of a label
  `attribution` was extracted to prevent, and it is a latent drift rather than a defect anyone has
  read — the string it produces is correct today. Left alone: no critic has reported it, and
  changing a rendered line on suspicion is what round 8 ruled against.
- **Nothing here was re-run against a model.** The before/after strings are produced by the shipped
  modules against the recorded inputs. No win/loss claim attaches to any of it.
### Pending fold-in — the ledger line counted a moment the list beside it did not

Round 12's blind critic found this in **both** builds, on the same task, twice over, and scored it
a disagreeing pair each time: *"The ledger line miscounts the session variables printed directly
beneath it, in both arms and by exactly one, twice (TTU2)."*

From the recorded runs, the last two lines of the reply's own bubble:

```
.h2h-runs/B12/TTU2-20260828-151045
  Session variables (persist in this conversation): generate_primes, is_prime, prime_sum, primes.
  📒 Ledger: 3 computed facts, 3 session variables from 2 turns          four named, three counted

.h2h-runs/A12/TTU2-20260828-155621
  Session variables (persist in this conversation): is_prime, primes, total.
  📒 Ledger: 2 session variables from 2 turns                          three named, two counted
```

Both arms, same direction, off by exactly one — which reads like a fencepost and is not one.

#### The name that was missing rules the fencepost out

`buildLedger` holds the newest `Session variables` list any `run_python` result reported. In B12
that list, at the moment the line was written, was turn 1's:

| | |
| --- | --- |
| ledger held | `generate_primes, prime_sum, primes` |
| block above printed | `generate_primes, is_prime, prime_sum, primes` |
| the difference | **`is_prime`** — the second of four, sorted |

The missing name is in the *middle* of the list. No fencepost, no `slice`, no cap and no
private-name filter reaches only that one. It is missing because it did not exist yet when the
count was taken: `is_prime` was defined by a run **inside the reply the line is printed under**.

#### Two exclusions, and only the first is on screen

**1. The ledger is written before the turn it is printed on.** The ledger exists to be handed to
the model, so `ledgerProvider` builds it from every message *except the reply being written* — it
has to, because the block must reach the model before the model answers. The line is then rendered
at the bottom of that same reply, a few lines under the `run_python` block whose output ends with
the `Session variables` note. The two lists are one turn apart by construction, and any call in the
reply that defines a name makes them differ by exactly that name. Both recorded arms are this.

**2. A run that raised was read as having reported nothing.** `buildLedger` gated *everything* on
`rec.status === 'done'`, session list included. B12's turn 2 is where that shows: both of its runs
raised — after defining `is_prime` — and the sandbox reported the session it still held in **both**
error results, because it deliberately keeps its globals through an exception ("a session keeps its
globals — like a REPL, an exception mid-run leaves earlier definitions standing",
`src/main/ipc/workbench.ts`), and the `run_python` handler appends the note on the error path for
exactly that reason. The ledger threw it away and went on carrying turn 1's three names into every
later turn. This one is not visible in the round's screenshots; it was found reading the recorded
run that produced them.

The two are different in kind, and so is the repair. A **fact** is something a run computed, so a
run that did not complete establishes none — that gate stays. The **session list** is not computed;
it is the sandbox reporting which globals it holds. It is now read from a `run_python` result
whether the run finished or raised, and from nothing else.

#### The count was right, the list was right, and they were never the same thing

Which is the third of the three possible repairs. The count was a true count of what the app
carried into the turn; the list was a true list of what the sandbox held after the reply's own run.
Correcting either would have made it lie. What was wrong was printing them as though they were
comparable, so the line now names its moment:

```
📒 Ledger as this turn began: 3 computed facts, 3 session variables from 2 turns
```

"As this turn began" is exact rather than approximate: the user's message for the turn is in the
ledger — it is what began the turn — and nothing the turn has since produced is. A reader who sees
four names above and three counted below can now settle the difference without leaving the screen;
the line's `title` says the rest — that a call in this reply which defines a variable is not in
these counts, and joins them next turn — and the Settings copy says it too.

#### What is pinned

| the case | what it fixes in place |
| --- | --- |
| B12's two lists, from its own strings | the ledger holds `generate_primes, prime_sum, primes`; the difference is `is_prime`, second of four sorted — the assertion that makes a fencepost explanation fail |
| A12's two lists, from its own strings | two counted against three named; the difference is `total`, defined by this reply's run |
| both arms' disclosure lines, character for character | `📒 Ledger as this turn began: …`, and no longer the bare `📒 Ledger: …` that read as a count of the state on screen |
| a turn whose own run defines nothing new | the moment is named there too — no special case, the wording does not depend on whether the two agree |
| a `run_python` that raised | its session list is read: 4 variables, not 3 |
| the same raised run's stdout | establishes **no facts** — the gate that stays |
| a call still running | contributes nothing; there is no result to read |
| every count in the line against the block | each number is the length of the list printed under its own heading, for facts, files, constraints, decisions and session variables alike — the line is reconcilable against the one list it does describe |
| `ledgerProvider` end to end | the in-flight reply is excluded, the patched line is the as-of one, and the block carries the pre-turn list |

#### Limits

- **The lag is real and stays.** The line is a disclosure of what the model was given, so it cannot
  be recomputed after the turn without ceasing to be one: a post-turn count would claim the model
  saw a variable it never saw. The fix is that the line says which moment it counts, not that the
  two moments were merged.
- **Found and not fixed.** The runs that defined the extra variable in both recorded arms were
  **app-initiated verification runs** — "running the Python in the answer to check that it works",
  "recomputing the figures stated in the answer" — executing in the user's conversation session and
  leaving `is_prime` and `total` behind in it. The app's own comment says the verification runs are
  "sessionless by construction"; through the `run_python` tool handler with a conversation id, they
  are not. Whether a check should be able to write to the session the user's next turn will read is
  a question about the checks, not about the ledger, and it wants its own round.
- `LEDGER_MAX_FACTS` still truncates silently at 24. The line and the block truncate together — the
  count is taken after the slice, so the two agree — but neither says that older facts were dropped.
### Pending fold-in — a sixty-second limit that stopped no clock

Round 12's critics found this in **both** builds, and in each run it was the single pair of
app-written lines they scored as disagreeing. On TTU1, one message
(`.h2h-runs/judge-r12/TTU1/run-1`, which is `B12/TTU1-20260828-150740`):

> ⏱ Checking stopped at its 60s limit. Ran: the code check. Not run: the revision.
>
> 282 tok · 5.2 tok/s · 23.19s to first token · 9.2s gathering · 54.3s answer · **114.1s checking**
> · 177.7s total

The other arm (`judge-r12/TTU1/run-2` = `A12/TTU1-20260828-155303`) is the same banner over
**81.3s checking**. The critic's line: *"both screens still print 'Checking stopped at its 60s
limit' next to a checking figure of 114.1 s / 81.3 s."*

A second critic, on a different task, scored the **identical pair of lines as agreeing** — because
there the checking figure was 60.1 s (`judge-r12/V3/run-1`). So the two lines are consistent when
the budget is kept and contradictory when it is overrun, and the question the round has to answer is
not how the sentence is worded but why checking runs to nearly twice its stated limit.

#### What actually happened, from the same capture

Four lines above the banner, in the tool-call list of that very message:

> ∅ 🔍 deep_research — No usable sources were found… **Searched 8×, read 3 page(s) across 1
> domain(s) in 93s.**

That call is the revision pass's. `reviseAgainstFindings` runs with the slot's real tools on purpose
— the first option offered to a model holding a flagged specific is to *verify* it, not to delete it
— and the model reached for `deep_research`. The arithmetic closes: the revision was admitted at
~1 s with the whole minute in front of it, spent the best part of twenty seconds asking the model
for a correction, and the campaign it asked for ran 93 s. The other arm is the same shape with a 44 s campaign
(`Searched 3×, read 0 page(s) … in 44s`) and lands at 81.3 s.

So of the three shapes this could have been, it is the first, and the enumeration is worth writing
down because two of them were also true in small part:

- **The limit is checked between passes, not during one.** Yes, and that is the whole of it.
  `admits()` gates what may *start*, and `budget.signal` aborts the model streams a pass is waiting
  on — `runClaimCheck`, `runAutoCritic`, `runRecompute` and `reviseAgainstFindings` all take it. What
  no signal reaches is `window.api.executeTool`: an IPC round trip to the main process with no
  cancellation path. A `deep_research` campaign or a `run_python` sandbox boot dispatched at 0:59
  runs until it returns, and the reader waits.
- **The two figures were measured over different spans.** True, and by a smaller amount than it
  looks. The budget's clock started where control reached `createVerifyBudget`; the stat line's
  "checking" span starts at the last token (it is `turnMs − gatherMs − totalMs`, and `totalMs` is
  stamped there). Between the two sit the paced tail drain and the turn's end-of-stream bookkeeping
  — which is why **every** well-behaved tail in `.h2h-runs` reads 60.1, 60.2 or 60.3 s against a
  60 s limit and never 60.0.
- **The budget is not enforced.** True in one narrow place, now closed: `runAgentLoop` consulted its
  signal before a round and after it, never between the calls one round asked for. A round
  requesting three tools dispatched all three however long ago the deadline had fired.

#### The repair, and the trade it refuses

A checking pass already in flight cannot always be abandoned safely, and killing a 93-second
research campaign at the 60-second mark — after the reader has already paid for 60 of those seconds
— to make a sentence true would be the wrong way round. The honest answer is that **the limit bounds
what checking STARTS, not what it FINISHES**, so that is what the app now says.

1. **One clock.** `createVerifyBudget` takes the origin from the caller, and `runTurn` hands it
   `answerEndedAt` — the very stamp `totalMs` is measured to. The deadline now counts the same span
   the footer calls "checking", so a figure above the limit is an overrun and nothing else.
2. **One number.** `runVerificationTail` takes a single `tailEndedAt` stamp and hands it to both
   `budget.notice()` and `turnMs`. A screen that states one quantity twice states it identically.
3. **Two sentences, because there are two facts.** A tail that ends at its limit keeps the sentence
   it had. A tail that overruns by a second or more says so, in the stat line's own word and figure.
4. **Three states, not two.** `Not run` used to cover both a pass that never began and a pass the
   deadline caught in flight — and on TTU1 that printed `Not run: the revision` directly beneath the
   revision's own `deep_research` row, which is the shape round 12 repaired one pass over. A pass
   that began and was stopped is now `Cut short`.
5. **Nothing new is dispatched after the deadline.** The per-call loop checks its signal, and a call
   it declines goes through `declinedCall` — so the row wears `↩` and the footer says "declined",
   because nothing was contacted and nothing broke.

TTU1, both arms, with the same measurements:

> ⏱ Checking stopped starting new work at its 60s limit; a pass already running carried it to
> **114.1s**. Ran: the code check. **Cut short: the revision.** The answer above is unchanged.

> ⏱ Checking stopped starting new work at its 60s limit; a pass already running carried it to
> **81.3s**. Ran: the code check. Cut short: the revision. The answer above is unchanged.

#### The true negatives

- **`judge-r12/V3/run-1`, the recorded agreeing pair.** Both remaining passes were refused at their
  gates and nothing was in flight, so the tail ended at 60.1 s. The sentence is **word for word the
  one it already had** — `⏱ Checking stopped at its 60s limit. Ran: the code check. Not run: the
  revision, the recomputation. The answer above is unchanged.` — and acquires no overrun clause it
  has nothing to report. Pinned as an exact string equality, not a pattern.
- **`B10/TH2`, the other recorded agreeing pair**, at 60.1 s: `Ran: the claim check, the code check.
  Not run: the revision.` Unchanged.
- **The boundary.** Every honest tail in `.h2h-runs` lands at 60.0–60.3 s; the overruns are 62.2,
  69.4, 81.3 and 114.1. The clause appears at one second and not before — 60.0, 60.1, 60.3 and
  60.999 keep the plain sentence, 61.0 and up do not — because a second is the resolution the reader
  is reading at, and `60.1s checking` beside a `60s limit` is the pair a critic scored as agreeing.
- **A pass the deadline genuinely cut off** — `runRecompute` aborted before a program came back,
  showing `🧮 Recompute skipped — cancelled` — is `Cut short`, not `Ran`. The notice may
  under-claim; it may never over-claim.
- **`B10/FR3`, round 11's case** — not a negative but the regression this must not undo — replays
  correctly through both changes at once: `⏱ Checking
  stopped starting new work at its 60s limit; a pass already running carried it to 62.2s. Ran: the
  code check, the recomputation. Not run: the revision.` The recomputation is named as run, which is
  round 12's fix; the 2.2 s is now accounted for, which is this round's.
- **A user Stop still leaves no notice at all**, and a turn stopped before the tail begins never
  opens a budget. The reader who pressed Stop knows why the checking ended.
- **A call already in flight when the deadline lands is allowed to finish** and is recorded `done`;
  only its unsent siblings are declined. Killing it is the trade this round refuses.

#### Limits

- **The overrun is disclosed, not prevented.** A single `deep_research` dispatched at 0:59 can still
  take the tail past three minutes, and nothing here shortens it. The one enforcement that costs no
  work already paid for — refusing the calls behind it — is in; the rest would mean handing the
  remaining budget down through `executeTool` into the main process as a per-call deadline, which is
  a real repair and a larger one than a sentence.
- **A tail that overruns and loses nothing still says nothing.** If the deadline fires during the
  last pass and that pass finishes, no pass is lost and there is no notice — so a `68s checking`
  can appear with no line beside it. That is not a contradiction, but it is also not an account.
- **`VERIFY_OVERRUN_FLOOR_MS` is a reading threshold, not a measurement.** It says how far apart two
  printed figures have to be before a reader would call them different, and one second is a
  judgement about the stat line's one decimal place. Print two decimals there and this number is
  wrong.
### Pending fold-in — the reply invented the retrieval whose true account was printed above it

Round 12's critic found this in **both** builds, on the same task, and made it the round's highest
contested count: three record-level contradictions per run. Task VC3 asks, in as many words, *"Which
documents from my library did you actually use just now, how relevant were they, and how long did
that take?"* — and both arms answered it with numbers nothing had returned.

`.h2h-runs/judge-r12/VC3/run-2` (arm A, `A12/VC3-20260828-161158`). One `reference_lookup` ran and
returned five passages, every one of them labelled `Food safety › …`:

> 1 call was made to the reference_lookup tool with query "how long to cool a burn under running
> water"
> It pulled from the **First Aid Basics** pack (6 passages max)
> It returned 3 relevant passages, all citing "First Aid Basics › Burn Treatment"

`.h2h-runs/judge-r12/VC3/run-1` (arm B, `B12/VC3-20260828-152450`). Two lookups returned eleven
passages carrying relevance `1 / 0.818 / 0.767 / 0.72 / 0.718` and
`1 / 0.945 / 0.924 / 0.922 / 0.885 / 0.802`:

> **Documents used:** The reference lookup returned **4 passages** from the **health pack** …
>
> | Passage | Similarity Score | … |
> | #1 | 0.83 | … | #2 | 0.79 | … | #3 | 0.76 | … | #4 | 0.62 | … |

There is no health pack and no First Aid Basics passage in either run. One message above each of
these the app had printed its own provenance strip — `📖 From the library: [1] Food safety › Safe
minimum internal temperatures · 6% in (1.00), … [5] Food safety › Cold food storage chart · 37% in
(0.72)` — and said nothing. The critic's summary: *"Each build holds the exact provenance data on
screen — the pack names, the passage counts, the relevance figures — and each let the reply
misdescribe all three without a word."*

#### Why the existing rungs are all silent here

Every rung in the ladder reads the records of **the turn it is checking**, and VC3's retrieval ran
one turn earlier. That is not an accident of this task; it is the shape of the question. Nobody asks
what a lookup returned until after it has returned, so a provenance question is *always* asked a
turn late, and a pass scoped to `allRecords` is structurally blind to the whole family.

Even with the records in hand, none of the eleven rungs asks this question. `unrunToolClaims` and
`contradictedToolAccounts` settle the **act**; `overstatedToolCounts` settles **how many calls**;
`statedArgumentsIn` settles **what went out**. What came *back* — the pack, the passage count, the
relevance figures — was never read, and it is the half of the record a reader actually cites.

#### The corpus: the same artifact, one message up

`misdescribedRetrieval` takes `RetrievalTurns` — `ChatMessage.toolCalls` for each earlier assistant
turn, one array per turn — and this is the one place the pass looks outside its own turn. It is
**not** the bench artifact v2.3 refused: `record.library` is read by the harness through
`libraryList()` from outside the app, whereas this is the same in-memory renderer array `records`
already is, held synchronously, in this conversation.

Grouped per turn and never flattened. `turnLookups` claims each passage number once and a turn's
numbering restarts at `[1]`, so a flat list would let turn two's `[1]`–`[5]` collide with turn one's
and vanish — the check would then *understate* what was retrieved, which is the direction that
invents findings.

**And the ambiguity is designed out rather than guessed at.** Which earlier retrieval is the reply
describing? The pass does not decide. A claim is faulted only when it matches **nothing any turn in
the conversation retrieved**, so no reading of "just now" can rescue it. Every widening of the truth
set — each lookup's own count, each turn's total, the conversation's total, every segment of every
citation line, and the `pack` argument of calls that returned nothing — can only ever *silence* the
check.

#### Scope: three numbers with a witness, and four claims refused

| settled | how |
| --- | --- |
| **Which pack** | Every `›`-segment of every citation line the lookups returned, plus any `pack` argument sent. A past-tense report of retrieval `from the <name> pack` whose name matches none of them. |
| **How many passages** | A count adjacent to the noun (`4 passages`) in a sentence reporting what came back, matching no lookup's count and no turn's total. |
| **What relevance came back** | A decimal in [0,1] under a `relevance` / `similarity` heading, matching no passage's score at full precision, 3dp, 2dp or 1dp, rounded **or** truncated. |

Four neighbours were considered and **refused**, for v2.3's reason — a rung built on a fact the app
cannot establish is worse than the gap it closes:

| candidate | why not |
| --- | --- |
| *"The answer combined what was available from those results with established food safety knowledge"* | Where the answer's **content** came from. Out of scope since v2.3 and always will be: the records show the passages arriving, and nothing shows whether a sentence was written out of them. |
| **How many lookups ran** | `overstatedToolCounts`' rung, and neither recorded reply miscounts — run-2 says "1 call" and one call ran. What this round changes there is a phrase, not a rule: `N calls **were made to** the tool` is the passive of a claim that rung already reads, and it is how the recorded corpus writes it. |
| **Understated** counts | A partial count is a true sentence — "I ran one lookup for the storage half" over two lookups — so telling a total from a part means reading the sentence, not looking up the record. Only claims no reading can rescue are faulted. |
| *"The top two passages were strong matches"* | A relevance **ranking** is the model's own reading of passages it holds. `describeCoverage`'s refusal applies unchanged: the app cannot decide which passage answers the question, so it cannot fault an opinion about which one did. |

And one refusal inside a sentence the rung otherwise fires on. Run-2's *"It returned **3 relevant**
passages"* draws nothing, because the count rung requires the number to be adjacent to the noun. The
sentence has two readings — three came back, or three of what came back were relevant — and the
second is a claim about relevance the app has already refused to adjudicate. The cost is a miss on
half of one recorded line; the other half (`the First Aid Basics pack`) is faulted, so the reader is
not left without a warning on it.

#### The cry-wolf budget, spent on the recorded corpus

Swept over **all 432 recorded replies** in `.h2h-runs` (204 of them in conversations carrying a
`reference_lookup`), with records reconstructed per turn out of each run's
`transcript-expanded.txt`. The first version flagged **8**. Six were real; two were the same reply
captured twice, and it was a false positive:

- **`A7/VC3-20260825-022756`** (= `judge-r7/VC3/run-2`) — five passages came back; the reply says
  *"**Two passages were retrieved:**"* and then lists exactly two, `[1]` and `[5]`, each with what it
  states. Read against the record that sentence is false; read against the colon under it, it is a
  heading for a list. The app cannot tell "retrieved" from "used" there, so it does not try — it
  asks instead whether the reply put that many passages on the page, which is a count it can take
  (`citedIndices`). Suppression only, and one-directional: eleven claimed over two cited is still
  faulted.

After it, the sweep flags **6 of 432** — three distinct replies, each captured twice, every one read
by hand and every one real:

| run | flagged |
| --- | --- |
| `A12/VC3` = `judge-r12/VC3/run-2` | the `First Aid Basics` pack, over five Food safety passages |
| `B12/VC3` = `judge-r12/VC3/run-1` | the `health` pack; `4 passages` against 5 and 6; relevance `0.83, 0.79, 0.62` |
| `A10/VC3` = `judge-r10/VC3/run-2` | *"came from a single PDF in the \"first aid\" pack"*, over Food safety passages |

`A10/VC3` was not in the brief and is the same defect one round earlier, which is the sweep earning
its keep: the shape has been shipping since at least round 10.

Detector exposure, measured over the same 432: **6** replies contain the pack phrase, **10** a
passage count, **20** a relevance word. Of the 20, only one states a decimal in [0,1] at all. This
rung is quiet because there is very little in the corpus for it to be loud about — which is also why
the three replies it does flag are worth flagging.

#### The true negatives, each beside its true positive

| the finding | the silence beside it |
| --- | --- |
| `First Aid Basics` / `health` / `single PDF in the "first aid"`, over Food safety passages | The **honest** account of the same retrieval: right pack, right counts, right relevances in the app's own two decimals — no badge at all, from any rung |
| — | Hedges: `the passages I was given seemed to be about…`, `I think they came from the first aid pack`, `it may have returned 4 passages`, `if the lookup returned 3 passages…` |
| — | The round-11 list of installed packs (`A11/VC3`): *"the tool searches your installed reference **packs** (first aid, preparedness, personal finance, health, home repair, legal basics)"* — present tense, plural, and about what the tool **can** search rather than what this lookup returned |
| `4 passages` against lookups of 5 and 6 | `(6 passages max)` — a ceiling is not a count, and six is `reference_lookup`'s own default `topK`; `up to 8 passages` likewise |
| — | `Two passages were retrieved:` with two passages cited under it (`A7/VC3`) |
| — | A **document** called a pack (`the Cold food storage chart pack`) — a name the reader can see, so a mislabel rather than a fabrication; and a generic one (`the reference pack`), which picks out no pack at all |
| — | A pack the call was **sent** (`pack: 'first-aid'`) even when that call returned nothing |
| relevance `0.83`, `0.79`, `0.62` | `0.76` for a passage scoring `0.767` — the strip prints two decimals and the tool output three, so choosing between `0.76` and `0.77` is a rendering convention, not a claim |
| — | A conversation where **nothing** was retrieved: a sentence about what the library returned is then a sentence about a lookup that never ran, which is `unrunToolClaims`' finding |
| Both recorded accounts end to end through `checkToolGrounding` | The honest account on the same turn draws **no badge at all**; and `priorTurns` reaches exactly one rung — `I didn't use reference_lookup` over a lookup that ran a turn ago stays silent |

#### The on-screen string

> ⚠️ This reply's account of what the library returned contradicts the passages: the reply says the
> passages came from the "health" pack; every one retrieved is from Food safety; the reply says 4
> passages came back; the 2 lookups returned 5 and 6; the reply gives relevance 0.83, 0.79, 0.62;
> the passages carry 1, 0.818, 0.767, 0.72 and 6 more.

It renders directly under `toolArgs` — what the call was **sent**, then what it brought **back**, the
two halves of one sentence — and above the quotation rung, because a reader who believes the wrong
pack was searched mistrusts every passage under it.

#### Limits

- **One finding per kind, not per number.** A reply inventing a pack, a count and four relevance
  figures produces three lines, not six. The lines name every item (capped at four with `and N
  more`), but `groundingFindingCount` sees three — deliberately, because the badge is read as
  prose and six clauses about one fabricated table is a paragraph.
- **The pack check needs the word "pack".** `A7/VC3` says *"specifically the **first aid / health
  pack**"* with no `from` before it, and goes unflagged. Widening past `<verb> … from the <name>
  pack` means guessing which noun phrase in a sentence is a pack name, which is the guess this file
  refuses everywhere else.
- **The relevance check needs a decimal point.** A score written as a bare `1` is invisible to it.
  `1` is far too common in prose to read as a relevance figure, and the cost is a miss on the one
  value the library prints without one.
- **Found and not fixed.** Run-2's stated query — *"how long to cool a burn under running water"*
  against a call that carried the user's own chicken question — is `statedArgumentsIn`' rung, and it
  is silent for the same corpus reason: the call ran a turn earlier. Extending that rung to
  `priorTurns` is one line and is deliberately not taken here. It is a different rung with different
  true negatives — a reply may quote the query of a lookup from three turns back perfectly honestly
  — and those want recording before its corpus is widened.
### Pending fold-in — the coverage line counted its own vocabulary and called it the reply

Round 12's only result against the new build, held at low confidence and then overturned on the
arithmetic. Task V3, both arms, under a reply about a dripping faucet:

> ⚠️ 1 figure ($15) in this reply is not backed by the tool output.
>
> Covered 1 of the 4 measurements in this reply.
> Not compared against anything: 1,450 gallons, 2.2 gallons per drop, 30 days.

The critic counted six quantities and was overruled, correctly. `measurementsIn` over the exact
reply bytes returns exactly four spans — `1,450 gallons`, `2.2 gallons per drop`, `30 days`,
`60 minutes` — and `quantityCoverage`, which turns those into the N-of-M, is byte-identical across
the arms. Of the critic's two extras, one is a currency figure, which the line directly above counts
and reports separately. The **4 is right.** The other extra is the defect: the reply also states
`~876 drops per day`, `drop` is not in `MEASUREMENT_UNITS`, so that quantity was never a candidate —
and *in this reply* is a claim about the reply made from a scan narrower than the reply.

The near-miss is the whole of it. `2.2 gallons per drop` **is** read, because `gallon` is a known
unit. `876 drops per day` is not, because `drop` is not. The reply's own arithmetic multiplies the
two together, and the app read one factor and not the other, in a sentence that said it had read the
reply.

| | line |
| --- | --- |
| before | `Covered 1 of the 4 measurements in this reply. Not compared against anything: 1,450 gallons, 2.2 gallons per drop, 30 days.` |
| after | `Covered 1 of the 4 measurements this check can read in this reply. Not compared against anything: 1,450 gallons, 2.2 gallons per drop, 30 days. Outside what it can read at all, so not in that count: 876 drops per day.` |

**Two repairs, and the first is the one that cannot be wrong.** The denominator now says whose
reading it is. That sentence is true whatever the second scan misses, and it is what every other
rung on the same screen already does — *not backed by the tool output*, *Checked against: …*. This
one named no corpus at all.

#### Why the scan was not widened instead

The obvious fix is to recognise number-plus-noun generally, so the denominator really is the
measurements in the reply. Measured before choosing, over the documents this app actually ships —
every `packs/**/*.md`, with the spans the unit vocabulary already reads subtracted — a
number-plus-noun scan returns **578 spans, 293 distinct**, headed by:

```
 28  3 to         17  72, index     14  111 if       10  111 or        9  999 and
 19  1 to         17  529 plans     11  2 to         10  111 online    8  2 diabetes
 10  65 and        9  2025, the      5  2023 Next     4  31 March      4  09 June
```

Ranges, digit groups ending in a separator, an IRS form name, phone numbers, dates, a disease
classification. Widen the sweep to this repo's own prose and `4 steps`, `1 measurement`,
`3 lookups`, `18 tasks` join it — the app's own chrome, exactly as the brief predicted. **There is
no noun list that separates `529 plans` from `876 drops`**; they are the same shape. Any exclusion
set written for the ones seen so far is the enumeration this codebase has recorded being defeated
twice — `carriesAQuotation` ("an enumeration
of the furniture seen so far, defeated by the next piece") and `ARGUMENT_PARAMS` ("the known-good
set is *what the turn actually sent* — never an enumeration of the shapes a fabrication takes").

And the cost is not confined to the sentence. `MEASUREMENT_UNITS` is single-sourced on purpose: the
same vocabulary arms `unsourcedQuantities` (the ⚠️ line), `researchGrounding`, the library scorer,
and — inverted — `amountsIn`, which decides which bare numbers may support a **price**. Widening it
would let a reply's `5 steps` be *faulted* against a passage's `3 steps`, and would move money
verdicts as a side effect of a noun list. A denominator repair that changes what the warning banner
accuses is not a repair.

#### What was built instead, and where the inversion belongs

`unreadableQuantitiesIn` is the inverse of the unit list, applied on the **disclosure** side where a
mistake costs a sentence and never a verdict. Known-good is `MEASUREMENT_UNITS`; the complement is
found by shape and subtracted **by offset**, so whatever the unit list learns tomorrow this shrinks
to match without being edited, and the two can never both claim one span.

The discriminator is not a noun list — it is the sentence's own syntax. **`X per Y` and `X/Y` are
how English writes a dimension out loud**, and a phone number, a date, a form name and a list length
cannot wear one. Same scan, restricted to rates, over the same packs: **27 spans, 15 distinct** —
578 down to 27, and every one of the 27 is a real measurement this app cannot read.

All fifteen, in full, because a claim of "no false positives" is worth nothing without the list:

| span | pack |
| --- | --- |
| `0.4 pCi/L`, `1.3 pCi/L`, `2 pCi/L`, `4 pCi/L`, `8 pCi/L`, `10 pCi/L`, `20 pCi/L`, `50 Bq/m` | `home-safety/docs/radon.md` |
| `5 parts per million`, `50 parts per million`, `55 milligrams per cubic` | `home-safety/docs/carbon-monoxide-indoors.md` |
| `500 milligrams per liter`, `1 quart/liter` | `home-safety/docs/emergency-water-disinfection.md` |
| `40,000 cases per year` | `food-safety/docs/refrigerator-thermometers.md` |
| `3 colds per year` | `health/docs/common-cold.md` |

Zero identifiers, zero dates, zero list lengths, zero chrome. Three shape rules carry it, each about
the writing rather than about the word: the digit group **ends in a digit** (`72, index` is not a
quantity called `index` — the fix `CURRENCY` already records for `$30,000,`); a **space** stands
between number and word (`1st`, `3pm`, `2x`, `1080p` are one token, and a scan that splits tokens
invents the dimension it reports); and `per` is a **word** with `/` written **tight** — greedy
backtracking otherwise reads this repo's own address fixture `10023 Upper West Side` as *10023 "Up"
per "West"*, and ` /` collects file paths.

**It is a floor and never a census, and the sentence is written so that this is safe.** The clause
*names* what it found and states no total for the reply; a second census would be the same
overstatement one clause along. Nor is it gated the way the line is: `coverageWorthSaying` exists
because "compared against nothing" reads as broken when the number is on screen in the passage
below, and "this check cannot read this unit" is not contradicted by the passage stating the
quantity — it was never a claim about the quantity's truth.

**True negatives.** A turn whose every measurement the vocabulary reads stores no `unread` field at
all and prints two clauses, not three (`Covered 1 of the 2 measurements this check can read in this
reply. Not compared against anything: 9 days.`) — a build that hedged every coverage line fails
there. `2.2 gallons per drop`, `60 seconds/min`, `700 gallons per month` are read by the unit
vocabulary and so are absent here, never named twice. `$2 drips per second` is the money rung's and
`2 drips per second` is not, which is what shows the currency guard doing work rather than the
pattern failing anyway. `876` at the end of one line and `drops per day` at the start of the next
are two claims, as everywhere else in that file. And the disclosure is not a finding: on the
recorded reply `groundingFindingCount` is still 1, the labels are still `['$15']`, and the
correction prompt sent back to the model contains neither `876` nor `drops per day`.

#### Limits

- **Without its rate the same quantity is invisible.** `about 876 drops a day` discloses nothing.
  That is the direction this project has settled on twice: a miss costs a disclosure, a false name
  on a warning banner costs the badge (round 4). It is also why the first repair — the denominator
  saying whose reading it is — is not optional and does not depend on this scan.
- **A quantity with no digits is not a quantity here.** "a third of a tankful" is outside both
  scans, and no wording of the second clause would reach it. The first sentence is what stays honest
  about that case.
- **Residue outside prose.** Over source files rather than documents the rate scan still returns
  `400 test/styleCheck`, `252 render/style`, `3 left/i`, `8080 searxng/searxng` — paths, a regex
  flag, a container tag. None appear in a document or a reply, and the scan runs on the assistant
  message alone, so this is recorded rather than repaired.
- **The span stops at the first word after `per`.** `55 milligrams per cubic` is how the carbon
  monoxide passage's `…per cubic metre` is named. The reader can find the string, which is the bar
  this project sets for a named span, but it is a phrase cut short rather than a unit.
- **An exponent glued to the unit hides the rate.** The radon pack writes both `50 Bq/m 3` and
  `740 Bq/m3`; the first is disclosed and the second is not, because `\b` falls inside `m3`. The
  `pCi/L` spelling in the same rows is the one that carries the reading, so the document is not
  silent — but the miss is real and is recorded rather than patched, since widening the word after
  the slash is how `test/styleCheck` got in.
- **`15 dollars` is not routed to the money rung.** The currency guard is by glyph, because `pounds`
  is already a mass and a currency *word* list would collide with the unit list it is subtracting
  from. A reply spelling a price out would have it disclosed here as unreadable, which is true and
  slightly beside the point.
- **The line still rides an existing badge.** A reply the pass faults nowhere makes no coverage
  claim, so it gets no correction — including on a reply whose only quantities are ones this scan
  cannot read. Unchanged from v2.1, and the same reasoning: a permanent grey line under every
  mention of "20 minutes" is round 4's cry-wolf in a quieter ink.
