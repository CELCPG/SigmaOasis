# The library's model aids: the `library-aids` suite

Part of the [evals index](../evals.md). The aids themselves (re-rank, the sample answer) are
described in [library-ranking.md](../library-ranking.md); the 28-case library suite they were first
measured on is in [answers.md](answers.md) (*The library's model aids, measured*, v4.4, G5).

## What it measures, and why it exists (v4.5, H5)

4.4's G5 measured re-rank and the sample answer beside same-day controls and called both
SAME-WITHIN-NOISE. The suite could hardly have shown otherwise. The aids run only when the
question falls in a high-stakes domain (`stakesDomain`: first aid, health, building, finance — a
keyword rule on the question, `grounding.referenceDomains`), and **5 of the library suite's 28
cases do** (`02-burn-no-ice`, `03-nosebleed`, `06-heat-exhaustion`, `25-credit-score-range`,
`26-standard-deduction`). The other 23 never reach an aid: their questions carry no trigger word
("I spilled boiling water on my forearm", "what are the signs of a stroke", "bitten by a dog" —
none says *burn*, *stroke* or *bite*). And the five are not hard: plain ranking puts their
section first. An aid can only change the answer where plain ranking leads with the wrong
passage — or leaves the right one out of the five a reply gets to read — and there the suite had
none.

`EVAL_SUITES=library-aids` is the suite built for them: 27 cases, every question inside the
domains, over three small packs of their own, scored the way the library suite is scored. It is
the suite on which an aid can be measured to *help*, not only shown to cost nothing. Nothing about
the shipping defaults changes with it: both aids stay off unless a measurement on this suite says
otherwise (the last section).

## The four kinds of case

Each is a place where plain embedding-and-keyword ranking plausibly leads with the wrong passage:

| kind | what makes it hard | cases | example |
| --- | --- | --- | --- |
| vocabulary | the question's words are not the document's | 7 | "My two-month-old is burning up and fussy. Can it wait until morning?" (the section says *fever*, *baby under 3 months*) |
| paraphrase | an indirect, situational question | 7 | "My son bumped his head … and keeps throwing up. Is that a concussion thing or something worse?" (the answer is under "Go to the emergency room if") |
| near-tie | two sections of one topic both fit; the right one names the answer | 7 | "My 5-month-old has a fever of 101 …" (*under 3 months* is an emergency, *3 months to 3 years* is not) |
| multi-document | the answer is in a document whose title is not the question's topic | 6 | "If my son gets a bee sting … what should the babysitter do?" (the babysitter sheet, not *Stings, bites and ticks*) |

Each case (`test/fixtures/library-aids/cases/*.json`) names the question, the **source** section
whose passage must be retrieved and cited, the **decoys** that plausibly outrank it, the facts a
reply must state (`mustInclude`) and, for seven of them, the advice it must not give
(`mustNotAssert`, with an `unsafeReply` the unit test shows it flagging). The scorer is the library
suite's — `scoreLibrary`: answered (every fact), cited (`[n]` or a retrieved title), forbidden
(never banded), unsupported figures — including 4.4's list lead-in fix. A source section holds the
facts and none of its decoys holds them all (`test/libraryAids.test.ts` checks both), so a reply
built on the wrong passage cannot pass. The runner records, per case, where the source stood among
the passages the lookup returned (`rank`, 0 = not among them): recorded, not scored.

**The documents** are three small packs written for it, `test/fixtures/library-aids/packs/`
(`aids-health`, `aids-money`, `aids-house`): 33 documents of a personal library's kind (a
pediatrician's handout, a pharmacist's notes, a renters and an auto policy summary, an employer's
benefits guide, a deck project's notes, a home inspection report, the babysitter sheet on the
fridge) and four *questions we saved* pages whose `##` headings are questions and whose answers
are generic — the kind of page that ranks first for a question and holds none of its numbers. They
install into a library of their own (`.eval-library-aids`), so the 28 cases' library and their
scores are untouched; a pack whose source text changed is reinstalled (and re-embedded) at the
next run. Figures in them are fixture figures.

## Running it

