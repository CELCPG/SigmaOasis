# Sigma Oasis v4.3.0 — a gate that knows its own noise, and the measurements 4.1 owed

4.1 and 4.2 measured the agent and then decided defaults with a gate that could not tell a change
from the weather: the same code scores anywhere from 14 to 21 of 26 a pass on the 9B, and the gate
called an unchanged engine worse. 4.3 gives the gate a noise band, re-decides every agent experiment
with it, and spends the rest on what was owed — the tool-choice and answer suites on the
descriptions 4.1 changed, a live-world suite that measures the model instead of its own fixture,
the latency bench's first lines (with the saving 4.1's history trim claimed, timed at last), and the
dependency upgrades, the reply renderer's markdown library among them. The plan and its status are
`ROADMAP-v4.3.md`.

## The gate, with a noise band

- **Four passes a side, or no verdict.** Below that `eval:diff` answers TOO-FEW-PASSES (exit 3)
  and calls no banded line.
- **Every gated line read against the measured spread.** A per-pass rate; the band is two standard
  errors of the difference of the two means, from the baseline's spread — measured when it is
  saved, and stored in it — and the run's own, never taken as quieter than the baseline's. The
  verdict is BETTER, SAME-WITHIN-NOISE or WORSE, and the table prints the band beside every delta.
- **False claims are never banded:** any rise is WORSE, on any number of passes.
- **Several runs make one arm** (`eval:diff` merges them on either side, `--save` into one
  baseline), and **slices make one pass** (`--join`): a pass that outlasts one command runs in
  `EVAL_CASES` ranges and is joined back.
- **Proved on 9/30's results.** The 4.1 engine (18, 21, 20, 19 of 26) against 4.2's with its
  experiments off (14, 16, 17, 21) — byte-identical on the wire — is **SAME-WITHIN-NOISE**: solved
  −2.50 a pass against a band of ±3.21, collateral +1.25 against ±1.35, the same the other way
  round. The 4.1 gate called the 4.1 engine's own second run a regression.
- **The 9B's agent baseline is now eight passes from four runs** (σ 2.49 of 26). A four-pass run
  against it gets a band of ±3.05 — the size of change four passes can see. A 2-case change needs
  about thirteen passes a side.

## Every agent experiment, re-decided — all stay off

Four passes an arm against that baseline, `qwen3.8-9b-distill`, 2026-10-01:

