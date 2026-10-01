# Roadmap: Sigma Oasis 4.3 — a gate that knows its noise, and the measurements 4.1 owed

Written by Apex the night of 2026-09-30, against `main` at 4.2.0 (`e1a5272`), from the list the 4.2
notes and the 4.1 status left: a gate that can tell a change from the noise, the tool-choice and
answer suites re-run on the descriptions 4.1 changed, the latency bench's first line, and the
dependency upgrades. Built that night on `rel/4.3`; finished on 2026-10-01 after Colin's "publish
4.2.0 and let's finish up 4.3" and the decisions in A-042. The status is at the end.

## Where 4.2.0 stood

- **The release ran clean, as a draft.** The tag's run (Actions run 36706904583, 2026-09-30
  11:10–11:26 UTC) passed all six jobs; draft release 399976042 carried all eleven assets and an
  empty body; the tap was bumped (`CELCPG/homebrew-tap` 164bca7). Published 2026-10-01 11:33 UTC
  on Colin's word, titled and with a body (24,760 characters), all eleven assets on it.
- **The gate could not decide.** The same engine scores single passes from 14 to 21 of 26 on the
  9B; `eval:diff`'s two-pass stable-set gate called an unchanged engine WORSE.
- **Owed since 4.1:** `eval:tools` and `eval:answers` (with the new `live` suite) not re-run since
  4.1 dropped the descriptions' Example lines; `bench:latency` never run; no dependency upgraded
  (`npm audit`: 18 advisories, 1 critical).

## E — measurement

1. **A gate with a noise band.** At least four passes a side; every gated line a per-pass rate read
   against `band = 2·√(σb²/nb + max(σr, σb)²/nr)`, σb stored in the baseline; BETTER /
   SAME-WITHIN-NOISE / WORSE, or TOO-FEW-PASSES; false claims never banded; several runs of one
   arm merge. **Done.** 4.1 against 4.2 with experiments off — byte-identical requests — is
   SAME-WITHIN-NOISE.
2. **Re-run `eval:tools` and `eval:answers`.** **Done**, with baselines for tool choice.
3. **`bench:latency`'s first lines.** **Done**, and the bench now times S1's saving.
4. **The live suite measured its fixture** — its pages were `http://127.0.0.1:<port>/…`, which
   `fetch_webpage`'s own description says it refuses, and 7 of 8 misses said so. **Done** (A-042:
   the suite may use the fetch guard's test seam): `SIGMA_RESEARCH_FIXTURE_ALIAS` names one exact
   HTTPS origin standing for the fixture; the guard admits it unresolved, `auditedFetch` sends any
   request for it to the loopback server, the page renderer refuses it — nothing addressed to it
   leaves the machine (`src/main/ipc/fixtureSeam.ts`, closed in the app). Live: **17/18, the 4.1
   gate (≥ 90%, no ledger answer) passes.**
5. **`eval:tools` records each fixture's wire set.** **Done** — and the first record found the
   subset arm was not the chat's wire (F6).
6. **Think-harder's empty review** (1,999 of 2,000 tokens thinking). **Done**: the harness's cap,
   not the app's — the review and revision get 6,000, as the app gives them room, and a review
   that never answers scores the draft as the app keeps it. 0 errors in 60 (2 before).
7. **The library's forbidden-pattern false positive.** **Done**: the tornado case flagged "below
   the windows" (the pack's car advice), not "stay away from windows"; it now forbids the unsafe
   advice, and the summary counts forbidden hits. 3/84 → 0/84 on the three passes, rescored.
8. **Re-decide the agent experiments at four passes a side**, by the gate, against the eight-pass
   baseline. **Done** — all four arms WORSE (three on a false claim, one on solved), every switch
   stays off; the verdicts are in the status table and `docs/evals/agent.md`. Arms ran in `EVAL_CASES` slices joined back into passes
   (`eval:diff --join`), because a pass outlasts one command here.

## D — dependencies (docs/dependencies-4.1.md)

1–6. electron 44.5.1; dompurify 3.4.16 (an XSS advisory); highlight.js 11.12; postcss and
   autoprefixer; @types/node 24.19; `npm audit fix` without `--force`. **Done.**
7. marked 12 → 18 — the notes' first major, on the XSS path. **Done**, kept (A-042).
8. electron-builder 26 — **stays out of 4.3** (A-042): `release.yml` runs on `push: tags: v*`
   only, so the signed Mac half cannot be dry-run without a real tag. The Windows half is proved
   on `4.3/builder26` (`0126690`, not merged). How to add the dry run is under *Decisions*.
