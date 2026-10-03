# Roadmap: Sigma Oasis 4.5 — the new cards, Gemma 4 as an agent, and what 4.4 saw and left

Written by Apex just after midnight on 2026-10-03, after Colin's "work on the next updates to sigma
oasis", against `rel/4.4` (`b986dca`, 4.4.0, release-ready and pushed nowhere, like 4.3.0 before
it: A-049, A-060). Built on `rel/4.5` (worktree `so-wt/int45`) from tracks `4.5/<name>`
(worktrees `so-wt/45-<name>`). Nothing leaves the PC: no push, no tag, no release.

## Why now: the machine changed under the baselines

On 2026-10-02 the RTX 5070 left the PC. The 9B (`qwen3.8-9b-distill`, LM Studio) now runs on the
Intel Arc Pro B65 over Vulkan, beside nomic and a new model: **Gemma 4 26B-A4B**, served on its own
by llama.cpp at `127.0.0.1:8084` (vision, one request at a time). The 35B-A3B stays on the B60
(`:8081`). Every 4.4 measurement, including the committed 9B baselines, was taken on the 5070. A
4.4 verdict is still sound (each was paired with a same-day control), but a committed baseline is
another day's **and another card's** now, and nobody knows the 9B's noise or speed on the B65.

## The goals

| goal | what | where |
| --- | --- | --- |
| H1 | The 9B re-baselined on the B65: agent (4 passes, the shipping 4.4 engine), tool choice (the app's subset, 4.4's shipping switches, 4 passes), `bench:latency`; set beside the 5070 numbers | `4.5/b65` |
| H2 | The think-first planners 4.4 saw and left (F, *seen*): plan mode (`ipc/plan.ts`), the outline (`ipc/outline.ts`), deep research's planner (`ipc/deepResearch/plan.ts`) send grammar + `thinking: false`, which a `<think>` family ignores. Measure on the 9B; apply 4.4's re-rank fix (the closed-think prefill) where it is no worse on validity and faster | `4.5/planners` |
| H3 | An unrun-claim guard: the 35B-A3B says "tests pass" without running them (3 in 99, G6). The engine already knows every command it ran and its exit code; the eval's false-claim rule (`evalHarness.ts`) moves into a shared module and the engine marks the report when it claims a pass the run does not show. Annotation only (no extra model round: 4.3's `verifyRound` was WORSE). **H3b:** the detector reads tense, mood and subject (6 of the 11 recorded false claims were plans, instructions and descriptions of code), `eval:diff` reads one claim rule on both sides, and 4.4's "3 in 99" is 1 in 99 ([claims.md](docs/evals/claims.md)) | `4.5/claims` |
| H4 | Gemma 4 26B-A4B as an agent model: (a) the catalog reads a llama.cpp server (`capabilities: ["multimodal"]` → vision; `/props` → context length), (b) its agent and tool-choice baselines beside H1's 9B and 4.4's 35B, false claims counted | `4.5/catalog`, `4.5/gemma` |
| H5 | A library suite where re-rank and the sample answer (HyDE) could show a gain — 5 of 28 current cases are in their domain — then both measured again beside a same-day control | `4.5/library` |
| H6 | Dependencies: electron's latest 44.x patch and any runtime patch updates; `npm audit` no worse | `4.5/deps` |
| H7 | Integration: tracks on `rel/4.5`, the full `npm test`, 4.5.0 release-ready (version, notes), this file's status | `rel/4.5` |

The rule, unchanged from 4.4: **a switch turns on by default only if its arm is BETTER beyond the
noise band, beside a same-day control, with zero new false claims.** A fix that does not change
what the model is asked (H2's prefill is a change; H3's annotation is not) still needs H2's
measurement before it ships.

## How it runs

- Units of ≤60 minutes, one deliverable each, on Workboard `apex-runs` (cards "Sigma 4.5 · H…").
  Builders are native subagents; Apex verifies each before the card is done.
- **One machine-wide heavy lock** for GPU evals, full `npm test`, builds and `npm ci`:
  `.eval-results/4.5-2026-10-03/step.sh` (4.4's harness: gaming check, deadline, orphan reaper,
  `clerk-off`/`clerk-on`, exit 75 = busy). Each chunk under ten minutes.
- Track worktrees junction `node_modules` and `resources/pyodide` to `int44`'s. **Never `npm
  install` or `npm ci` in a junctioned worktree** — it writes into `int44`. H6 makes its own copy.
- The B65 carries the 9B and Gemma; H1, H2's measurement, H4b and H5b queue on the lock, never
  two at once.

## Release order

4.3.0, then 4.4.0 (their roadmaps' *Release* sections), then 4.5.0. `rel/4.5` stays a
fast-forward of `rel/4.4`.

## Status

(Filled in by H7.)