```
# the retrieval-only check — no answering model, the embedder only (nomic on :1234); seconds
LMSTUDIO_EVAL=1 EVAL_RETRIEVAL_ONLY=1 EVAL_SUITES=library-aids npm run eval:answers

# the suite, on its own, or one kind, or a slice (the cases run in kind order)
EVAL_SUITES=library-aids LMSTUDIO_EVAL=1 npm run eval:answers -- <model>
EVAL_SUITES=library-aids EVAL_LIBRARY_KIND=near-tie,multi-document LMSTUDIO_EVAL=1 npm run eval:answers -- <model>
EVAL_SUITES=library-aids EVAL_CASES=1-7 LMSTUDIO_EVAL=1 npm run eval:answers -- <model>

# an aid against its same-day control, as for `library` (G1)
EVAL_CONTROL=1 EVAL_SUITES=library-aids EVAL_LIBRARY_ASSIST=rerank EVAL_PASSES=4 LMSTUDIO_EVAL=1 npm run eval:answers -- <model>
```

The results file keeps the library block, so `eval:diff` reads it unchanged (`--paired`, `--base`
and `--run`); the file name carries `-aids`, and `librarySuite: "library-aids"` is in it. Name the
two library suites together and the runner refuses: each writes the file's one library block.
**`eval:diff` does not read `librarySuite`** (H7a): a `library` file and a `library-aids` file
would be compared without a refusal, so diff aids against aids only, never against a baseline or
control from the 28-case suite.

## The retrieval-only check, and the split it prints

A suite where plain ranking already puts every source first has no headroom, so
`EVAL_RETRIEVAL_ONLY=1` ranks each case's passages with the app's own lookup (hybrid keyword +
nomic, the floor, the wrong-section guard, MMR; both aids off) at the app-initiated lookup's topK
of 5 and at the most a lookup can return, 12, and prints where the source section stood, beside its
rank by cosine alone, by keyword alone, and fused (the order the re-rank's pool of 15 is cut from).
No answering model is loaded or asked.

On the first draft of the corpus (the packs without the FAQ pages) 16 of 27 sources were already
first and none was lower than third: an answering model would have been shown the source every
time, with nothing for an aid to fix. The FAQ pages are what the check asked for. The final split
(H5a, 2026-10-03, 432 passages, the aids off), **re-run on the merged tree (`rel/4.5`, 4.5.0; H5b)
and identical**:

| where the source stands | cases |
| --- | --- |
| first | **9 of 27 (33%)** |
| second | 9 |
| third | 3 |
| fourth | 3 |
| fifth | 1 |
| outside the five the answering model is shown | 2 (seventh, and fifth in the twelve-passage lookup) |
| within the twelve a lookup can return | 27 of 27 |
| within the fused order's first fifteen — the re-rank's pool | 27 of 27 |

By kind, first / not first: vocabulary 2 / 5, paraphrase 2 / 5, near-tie 3 / 4, multi-document
2 / 4. The nine controls, where plain ranking is already right and an aid can only do harm, are
`04-bank-insurance-extra`, `06-breaker-bigger`, `10-who-gets-401k`, `14-estimated-payments`,
`16-sprain-heat-or-ice`, `17-ira-at-55`, `18-mri-appeal`, `26-east-wall-crack` and
`27-home-office-corner`. What plain ranking leads with instead is mostly the FAQ page's generic
answer ("ask your lender when it can be removed") or a section of the right document about another
situation (*under 3 months* for a 5-month-old). Keyword ranking alone is the weak leg for the
vocabulary and paraphrase cases (the source's BM25 rank is 10th to 25th for "burning up",
"throwing up and dizzy" and the 5-month-old). Re-run the check before any measurement; if the
split moves, a measurement on the suite is a measurement of a different suite.

## Re-rank, measured on it (v4.5, H5b, 2026-10-03)

`qwen3.8-9b-distill` on the Arc Pro B65 (LM Studio alone), temperature 0, one session
(`h5b-rerank`), four passes a side beside a same-day control, interleaved ABBA (two commands of
`EVAL_PASSES=2`, control first on one pass, the aid first on the next):

```
EVAL_CONTROL=1 EVAL_SESSION=h5b-rerank EVAL_SUITES=library-aids EVAL_LIBRARY_ASSIST=rerank EVAL_PASSES=2 LMSTUDIO_EVAL=1 npm run eval:answers -- qwen3.8-9b-distill   # twice
npm run eval:diff -- --paired <the two control files and the two re-rank files>
```

| of 27 a pass | control, aids off | re-rank | band | |
| --- | --- | --- | --- | --- |
| answered | 22, 21, 21, 21 — 21.25 (σ 0.50) | 22, 22, 22, 22 — 22.00 (σ 0.00) | ±0.71 | **+0.75 BETTER** |
| cited the source | 25, 24, 24, 24 — 24.25 | 21, 21, 21, 22 — 21.25 | ±0.71 | **−3.00 WORSE** |
| unsupported figures | 4, 3, 3, 3 — 3.25 | 4, 4, 3, 5 — 4.00 | ±0.96 | +0.75 SAME-WITHIN-NOISE |
| asserted forbidden advice | 0 of 108 | 0 of 108 | never banded | no new one |
| the source section first | 9 in every pass (36/108) | 20 in every pass (80/108) | | recorded, not scored |

**Verdict: WORSE (exit 1). `libraryRerank` stays off.** The switch turns on only if the arm is BETTER
beyond the band with no new forbidden advice; here the answered line rose beyond its band and the
citing line fell beyond its own.

- **It applied.** 27 of 27 re-ranks in each of the four passes, 108 of 108, none fell back to the
  fused order. (Before 4.4's F2 fix none had applied on a `<think>` family; the plain ask with the
  closed-think prefill holds on the B65.)
- **It does what it is for, to the rank.** The source went from first in 9 of 27 cases to first in
  20 — it is the aid's own job, and a gain the dry check promised (all 27 sources were in the pool
  of 15). It hands the model 3 passages where plain ranking hands it 5.
