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
| `eval:answers` library (v4.4) | answered per pass | cited the source (may not fall beyond its band) · unsupported figures | asserted forbidden advice |

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
- `agent-qwen3.8-35b-a3b.json` (v4.4, G6): the 35B-A3B in llama-server on the B60, four passes from four
  joined runs, 2026-10-01 night — over 25 cases: `long-discount-rules` finished inside the harness's
  8.5-minute chunk 2 times in 7 on it and is left out of every pass (the file says so in `note`).
- The subset baselines (v4.4, G10, re-recorded 2026-10-02 in one session, four passes a side, ABBA):
  `toolchoice-qwen3.8-9b-distill-subset-ontop-filefirst.json` is the chat as 4.4 ships it
  (`FORCED_TOOLS_ON_TOP` and `FILE_TOOLS_FIRST` on — `EVAL_SUBSET=1 EVAL_FORCED_ON_TOP=1
  EVAL_FILE_TOOLS_FIRST=1`), and a change to the chat's selection is diffed against it;
  `toolchoice-qwen3.8-9b-distill-subset.json` is the same arm with every switch off, its control.
  Both rank on the descriptions alone, as the app does (4.3's subset baseline ranked on
  `name: description` — ROADMAP-v4.4, F1). The whole-toolbox `toolchoice-qwen3.8-9b-distill.json`
  stands: no description, fixture or system prompt changed in 4.4, so its wire is byte-identical.

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

## The same-day control (v4.4, G1)

A committed baseline is another day's: the machine, the server's state and the hour are not the
arm's. On 9/30 two runs of unchanged code differed by four cases in their means, so a BETTER
against a baseline from another day may have measured the day. **A switch turns on by default only
if its arm is BETTER beyond the band against a same-day control, with no new false claim** (and,
in the library suite, no new forbidden advice). The control is the engine with every switch off,
run in the arm's own session, interleaved with it:

```
# one command: a pass of each in turn, ABBA (control first on odd passes, the arm first on even)
EVAL_CONTROL=1 EVAL_EXPERIMENTS=toolsByPhase EVAL_PASSES=4 LMSTUDIO_EVAL=1 npm run eval:agent -- <model>
EVAL_CONTROL=1 EVAL_SUBSET=1 EVAL_FORCED_ON_TOP=1 EVAL_PASSES=4 LMSTUDIO_EVAL=1 npm run eval:tools -- <model>
EVAL_CONTROL=1 EVAL_SUITES=library EVAL_LIBRARY_ASSIST=rerank EVAL_PASSES=4 LMSTUDIO_EVAL=1 npm run eval:answers -- <model>

# a pass too long for one command: EVAL_CASES slices, each tagged with the session, the
# control's and the arm's slices alternating; join each side's slices into passes (--join)
EVAL_SESSION=<id> EVAL_CASES=1-4 LMSTUDIO_EVAL=1 npm run eval:agent -- <model>                         # control
EVAL_SESSION=<id> EVAL_CASES=1-4 EVAL_EXPERIMENTS=toolsByPhase LMSTUDIO_EVAL=1 npm run eval:agent -- <model>  # arm

npm run eval:diff -- --paired <the session's control and arm files …>    # sorted by their tags
npm run eval:diff -- --base <control passes …> --run <arm passes …>        # the same, by hand
```

Each results file says `session: { id, role }` — `control` for the engine with every switch off,
`arm` otherwise. Every diff prints its base on its second line: *the same-day control* (the base
is the control and the run the arm of the same session ids), *a committed baseline* (saved on a
date), *a control from another session*, or *a results file with no session*. A BETTER against
anything but the same-day control carries a note that it cannot turn a switch on. A four-pass control
measures its own spread from four numbers and can read quieter than the engine is (the 9B's control on
2026-10-01 night read 18, 19, 18 — σ 0.58 of 26 — after three passes, against the eight-pass baseline's
2.49; its fourth pass scored 13); `--noise-from baselines/<baseline>.json` floors
every side's spread at that baseline's, and says so. Several arms may
share one control's passes when they ran interleaved with it in one session (4.4's tool-choice and
library arms did).