9. The build chain (vite 7, electron-vite 5, plugin-react 5); then React 19, zustand 5, tailwind
   4, electron-store 11, TypeScript 7. → 4.4.

## F — found and fixed on the way

1. `npm run test:replay` ran the whole suite: `scripts/test.sh` never read `--only`. **Fixed.**
2. An `EVAL_SUBSET=1` run was filed as a whole-toolbox run. **Fixed.**
3. `bench:latency` timed S1's cost and never its saving. **Fixed.**
4. `.sigma/.gitignore` ignored `worktrees/` alone, so the inbox and the trash showed in the user's
   `git status` (a 4.1 known gap). **Fixed**, and an older file is brought up to date.
5. The app's `git worktree add` ran the repository's own `post-checkout` hook (a 4.1 known gap).
   **Fixed**: hooks are read from an empty directory made for the call.
6. **The chat's forced tools evict the ranked picks.** Four tools are always on and the cap is
   six, so on a turn the web pair is forced onto, both ranked picks go — "what time is it right
   now?" reaches the model with no `get_current_datetime`, "make a note…" with no `create_note`
   (both on by default). `withForcedTools` also evicts by wire order, not by rank as its comment
   says. The behaviour is 4.0.1's, deliberate and pinned by tests. Measured, not changed: with
   forced tools on top of the cap, the subset arm is BETTER (+0.75 clean a pass, band ±0.50) on
   the eval's full toolset. **A decision for Colin, 4.4.**

## Moved to 4.4, with the reason

- **Re-rank, the sample-answer expansion** (4.2, off): `eval:diff` reads agent and tool-choice
  results only, and the library suite's lookup asks "the first chat model LM Studio lists" — with
  re-rank on, that could load another model. Needs the answering model passed and the gate taught
  the library suite's file.
- **Draft models** (4.2, off): measuring one means loading a second model in LM Studio, which is
  Colin's to allow.
