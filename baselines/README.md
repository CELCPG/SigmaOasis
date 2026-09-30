# Baselines

The eval results every 4.1 change is judged against (ROADMAP-v4.1.md, Track M). A change that
claims to hold is diffed against the file here for the same suite, model and arm; the diff is the
gate, and its table goes in the commit or PR that makes the claim.

```
npm run eval:diff -- baselines/agent-qwen3.8-9b-distill.json .eval-results/agent-qwen3.8-9b-distill-2026-….json
```

Exit 0: held. Exit 1: a gated line got worse. Exit 2: the files could not be read or compared.

## What is gated

Only the cases both files ran are compared, as rates (a one-pass run against a three-pass
baseline is fine). The **stable set** is the baseline's cases that did not flip between its
passes; its flaky cases are the measured noise floor and are shown, never gated.

| suite | may not drop | may not rise |
| --- | --- | --- |
| `eval:agent` | solved, stable set | false claims · collateral · Undo leaving files |
| `eval:tools` | clean (correct, no spurious call, no loop), stable set | spurious calls on no-tool fixtures · loops · runs with invalid arguments |

Timing (wall time, rounds, TTFT, decode tok/s) is printed and not gated: the machine moves it
(v4.1, decision 1). `--tolerance 0.05` allows a 5-point solved drop; the default is none.

## The format

A baseline is a results file as `eval:agent` or `eval:tools` writes it, trimmed by

```
npm run eval:diff -- --save .eval-results/agent-<model>-<time>.json [--name <name>]
```

which keeps the schema and every scored field, drops what only a reader of one failure needs (the
report text, the check's output, each round's timing — the per-run timing summary stays), and adds
`baseline: { from, savedAt }`. The default name is `<suite>-<model>[-x-<experiments>]`:
`agent-qwen3.8-9b-distill.json`, `agent-qwen3.8-9b-distill-x-resultDigests.json`,
`toolchoice-qwen3.8-9b-distill.json`. The full file stays in the ignored `.eval-results/`.

## Rules

- Record a baseline with `EVAL_PASSES=3` and LM Studio to itself (docs/evals.md, "The agent,
  measured"). One pass measures no noise floor, and the diff says so.
- Replace a baseline only in a commit that says why, with the diff table between the old one and
  the new one. A baseline quietly re-recorded after a regression is how a gate stops gating.
- The reference models are the 9B distill on the 5070 and the 35B-A3B as the second arm
  (ROADMAP-v4.1.md, decision 2).

## The noise floor (measured 2026-09-30)

The same engine, unchanged, run twice on an idle machine, scores single passes anywhere from 14 to
21 of 26 on `qwen3.8-9b-distill` (temperature 0; LM Studio's MTP drafting and prompt-cache reuse
make greedy decoding path-dependent). Two passes are not enough to call a case stable: the 4.1
engine's second run fails the stable-set gate against its first. Until the gate carries a noise
band, run at least four passes for any arm that decides a default, and read the medians beside the
gate's verdict.