## The B65 (v4.5, H1)

Since 2026-10-02 the 9B (`qwen3.8-9b-distill`, Q4_K_M, 68,608-token context, LM Studio over Vulkan)
runs on an Intel Arc Pro B65; the RTX 5070 is gone. Every number above was measured on the 5070 and
stays as it is: that is the history, and the card is out of the machine. Recorded 2026-10-03
on `4.5/b65` (the 4.4.0 engine, the chat as it ships), one machine, LM Studio to itself, Clerk off.

| on the B65, diff against | file | how |
| --- | --- | --- |
| tool choice, the app's subset (`EVAL_SUBSET=1 EVAL_FORCED_ON_TOP=1 EVAL_FILE_TOOLS_FIRST=1`) | `toolchoice-qwen3.8-9b-distill-subset-ontop-filefirst-b65.json` | add `--noise-from baselines/toolchoice-qwen3.8-9b-distill-subset-ontop-filefirst.json` (below) |
| agent | **none yet** | two passes exist (20 and 17 of 26), the agent is not deterministic here and the rule wants four: run the same-day control (`EVAL_CONTROL=1`) and diff against it, or record passes 3–4 first |
| anything else (whole-toolbox tool choice, the subset's control, the 35B-A3B) | the 5070 files above | a cross-card look at best; not re-recorded on the B65 |

`toolchoice-…-ontop-filefirst-b65.json` is four passes from four runs (rule met): **26, 26, 26, 26
of 28 clean**, spurious 0/3, invalid arguments 0, loops 1 a pass. The 5070's file reads 25, 24, 25, 25.
It fails the same two fixtures every pass — `22-price-near-miss` (calls `web_search`, not
`shop_compare`, and repeats it to the iteration cap: the one loop) and `27-live-futures` (calls
`market_data` first where `web_search` is expected) — and solves two the 5070's file never did (`15-shop-requirements`, `26-live-score`).
Diffed against the 5070's file it reads BETTER on clean (+1.25, band ±0.71) and WORSE on loops
(0 → 1, band ±0.00): a difference between the cards on one fixture, saved in
`.eval-results/…/h1/diff-tools-vs-5070-ontop-filefirst.txt`, not a regression of the code.

**Use `--noise-from` with it.** The four passes agree to the case, so σ is 0.00 and a future run
would be held to a band of ±0.00: one lost fixture would read WORSE. The 5070's σ (0.50 of 28, ±0.71
for four passes) is the honest floor — four passes that happen to agree do not prove a quiet engine
(the rule's own words about the control, above). With the flag a run identical to the file reads
SAME-WITHIN-NOISE at ±0.71; the flags (spurious calls, loops, invalid arguments) keep their band of ±0.

**Is the B65 deterministic? For tool choice's verdicts, nearly; for the agent, no.**
- Tool choice, four passes: 27 of 28 fixtures made the same calls, stopped the same way and scored
  the same in every pass. The one that did not, `01-list-directory`, made 3 calls in passes 1–3 and 2
  in pass 4 — scored correct either way. So no pass differed in a score, and the passes add no spread.
- Agent, two passes (20 and 17 of 26, 0 false claims in 52 runs, collateral on 3 cases in each): 23 of
  26 cases kept their verdict, and the 3 that flipped (`chain-stats`, `needs-you-tax-rate`,
  `read-only-why-failing`) all went from solved to not solved. Rounds were equal in 12 of 26 cases, tool
  calls in 12, final text in 7, the per-round completion-token sequence in 1 (`needs-you-deploy-token`).
  Two of the three collateral cases differ between the passes (`refactor-callback-to-promise` touched
  `check-config.js` in pass 1 and nothing in pass 2; `needs-you-tax-rate` the reverse, `src/vat.js`;
  `office-merge-sheets` touched `make_merged.py` and then `merge.py`). The same cases in the same order
  in the same chunk gave different runs (cases 1–4: `chain-slugify` 18 rounds, 156 s in pass 1, 37
  rounds, 508 s in pass 2), and `feature-top-words` ran away (> 7 min and > 9 min) after
  `feature-stack-peek` in two chunks and took 100 s and 315 s alone. Case by case:
  `.eval-results/…/h1/determinism-p1-p2.md`.
- So greedy decoding on the B65 does **not** make the agent suite repeatable: a round whose hidden
  reasoning differs by a few tokens changes the next prompt, and the runs part within one or two
  rounds. Extra passes buy spread here, as on the 5070 (the two passes' σ is 2.12 of 26; the 5070's
  eight, 2.49). Tool choice is the exception because a fixture is one or two rounds.
- No agent baseline is committed: two passes cannot answer anything but TOO-FEW-PASSES, which is all
  `agent-qwen3.8-9b-distill-4.0.2.json` does already. Passes 3–4 (about 45–50 minutes of GPU a pass here)
  make four passes in four runs.

**The agent's verdict on the B65** (H1, two passes, the 4.4 engine with every experiment off):
- **Solved:** 20 and 17 of 26, mean 18.50 (σ 2.12) against the 5070's 18.25 over eight passes (14–21,
  σ 2.49): +0.25, nowhere near a difference. Two passes cannot show that the cards are equal, only that
  nothing here says the B65 solves fewer (`eval:diff` on them reads TOO-FEW-PASSES, exit 3; the band
  it would have held them to is ±3.94).
