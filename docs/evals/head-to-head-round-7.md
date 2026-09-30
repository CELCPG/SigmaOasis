# Head-to-head: round 7

Part of the [evals index](../evals.md).

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

### Pending fold-in — a fold the reader cannot tell from the string

Round 8 got a 220-character token to stay inside the chat column, which fixed a real defect:
the same token used to show 26 characters at a time behind a scrollbar on a block one line
tall. A blind critic then found what the fix cost, in the winning run:

> run-2 wraps the token at hyphen boundaries, so every wrapped line ends in a real-looking
> `-`: `signme-oasis-head-to-head-` / `layout-probe-a-single-` / `unbroken-token-that-must-` /
> `not-block-out-the-chat-` / `column-0001-0002-0003-`. A reader transcribing by eye cannot
> tell a wrap point from a character in the string, which is the failure mode the prompt
> (*"repeat it back to me on its own line so I can copy it"*) is trying to avoid.

**The hyphen is not incidental to the fix — it is the fix's own mechanism showing through.** A
hyphen is a soft wrap opportunity in the line-breaking algorithm, and `overflow-wrap` is a
last-resort rule: it breaks *inside* a run only when the run cannot fit a line of its own.
Given a hyphenated token it never has to, so it takes the hyphens and every folded row ends in
one. Measured, and this is the measurement that decided the round: `overflow-wrap: break-word`
and `overflow-wrap: anywhere` fold this token **identically** — the same 6 rows, the same 4
hyphen ends. The keyword round 8 chose was never what put the fold there.

What makes a trailing hyphen worse than any other character is not ambiguity in general but one
specific convention: since print, an end-of-line hyphen has meant *the renderer put this here,
take it out when you rejoin the lines*. So the failure is not that the reader is unsure — it is
that a reader who is confident deletes characters from the string they came for.

#### The two options, measured rather than assumed

`word-break: break-all` folds where the row fills instead of where the breaker prefers, so a
fold lands mid-token on a character no convention says to alter, and — the part that matters
more — every folded row runs into the block's right padding while a row that *ends* stops
short. That edge is the signal `break-word` never produces.

One measured surprise governs the implementation: **the two properties do not compose.**
Setting `word-break: break-all` while `overflow-wrap: break-word` is still in effect gives back
the hyphen folds exactly — Chromium keeps preferring the breaker's own opportunities. The rule
has to reset `overflow-wrap: normal` in the same declaration, and that reset is load-bearing,
not tidiness.

`break-all` is also not free, which is why this is a predicate and not a stylesheet rule.
Filling every row to the edge breaks an identifier that would have fitted the next row — round
8's shredding, moved inside a code block. Measured on three lines of ordinary JavaScript at a
420px column: **0 shredded words under `break-word`, 3 under `break-all`**
(`mergeDefaults(userConfiguration,`, `synchroniseWorkspaceManifest(workspaceRoot,`,
`JSON.stringify(nextManifest,`). So the two rules are dispatched, not ranked: `foldsAnywhere`
in `lib/markdown.ts` marks a block only when it holds an unbreakable line **and** holds no long
line that could be shredded instead. A block of real code — including one a reader turned Wrap
on for by hand — keeps the word-preserving rule, because there the goal is to read the code.

#### Measured, in `test/styleCheck.ts`

The app's own stylesheet, compiled the way the app compiles it, laid out in a real offscreen
window. Both blocks are in the same fixture at the same width, so the control is the same token
under round 8's rule rather than a remembered figure. A fold is counted **ambiguous** when it
ends in a hyphen *and* stops short of the content edge by at least one character advance — the
conjunction is the defect, because a hyphen on a row visibly cut by the edge is plainly content,
and a row stopping short on any other character claims nothing.

| Chat column | Folds reading as hyphenation, before | After | Contained (`scrollWidth ≤ clientWidth`) |
| --- | --- | --- | --- |
| 232px (split view) | **10 of 10** | **0 of 8** | 198 ≤ 198, both |
| 420px | **2 of 4** (4 of 4 fold on a hyphen) | **0 of 4** | 386 ≤ 386, both |
| 700px | **1 of 2** | **0 of 2** | 666 ≤ 666, both |
| 900px | **1 of 1** | **0 of 1** | 866 ≤ 866, both |
| 1100px | 0 of 1 | 0 of 1 | 1066 ≤ 1066, both |

