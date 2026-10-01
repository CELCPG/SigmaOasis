# Baselines

The eval results every change is judged against (ROADMAP-v4.1.md, Track M; the noise band is
ROADMAP-v4.3.md, item 1). A change that claims to hold is diffed against the file here for the
same suite, model and arm; the diff is the gate, and its table goes in the commit or PR that makes
the claim.

```
npm run eval:diff -- baselines/agent-qwen3.8-9b-distill.json .eval-results/agent-qwen3.8-9b-distill-2026-….json [more runs of the same arm …]
npm run eval:diff -- --base <a.json> <b.json> --run <c.json> <d.json>
```

The verdict is one of three words, and the exit code follows it:

| verdict | exit | meaning |
| --- | --- | --- |
| BETTER | 0 | a gated line moved beyond its noise band the right way, and none the wrong way |
| SAME-WITHIN-NOISE | 0 | no gated line moved beyond its band |
| WORSE | 1 | a gated line moved beyond its band the wrong way, or a false claim appeared |
| TOO-FEW-PASSES | 3 | a side has fewer than four passes, so no banded line was called |

Exit 2: the files could not be read or compared.

## What is gated (v4.3)

Only the cases both sides ran are compared. Each gated line is a **per-pass rate**, and the run's
mean is read against the baseline's with a **noise band**:

    band = 2 · √(σb²/nb + max(σr, σb)²/nr)

σb is the baseline's pass-to-pass standard deviation, measured when it was saved and stored in it
(`noise`, below); σr is the run's own, never taken as smaller than σb (four passes that happen to
agree do not prove a quieter engine); nb and nr are the passes. Two standard errors of the
difference: an unchanged engine lands outside it about one time in twenty.

| suite | the solved line (may not drop beyond its band) | flags (may not rise beyond their band) | never banded (any rise is WORSE) |
| --- | --- | --- | --- |
| `eval:agent` | solved per pass | collateral · Undo leaving files | false claims |
| `eval:tools` | clean per pass (correct, no spurious call, no loop) | spurious calls on no-tool fixtures · loops · runs with invalid arguments | — |

- **At least four passes a side.** Several results files of one arm merge into one side — and
  should: passes of one run share the server's state, and two runs of the same code differed by
  four cases in their means on 9/30. A merge refuses files of another model or arm.
- **A pass too long for one command** can be run in `EVAL_CASES` slices and joined back into one
  pass with `npm run eval:diff -- --join <slice> <slice> … --out <pass.json>` (v4.3): same model,
  arm and pass count, no case in two slices. A merge would count each slice as a pass.
- The **stable set** (the baseline's cases that never flipped) and the flaky cases are still
  printed, with the cases a run lost or gained — that is where to look — but no longer gated.
- The table prints the band beside every delta, and a last line says how many passes a 2-case
  change would need at the measured spread.
- Timing (wall time, rounds, TTFT, decode tok/s) is printed and not gated: the machine moves it
  (v4.1, decision 1). `--tolerance 0.05` widens the solved band by 5 points; the default is none.
  `--min-passes` changes the four; only a deterministic replay should lower it (`test/replayGate`).

## The format

A baseline is a results file as `eval:agent` or `eval:tools` writes it, trimmed by

```
npm run eval:diff -- --save .eval-results/agent-<model>-<time>.json [more runs of the same arm …] [--name <name>]
```

which merges the runs, keeps the schema and every scored field, drops what only a reader of one
failure needs (the report text, the check's output, each round's timing — the per-run timing summary
stays), and adds `baseline: { from, savedAt, passRuns }` (`passRuns`: which run each pass came from)
and `noise`: for each gated line, the hits per pass, the rate's mean and σ, and the band a four-pass
run with no more spread would get. A comparison on fewer cases than the band was measured on
re-derives it from the passes and says so. The default name is `<suite>-<model>[-x-<experiments>]
[-<arm>]`: `agent-qwen3.8-9b-distill.json`, `agent-qwen3.8-9b-distill-x-resultDigests.json`,
`toolchoice-qwen3.8-9b-distill.json`, `toolchoice-qwen3.8-9b-distill-subset.json`. The full files
stay in the ignored `.eval-results/`.

## Rules

- Record a baseline with at least four passes from at least two runs (`EVAL_PASSES=2`, twice, is the
  minimum; more resolves more), the app closed and LM Studio to itself. `--save` warns below either.
- Replace a baseline only in a commit that says why, with the diff table between the old one and
  the new one. A baseline quietly re-recorded after a regression is how a gate stops gating.
- The reference models are the 9B distill on the 5070 and the 35B-A3B as the second arm
  (ROADMAP-v4.1.md, decision 2).
- `agent-qwen3.8-9b-distill-4.0.2.json` has two passes from one run: kept as the record of 4.0.2, it
  can only answer TOO-FEW-PASSES.

## The noise floor (measured 2026-09-30)

The same engine, unchanged, scores single passes anywhere from 14 to 21 of 26 on
`qwen3.8-9b-distill` (temperature 0; LM Studio's MTP drafting and prompt-cache reuse make greedy
decoding path-dependent): 18, 21 and 20, 19 for the 4.1 engine's two runs, 14, 16 and 17, 21 for
4.2's with its experiments off, whose requests are byte-identical. σ is 2.49 cases a pass over all
eight. The 4.1 gate called the 4.1 engine's second run WORSE than its first; the 4.3 gate calls 4.1
against 4.2 (four passes each) SAME-WITHIN-NOISE — solved −2.50 per pass against a band of ±3.21,
collateral +1.25 against ±1.35. At that spread a four-pass arm resolves about ±3.5 cases of 26; a
2-case change needs about 13 passes a side.

The committed `agent-qwen3.8-9b-distill.json` is those eight passes, four runs (v4.3): solved
18.25 of 26 a pass, σ 2.49; a four-pass run diffed against it gets a band of ±3.05.