- **False claims: 0** in 52 runs (26 cases, two passes). Collateral on 3 cases in each pass.
- **Not deterministic:** 23 of 26 cases kept their verdict, 3 flipped (all solved → not solved); rounds
  equal in 12, tool calls in 12, final text in 7. Case by case:
  `.eval-results/4.5-2026-10-03/h1/determinism-p1-p2.md`.
- **No agent baseline file is committed.** The rules above want at least four passes from at least two
  runs; there are two passes. Passes 3–4 are left for later. Until then a change to the agent on the
  B65 is diffed against its own same-day control (`EVAL_CONTROL=1`), as the table above says.
- **Found, not fixed: an order-dependent runaway.** `feature-top-words` (case 6) ran past 7.5 minutes and
  past 9 minutes (both chunks killed; the first at 450 s, the second at 570 s) when it came right after
  `feature-stack-peek` in the same chunk, and finished in 100 s (15 rounds) and 315 s (21 rounds) when
  run alone. The 5070's eight passes ran it in 22–353 s. Cause not found. A chunk that holds that pair
  of cases in that order can lose the rest of the chunk to the harness's limit (cases 7–9 never ran in
  the second kill); run `feature-top-words` alone.

**Speed** (the runners' own timing; not gated). Decode 38–48 tok/s on short prompts and 25 on 14,000-token
ones, against 102–105 on the 5070; TTFT median 0.47 s against 0.21 s; a whole agent pass is 2,589 to
2,940 s of case time against 973 s of the 5070's medians (x2.7–3.0; without `long-discount-rules`,
which ran 1,579 s then 578 s, x1.9 in pass 1 and x2.8 in pass 2),
`eval:tools` 339–402 s a pass against 272–294 s. The latency bench's line is in
[docs/evals/measurement.md](../docs/evals/measurement.md): a full window's prefill 261 s against
26.8 s (9.8×), the next turn past it with the low-water trim 3.0 s against 0.70 s, short prompts
under a second, decode 42 against 95.5 tok/s. The chat gives up on a first byte at 300 s, the agent
at 360 s: the 261 s prefill is inside both, 39 s short of the chat's.

**After `4.5/claims` merges** (H3b): it stamps every scored agent file with a `claimsRule` and makes
`eval:diff` refuse to compare, merge or join files scored by different rules. The tool-choice file here
holds no claims and needs nothing; its test only reads `agent-*` baselines. The two agent passes in
`.eval-results/` (and any pass 3–4) are scored by the old rule: re-score them with
`npm run eval:claims -- <results folders> --rescore <files> --write` before they meet a stamped baseline
(H7 does it).
