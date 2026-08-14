# Measuring what a streamed reply costs to render

`scripts/render-bench.sh` measures the main-thread cost of rendering one
streamed reply. This page is why it is built the way it is, and the two traps
that make a naive version of the same measurement produce confident nonsense.

## Running it

```bash
npm run bench:render -- v1.4.7        # measure the current working tree
npm run bench:render -- --report      # tabulate everything recorded so far
```

Each run builds the checked-out tree, launches it against a throwaway profile
pointed at a stand-in LM Studio server, streams one fixed reply, and appends a
row to `.render-bench/results.jsonl`. To compare two versions, run it once per
checkout:

```bash
git checkout v1.4.6 && npm run bench:render -- v1.4.6
git checkout v1.4.7 && npm run bench:render -- v1.4.7
npm run bench:render -- --report
```

Moving `HEAD` is deliberately left to you — a benchmark that checks out
branches on its own is one stray invocation away from discarding uncommitted
work.

Knobs: `BENCH_TOK_PER_SEC` (default 60; try 150 for a fast model),
`BENCH_BLOCKS` (default 8, ≈ 25 KB / 516 lines), `BENCH_PAIRS` (prior
exchanges already in the conversation, default 12).

It opens a real window and takes a few minutes. CI does not run it.

## Why it is built this way

**A stand-in model, not a real one.** A real model writes a different answer
every run, at a rate that varies with thermal state and whatever else is
loaded. An A/B against it compares two different workloads and reports the
difference as a result. The stub streams byte-identical text on an identical
cadence to both sides, paced against a fixed wall-clock schedule so a slow
write cannot stretch the run. Only the model is replaced: SSE parsing, the
reasoning split, markdown, highlighting, sanitizing and React are all the
app's own shipped code.

**A conversation that is already long.** A per-token re-render cascade costs
nothing when there is one bubble on screen. Measuring an empty conversation
measures the best case and shows no difference at all — the first version of
this benchmark did exactly that and reported a clean null result. The profile
is seeded with a dozen prior exchanges.

**A throwaway profile.** The run writes settings and conversations, so it gets
its own `userData` directory and never touches the real one. Tools, memory
recall, claim-check and the grounding correction pass are all disabled in the
seeded settings: they are identical across versions and only add variance.

**An unoccluded window.** macOS throttles an occluded renderer, which turns a
smooth stream into one jump every several seconds. The launcher pins the window
on top.

**Processor time, not "did it keep up".** `Performance.getMetrics`
`TaskDuration` is cumulative main-thread processor time, split by
`ScriptDuration` / `LayoutDuration` / `RecalcStyleDuration`. It answers "how
much work was this", which holds even when both versions keep up — and at a
realistic token rate they may well both keep up while differing by 2×. A
sampled round-trip of a trivial `Runtime.evaluate` stands in for what a
keystroke would have felt.

## Two traps

- **`longtask` reports nothing here.** `PerformanceObserver.supportedEntryTypes`
  lists it and `observe({ entryTypes: ['longtask'] })` is accepted without
  error, so the code looks right — and in the app's `file://` renderer it
  silently never fires. A deliberate 900 ms block registered **zero** long
  tasks while `getMetrics` recorded 0.901 s. Sanity-check any instrument
  against a known block *before* trusting a number it produces.
- **Poll with `textContent`, not `innerText`.** `innerText` forces layout, so
  the probe adds the very cost it is trying to measure, and does so unevenly as
  the DOM grows.

The prompt text also varies per run, or the opt-in response cache can serve a
hit and the whole thing becomes a cache benchmark.

## What v1.4.7 measured

A 516-line, 25 KB code-heavy reply into a twelve-exchange conversation, two
runs per version, main-thread processor time:

| | v1.4.6 | v1.4.7 |
| --- | --- | --- |
| 60 tok/s, 105 s stream | 55.1 s | 26.3 s |
| …JavaScript | 32.1 s | 6.8 s |
| 150 tok/s, 42 s stream | 35.1 s | 10.0 s |
| …JavaScript | 21.1 s | 2.8 s |
| 150 tok/s, input delay p95 | 82 ms | 4 ms |

Both versions keep up at 60 tok/s, which is why this was never reported as a
bug: the old code had just enough slack between tokens to hide in. The
difference shows as input delay only once the model is fast enough to close
that slack — at 150 tok/s v1.4.6 spends 83% of a core on rendering, against
about 24% for v1.4.7 at either rate.

Note that v1.4.6's *total* processor time falls as the stream speeds up
(55.1 s → 35.1 s), because React batches updates that land in the same
event-loop turn, so a faster stream coalesces some of the per-token work. The
cost per second of streaming still rises, which is what the input delay
reflects.
