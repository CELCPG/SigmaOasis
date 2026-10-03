# Roadmap: Sigma Oasis 4.5 — the new cards, Gemma 4 as an agent, and what 4.4 saw and left

Written by Apex just after midnight on 2026-10-03, after Colin's "work on the next updates to sigma
oasis", against `rel/4.4` (`b986dca`, 4.4.0, release-ready and pushed nowhere, like 4.3.0 before
it: A-049, A-060). Built on `rel/4.5` (worktree `so-wt/int45`) from tracks `4.5/<name>`
(worktrees `so-wt/45-<name>`). Nothing leaves the PC: no push, no tag, no release.

## Why now: the machine changed under the baselines

On 2026-10-02 the RTX 5070 left the PC. The 9B (`qwen3.8-9b-distill`, LM Studio) now runs on the
Intel Arc Pro B65 over Vulkan, beside nomic and a new model: **Gemma 4 26B-A4B**, served on its own
by llama.cpp at `127.0.0.1:8084` (vision, one request at a time). The 35B-A3B stays on the B60
(`:8081`). Every 4.4 measurement, including the committed 9B baselines, was taken on the 5070. A
4.4 verdict is still sound (each was paired with a same-day control), but a committed baseline is
another day's **and another card's** now, and nobody knows the 9B's noise or speed on the B65.

## The goals

| goal | what | where |
| --- | --- | --- |
| H1 | The 9B re-baselined on the B65: agent (4 passes, the shipping 4.4 engine), tool choice (the app's subset, 4.4's shipping switches, 4 passes), `bench:latency`; set beside the 5070 numbers | `4.5/b65` |
| H2 | The think-first planners 4.4 saw and left (F, *seen*): plan mode (`ipc/plan.ts`), the outline (`ipc/outline.ts`), deep research's planner (`ipc/deepResearch/plan.ts`) send grammar + `thinking: false`, which a `<think>` family ignores. Measure on the 9B; apply 4.4's re-rank fix (the closed-think prefill) where it is no worse on validity and faster | `4.5/planners` |
| H3 | An unrun-claim guard: the 35B-A3B says "tests pass" without running them (3 in 99, G6). The engine already knows every command it ran and its exit code; the eval's false-claim rule (`evalHarness.ts`) moves into a shared module and the engine marks the report when it claims a pass the run does not show. Annotation only (no extra model round: 4.3's `verifyRound` was WORSE). **H3b:** the detector reads tense, mood and subject (6 of the 11 recorded false claims were plans, instructions and descriptions of code), `eval:diff` reads one claim rule on both sides, and 4.4's "3 in 99" is 1 in 99 ([claims.md](docs/evals/claims.md)) | `4.5/claims` |
| H4 | Gemma 4 26B-A4B as an agent model: (a) the catalog reads a llama.cpp server (`capabilities: ["multimodal"]` → vision; `/props` → context length), (b) its agent and tool-choice baselines beside H1's 9B and 4.4's 35B, false claims counted | `4.5/catalog`, `4.5/gemma` |
| H5 | A library suite where re-rank and the sample answer (HyDE) could show a gain — 5 of 28 current cases are in their domain — then both measured again beside a same-day control | `4.5/library` |
| H6 | Dependencies: electron's latest 44.x patch and any runtime patch updates; `npm audit` no worse | `4.5/deps` |
| H7 | Integration: tracks on `rel/4.5`, the full `npm test`, 4.5.0 release-ready (version, notes), this file's status | `rel/4.5` |

The rule, unchanged from 4.4: **a switch turns on by default only if its arm is BETTER beyond the
noise band, beside a same-day control, with zero new false claims.** A fix that does not change
what the model is asked (H2's prefill is a change; H3's annotation is not) still needs H2's
measurement before it ships.

## How it runs

- Units of ≤60 minutes, one deliverable each, on Workboard `apex-runs` (cards "Sigma 4.5 · H…").
  Builders are native subagents; Apex verifies each before the card is done.
