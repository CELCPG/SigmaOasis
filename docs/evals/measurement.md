# Measurement: Track M

Part of the [evals index](../evals.md).

## Track M: what every run now records (v4.1)

ROADMAP-v4.1.md puts measurement first: nothing turns on by default until a run shows it holds.
This section is the instrument's side of that — what the runners record and how two runs are
compared. The numbers themselves go in the sections above as they are measured.

### Per-round latency in `eval:agent` (M3)

A1 and A3 claim prefill wins and nothing recorded prefill. Every request a case sends is now timed
at the transport (`src/main/agent/latency.ts`, a passive second reader of the same SSE frames the
engine reads, so the engine is measured as it ships):

- **TTFT** — request to the first content, reasoning or tool-call byte;
- **prefill** — the server's own figure when it sends one (llama.cpp's `timings.prompt_ms`);
  LM Studio's OpenAI endpoint sends none, so TTFT stands in and the report says so;
- **prompt tokens**, and **cached tokens** when the server reports
  `usage.prompt_tokens_details.cached_tokens` (absent, never zero, when it does not);
- **decode tok/s** — completion tokens after the first, over first token to last.

Each run keeps its rounds (`latency`) and their median and max (`latencySummary`); the table gains
*TTFT median · max* and *decode tok/s*, and a line per model gives prefill, the largest prompt and
the cached share. Helper rounds are timed too — they are requests the task waited on. A run the
GPU's error counter moved in keeps its score and loses its time, here as for wall time.

### Baselines, committed and diffed (M2)

`baselines/` holds the results files a change is judged against, trimmed by
`npm run eval:diff -- --save <run.json>` to the same schema minus report text and per-round timing.
`npm run eval:diff -- <baseline.json> <run.json>` compares the cases both ran, as rates, and exits 1
when a gated line got worse: for `eval:agent` the stable set's solved rate (the baseline's cases
that did not flip between passes — its flaky cases are the noise floor, shown and not gated), false
claims, collateral and a dirty Undo; for `eval:tools` the stable set's clean rate, spurious calls,
loops and invalid arguments. Timing is printed, never gated. The rules are in
`src/main/agent/evalDiff.ts` and pinned by `test/evalDiff.test.ts`; `baselines/README.md` has the
format and when a baseline may be replaced.

### The offline gate: a scripted model, replayed, and the wire hashed (M6)

`test/replayGate.test.ts` runs in `npm test` on every CI leg, and alone as `npm run test:replay`
(the same typecheck and compile, then only the replay, diff and latency tests). No model, no
network:

- **`eval:agent`, replayed.** A scripted model drives the shipping engine through three cases —
  one per scoring path: hidden checks (`fix-paginate`), needs-you, read-only — two passes, scored
  by `runCase`, written by the runner's own `agentResultsFile`, then diffed by `eval:diff` against
  `test/fixtures/replay/agent-scripted.json`. A second replay with a wrong fix reported as passing
  must fail that diff: the gate is shown to bite, not assumed to.
- **`eval:tools`, replayed.** Every fixture in `test/fixtures/toolchoice/` through
  `runToolChoiceEval` with a model that calls the expected tool with the smallest arguments its
  schema accepts; every fixture must load (the in-app loader drops one naming an unknown tool
  silently — here it fails), score clean, and match `toolchoice-scripted.json`. A model that
  answers a search question from memory must fail the diff.
- **The wire, hashed.** The tools the engine puts on its first request (*Accept edits* and
  *Read-only*, experiments off, the shell's name fixed — the one platform-dependent word) and the
  chat's definitions with their budget notes, as a turn sends them, are hashed per tool and per
  set against `test/fixtures/wire/tool-schemas.json`. A change fails with what was added, removed,
  changed or reordered — every cached prefix after the tool list moves with it.

Both snapshots change only on purpose: `UPDATE_REPLAY_SNAPSHOTS=1 npm run test:replay`, and the
re-recorded files are committed with the change that moved them.

### The live world (M5)

4.0.1's measured session asked for today's weather, this morning's futures and the next game, and
got a list of websites each time; 4.0.2 kept the ledger off such turns. Three pieces now measure
that path, one of them with no model at all:

- **Tool choice.** Four fixtures ask the live world — `25-live-weather`, `26-live-score`,
  `27-live-futures`, `28-live-latest-version` — each expecting `web_search`, each tagged `"live"`.
  The suite is 28 fixtures from here on: compare clean counts with earlier rows by fixture, not by
  total.
- **Offline, in `npm test`** (`test/liveWorld.test.ts`). For every live question in either suite,
  with a ranking that puts both web tools last, `web_search` and `fetch_webpage` are on the wire
  after `webToolsForTurn`, within the cap; the ledger provider is off and the app-run search on.
  **Known gap, pinned:** "the latest version of node.js" is not in `LIVE_DOMAINS`, so the web tools
  ride it (via `FACT_DOMAINS`) and so may the ledger, whose `date`/`measurement` classes keep for
  730 days. Track G1 owns the repair; the test that pins it flips when it lands.
- **`EVAL_SUITES=live npm run eval:answers -- <model>`** (`scripts/evalSuites/live.ts`, scored in
  `src/renderer/src/lib/liveEval.ts`). Six questions about fictional places and markets — weather
  today and tomorrow, last night's score, the next game, two futures quotes — each answered only by
  a loopback page: a small table, one row per day, dated from the clock when the run starts, a
  distinct figure per row. The turn is the chat's minus the window: no ranking (the worst case, so
  only the forced tools put the web on the wire), budget notes, the ledger provider ahead of the
  app-run search, and a planted ledger entry carrying the wrong day's figure. Scored per case: web
  tools on the wire, the search ran, a page was read, the day asked's figure in the reply and no
  other day's in its place, any date the reply names the right one, no ledger answer — and *pass*
  when every line holds. The 4.1 gate: pass on ≥ 90%, zero ledger answers. Not yet run.

### The latency bench (M7)

`npm run bench:latency -- <model-id> [label]` sends a fixed workload to a loaded model, one request
at a time, streamed, temperature 0, 64-token replies, and times each request as `eval:agent` does
(TTFT, prefill, prompt and cached tokens, decode tok/s):

| scenario | what it is |
| --- | --- |
| cold | a prompt whose first bytes the server has not seen (each run's system prompt opens on a nonce) |
| warm | the same request again, its prefix cached |
| turn-1 … turn-10 | one chat growing a turn at a time, each request extending the last; the report shows 1 and 10 |
| window-first, window-next | a chat past `BENCH_WINDOW` (default 16,384 — set it to the loaded context), trimmed by the app's own `planHistory`, then its next turn: the oldest turns drop, the prefix changes just after the system prompt, and the window is prefilled again — Track S1's cost |

The assistant turns are canned, not the model's, so every run sends the same bytes.
`BENCH_REPEATS` (default 3) repeats the workload; the line keeps medians. Each run appends one line
to `.latency-bench/results.jsonl`, marked when the GPU's error counter moved during it, and
`npm run bench:latency -- --report` tables them. The pure half (workload, summary, report) is
`src/main/agent/latencyBench.ts`, pinned by `test/latencyBench.test.ts`.

Not measured here: the app's own split of a turn across gather, pin, compaction and verify. Those
happen before and after the request, in the renderer; this bench times the request. Record a line
per release (and a 4.0.1 line for the 4.1 gate) with the app closed and nothing else on the server.