- **The answers did not follow it.** The passes agree to the case, so the bands are narrow and the
  difference is by case. Answered: four cases won (`05-penalty-free-withdrawal`, `15-five-month-fever`,
  `22-employer-match`, `27-home-office-corner`), three lost (`02-black-head-in-skin`, where the re-rank
  dropped the source out of the three passages; `16-sprain-heat-or-ice`, where it pushed a source that
  was first down to third; `24-babysitter-sting`, source first in all four passes and a fact still missed —
  cause not found). On the 24 cases the control answered the same way every pass, answered is 80 of 96
  on both sides (two won, two lost); the +0.75 is the three cases that were flaky under the control
  (5 of 12 passes → 8 of 12): one case net.
- **Citing is where it cost.** Nine cases moved, six down (`01`, `02`, `04`, `05`, `08`, `12`) and three up.
  In the lost ones the reply quotes the right passage ("the reference library states …") with no `[n]`
  and no title. Replies carrying a `[n]` at all: 91 of 108 under the control, 76 of 108 under re-rank; with
  the source first, 32 of 36 against 50 of 80. Why the 9B marks a passage less when it is first of three
  was not established; the loss on the line the gate bands is measured either way.
- Re-rank adds about half a second a case (9.6 and 9.8 s against 8.9 and 9.4).
- Files: `.eval-results/answers-qwen3.8-9b-distill-aids-{control,rerank}-2026-10-03T12-00-09.json` and
  `…T12-17-22.json`. The sample answer (`EVAL_LIBRARY_ASSIST=hyde`) is the next section.

## The sample answer (HyDE), measured on it (v4.5, H5b2, 2026-10-03)

The same model, machine, temperature and shape as the re-rank's section: `qwen3.8-9b-distill` on the
Arc Pro B65, one session (`h5b2-hyde`), two commands of `EVAL_PASSES=2` (control, arm | arm, control in
each), four passes a side beside a same-day control:

```
EVAL_CONTROL=1 EVAL_SESSION=h5b2-hyde EVAL_SUITES=library-aids EVAL_LIBRARY_ASSIST=hyde EVAL_PASSES=2 LMSTUDIO_EVAL=1 npm run eval:answers -- qwen3.8-9b-distill   # twice
npm run eval:diff -- --paired <the two control files and the two hyde files>
```