Round 8's containment is unchanged at every width — that column is the non-regression, and it
was the whole of round 8's win.

**The true negatives, which are the point.**

| True negative | Measured |
| --- | --- |
| Ordinary wrapped code has no word broken that would have fitted a row of the block | 0 at 420px and 0 in split view, against 3 if the fold rule reached it |
| …and the fold rule visibly did not reach it | rows still stop short of the edge |
| The control — the same token, round 8's rule, same fixture, same width | 10 / 2 / 1 / 1 ambiguous folds: there is a defect for the fix to move |
| Every fold under the new rule is cut at the edge | 0 of 4 and 0 of 8 stop short — the mechanism behind the zeros above |
| The visual rows rejoin to the DOM text | nothing added, nothing lost |
| A block holding the token *and* a long ordinary line | wraps, but is **not** marked to fold anywhere |
| A block of ordinary code alone | neither wrapped nor marked |

#### What copy actually yields — and why it changes how much of this matters

This was measured before anything was changed, because it decides how large the defect is.
Through the shipping renderer, in a real document (`test/markdownCheck.ts`):

| Path | Yields |
| --- | --- |
| The header's **Copy** button (`code.textContent`) | the 207-character token, byte-identical |
| Select the block and copy (`Selection.toString()`) | the same string, byte-identical to `textContent` |

**A fold exists only in the layout. It is not in the DOM, and Chromium does not insert one into
a selection** — the two paths are equal to each other and to the source string, asserted as
equality rather than as a length, at both widths and under both rules. So the visual ambiguity
never corrupted any copy path, and it did not on the day the
critic filed it. What it corrupts is the reader who transcribes from the screen or from a
screenshot — which is a real reader, and the one the prompt describes, but a narrower loss than
"the app hands back the wrong string".

The `Copy` control is also a genuine answer for that reader, and it is discoverable: measured at
**7.65:1** against the header it sits on, 38.5 × 24px, labelled in words, always rendered — no
hover, no focus, no disclosure. That is asserted now rather than assumed, because "there is a
button for it" is only an answer while the button is legible.

#### What this does not measure, and what it does not fix

- **Nothing was re-run against a model, and no sweep was taken.** These are before/after
  measurements of one build in a render harness. No win/loss claim attaches to any of it.
- **A fold can still land after a hyphen — it just cannot be misread as hyphenation.** At 420px,
  2 of 4 folds still end in `-`; they are safe because the row is visibly cut at the edge, not
  because the character changed. Guaranteeing a mid-token character is not achievable in CSS:
  `break-all` folds where the row fills, and sometimes a hyphen sits there. The claim being made
  is the narrower one the layout can actually support.
- **The fold signal is the flush right edge, and a reader has to notice it.** It is the same
  signal a terminal gives, and it is unmistakable in a block of monospace with one short last
  row — but it is not a glyph, and nobody is told to look for it.
- **A marker was considered and rejected on evidence.** CSS cannot select a line box, so any
  per-fold marker has to be real content in the `<code>` element — and both copy paths read that
  element. Measured, `::before`/`::after` generated content is invisible to `textContent`,
  `innerText` **and** `Selection.toString()`, so a marker *would* have been copy-safe; it is
  simply not addressable per fold. Trading an exact copy for a visual hint would be the wrong
  trade when copy is the stated goal, and here the trade was not even available.
- **An ordinary wrapped block still folds at hyphens, and that is not fixed.** Found while
  building the fixture: `JSON.stringify(nextManifest, null, 2), "utf-8")` in split view folds as
  `"utf-` / `8")`, splitting an 8-character literal that would have fitted a row of its own,
  because the breaker takes the hyphen inside `utf-8`. It is the same defect class in a block
  the fold rule deliberately does not reach — and reaching it would shred the identifiers around
  it. The fixture uses hyphen-free code so the shredding assertion measures identifier splitting
  and nothing else; this case is recorded, not asserted, because no CSS resolves it.
- **The `Wrap` control's contrast is measured; its discoverability is not.** 7.65:1 says the
  label is legible. It does not say a reader knows the block folded, or that pressing Wrap would
  unfold it.
- **`foldsAnywhere` decides from the source text, never from layout** — deliberately, like
  `startsWrapped`. A 100-character token that would have fitted a wide window still folds. A
  default derived from layout changes when you resize the window, and a code block that reflows
  on drag is worse than either default.
