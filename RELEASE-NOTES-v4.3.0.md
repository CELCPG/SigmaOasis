<!-- Draft, written on rel/4.3 the night of 2026-09-30. Not released: no version bump, no tag. -->
# Sigma Oasis v4.3.0 — a gate that knows its own noise, and the measurements 4.1 owed

4.1 and 4.2 measured the agent and then decided defaults with a gate that could not tell a change
from the weather: the same code scores anywhere from 14 to 21 of 26 a pass on the 9B, and the gate
called an unchanged engine worse. 4.3 gives the gate a noise band, then spends the night on what
was owed — the tool-choice and answer suites on the descriptions 4.1 changed, the latency bench's
first line (with the saving 4.1's history trim claimed, timed at last), and the dependency
upgrades, the reply renderer's markdown library among them. The plan and its status are
`ROADMAP-v4.3.md`.

## The gate, with a noise band

- **Four passes a side, or no verdict.** Below that `eval:diff` answers TOO-FEW-PASSES (exit 3)
  and calls no banded line.
- **Every gated line read against the measured spread.** A per-pass rate; the band is two standard
  errors of the difference of the two means, from the baseline's spread — measured when it is
  saved, and stored in it — and the run's own, never taken as quieter than the baseline's. The
  verdict is BETTER, SAME-WITHIN-NOISE or WORSE, and the table prints the band beside every delta.
- **False claims are never banded:** any rise is WORSE, on any number of passes.
- **Several runs make one arm.** Passes of one run share the server's state; `eval:diff` merges
  runs on either side, and `--save` merges them into one baseline, refusing another model or arm.
- **Proved on 9/30's results.** The 4.1 engine (18, 21, 20, 19 of 26) against 4.2's with its
  experiments off (14, 16, 17, 21) — byte-identical on the wire — is **SAME-WITHIN-NOISE**: solved
  −2.50 a pass against a band of ±3.21, collateral +1.25 against ±1.35, the same the other way
  round. The 4.1 gate called the 4.1 engine's own second run a regression.
- **The 9B's agent baseline is now eight passes from four runs** (σ 2.49 of 26). A four-pass run
  against it gets a band of ±3.05 — the size of change four passes can see. A 2-case change needs
  about thirteen passes a side.

## Measured

`qwen3.8-9b-distill` on the RTX 5070, temperature 0, the night of 2026-09-30.

- **Tool choice, re-run on 4.1's shorter descriptions** — and the first tool-choice baselines,
  four runs each, not one fixture flipping between runs:

  | arm | clean per pass (28) | correct-tool | spurious |
  | --- | --- | --- | --- |
  | the whole toolbox | 22, 22, 22, 22 | 84/100 | 0/12 |
  | the app's own six a turn | 23, 23, 23, 23 | 80/100 | 0/12 |

  On the 24 fixtures shared with 2026-09-28's run, 21 then and 21 now: the descriptions lost their
  Example lines and the model lost nothing measurable.
- **Answers, three passes:** the library answered 80 of 84 (cited the source in 55); arithmetic
  and CSV questions 28 of 60 bare and **59 of 60 with the Workbench**; think-harder moved one case
  in sixty. The live-world suite passed 10 of 18 with no ledger answer and no wrong day in any —
  and its misses are its fixture's: the pages are served from `http://127.0.0.1`, the web fetch
  tool's own description says it refuses private addresses, and the model believed it.
- **The latency bench's first lines:** cold 1.0 s, warm 73 ms, turn 10 of a growing chat 261 ms,
  decode about 95–100 tok/s. **Past a full window, the next turn takes 27.5 s if the oldest turn
  is dropped and the window re-read, and 0.70 s with 4.1's low-water trim** — the saving 4.1
  shipped untimed. The bench now has both scenarios.

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

- `npm run test:replay` ran the whole suite: the test script never read the `--only` it was given.
- A tool-choice run with the app's per-turn selection was filed as a whole-toolbox run, so the
  model picker's score could show the wrong arm's number.

## Not in this release

- The live suite's fixture origin (it waits on a decision about the fetch guard's test seam), so
  4.1's live-world gate is still unjudged.
- Every experiment stays off; none has been re-run at four passes a side against the new baseline.
- electron-builder 26, the build chain, React 19, zustand 5, tailwind 4, electron-store 11.

## Upgrade notes

- Nothing changes in Settings or on disk. Replies render as before.
- For anyone running the evals: `eval:diff` exits 3 below four passes a side, `--save` takes
  several runs, and a baseline carries a `noise` block. Subset tool-choice runs are written as
  `subset-toolchoice-*.json`.
