# Roadmap: Sigma Oasis 4.4 — a control beside every arm, and the decisions 4.3 left open

Written by Apex the night of 2026-10-01, after Colin's "set 10 goals for sigma oasis and complete
them" (~21:00 ET), against `rel/4.3` at 4.3.0 (`8fe8d37`, release-ready, not pushed — A-049). Built
that night on `rel/4.4` by two workers on one PC, every heavy step through one machine-wide lock:
the measurement worker (G1–G6) and the build worker (G7–G9). G10 follows both. Nothing left the PC:
no push, no tag, no release. The status is at the end.

## The ten goals

| goal | what | owner | where |
| --- | --- | --- | --- |
| G1 | A same-day control for agent arms: the engine with every switch off, re-run in the arm's own session, interleaved; `eval:diff` says which base it read | measure | `rel/4.4` |
| G2 | F6 decided by measurement: forced tools on top of the cap, on the **default** toolset, beside a same-day control; `withForcedTools` evicts by rank, as its comment says, if no measured wire moves | measure | `rel/4.4` |
| G3 | `toolsByPhase` (4.1, A5) decided by measurement — four passes and a same-day control | measure | `rel/4.4` |
| G4 | The file-request ranking miss (`read_note`, `memory_save` over `read_file`, `write_file`): the smallest fix, as an arm | measure | `rel/4.4` |
| G5 | Re-rank (and the sample-answer expansion) made measurable — the answering model passed by name, the gate taught the library suite — then measured | measure | `rel/4.4` |
| G6 | The 35B-A3B's agent baseline, owed since 4.1, on the B60 | measure | `rel/4.4` |
| G7 | A dry run for the signed Mac build (`release-dryrun.yml`, `workflow_dispatch`) | build | `4.4/dryrun` |
| G8 | electron-builder 26 (4.3's D8, proved on Windows in `4.3/builder26`) | build | `4.4/builder26` |
| G9 | The build chain (vite 7, electron-vite 5, plugin-react 5) | build | `4.4/buildchain` |
| G10 | Integration: G1–G9 on `rel/4.4`, the full `npm test`, 4.4.0 release-ready (version, notes) | Apex, after both | `rel/4.4` |

The rule every switch below is held to (set by Apex with the goals): **a switch turns on by default
only if its arm is BETTER beyond the noise band, beside a same-day control (G1), with zero new
false claims.** Everything else stays off.

## G1 — the same-day control

Every 4.3 verdict was an arm measured on 2026-10-01 against a baseline measured on 9/30, and the
same engine scores single passes from 14 to 21 of 26 on the 9B. 4.3 kept every switch off, so none
turned on that way, but a BETTER would have needed a control beside it.

- **Runners tag what they measured.** `eval:agent`, `eval:tools` and `eval:answers` (library) write
  `session: { id, role }` — `control` for the engine with every switch off, `arm` otherwise
  (`src/main/agent/evalSession.ts`).
- **One command runs both.** `EVAL_CONTROL=1` beside an arm (`EVAL_EXPERIMENTS`,
  `EVAL_ROUND_MAX_TOKENS`; `EVAL_FORCED_ON_TOP`, `EVAL_FILE_TOOLS_FIRST`; `EVAL_LIBRARY_ASSIST`)
  runs the control too, a pass of each in turn, ABBA — control first on odd passes, the arm first on
  even ones — and writes two files. A pass longer than one command runs as `EVAL_CASES` slices
  tagged `EVAL_SESSION=<id>`, the control's and the arm's alternating, joined into passes.
- **`eval:diff` says which base it read** — the second line of every diff: *the same-day control*,
  *a committed baseline, saved <date> — another day's*, *a control from another session*, or *a
  results file with no session*. A BETTER against anything but the same-day control carries a note
  that it cannot turn a switch on. `--paired <files>` sorts one session's files into control and arm
  by their tags. Merges and joins keep the session and refuse to mix a control with its arm.
- The same-day control and the library suite in `baselines/README.md`; tests in
  `test/evalSession.test.ts` and `test/evalDiff.test.ts`.
