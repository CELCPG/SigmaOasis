# Measuring what a streamed reply costs to render

How the v1.4.7 rendering figures were produced, and the two traps that make a
naive version of this measurement produce confident nonsense. Written down
because the v1.4.8 storage work in `STRATEGY-speed-and-quality.md` will want to
re-run it.

## The method

1. **Stand in for the model.** A small HTTP server on a spare port answers
   `GET /v1/models`, `GET /api/v0/models` and `POST /v1/chat/completions`,
   streaming one *fixed* reply as SSE frames — one frame per notional token,
   paced to a chosen tokens/sec with a self-correcting sleep so a slow write
   cannot stretch the run. Point `baseUrl` at it.

   This is the load-bearing part. A real model writes a different answer every
   time, at a rate that varies with thermal state and what else is loaded, so
   an A/B against a real model compares two different workloads and reports the
   difference as a result. Everything downstream of the socket — SSE parsing,
   the reasoning split, markdown, highlighting, sanitizing, React — is the
   app's own code, so only the model is replaced.

2. **Use a realistic conversation.** Seed `conversations/<id>.json` in the
   profile with a dozen prior exchanges before launching. A one-message
   conversation is the *best* case for a per-token re-render cascade — "re-render
   every bubble" is free when there is one bubble — and will show no difference
   at all.

3. **Isolate the profile.** Launch through a wrapper that calls
   `app.setPath('userData', …)` on a throwaway directory, seeded with a
   `config.json` that disables tools, memory recall, claim-check and the
   grounding correction pass. Those are identical across versions and only add
   noise. Never measure against the real profile.

4. **Keep the window unoccluded.** macOS throttles an occluded renderer;
   `win.setAlwaysOnTop(true)` from the wrapper keeps the numbers honest.

5. **Drive it over CDP** with `--remote-debugging-port`, and read
   `Performance.getMetrics` before and after the turn. `TaskDuration` is
   cumulative main-thread processor time and is the primary number;
   `ScriptDuration`, `LayoutDuration` and `RecalcStyleDuration` split it up.
   Sample a trivial `Runtime.evaluate` round-trip during the stream as a proxy
   for what a keystroke would have felt.

Run each version at least twice and report the spread, not one number.

## Two traps

- **`longtask` reports nothing here.** `PerformanceObserver` accepts
  `entryTypes: ['longtask']` and `PerformanceObserver.supportedEntryTypes`
  lists it, so the code looks right — and in the app's `file://` renderer it
  silently never fires. A deliberate 900 ms block registered **zero** long
  tasks while `Performance.getMetrics` recorded 0.901 s. Sanity-check any
  instrument against a known block *before* trusting a number it produces; the
  first version of this measurement reported a clean null result from a dead
  observer.
- **Poll with `textContent`, not `innerText`.** `innerText` forces layout, so
  the probe adds the very cost it is trying to measure, and it does so unevenly
  as the DOM grows.

Also: vary the prompt text per run, or the opt-in response cache can serve a
hit and the measurement becomes a cache benchmark.

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
bug. The difference is visible as input delay only once the model is fast
enough to close the slack — at 150 tok/s v1.4.6 spends 83% of a core on
rendering, against about 24% for v1.4.7 at either rate.
