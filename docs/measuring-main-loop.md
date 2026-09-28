# Measuring how long the main process stops answering

Since 3.0 an agent task runs in the main process — its stream, its stall timer, its approvals —
so a main-thread stall is no longer only a late IPC reply: it is a live stream that stops
arriving. `scripts/main-loop-bench.sh` measures that stall against the app's own heaviest
synchronous work, at the caps the app enforces. It is the M4 measurement of `ROADMAP-v3.1.md`.

## Running it

```bash
npm run bench:main-loop -- "main 0edef37"     # label the run; results append to .main-loop-bench/results.jsonl
```

It bundles `scripts/main-loop-bench/bench.ts` with the app modules it drives and runs it in the
project's own Electron — the real main process, with real `BrowserWindow`s for the render phase.
No model and no network: a stand-in server (`stream-server.mjs`) streams a token every 25 ms
and serves the pages. It takes well under a minute and needs nothing from you. CI does not
run it.

## What it records

Four phases, each with the stream running throughout:

| phase | what the app does | the cap it is held to |
| --- | --- | --- |
| baseline | nothing but the stream | — |
| pdf | `readTextDocument` on a PDF, three times — the path an attachment and a folder pack take | 400 FlateDecode streams, 40 MB inflated (`MAX_DECOMPRESSED_BYTES`) |
| folder | `createPackFromFolder`, then the first `lookupLibrary`, which builds the BM25 index | 400 documents, 8,000,000 characters (`MAX_PACK_CHARS`) |
| render | `renderPage` on five pages, a session and a window each | — |

For each: the event loop's delay from `perf_hooks.monitorEventLoopDelay` (10 ms resolution;
p50, p99, max), the stream's p99 and longest gap between chunks, and the phase's wall time. The
inputs come from a fixed seed, so two runs measure one workload.

## The traps

- **The server has to be somewhere else.** A stand-in in the measured process shares its event
  loop: a stall delays the server's own timer, and the gap it causes is hidden inside the gap it
  measures. Here it is a separate process with its own clock.
- **The worker has to be beside the bundle.** `pdfOffThread.ts` extracts in-thread when there is
  no `pdfWorker.js` beside it — which is right for the CLI and would make a benchmark quietly
  measure the old way. The script builds the worker next to the bench, and every run prints and
  records which way it extracted.
- **`render.ts` loads only HTTPS.** The pages are served with a throwaway self-signed
  certificate that the bench process — never the app — trusts for exactly that origin. Without
  `openssl` the render phase is skipped and says so. On Git Bash, `openssl -subj "/CN=…"` needs
  `MSYS_NO_PATHCONV=1` or no certificate is written.
- **Windows' timer is the floor.** A p50 of 15.6 ms with nothing happening is the system timer's
  resolution, not a stall; compare phases with each other, not with zero.

## Measured (v3.1)

The bench machine, Electron 44, Windows, 2026-09-28:

| phase | loop p99 before | after | longest stream gap before | after |
| --- | --- | --- | --- | --- |
| baseline | 16.5 ms | 16.4–16.6 ms | 32 ms | 32–33 ms |
| pdf | **320 ms** | **19–20 ms** | **355 ms** | **32–33 ms** |
| folder | 23 ms | 18–20 ms | 102 ms | 95–107 ms |
| render | 22 ms | 21–23 ms | 37 ms | 35 ms |

"Before" is `main` at `0edef37`; "after" is the PDF worker, two runs. The pdf phase's wall time
grew from 1.9 s to 2.1 s for its three extractions — the worker's start and the copy of the
bytes — and a stream running beside it no longer notices.
