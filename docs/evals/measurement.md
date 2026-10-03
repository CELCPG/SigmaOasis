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
`npm run eval:diff -- --save <run.json> [more runs…]` to the same schema minus report text and
per-round timing, plus the spread of every gated line over its passes (v4.3).
`npm run eval:diff -- <baseline.json> <run.json> [more runs…]` compares the cases both ran and
answers BETTER, SAME-WITHIN-NOISE or WORSE (exit 1), or TOO-FEW-PASSES (exit 3) below four passes
a side. Each gated line is a per-pass rate read against a noise band of two standard errors of the
difference of the means, from the baseline's stored σ and the run's own (never below the
baseline's): for `eval:agent` solved, collateral and a dirty Undo, with false claims never banded —
any rise is WORSE; for `eval:tools` clean, spurious calls, loops and invalid arguments. The stable
set and the flaky cases are printed, not gated. Timing is printed, never gated. The rules are in
`src/main/agent/evalDiff.ts` and pinned by `test/evalDiff.test.ts`; `baselines/README.md` has the
format, the band and when a baseline may be replaced.

**Why the band (v4.3).** The 4.1 gate gated the stable set: the baseline's cases that did not flip
between its two passes. On 2026-09-30 the same engine scored single passes from 14 to 21 of 26, and
the gate called the 4.1 engine's second run WORSE than its first. With four passes a side and the
band, 4.1 against 4.2 with experiments off (byte-identical requests) is SAME-WITHIN-NOISE: solved
−2.50 per pass against ±3.21.

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
| lowwater-first, lowwater-next (v4.3) | the same chat planned as the chat has planned it since 4.1: trimmed to the low-water mark (65% of the budget), and the next turn floored where that trim cut, so it opens with the last request byte for byte — S1's saving. Through 4.2 the bench timed only the cost |

The assistant turns are canned, not the model's, so every run sends the same bytes.
`BENCH_REPEATS` (default 3) repeats the workload; the line keeps medians. Each run appends one line
to `.latency-bench/results.jsonl`, marked when the GPU's error counter moved during it, and
`npm run bench:latency -- --report` tables them. The pure half (workload, summary, report) is
`src/main/agent/latencyBench.ts`, pinned by `test/latencyBench.test.ts`.

Not measured here: the app's own split of a turn across gather, pin, compaction and verify. Those
happen before and after the request, in the renderer; this bench times the request. Record a line
per release (and a 4.0.1 line for the 4.1 gate) with the app closed and nothing else on the server.

**Draft models (v4.2, S8).** `npm run bench:latency -- <model-id> [label] --draft <draft-id>` runs
the same workload twice in every repeat — without `draft_model`, then with it — after warming both,
and appends two lines, `label` and `label+draft`. The report names the draft beside the model and
the share of drafted tokens the model kept, when the server reports it (LM Studio's
`accepted_draft_tokens_count` / `total_draft_tokens_count`, or OpenAI's
`accepted_prediction_tokens`); a server that reports none gets a line saying it may have ignored
the field. The comparison that matters is decode tok/s and TTFT between the two lines. A role's
*Draft model* (Settings → Roles) stays none by default until a line here shows a gain; the 9B
distill already drafts through MTP in LM Studio's own config and is not expected to gain.

**The first lines (2026-09-30 night).** `qwen3.8-9b-distill` on the RTX 5070, `BENCH_WINDOW=68608`
(the loaded context), three repeats, medians; `4.2.0` from main's code, `4.3-dev` from rel/4.3 with
the two low-water scenarios added. No 4.0.1 line exists, so the 4.1 gate's "down against 4.0.1"
was never measured; the low-water pair is the before-and-after S1 claims, on one machine and one
night:

| label | cold | warm | turn-1 | turn-10 | window-first | window-next | lowwater-first | lowwater-next | decode tok/s | prompt at window |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4.2.0 | 1.1 s | 73 ms | 223 ms | 264 ms | 27.0 s | 27.6 s | — | — | 99.5 | 65,515 tok |
| 4.3-dev | 1.0 s | 73 ms | 234 ms | 261 ms | 26.8 s | 27.5 s | 17.0 s | 703 ms | 95.5 | 65,514 tok |

- **S1, measured:** past a full window, the next turn costs 27.5 s when the oldest turn is dropped
  and the window re-read, and 0.70 s when the history was trimmed to the low-water mark the turn
  before — 42,900 prompt tokens of which about 330 are new. The trim itself costs one 17.0 s
  prefill of 65% of the window; every turn after it, until the history grows back to the brim,
  costs the 0.7 s. Each repeat agreed within 2.5 s (first) and 30 ms (next).
- A prompt cache that holds: warm 73 ms against cold 1.0–1.1 s; turn 10 (3,118 prompt tokens)
  costs 30–40 ms more than turn 1.
- The OpenClaw Clerk task, a client of the same model, was paused. The installed Sigma Oasis app
  also shares the model (two slots); whether it was open during the runs was not checked — at
  00:55 it was not running. LM Studio's MTP drafting kept 41–90% of drafted tokens.

**The B65's line (2026-10-03, v4.5 H1).** The same 9B (`qwen3.8-9b-distill`, Q4_K_M, 68,608-token
context) on the Intel Arc Pro B65, LM Studio over Vulkan, the RTX 5070 out of the machine. Label
`4.5-b65`, from `4.5/b65` (the 4.4.0 engine; the bench's workload is unchanged since 4.3),
`BENCH_WINDOW=68608`, three repeats, medians, the OpenClaw Clerk off, 2,107 s start to finish. The
results file is not committed (`.latency-bench/` is ignored); this section is the record, and the
5070's two lines above are the only other record there is. The line carries no `machine` mark. Whether
the Sigma Oasis app was closed was not checked.

| label | cold | warm | turn-1 | turn-10 | window-first | window-next | lowwater-first | lowwater-next | decode tok/s | prompt at window |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4.3-dev, RTX 5070 | 1.0 s | 73 ms | 234 ms | 261 ms | 26.8 s | 27.5 s | 17.0 s | 703 ms | 95.5 | 65,514 tok |
| 4.5-b65, Arc Pro B65 | 1.7 s | 118 ms | 591 ms | 800 ms | 261.3 s | 262.1 s | 120.2 s | 3.03 s | 42.1 | 65,516 tok |
| B65 ÷ 5070 | 1.7× | 1.6× | 2.5× | 3.1× | 9.8× | 9.5× | 7.1× | 4.3× | 0.44× | — |

The B65 per scenario (median of three; the range is the fastest and slowest repeat; "kept" is the
share of drafted tokens LM Studio's MTP drafting kept — the 5070's lines keep no per-scenario figures):

| scenario | TTFT | range | prompt tok | decode tok/s | kept |
| --- | --- | --- | --- | --- | --- |
| cold | 1.72 s | 0.52 – 2.13 s | 280 | 48.9 | 84% |
| warm | 118 ms | 113 – 130 ms | 280 | 49.3 | 84% |
| turn-1 | 591 ms | 573 – 599 ms | 280 | 48.2 | 81% |
| turn-2 | 562 ms | 557 – 579 ms | 581 | 45.2 | 74% |
| turn-3 | 655 ms | 655 – 670 ms | 900 | 46.4 | 77% |
| turn-4 | 676 ms | 669 – 682 ms | 1,223 | 45.0 | 79% |
| turn-5 | 627 ms | 615 – 640 ms | 1,537 | 42.0 | 76% |
| turn-6 | 720 ms | 719 – 767 ms | 1,867 | 41.7 | 76% |
| turn-7 | 659 ms | 650 – 673 ms | 2,174 | 42.7 | 78% |
| turn-8 | 666 ms | 665 – 686 ms | 2,484 | 42.2 | 77% |
| turn-9 | 686 ms | 684 – 710 ms | 2,796 | 40.4 | 75% |
| turn-10 | 800 ms | 777 – 835 ms | 3,118 | 40.7 | 80% |
| window-first | 261.3 s | 261.3 – 261.5 s | 65,525 | 8.4 | 68% |
| window-next | 262.1 s | 261.4 – 262.6 s | 65,516 | 7.3 | 50% |
| lowwater-first | 120.2 s | 118.1 – 121.4 s | 42,566 | 11.6 | 68% |
| lowwater-next | 3.03 s | 3.01 – 3.08 s | 42,898 | 11.6 | 68% |

- **S1 holds on the B65, and matters more.** Past a full window the next turn costs 262.1 s when the
  oldest turn is dropped and the window re-read, and 3.03 s with the low-water trim: 259 s saved a
  turn (the 5070: 27.5 s against 0.70 s). The trim's own prefill of 42,566 tokens is 120.2 s, once,
  and every turn after it until the history grows back to the brim costs the 3 s. The three repeats
  of window-first agree to 0.2 s, those of lowwater-next to 70 ms.
- **Prefill is the card's weak side.** 3,118 tokens (turn 10) prefill at about 3,900 tok/s, the
  42,566-token trim at 354 tok/s and the 65,525-token window at 251 tok/s: the rate falls with depth
  (the 5070 read the window at about 2,440 tok/s). Decode falls with depth too: 48–49 tok/s on a
  280-token prompt, 40.7 at 3,118, 11.6 at 42,566, 7.3–8.4 at the full window. The report's
  decode column (42.1) is the median across all sixteen scenarios, as the 5070's 95.5 is.
- **Short prompts stay under a second.** Warm 118 ms, turn 1 591 ms, turn 10 800 ms (3,118 tokens
  cost 200 ms more than 280); cold ranges 0.52–2.13 s across the repeats, the widest spread of any
  short scenario, so its median (the middle repeat) says little. The prompt cache holds: warm is
  118 ms against cold's 1.72 s.
- MTP drafting kept 50–84% of drafted tokens (the 5070: 41–90%): fewest at the full window.
- **The timeouts the 261 s prefill meets.** The chat waits 300 s for a first byte
  (`FIRST_BYTE_TIMEOUT_MS`, `chatTransport.ts`); the agent waits `AGENT_STREAM_STALL_MS` × 4 = 360 s
  (90 s × 4, `stream.ts`). A full window's prefill, 261 s, is inside both, with 39 s to spare on
  the chat's and 99 s on the agent's: close on the chat's. Between chunks the chat tolerates 60 s of
  silence (`STREAM_STALL_MS`) and the agent 90 s; decode at 7–8 tok/s is nowhere near either.
  A prefill 15% slower (a card that is also serving another request) would cross the chat's limit.
  Past the window the low-water trim is what keeps the chat clear of it: its next turn is 3 s.
- **Attempt 1 died at the bench's own limit.** The bench cut a request after 180 s of silence
  (hardcoded), and the window prefill is 261 s, so the first run was cut at its first window scenario
  (cold, warm and turns 1–10 of repeat 1 had printed). `BENCH_STALL_MS` (default 180000, unchanged
  for any card that was already inside it) now sets the limit; this line ran with `BENCH_STALL_MS=900000`.
  The script has no test of its own (its options are read inside `main()`; the tests cover the
  workload and the report in `latencyBench.ts`), so the variable is not pinned by one.