| arm | solved a pass | verdict |
| --- | --- | --- |
| digests, low-water mark, multi-read, verify round | 17, 16, 16, 17 | **WORSE** — a false claim (`needs-you-tax-rate`); solved −1.75, inside the band |
| think by phase (4.2's family profiles), plan focus | 15, 15, 13, 14 | **WORSE** — solved −4.00 against ±3.05 |
| reviewer, notes | 16, 14, 15, 16 | **WORSE** — five false claims in 104 runs, one or more every pass; solved −3.00, inside the band |
| `planRound` | 14, 16, 15, 19 | **WORSE** — its one false claim of 9/30 stands; solved −2.25, inside the band |

A switch turns on only when its arm is BETTER beyond the noise with no false claim; none was. Three
of the four were decided by the false claim — the line the band never touches. `toolsByPhase`, never
measured, stays off with them.

## Measured

`qwen3.8-9b-distill` on the RTX 5070, temperature 0, 2026-09-30 night and 2026-10-01.

- **Tool choice, re-run on 4.1's shorter descriptions** — and the first tool-choice baselines,
  four runs each, not one fixture flipping between runs: the whole toolbox 22 of 28 every pass;
  the chat's own selection 22 of 28 every pass. On the 24 fixtures shared with 2026-09-28's run,
  the descriptions lost their Example lines and the model lost nothing measurable.
- **What the chat puts on the wire, recorded.** A tool-choice run now records each question's
  tools, and the first record showed that when the chat forces the web pair onto a turn, its cap
  of six (four always on) evicts both ranked tools — "what time is it right now?" reaches the
  model with no clock tool, "make a note…" with no notes tool. Measured, not changed in this
  release: letting forced tools ride on top of the cap scored better; the choice is Colin's, for
  4.4.
- **Answers, three passes:** the library answered 80 of 84 (cited the source in 55); arithmetic and
  CSV questions 28 of 60 bare and **59 of 60 with the Workbench**; think harder 30 of 60 against
  29 bare.
- **The live world, measured on the model at last: 17 of 18 answered from the page**, the right
  day's figure every time, never the planted stale ledger entry — 4.1's live-world gate (≥ 90%)
  passes. Until now the suite served its pages from `http://127.0.0.1`, the fetch tool's own
  description says it refuses private addresses, and the model believed it (10 of 18). The
  fixture now sits behind an ordinary HTTPS address that the fetch guard's test seam maps to the
  machine itself; nothing sent to it leaves the machine, and the seam is closed in the app.
- **The latency bench's first lines:** cold 1.0 s, warm 73 ms, turn 10 of a growing chat 261 ms,
  decode about 95–100 tok/s. **Past a full window, the next turn takes 27.5 s if the oldest turn
  is dropped and the window re-read, and 0.70 s with 4.1's low-water trim** — the saving 4.1
  shipped untimed.
- On Windows: `npm run typecheck` clean; the node suite 3,603 of 3,603 (4.2's 3,569 and 34 new);
  every Electron check — render 25, style 74 and 123, tab traversal 43, modal focus 179, field
  contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown
  62, workbench 53, MCP secrets 19, transport 24.

## Dependencies

- **marked 12 → 18**, the library that turns every reply into HTML: the code-block and table
  renderers rewritten for 18's token objects. Across 25 samples — code, tables, task lists, raw
  HTML, links — the HTML is the same but for three changes no reader can see. DOMPurify is still
  the boundary, and its in-window check passes.
- **DOMPurify 3.4.16** (an XSS fix upstream, in a mode the app does not use), **Electron 44.5.1**,
  highlight.js 11.12, postcss and autoprefixer, `@types/node`, and the transitive packages `npm
  audit` could fix without a major. Advisories: 18 → 11; every one left comes with
  electron-builder 24 or the vite chain, and `docs/dependencies-4.1.md` has the order.

## Fixed

- **The agent's worktrees run no repository hook.** `git worktree add` checks a tree out, and a
  checkout runs the repository's `post-checkout` hook — code from the folder, run because the app
  asked git for a worktree. Hooks are now read from an empty directory made for the call.
- **`.sigma/`'s inbox and trash stay out of `git status`.** The ignore file listed the worktrees
  alone, so a dropped file or a deleted one could be committed by a `git add -A`; it now lists all
  of the app's plumbing, and an older one is brought up to date.
- The evals: think harder's review was cut at the harness's 2,000 tokens where the app gives it
  room; the tornado case flagged the pack's own advice as forbidden; `npm run test:replay` ran the
  whole suite; a per-turn-selection tool-choice run was filed as a whole-toolbox run.

## Not in this release

- electron-builder 26 (on its own branch: the Windows build is proved; the signed Mac build cannot
  be dry-run without a release tag), the build chain, React 19, zustand 5, tailwind 4,
  electron-store 11.
- Library re-rank, the sample-answer expansion and draft models stay off and unmeasured.
- The forced-tools eviction above, measured and left for Colin.

## Upgrade notes

- Nothing changes in Settings or on disk. Replies render as before. `.sigma/.gitignore` gains
  `inbox/` and `trash/` the next time the agent makes any of its folders.
- For anyone running the evals: `eval:diff` exits 3 below four passes a side, `--save` takes
  several runs, `--join` takes slices, and a baseline carries a `noise` block. Subset tool-choice
  runs are written as `subset-toolchoice-*.json` and record each fixture's `wire`.
