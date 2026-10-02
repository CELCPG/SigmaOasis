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
  `--noise-from <baseline>` floors the spread at a committed baseline's: a four-pass control can read
  quieter than the engine is (G3's control read 18, 19, 18 — σ 0.58 of 26 — after three passes, against
  the eight-pass baseline's 2.49; its fourth scored 13, σ 2.71 over four).
- The same-day control and the library suite in `baselines/README.md`; tests in
  `test/evalSession.test.ts` and `test/evalDiff.test.ts`.

## G2 — F6, forced tools on top of the cap: **on**, by measurement

The behaviour is a switch, `FORCED_TOOLS_ON_TOP` (`withForcedTools`' `onTop`), and `eval:tools`'
on-top arm is the app's own code through it. Measured on the **default** toolset
(`EVAL_TOOLSET=default`: the 20 tools a fresh install turns on; 24 fixtures, the four whose tool is
off by default unscored), `qwen3.8-9b-distill`, four passes a side interleaved with a same-day
control: clean **21, 21, 21, 21 → 23, 23, 23, 23** of 24, **BETTER** (+2.00, band ±0.00 — both
sides repeated themselves exactly). `09-datetime` and `10-create-note` keep their tool; nothing
lost; no spurious call, loop or bad argument. On the whole toolbox, the same: 21 → 23 of 28, four
gained, `26-live-score` and `27-live-futures` lost to `market_data` (off by default). On by the
rule; 4.0.1's cap stays reachable as `onTop: false`. The cost: 6.7 tools a fixture instead of 6.0,
8 on a forced turn.

`withForcedTools` now evicts the lowest-scored pick, as its comment said. Every run counted the
fixtures where that sent another wire than eviction by wire order: **0 of 28** (the chat forces the
web pair together, and two forced tools take both ranked places whatever their order). The order
can matter only for one forced tool (a sticky web tool, a provider's late force), where it now
keeps the better-scored pick. The agent eval does not apply: the agent has its own tools and never
reads the chat's selection.

## G3 — `toolsByPhase`: **measured, off**

4.1's A5 (edit tools wait for a read; documents, chores and MCP tools wait until the task points at
them), never decided by a measurement. `qwen3.8-9b-distill` on the 5070, four passes a side, the
arm and its same-day control interleaved slice by slice, ABBA (session `g3-2026-10-01`, 2026-10-01
21:16 → 10-02 03:11), each pass as six `EVAL_CASES` slices joined back (`eval:diff --join`):

| | solved a pass (of 26) | false claims | collateral a pass | median time, solved |
| --- | --- | --- | --- | --- |
| same-day control, every switch off | 18, 19, 18, 13 — 17.00, σ 2.71 | 0/104 | 1.75 | 17 s |
| `toolsByPhase` | 17, 17, 15, 18 — 16.75, σ 1.26 | 0/104 | 3.00 | 18 s |

**SAME-WITHIN-NOISE**: solved −0.25 (band ±3.83), collateral +1.25 (±1.26), no false claim; the
same with the spread floored at the eight-pass baseline's (`--noise-from`). Not BETTER, so it stays
off. Fifteen cases moved between the sides in at least one pass, in both directions; the three the
control solved every time and the arm did not (`chain-csv-totals`, `fix-weekend`,
`tidy-sort-downloads`) are where to look if it is tried again. At this spread a 2-case change needs
about 15 passes a side.

Two `long-discount-rules` runs outlasted their chunk and were rerun, one a side (arm pass 1: rerun
solved in 38 s; control pass 3: rerun not solved). The arm's first run was not killed as meant —
see *Harness* below — and finished not solved after 19 minutes, overlapping other runs; it is set
aside (`44-eval/.eval-results/discarded/`). Counted instead of the rerun, the arm's pass 1 would be
16 and its mean 16.50: the verdict is the same.

## G4 — the file-request ranking miss: **fixed**, by measurement

With the app's own ranking (each description alone — see F1), "read the file notes/todo.md and
summarize it" gave the two ranked places to `read_note` (0.622) and `list_directory` (0.609),
`read_file` fourth (0.603); "save this shopping list to a file called groceries.txt" put
`write_file` ninth (0.554). The notes tools' descriptions say "file" in their *Do not use* lines,
and an embedding does not read a "not". The smallest fix is lexical: a turn that names a local file
(a path with an extension, or a document or data file name — not a web address, a folder, or
`node.js`; `namesLocalFile`) puts `read_file`, `write_file` and `propose_patch` (those the slot has)
in the ranked places first. A switch, `FILE_TOOLS_FIRST`.

- Default toolset: **21 → 22** of 24 a pass (`02-read-file`), BETTER (±0.00), nothing lost.
- Whole toolbox, the chat's subset: **21 → 23** of 28 (`02`, `03-write-file`), BETTER (±0.00),
  nothing lost.
- The whole-toolbox arm (every tool on the wire) cannot move: no description changed, so its wire
  is byte-identical; not re-run.
- **Both switches together** (as 4.4 ships), default toolset, their own same-day control: **20.75 →
  24.00** of 24 (+3.25, band ±0.71), BETTER — `02`, `09`, `10`; nothing lost.

On by the rule. The agent's wire does not change (its tools are its own).

## G5 — re-rank and the sample answer: **measurable, measured, off**

- **Measurable.** The library lookup is given the model under test by name — never "the first chat
  model LM Studio lists" — in both the app-initiated lookup and the model's own `reference_lookup`;
  `EVAL_LIBRARY_ASSIST=rerank|hyde` turns the switches on; each case records whether re-rank
  applied or fell back, and whether the sample answer ranked; `eval:diff` reads the library block as
  a third suite (answered per pass gated; cited and unsupported banded; forbidden advice never
  banded, like a false claim); `EVAL_CONTROL=1` and `EVAL_SESSION` as for the other suites.
- **Re-rank had never applied** (F2): under the `json_schema` grammar the 9B distill thought
  through all 80 tokens and answered nothing — 20 of 20 re-ranks in the first session fell back. A
  `<think>` family is now asked plainly with the closed-think prefill; re-applied 20 of 20.
- **Measured**, four passes a side beside same-day controls (`docs/evals/answers.md`):
  - re-rank, working: answered 26.50 → 26.75 of 28 (±1.41), cited 17.75 → 15.75 (±2.68),
    unsupported 3.75 → 2.75 (±1.78), forbidden 0/112 both — **SAME-WITHIN-NOISE, stays off**;
  - the sample answer: answered 26.25 → 26.75 (±0.71), cited 20.50 → 21.00 (±1.53), forbidden
    0/112 both — **SAME-WITHIN-NOISE, stays off**.
- Only 5 of the 28 library cases are in the aids' domains (health, first aid, finance, building).

## G6 — the 35B-A3B's agent baseline: **saved**, `baselines/agent-qwen3.8-35b-a3b.json`

`eval:agent` already spoke to any OpenAI-compatible server on this machine (`LMSTUDIO_BASE_URL`,
loopback only); the one addition is `EVAL_GPU=none`, so a server on the B60 is not watched through
the 5070's PCIe counter (`scripts/gpuHealth.ts`, tested). `qwen3.8-35b-a3b` as the B60's
llama-server serves it (`http://127.0.0.1:8081/v1`, a 32,768-token slot), one request at a time,
its slices run beside the G3 chunks, 2026-10-01 21:16 → 10-02 03:31.

| on the 25 cases all four passes share | 35B-A3B | 9B, tonight's control | 9B, the 8-pass baseline (9/30) |
| --- | --- | --- | --- |
| solved a pass (of 25) | **21, 21, 21, 19 — 20.70** (σ 0.60) | 18, 18, 18, 13 — 16.75 | 17.88 (σ 2.23) |
| false claims | **3/99** | 0/100 | 0/200 |
| collateral a pass | 1.01 | 1.75 | 2.25 |
| runs excluded (the server dropped one) | 1 | 0 | 0 |
| median time a case, solved | 21 s | 17 s | 16 s |
| median rounds · TTFT · decode | 6 · 451 ms · 68 tok/s | 9 · 207 ms · 102 tok/s | 9 · 204 ms · 106 tok/s |

Read by the gate against the 9B (another model, so information, not a verdict on a change): solved
+2.82 a pass against the baseline (±2.73) and +3.95 against tonight's control (±3.54) — more than
the 9B's noise — and **false claims 3 against none**, which the gate never bands. All three are
reports that the tests pass with no test run behind them (`needs-you-tax-rate`, `read-only-why-failing`,
`chain-slugify`). The 35B solves more and takes fewer rounds; the 9B's default engine made no false claim in 312 runs
(the baseline's 208, tonight's control's 104, all 26 cases). Per case it is ahead on `office-merge-sheets` (4/4 against the 9B's 0/4 tonight),
`office-total-column`, `tidy-rename-by-date`, `feature-stack-peek` and `refactor-callback-to-promise`,
and behind on `fix-parse-duration`, `tidy-duplicates` and `needs-you-tax-rate` (0/4 each);
`docs/evals/agent.md` has the table.

`long-discount-rules` is not in it: on the 35B it finished inside the 8.5-minute chunk this harness
runs in 2 times in 7 (solved both, 106 s and 245 s); the other five ran past it, with rounds that
reached the 16,384-token cap at 68 tok/s. `read-only-why-failing` ran past it once in five (one
16,384-token round in a 468 s run). The baseline holds four passes of the other 25 cases; a run
diffed against it is compared on those and told so.

## F — found and fixed on the way

1. **`eval:tools`' subset arm did not rank as the app ranks.** It embedded `name: description`;
   the app (`main/ipc/toolRank.ts`) embeds the description alone, and the two rank the file
   requests differently. The arm ranks on the description now; 4.3's subset baseline is not
   comparable with 4.4's numbers (every 4.4 comparison is against a same-day control anyway).
2. **Re-rank had never applied on a `<think>` family** (G5): a `json_schema` grammar does not stop
   the 9B distill thinking in LM Studio, `enable_thinking: false` is ignored, and the 80-token
   answer was all reasoning. Asked plainly with the closed-think prefill, it answers in 0.2 s.
3. **The library suite flagged correct advice as forbidden** (G5): items under "**Do NOT:**" were
   scored on their own line. A list item inherits its lead-in's negation; 5 flags → 0 on re-scoring.

Seen and not fixed (4.5): the same grammar-and-no-thinking pairing is sent by the chat's plan mode
(`ipc/plan.ts`), the outline (`ipc/outline.ts`) and deep research's planner
(`ipc/deepResearch/plan.ts`). Their budgets are larger than the re-rank's 80 tokens, so on a
`<think>` family they likely think first and answer late rather than not at all — unmeasured.

## The night's harness, and what it got wrong (outside the repository)

The measurements ran as one queue of chunks, each under the shared heavy lock and under ten
minutes (`.eval-results/4.4-night-2026-10-01/`: `q.sh`, `ag.sh`/`ag2.sh`, `tl.sh`, `status.txt`),
a 9B slice and a 35B slice at once in the agent chunks, the build worker's chunks between them.
Clerk was paused 21:16 → 03:12 and is back (Ready).

- **A killed chunk's runs did not always die.** `step.sh` kills at its deadline with `taskkill /T`
  on the command's shell; the agent chunks started their two `node` runs in the background
  (`ag.sh`), and the tree kill did not reach them. Three runs outlived their kill: the 9B's
  `long-discount-rules` (G3 arm, pass 1) finished 10 minutes later beside library chunks `libB1`
  and the first pass of `libB2` (G5's second session: both sides of `libB1` shared the 9B with it);
  the 35B's `read-only-why-failing` (pass 1) finished 5 minutes later, overlapping its own rerun —
  two requests on the B60 for 2 min 18 s; a third (35B, pass 2) was found and killed by hand within
  10 s. The two that saved results are set aside (`44-eval/.eval-results/discarded/`, with a
  README); the reruns count, as 4.3's method reruns a killed case. From 01:00 the chunks ran
  through `ag2.sh`, which kills its own children by Windows pid 30 s before the deadline: no orphan
  after that (checked).
- **A script edited while it ran** (`tl.sh`, bash reads as it goes) failed one tool-choice chunk at
  its end; both of its passes had finished and saved, and count.
- **Killed and rerun:** G3 — `long-discount-rules` once a side (arm pass 1, control pass 3). G6 — the
  35B's `long-discount-rules` five times (left out, above) and `read-only-why-failing` twice (both
  reruns finished).

## Decisions for Colin

1. **F6 is decided by measurement, as recommended — confirm at release.** Forced tools ride on top of
   the cap (`FORCED_TOOLS_ON_TOP`, on): default toolset 21 → 23 of 24 clean a pass, nothing lost. The
   price is two more tool schemas on a turn the web pair is forced onto (8 instead of 6), and on a
   conversation the web tools stay with (sticky since 4.1) every turn after. Off is one constant.
2. **File tools first** (`FILE_TOOLS_FIRST`, on) is a lexical rule in the chat's selection: a
   named file promotes `read_file`, `write_file`, `propose_patch`. Narrow on purpose (no code
   extensions bare, no web addresses, no folders) — it will miss "open my budget spreadsheet".
3. **The 35B-A3B makes false claims the 9B does not** (3 in 99 runs against none in 312): it reports
   that tests pass without having run them. It solves more (20.70 against 17.88 of 25). Whether it
   is offered as an agent model, and with what warning, is Colin's.
4. Re-rank and the sample answer stay off (SAME-WITHIN-NOISE). Re-rank now works on a `<think>`
   family when turned on — it never did before (F2).

## Status (2026-10-02 03:40, `rel/4.4`, nothing pushed)

| goal | state | measured |
| --- | --- | --- |
| G1 same-day control | **done** | runners tag `session: { id, role }`; `EVAL_CONTROL=1` (ABBA) in `eval:agent`, `eval:tools`, `eval:answers`; `EVAL_SESSION` for slices; `eval:diff` names its base, `--paired`, `--noise-from`; every 4.4 verdict below is against a same-day control |
| G2 F6, forced tools on top | **done — on** | default toolset clean 21, 21, 21, 21 → **23, 23, 23, 23** of 24, BETTER (±0.00), none lost; whole toolbox 21 → 23 of 28; eviction by score moved 0 of 28 wires |
| G3 `toolsByPhase` | **done — off** | solved 17.00 (18, 19, 18, 13) → 16.75 (17, 17, 15, 18) of 26, **SAME-WITHIN-NOISE** (±3.83); false claims 0/104 both; collateral +1.25 (±1.26) |
| G4 file-request ranking | **done — on** | default toolset 21 → **22** of 24, whole toolbox (chat subset) 21 → **23** of 28, BETTER (±0.00), none lost; with G2: 20.75 → **24.00** of 24 (±0.71) |
| G5 re-rank, sample answer | **done — both off** | re-rank (working): answered 26.50 → 26.75 of 28 (±1.41), cited 17.75 → 15.75 (±2.68); sample answer: 26.25 → 26.75 (±0.71); forbidden 0 in 560 runs; both **SAME-WITHIN-NOISE** |
| G6 35B-A3B baseline | **done** — `baselines/agent-qwen3.8-35b-a3b.json` | 21, 21, 21, 19 of 25 (σ 0.60); false claims **3/99**; median 21 s a solved case (9B 16–17 s), 68 tok/s, 6 rounds; `long-discount-rules` left out (2 of 7 inside the chunk) |
| G7–G9 | the build worker's | `4.4/dryrun`, `4.4/builder26`, `4.4/buildchain` |
| G10 integration, 4.4.0 | after G7–G9 | — |
| `npm test` on `rel/4.4` | **green** on `87a9460` (every change in) | node suite **3,627/3,627**; render 25, style 74 and 123, tab traversal 43, modal focus 179, field contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown 62, workbench 53, MCP secrets 19, transport 24 (14 suites) |

Every switch and its default after the night: `FORCED_TOOLS_ON_TOP` **on**, `FILE_TOOLS_FIRST`
**on**, agent `toolsByPhase` **off** (and every other agent experiment off, as 4.3 left them),
`libraryRerank` **off**, `libraryHyde` **off**. The version is still 4.3.0 (G10's).

## What is left

- **G10:** merge G7–G9, the version (with `CLIENT_INFO`), the notes, the full `npm test`.
- The same grammar-and-no-thinking pairing in plan mode, the outline and deep research's planner
  (F, *seen*) — measure whether it costs them on a `<think>` family.
- A suite where the library's ranking aids could show a gain: 5 of 28 cases are in their domains.
- `long-discount-rules` on the 35B needs a run longer than this harness's chunk to be measured.
- The night's agent runs were rerun on a kill (both sides alike); a harness with no ten-minute
  ceiling would not need to.
