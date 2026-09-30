# Speed: Track S

Part of the [evals index](../evals.md).

## Speed: Track S (v4.1)

Nothing in this section is measured yet; each item names what would measure it. The one
check that runs today is `test/promptCache.test.ts` (roadmap M4): consecutive turns are
built with the turn's own functions, rendered the way a ChatML template renders them
(tools inside the system block), and the previous request minus its turn notes must be a
prefix of the next. It fails on 4.0.2's rules in two of its four cases — the full
conversation (0 of 7 transitions kept the prefix) and factual → chatty → factual.

- **S1, the low-water mark.** Over budget, history trims to 65% of it
  (`HISTORY_LOW_WATER`), and what an earlier turn folded away stays folded while the rest
  fits. A full conversation re-summarizes once every few turns instead of every turn.
  Measure: M7's "past its window" arm, prefill ms per turn.
- **S2, providers.** The library lookup runs beside the ledger → search chain; the app-run
  search stops holding the turn at 3.5 s (`AUTO_SEARCH_SOFT_DEADLINE_MS`). A late result
  is recorded as not used and charges no budget. Measure: gather ms on factual turns, and
  how often the deadline fires (a record reading "Not used").
- **S3, reasoning.** Reasoning streams through the paced tail and lands on the message at
  round ends; the critic's text patches once a frame. Measure: `BENCH_REASONING=6000
  npm run bench:render`, before and after.
- **S4, thinking.** The renderer's checks (claim extraction and judging, the critic, the
  recompute program) run with the closed-think prefill on think-tag models, as the main
  process's utility calls have since v1.9.2. Per role: Thinking auto / on / off. Measure:
  checking seconds on the stat line; claim-check verdicts against the answer suites.
- **S5, tool payloads.** A ranking failure keeps the previous turn's tools; the web pair
  stays once sent. The Example lines left the tool descriptions: 17,410 → 15,684
  description characters (−10%, not the 30–40% the roadmap hoped — the rest is the
  decision rules, kept). The wire hash moved (`8f651f5e6e7d`), so `eval:tools` owes a
  re-run before this ships.
- **S6, small costs.** Query vectors are cached for 60 s by (model, text); a streaming
  code block is highlighted in settled 40-line runs, so a flush costs the new text rather
  than the whole block. Finished messages render byte-for-byte as before.