- **`read_note` and `memory_save` outrank `read_file` and `write_file`** for file requests in the
  embedding ranking (E5's wire record): a ranking change is a wire change and needs its own arm.
- **`toolsByPhase`** (4.1, A5, off): never decided by a measurement, so not a re-decision; four
  passes cost about an hour of the shared 9B, spent on the arms that had been decided.
- **A same-day control for the agent arms**: every 4.3 verdict keeps a switch off; the first arm
  that comes out BETTER needs the baseline re-run beside it before anything turns on.
- **The 35B-A3B's agent baseline** (still owed since 4.1).
- **A signed Windows installer** (4.0's E7): a code-signing certificate is Colin's to buy.
- D9, the build chain and the rest.

## Decisions for Colin

Taken (A-042, 2026-10-01): marked 18 kept; the eight-pass baseline kept; the live suite may use the
test seam; electron-builder 26 out of 4.3.

Open:

1. **F6 — forced tools on top of the cap?** Keep 4.0.1's cap (today's behaviour), or let forced
   tools ride on top (8 tools on a forced turn; measured BETTER above), or evict by rank only
   (does not help when two forced tools take both ranked places). Recommendation: on top, with an
   arm over the default toolset first.
2. **A dry run for the signed Mac build**, before electron-builder 26: a second workflow,
   `release-dryrun.yml`, `on: workflow_dispatch`, running the macOS job as `release.yml` has it
   (credentials preflight, keychain, `electron-builder --mac --publish never`) and uploading the
   DMGs as an artifact — no `publish`, no Homebrew job. GitHub only offers a dispatch workflow once
   the file is on the default branch, so: merge that file to main, then
   `gh workflow run release-dryrun.yml --ref 4.3/builder26` (or Actions → *Release dry run* → Run
   workflow → branch `4.3/builder26`). Nothing in this repository does that today.
3. A code-signing certificate for the Windows installer.

## Release 4.3.0

`rel/4.3` is release-ready and pushed nowhere. On `main` (`e1a5272`, behind it, nothing of its own):

```bash
cd C:/Users/clong/Projects/SigmaOasis           # the main checkout, on main, clean
git fetch origin
git merge --ff-only rel/4.3                       # main → rel/4.3's tip
git push origin main                              # first: the release's guard needs the commit on origin/main
git tag -a v4.3.0 -m "Sigma Oasis 4.3.0 — a gate that knows its own noise, and the measurements 4.1 owed"
git push origin v4.3.0                            # runs .github/workflows/release.yml
```

What the tag's run checks, and why it will pass: the guard wants the tagged commit on `origin/main`
(pushed first) and `package.json` at 4.3.0 (the "4.3.0: version" commit, with the lockfile and
`CLIENT_INFO`); the macOS job runs `npm ci`, the typecheck and `npm test` (green here, below); the
assets are named by `electron-builder.yml`'s hard-coded `Sigma-Oasis-${version}-…`, which is what
the publish job verifies and the Homebrew job reads. Then publish the draft with
`RELEASE-NOTES-v4.3.0.md` as its body; the tap points at it from the moment the run ends.

## Status (2026-10-01, 4.3.0 on `rel/4.3`)

| item | state | measured |
| --- | --- | --- |
| E1 the band | **done** | 4.1 (18, 21, 20, 19) against 4.2 off (14, 16, 17, 21): **SAME-WITHIN-NOISE**, solved −2.50 a pass against ±3.21; the 4.1 gate called the 4.1 engine's own second run a REGRESSION |
| E1 the baseline | **done** — eight passes, four runs, σ 2.49 of 26 | a four-pass run gets ±3.05; a 2-case change needs ~13 passes a side |
| E2 `eval:tools` | **done**, two baselines | whole toolbox 22 ×4 of 28; the subset as the chat composes it 22 ×4 (re-recorded 10/1; 23 ×4 ranked only) |
| E2 `eval:answers` | **done**, three passes | library answered 80/84, cited 55/84; quant bare 28/60, Workbench **59/60** |
| E3 `bench:latency` | **done**, two lines | next turn past a full window **27.5 s without the low-water mark, 0.70 s with it** |
| E4 live suite | **done** | **17/18 · 94%**, ledger 0/18, wrong day 0/18 — the 4.1 gate passes (10/18 on the fixture before) |
| E5 wire record | **done** | every subset miss was the ranking's; F6 |
| E6 think harder | **done** | 0 errors, 0 unreviewed in 60; 29/60 → 30/60 |
| E7 forbidden | **done** | 3/84 → 0/84 |
| E8 arm A: digests, low-water mark, multi-read, verify round | stays off | **WORSE** — one false claim (`needs-you-tax-rate`); solved 16.50 a pass (17, 16, 16, 17), −1.75 against ±3.05 |
| E8 arm B: think by phase (4.2's family profiles), plan focus | stays off | **WORSE** — solved 14.25 a pass (15, 15, 13, 14), −4.00 against ±3.05; no false claim |
| E8 arm C: reviewer, notes | stays off | **WORSE** — five false claims in 104 runs (one or more every pass); solved 15.25 a pass (16, 14, 15, 16), −3.00 against ±3.05 |
| E8 `planRound` | stays off | **WORSE** — 9/30's one false claim stands (the two new passes had none); solved 16.00 a pass (14, 16, 15, 19), −2.25 against ±3.05 |
| E8 `toolsByPhase` | stays off, unmeasured | never decided by measurement; not run — 4.4 |
| D1–D7 | **done**, each with the full `npm test` | advisories 18 → 11 |
| D8 electron-builder 26 | out of 4.3 — no dry run without a tag | 3 advisories left on its track |
| F1–F5 | **done** | — |
| F6 forced tools | measured, unchanged — Colin's | on top of the cap: BETTER, +0.75 clean a pass (±0.50) |
| `npm test` on `rel/4.3` | **green** on "4.3.0: version" (`f882e22`) and on the notes commit after it | node suite 3,603/3,603; render 25, style 74 and 123, tab traversal 43, modal focus 179, field contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown 62, workbench 53, MCP secrets 19, transport 24 |
| release preconditions | **checked** | `origin/main` still `e1a5272`, an ancestor of `rel/4.3` (fast-forward); no `v4.3*` tag on the remote; `package.json` 4.3.0; `release.yml`, `electron-builder.yml` and `fetch-pyodide.sh` unchanged since 4.2.0's green run; `npm ls` clean |

Measured on Windows, `qwen3.8-9b-distill` on the RTX 5070, the Clerk task paused. The agent arms
ran on 2026-10-01 against a baseline measured overnight on 9/30, with no same-day control; every
verdict keeps its switch off, so none turns on this, but a BETTER would have needed one.