- **One machine-wide heavy lock** for GPU evals, full `npm test`, builds and `npm ci`:
  `.eval-results/4.5-2026-10-03/step.sh` (4.4's harness: gaming check, deadline, orphan reaper,
  `clerk-off`/`clerk-on`, exit 75 = busy). Each chunk under ten minutes.
- Track worktrees junction `node_modules` and `resources/pyodide` to `int44`'s. **Never `npm
  install` or `npm ci` in a junctioned worktree** — it writes into `int44`. H6 makes its own copy.
- The B65 carries the 9B and Gemma; H1, H2's measurement, H4b and H5b queue on the lock, never
  two at once.

## Release order

4.3.0, then 4.4.0 (their roadmaps' *Release* sections), then 4.5.0. `rel/4.5` stays a
fast-forward of `rel/4.4`.

## Decisions for Colin

Complete for everything known on 2026-10-03 at H7 part 1; part 2 adds what H4b1 (Gemma 4) and
H5b (re-rank and the sample answer on `library-aids`) leave to decide.


1. **The research planner stays on the grammar.** Plain was valid 12/12 and 0.9 s faster in the
   interleaved pass, but 23/24 against 24/24 over both passes: one malformed plan fell back to the
   one-question plan, to save 0.8 s of a call that precedes a run of minutes. Plan mode and the
   outline go plain on a `<think>` family (both no worse on validity and faster). Turning the
   research planner plain is one line: `makePlan` passes `chatCompleteStructured(model, (plain) =>
   plannerRequest(question, model, signal, plain))` instead of `chatCompleteJson(plannerRequest(…))`.
2. **Gemma 4 is reachable only by replacing LM Studio's URL.** Sigma has one connection
   (`settings.baseUrl`): chat, embeddings, the agent and the model pin all use it. Pointed at
   `:8084`, the library and memory lose nomic's embeddings and Gemma's single slot queues chat,
   titles and summaries; the model pin's load call, an LM Studio endpoint, answers 404 twice there
   and is then left alone for the session. A second connection (or one per role) would be a
   feature, not part of 4.5. H4a lets the catalog describe a llama-server correctly either way.
3. **Should a fall in false claims alone count as BETTER?** False claims are never banded: any rise
   is WORSE and any fall is BETTER. Under the corrected rule, 4.4's `toolsByPhase` reads **BETTER**
   against its same-day control on false claims alone (control 0 → 1 of 104, arm 0; solved −0.25,
   ±3.83). 4.5's `eval:diff` now says so beside such a verdict. Leaving it as is keeps today's rule.
   Making false claims a veto only (a rise is WORSE, a fall never makes a BETTER by itself) would fit
   the switch rule's "BETTER beyond the noise band". Either way it is a change to the gate's rule,
   and so Colin's call.
4. **4.4's decision 3, corrected.** The 35B-A3B's false claims are **1 in 99** in its baseline
   (`chain-slugify`; 2 in 103 over every 4.4 run of it, the other disclosing it could not run the
   tests), not 3 in 99. The 9B's are **1 in 312** (`long-discount-rules`, which the old 40-character
   window hid; 0 on the 25 cases the 35B's baseline covers), not 0. One against one is no
   difference between the models at these sizes. Whether the 35B is offered as an agent model is
   still open.
5. **electron-updater 6.8.10 carries npm's `v26` tag, not `latest`.** It is inside the range, a
   bug fix (the differential download's stale blockmaps, electron-builder #10097) with the same
   dependencies and no advisory. Keep it, or drop it (one revert of `c78d1af`'s two lines).
6. **`npm audit` reads 13, not 4.4's 8.** The 8 are electron-builder 24's (decision 5 of 4.4). The 5
   new ones (braces, chokidar, fast-glob, micromatch, tailwindcss) are one advisory,
   GHSA-vfj7-8cjw-p6xm (braces ≤ 3.0.3, stack-exhaustion DoS, published 2026-10-02, **no patched
   version**). It reaches us through tailwindcss 3's build-time chain (a dev dependency), and the
   only fix npm offers is tailwindcss 4, a major. 4.3.0's and 4.4.0's lockfiles carry the same
   braces 3.0.3, so they read 16 and 13 today (`npm audit --package-lock-only` on each). `release.yml` has no audit step, so
   nothing fails on it. The options are to accept it as dev-only, to wait for a braces patch, or to
   take tailwind 4 as its own track.
7. **The 9B on the B65: a full window's first token takes 261 s** (the 5070: 26.8 s; H1's
   `bench:latency`, three repeats within 0.2 s of each other). The chat gives up on a first byte at
   300 s (`FIRST_BYTE_TIMEOUT_MS`, `chatTransport.ts`), so it clears by 39 s; a prefill 15% slower
   would cross it, and the B65 also serves Gemma 4, so a 9B prefill beside a Gemma request is the
   likely way to get there. The agent's 360 s (90 s × 4) clears it by 99 s. Only the first turn at
   a full window meets it: the low-water trim's own re-read is 120 s, once, and every turn after it
   3.0 s. The options: **leave it** (it clears today, and nothing has failed), **raise it** (one
   constant; a server that has really stalled is then called stalled later), or **move the 9B** to a
   faster card (the card swap was Colin's). Leaving it for 4.5.0 and raising it only when a
   full-window turn on the shared card is seen to fail costs nothing now.
8. **The agent on the B65 is not deterministic, so the four-pass rule stands.** Two passes at
   temperature 0: 23 of 26 cases kept their verdict (the 3 that changed all went solved → not
   solved), rounds were equal in 12, the final text in 7 — the runs part within a round or two, as on
   the 5070. Tool choice is nearly repeatable (27 of 28 fixtures identical in four passes, no score
   moved) and has its B65 baseline. The agent has none: passes 3 and 4 cost about 45–50 minutes of
   the B65 each, behind Gemma and H5b on the same card. Record them on a quiet night for a B65
   agent baseline, or keep diffing agent changes on the B65 against a same-day control only (which
   costs four passes a side anyway). Also seen: `feature-top-words` runs away after
   `feature-stack-peek` in one chunk (> 7.5 and > 9 minutes, twice; 100 s and 315 s alone) — the
   harness runs it alone; the cause is not known.
9. **4.3.0's and 4.4.0's release notes carry the old false-claim reading.** Both are unreleased
   (A-049, A-060) and their branches are frozen. `RELEASE-NOTES-v4.4.0.md` says the 35B-A3B made
   false claims "3 in 99 runs" that "the 9B does not", and that the 9B's default engine made none in
   312; under rule 2 they are 1 in 99 and 1 in 312. `RELEASE-NOTES-v4.3.0.md` calls two arms (the
   digests/low-water/multi-read/verify-round arm and `planRound`) WORSE on a false claim that rule 2
   reads as an instruction and a description of code — SAME-WITHIN-NOISE now, still off. 4.5.0's
   notes give the corrected numbers. The options: publish 4.3.0 and 4.4.0 as written and let 4.5.0
   correct them a release later; or correct the two paragraphs in each GitHub release's body when it
   is published (the body is pasted from the file, so no branch moves); or a correction commit on
   `rel/4.3` and `rel/4.4` before their tags, which moves both release refs and `rel/4.5`'s base.

## Release 4.5.0

`rel/4.5` is release-ready but for H7 part 2 — the notes' two marked sections (*Gemma 4 26B-A4B, a
first look*; *Re-rank and the sample answer, on a suite built for them*) and H5b's commit if it
turns a switch on — and pushed nowhere. It is a fast-forward of `rel/4.4` (`b986dca`, 4.4.0),
`rel/4.3` (`8fe8d37`, 4.3.0) and `main` (`e1a5272`, 4.2.0). After 4.3.0 and then 4.4.0 are out
(A-049, A-060; their roadmaps' *Release* sections: `main` and `origin/main` at `b986dca`, the tags
`v4.3.0` and `v4.4.0` pushed), in the main checkout:

```bash
cd C:/Users/clong/Projects/SigmaOasis           # the main checkout, on main, clean
git fetch origin
git merge --ff-only rel/4.5                       # main → rel/4.5's tip
git push origin main                              # first: the release's guard needs the commit on origin/main
git tag -a v4.5.0 -m "Sigma Oasis 4.5.0 — plans that answer on a thinking model, a mark on a claim no test backs, and a new card under the 9B"
git push origin v4.5.0                            # runs .github/workflows/release.yml
```

For Colin to run, or to OK for Apex to run — nothing here has been run. What the tag's run checks,
as for 4.3.0 and 4.4.0: the guard wants the tagged commit on `origin/main` (pushed first) and
`package.json` at 4.5.0 (the "4.5.0: version" commit `7a252c4`, with the lockfile's two root
entries and `CLIENT_INFO`); the macOS job runs `npm ci` (the lockfile H6 wrote — electron-updater
6.8.10, `libc` fields kept), the typecheck and `npm test` (green here, below); electron-builder is
still 24, as 4.3.0 and 4.4.0 shipped; the assets are named by `electron-builder.yml`'s
`Sigma-Oasis-${version}-…`. Then publish the draft with `RELEASE-NOTES-v4.5.0.md` as its body —
once part 2 has filled its two sections — and set the Latest label deliberately when publishing.
`npm audit` reads 13 (decision 6); `release.yml` has no audit step.

## Status (2026-10-03 06:30, H7 part 1: 4.5.0 version and notes on `rel/4.5`, nothing pushed)

| goal | state | measured |
| --- | --- | --- |
| H1 9B on the B65 | **done — merged** (`5049548`), as measured | tool choice, the app's subset: **26, 26, 26, 26** of 28 in four runs (the 5070's 25, 24, 25, 25), saved as `baselines/toolchoice-…-ontop-filefirst-b65.json` (diff with `--noise-from` the 5070's file: σ 0). Agent: two passes, **20 and 17** of 26 (mean 18.50 against the 5070's 18.25, TOO-FEW-PASSES), 0 false claims in 52 runs, **not deterministic** (23 of 26 verdicts kept; decision 8), no agent baseline. `bench:latency`: a full window's first token **261 s** (5070 26.8 s; decision 7), past it with the low-water trim 3.03 s (0.70 s), decode 42 tok/s (95.5). Re-scored under claims rule 2 in H7: 0 flags moved |
| H2 think-first planners | **done — merged** (`bf3b756`) | on the 9B, grammar → plain with the closed-think prefill: plan mode valid 12/12 both, median 14.0 → **8.8 s**; the outline valid **3/12 → 12/12**, 31.9 → **7.7 s** (under the grammar it spent all 1,500 tokens thinking in 8 of 12); the research planner **stays on the grammar** (decision 1); the reformulation keeps it (plain 9/12 against 11/12); every other family is sent today's request byte for byte (golden bodies) |
| H3, H3b unrun-claim mark | **done — merged** (`88feb00`) | `src/main/agent/claims.ts`, `CLAIMS_RULE` 2: the engine, the agent turn and `sigma` mark a report that claims a pass the run does not show (annotation only; the 6 scripted tasks' 15 requests hash as before). On the 451 labelled sentences: 248 TP / 0 FP / 0 FN / 203 TN (rule 1: 243 / 6 / 5 / 197); over 1,058 recorded reports 9 flags flip (6 wrong ones off, 3 genuine on). Results files carry `claimsRule`; `eval:diff` refuses to compare, merge or join across rules; the baselines migrated (35B 3/99 → **1/99**, 9B 0/312 → **1/312**, decision 4); 4.3's verify round and plan round lose their only WORSE; `toolsByPhase` reads BETTER on false claims alone (decision 3) |
| H4a catalog reads llama.cpp | **done — merged** (`fe24374`) | `/v1/models` capabilities and meta (vision, loaded and training windows, quantization) and one `/props`; live `:8081` 3 GETs in 50 ms; LM Studio unchanged (golden entries, still one GET); the text-only warning names its server; no Load/Unload on a llama-server row |
| H4b Gemma 4 baselines | **in progress** (H4b1, a first look, on `4.5/gemma`; results under `.eval-results`, no commit expected) | tool choice: four passes recorded; agent: the first pass under way on the B65. Numbers go into the notes' *Gemma 4 26B-A4B, a first look* in H7 part 2 |
| H5a library-aids suite | **done — merged** (`4a2f6bc`) | `EVAL_SUITES=library-aids`: 27 cases, every question inside the aids' domains, over three packs of their own; plain ranking puts the source first in 9 (33%), 2nd–5th in 16, outside the five in 2, all 27 within the twelve and the re-rank's pool of 15; `EVAL_RETRIEVAL_ONLY=1` checks that without a model |
| H5b re-rank and HyDE on it | **in progress** — queued, not yet run (card in backlog): it follows H4b1 on the B65, one eval at a time | — ; it may turn a switch on with one commit, and fills the notes' *Re-rank and the sample answer* in H7 part 2 |
| H6 dependencies | **done — merged** (`4e79107`) | electron 44.5.1 is already the latest 44.x; electron-updater 6.8.9 → **6.8.10** (decision 5); `npm audit` 13 before and after (decision 6); `npm run build` stops at winCodeSign's symlink extraction, as it did for 4.3 and 4.4 on this PC |
| H7a integration, code tracks | **done** | the five tracks merged in order with no conflicts. `eval:claims` over the baselines: 0 defects, 0 misses; a `--rescore` dry run over every recorded results folder moves 0 flags. `eval:diff` reads library results (4.4's G5 files, a library-aids file) with no claim-rule check, and still refuses an agent file under rule 1 against a rule-2 baseline. `test:replay` 58/58. `node_modules` is now `rel/4.5`'s own (`npm ci`, lockfile untouched) |
| `npm test` on `rel/4.5` | **green** on `4e79107` (all five tracks in; after it, this file only) | node suite **3,878/3,878** (824 suites; 4.4.0's 3,634 + H2 22 + H3/H3b 184 + H4a 25 + H5a 13); render 25, style 74 and 123, tab traversal 43, modal focus 179, field contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown 62, workbench 53, MCP secrets 19, transport 24 (14 suites) |
| H7 part 1, 4.5.0 | **done** | `4.5/b65` merged (`5049548`, no conflicts); its two agent passes re-scored under claims rule 2 (`eval:claims --rescore --write`: 21 files, 52 runs, 50 read from a report, **0 flags moved**; `d045bd6` says so in `baselines/README.md`); `eval:diff` reads the B65 tool-choice file against itself SAME-WITHIN-NOISE, and the stamped agent passes against the 9B's baseline TOO-FEW-PASSES (unstamped, it refused them). Version `7a252c4` ("4.5.0: version"); notes `b206f89`, `RELEASE-NOTES-v4.5.0.md`; decisions 7–9 and *Release 4.5.0* in this file |
| H7 part 2 | **to do** — after H4b1 and H5b | the notes' two marked sections, H5b's commit if any, the decisions they leave, `npm test` again if code moves |

One gap seen while checking: `eval:diff` does not read a library file's `librarySuite`, so a
`library` file and a `library-aids` file would be compared without a refusal. H5b should diff aids
results only against aids results (a refusal like the claim rule's is a small follow-up).

Every switch and its default in 4.5.0 so far: `FORCED_TOOLS_ON_TOP` **on**, `FILE_TOOLS_FIRST`
**on**, agent `toolsByPhase` **off** (and every other agent experiment off), `libraryRerank`
**off**, `libraryHyde` **off** — as 4.4.0 left them, until H5b. New in 4.5, not switches: plan mode
and the outline go plain on a `<think>` family, and the unrun-claim mark (always on, annotation
only). The version is 4.5.0.