| of 27 a pass | control, aids off | sample answer | band | |
| --- | --- | --- | --- | --- |
| answered | 21, 21, 21, 21 — 21.00 (σ 0.00) | 20, 19, 20, 20 — 19.75 (σ 0.50) | ±0.50 | **−1.25 WORSE** |
| cited the source | 23, 26, 26, 25 — 25.00 (σ 1.41) | 23, 24, 23, 23 — 23.25 (σ 0.50) | ±2.00 | −1.75 SAME-WITHIN-NOISE |
| unsupported figures | 3, 3, 3, 4 — 3.25 | 2, 1, 2, 2 — 1.75 | ±0.71 | **−1.50 BETTER** |
| asserted forbidden advice | 0 of 108 | 0 of 108 | never banded | no new one |
| the source section first | 9 in every pass (36/108) | 13 in every pass (52/108) | | recorded, not scored |

**Verdict: WORSE (exit 1). `libraryHyde` stays off.** The switch turns on only if the arm is BETTER
beyond the band with no new forbidden advice; the answered line fell beyond its band.

- **It applied.** The sample answer was written, embedded and averaged into the ranking vector for
  27 of 27 cases in every pass, 108 of 108 (`expanded` in the case record is set only after both
  steps succeed). It hands the model 5 passages, as plain ranking does.
- **What it did to the ranking.** The source went from first in 9 of 27 cases to first in 13 and from
  outside the five shown in 2 cases to 1 (`15-five-month-fever` stays unretrieved in both; `22-employer-match`
  comes in at third). The ranks are the same in all four passes (the sample answer is written at
  temperature 0). Against the control the five passages differ as a set in 9 of 27 cases and in
  their order in 23.
- **Answered.** Won `05-penalty-free-withdrawal` (0 → 2 of 4 passes), `22-employer-match` (0 → 4) and
  `27-home-office-corner` (3 → 4); lost `01-baby-burning-up` (4 → 1), `02-black-head-in-skin` (4 → 0: all four
  replies say the library does not describe removal, with the source third where it was fourth), `14-estimated-payments` (4 → 0, see the next
  point) and `24-babysitter-sting` (1 → 0): 84 answered replies against 79. On the 25 cases the control
  answered the same way every pass: 80 of 100 against 75.
- **One loss is the scorer, not the model.** In `14-estimated-payments` all four sample-answer replies
  write the dates correctly ("**June 15**, **September 15**") but with a narrow no-break space (U+202F)
  between *June* and *15*; the case's `mustInclude` pattern has an ASCII space, so it reads the fact as
  missing. Re-testing the saved replies with Unicode spaces read as spaces moves exactly these four
  `answered` flags of the 216 replies (the control's and the sample answer's `19-joist-span` replies carry
  one too, and still match), and none of H5b's 216 re-rank-session replies.
  The table above is the scorer as it is. Read with those four counted, answered is 20.75 against 21.00
  (−0.25, ±0.50, SAME-WITHIN-NOISE), cited and the other lines do not move, and the verdict would read
  **BETTER**, on the unsupported-figures line alone (−1.50 beyond ±0.71: `01` and `11-card-or-fund`
  are flagged far less often, `05` newly twice). That reading is not the measurement: changing a scorer
  after the result, to a result that would turn a default on, is the owner's call, not this unit's.
- **Citing is within the band, and mostly not re-rank's mechanism.** Cited fell by 1.75 where the
  control itself spread by σ 1.41 (23 in its first pass, 26 in the next two). Replies carrying any `[n]`:
  91 of 108 under the control, 85 of 108 under the sample answer (re-rank: 76). Where the source was
  first, 43 of 52 carry one (83%) against 32 of 36 (89%): the same kind of loss in `16-sprain-heat-or-ice`
  (4 → 0: the reply says "according to your reference notes" with no `[n]` or title) and `01`, but small,
  and offset by `18-mri-appeal` and `21-footing-depth` (0 → 4 marked).
- Unsupported figures fell mostly in two cases: `01` (flagged "3 months" in all four control passes,
  one under the sample answer) and `11` (all four to none); `05` rose (0 → 2).
- It adds about 0.3 s a case (9.5 s against 9.2 s) for the extra model call and embedding.
- Files: `.eval-results/answers-qwen3.8-9b-distill-aids-{control,hyde}-2026-10-03T12-37-53.json` and
  `…T12-55-13.json`.
