# Sigma Oasis v1.8.0 — the analysis session

v1.6 gave a small model a Python sandbox; this release gives the sandbox a memory. `run_python`
is now a **session scoped to the conversation** — the dataframe loaded in turn one is simply
there in turn five — and, as always, the claim comes with a number: follow-up questions over a
dataset run **24% faster** with fewer tool calls, measured by a new eval suite that ships in this
release. Pinned by 1,324 node checks and 40 real-sandbox checks.

## Persistent Workbench sessions

- **A REPL scoped to the conversation.** Variables and `/work` files persist between `run_python`
  calls within one conversation, like a notebook: *"now filter that to Q4"* works on the
  dataframe already loaded instead of forcing the model to rewrite the whole load-and-clean
  preamble — and each rewrite was a fresh chance for a small model to err (the measured failure
  class from the v1.6 eval).
- **The isolation properties do not move.** The sandbox window, its CSP, the network refusal
  (not even loopback) and the virtual filesystem are exactly as before — a session is one kept
  globals dictionary, nothing more. One session lives at a time (the newest conversation wins,
  bounding memory), and switching conversations resets both globals and `/work`: nothing crosses
  between two conversations, pinned by real-sandbox checks in both directions.
- **Checks stay stateless by construction.** `analyze_file` profiles, the recompute and
  code-check verifiers, and docx extraction all run with fresh globals — a check that could see
  session state would not be checking the reply. A stateless job running mid-session neither
  sees nor disturbs the session.
- **Loss is disclosed, never silent.** A sandbox restart, the ten-minute idle teardown, or
  displacement by another conversation is reported in the next result — *"Session reset …
  re-run your setup"* — instead of surfacing as a bare NameError. Every result also lists the
  variables currently defined, so the model can see its own state.
- REPL semantics on error: an exception leaves earlier definitions standing, like a notebook cell
  that failed.

## Measured: a new multi-turn analysis suite

`EVAL_SUITES=multiturn` runs follow-up questions over one dataset through two arms — sessions on
vs. the old stateless sandbox — with each arm's tool description telling the truth about its
sandbox. Scored mechanically per turn, plus the behavioral columns the feature exists to change.
Against a 9B at temperature 0:

| arm | first turn | follow-ups | follow-up re-reads | s/turn | calls/turn |
| --- | --- | --- | --- | --- | --- |
| session | 5/5 | 10/10 | **6/10** | **30.3** | 1.3 |
| stateless | 5/5 | 9/10 | 10/10 | 40.1 | 1.5 |

Reported the way this project reports things: the one-turn correctness edge is within single-pass
noise and the notes say so. The solid findings are speed (24% faster follow-ups, fewer calls) and
the re-read column — where the model leaned on the session, follow-ups re-read nothing at all.
The honest finding is that a 9B told variables persist still re-reads out of habit more often
than not: sessions *enable* building on state, they do not force it, and that gap is now a
measured number future work can be judged against
([`docs/evals.md`](https://github.com/CELCPG/SigmaOasis/blob/v1.8.0/docs/evals.md)).

## Upgrade notes

- Auto-update from v1.7.x, v1.6.1 or v1.4.7. No settings changed; sessions are simply how
  `run_python` now behaves, and the tool's own description tells the model so.
- Everything in the [v1.7.1 notes](https://github.com/CELCPG/SigmaOasis/blob/v1.8.0/RELEASE-NOTES-v1.7.1.md)
  (bundled curated packs, .docx, prose tool-call recovery) and the
  [v1.7.0 notes](https://github.com/CELCPG/SigmaOasis/blob/v1.8.0/RELEASE-NOTES-v1.7.0.md)
  (tracked personal packs, section-aware retrieval, the energy layer) applies unchanged.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.7.1...v1.8.0
