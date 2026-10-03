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
| G10 | Integration: G1–G9 on `rel/4.4` (G8 waits on its track for the dry run), the full `npm test`, 4.4.0 release-ready (version, notes) | Apex, after both | `rel/4.4` |

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
off. Fifteen cases came out differently on the two sides in at least one pass, in both directions; the three the
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
- The second session's first three passes (one control, two re-rank) shared the 9B with an agent
  run that outlived its chunk (*the night's harness*, below); without them neither side has the
  four passes the gate needs.

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
reports that the tests pass with no test run behind them (`needs-you-tax-rate`,
`read-only-why-failing`, `chain-slugify`). The 35B solves more and takes fewer rounds; the 9B's
default engine made no false claim in 312 runs (the baseline's 208, tonight's control's 104, all
26 cases). Per case it is ahead on `office-merge-sheets` (4/4 against the 9B's 0/4 tonight),
`office-total-column`, `tidy-rename-by-date`, `feature-stack-peek` and `refactor-callback-to-promise`,
and behind on `fix-parse-duration`, `tidy-duplicates` and `needs-you-tax-rate` (0/4 each);
`docs/evals/agent.md` has the table.

`long-discount-rules` is not in it: on the 35B it finished inside the 8.5-minute chunk this harness
runs in 2 times in 7 (solved both, 106 s and 245 s); the other five were still running when it
ended (a killed run saves nothing, so how far they got is not known). `read-only-why-failing` ran
past it twice in six (all four that finished solved; one of them, 468 s, spent a round at the
16,384-token cap). The baseline holds four passes of the other 25 cases; a run diffed against it
is compared on those and told so.

## G7–G9 — the build tracks

Each from `rel/4.3` on its own branch, so each can land or wait alone; the build worker's notes are
outside the repository (`so-wt/44-build-notes.md`).

- **G7, the dry run** (`4.4/dryrun`, `736952a`): `.github/workflows/release-dryrun.yml` —
  `workflow_dispatch` only, one macOS job, read-only, release.yml's macOS steps unchanged and in
  order with `electron-builder --mac --publish never`, the DMGs kept as a 7-day artifact and each
  app checked (`codesign --verify --deep --strict` with a Developer ID authority, `spctl`
  *Notarized Developer ID*, `stapler validate`). `test/releaseDryrun.test.ts` (7) holds it to that;
  12 mutations of the workflow each fail it. RELEASING.md, "Dry-running the signed Mac build". An
  actual run needs the file on the default branch — a push to `main`, Colin's.
- **G8, electron-builder 26** (`4.4/builder26`, `13aea08`): 4.3's `0126690` (^26.15.3,
  `mac.notarize: true`) plus G7, and what 26 still needs written down (the team id only from
  `APPLE_TEAM_ID`; release.yml's own keychain stays; the macOS floor stamp stays). Windows build
  proved (`Sigma-Oasis-4.3.0-setup.exe`, `latest.yml` with 24's fields); its full `npm test` 3,610 /
  3,610 and the 14 Electron suites. Advisories 11 → 3 alone, 0 with G9. **Not merged:** it waits on
  a green dry run (decision 5).
- **G9, the build chain** (`4.4/buildchain`, `308f52f`): vite ^5.1.0 → ^7.3.6, electron-vite ^2.0.0
  → ^5.0.0, @vitejs/plugin-react ^4.2.1 → ^5.2.0; `build.externalizeDeps: true` for the deprecated
  `externalizeDepsPlugin()`. Same source, both chains: main +477 B, preload identical, renderer
  −60,207 B (−3.15%, the newer esbuild's printing), CSS and CLI byte-identical; out/main and
  out/preload require the same modules. Full `npm test` green there; advisories 11 → 8.

## G10 — integration, 4.4.0

- **Merged** `4.4/dryrun` (`7063d0a`) and `4.4/buildchain` (`7130e18`), both clean — `rel/4.4` had
  not touched `package.json` or the lockfile, so G9's came over as they were. `npm install` in this
  worktree (4 added, 7 changed), `lockkeep.js`: the lockfile byte-identical to G9's (libc kept on 13
  entries). `npm run typecheck` clean; `electron-vite build` (vite 7.3.6) and the CLI build clean.
  `npm run build -- --publish never` packs `app.asar` with electron-builder 24 — the same 52
  packages as 4.3 — and then fails on this PC extracting winCodeSign-2.6.0 ("Cannot create
  symbolic link: A required privilege is not held by the client"), as on `rel/4.3`; the signed
  builds run on CI.
- **The subset tool-choice baselines re-recorded** (`56fda8b`; F1 made 4.3's stale, and the two
  switches are on): one session, `g10-subset-2026-10-02`, 2026-10-02 03:51 → 04:10, the whole
  toolbox's 28 fixtures, four one-pass runs a side, ABBA. As 4.4 ships (both switches on,
  `…-subset-ontop-filefirst.json`, new): clean **25, 24, 25, 25** of 28, correct-tool 87/100; every
  switch off (`…-subset.json`, replaced; 4.3's was 22, 22, 22, 22): **21, 21, 21, 20**, 72/100.
  Shipped against its control: **BETTER**, +4.00 (±0.71) — `02`, `03`, `09`, `10`, `16`, `22`
  gained, `26-live-score` and `27-live-futures` lost to `market_data` (off by default); no
  spurious call or bad argument, the control's one loop the only one. Old → new control −1.25:
  `15-shop-requirements` (`reference_lookup` beside `shop_requirements` on the description alone,
  `image_search` on `name: description`, and the 9B calls nothing beside the first — every pass,
  as in the night's four whole-toolbox controls) and `01-list-directory`'s one loop.
  `docs/evals/tools.md` has the table. The whole-toolbox baseline stands: no description, fixture,
  system prompt or request changed, so its wire is byte-identical.
- **Version** `9056182` ("4.4.0: version": `package.json`, the lockfile's two root entries,
  `CLIENT_INFO`); **notes** `afc426a`, `RELEASE-NOTES-v4.4.0.md`.
- **`npm test`** on `9056182`: green (the Status, below). The commits after it are notes and this
  file.

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
Clerk was paused 21:16 → 03:12, and for G10's baseline session 03:51 → 04:10, and is back (Ready).
G10's chunks (`g10-*` in `status.txt`) ran one at a time under the same lock, their `node` in the
foreground of the chunk; nothing outlived one.

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
   the cap (`FORCED_TOOLS_ON_TOP`, on): default toolset 21 → 23 of 24 clean a pass, nothing lost;
   with file tools first, as 4.4 ships, the whole toolbox 20.75 → 24.75 of 28 (G10). The
   price is two more tool schemas on a turn the web pair is forced onto (8 instead of 6), and on a
   conversation the web tools stay with (sticky since 4.1) every turn after. Off is one constant.
2. **File tools first** (`FILE_TOOLS_FIRST`, on) is a lexical rule in the chat's selection: a
   named file promotes `read_file`, `write_file`, `propose_patch`. Narrow on purpose (no code
   extensions bare, no web addresses, no folders) — it will miss "open my budget spreadsheet".
3. **The 35B-A3B makes false claims the 9B does not** (3 in 99 runs against none in 312): it reports
   that tests pass without having run them. It solves more (20.70 against 17.88 of 25). Whether it
   is offered as an agent model, and with what warning, is Colin's.
   **Corrected 2026-10-03 (v4.5, H3b):** the detector behind "3 in 99" counted two plans and
   descriptions as claims. Under the corrected rule the 35B's baseline has **1 in 99** (`chain-slugify`,
   no command ran), and the 9B's 312 have **1** (`long-discount-rules`, which the detector's 40-character
   window had hidden; none on the 25 cases the 35B's baseline covers). One against one is not a
   difference between the models at these sizes. `docs/evals/claims.md` has the clauses.
4. Re-rank and the sample answer stay off (SAME-WITHIN-NOISE). Re-rank now works on a `<think>`
   family when turned on — it never did before (F2).
5. **electron-builder 26 waits on the signed Mac build's dry run, which only Colin can start**
   (A-042 kept it out of 4.3 for the same reason). Once `main` carries `release-dryrun.yml` (the
   4.4.0 push below does it; before that, RELEASING.md's cherry-pick): `git push origin
   4.4/builder26`, then Actions → Release dry run → Use workflow from `4.4/builder26` → Run. It
   notarizes for real and publishes nothing; the repository is public, so the branch becomes
   visible. Green: merge it into the next release (its `package.json` and lockfile meet G9's — the
   resolution is in the build notes: builder26's files, the three G9 lines, `npm install`,
   `lockkeep.js`); `npm audit` then reads 0. Red at *Build, sign & notarize*: the log says what 26
   wants.
6. **4.3.0 ships first** (A-049): `rel/4.4` is built on `rel/4.3`, and its notes follow 4.3.0's.
   Optional before the 4.4.0 tag: dry-run `main` itself once it is at `rel/4.4` (Actions → Release
   dry run → Use workflow from `main`) — the vite 7 bundles have been packed by electron-builder 24
   here, but not yet signed and notarized by it on a Mac; the tag's own run would be the first.

## Release 4.4.0

`rel/4.4` is release-ready and pushed nowhere. It is a fast-forward of `rel/4.3` (`8fe8d37`, 4.3.0)
and of `main` (`e1a5272`, 4.2.0). After 4.3.0 is out (ROADMAP-v4.3.md, *Release 4.3.0*: `main` and
`origin/main` at `8fe8d37`, the tag `v4.3.0` pushed), in the main checkout:

```bash
cd C:/Users/clong/Projects/SigmaOasis           # the main checkout, on main, clean
git fetch origin
git merge --ff-only rel/4.4                       # main → rel/4.4's tip
git push origin main                              # first: the release's guard needs the commit on origin/main
git tag -a v4.4.0 -m "Sigma Oasis 4.4.0 — the tools a question asks for, and a control beside every measurement"
git push origin v4.4.0                            # runs .github/workflows/release.yml
```

For Colin to run, or to OK for Apex to run — nothing here has been run. What the tag's run checks,
as for 4.3.0: the guard wants the tagged commit on `origin/main` (pushed first) and `package.json`
at 4.4.0 (the "4.4.0: version" commit, with the lockfile and `CLIENT_INFO`); the macOS job runs
`npm ci` (the lockfile G9 wrote, `libc` fields kept), the typecheck and `npm test` (green here,
below); electron-builder is still 24, as 4.3.0 shipped; the assets are named by
`electron-builder.yml`'s `Sigma-Oasis-${version}-…`. Then publish the draft with
`RELEASE-NOTES-v4.4.0.md` as its body. Pushing `main` also puts `release-dryrun.yml` on the default
branch, which decision 5 needs; it has no push trigger, so the push runs CI only.

## Status (2026-10-02 04:40, 4.4.0 on `rel/4.4`, nothing pushed)

| goal | state | measured |
| --- | --- | --- |
| G1 same-day control | **done** | runners tag `session: { id, role }`; `EVAL_CONTROL=1` (ABBA) in `eval:agent`, `eval:tools`, `eval:answers`; `EVAL_SESSION` for slices; `eval:diff` names its base, `--paired`, `--noise-from`; every 4.4 verdict below is against a same-day control |
| G2 F6, forced tools on top | **done — on** | default toolset clean 21, 21, 21, 21 → **23, 23, 23, 23** of 24, BETTER (±0.00), none lost; whole toolbox 21 → 23 of 28; eviction by score moved 0 of 28 wires |
| G3 `toolsByPhase` | **done — off** | solved 17.00 (18, 19, 18, 13) → 16.75 (17, 17, 15, 18) of 26, **SAME-WITHIN-NOISE** (±3.83); false claims 0/104 both; collateral +1.25 (±1.26) |
| G4 file-request ranking | **done — on** | default toolset 21 → **22** of 24, whole toolbox (chat subset) 21 → **23** of 28, BETTER (±0.00), none lost; with G2: 20.75 → **24.00** of 24 (±0.71) |
| G5 re-rank, sample answer | **done — both off** | re-rank (working): answered 26.50 → 26.75 of 28 (±1.41), cited 17.75 → 15.75 (±2.68); sample answer: 26.25 → 26.75 (±0.71); forbidden 0 in 560 runs; both **SAME-WITHIN-NOISE** |
| G6 35B-A3B baseline | **done** — `baselines/agent-qwen3.8-35b-a3b.json` | 21, 21, 21, 19 of 25 (σ 0.60); false claims **3/99**; median 21 s a solved case (9B 16–17 s), 68 tok/s, 6 rounds; `long-discount-rules` left out (2 of 7 inside the chunk) |
| G7 dry run | **done — merged** (`7063d0a`) | `release-dryrun.yml`, `test/releaseDryrun.test.ts` 7/7; an actual run is Colin's (decision 5) |
| G8 electron-builder 26 | **done — ready, not merged** (`4.4/builder26` @ `13aea08`) | Windows build proved; 3,610/3,610 and the 14 suites there; advisories 11 → 3, 0 with G9; waits on the Mac dry run |
| G9 build chain | **done — merged** (`7130e18`) | vite 7.3.6, electron-vite 5.0.0, plugin-react 5.2.0; typecheck and bundles clean on `rel/4.4`; advisories 11 → **8** (all electron-builder 24's) |
| G10 integration, 4.4.0 | **done** | G7 and G9 merged; subset baselines re-recorded (`56fda8b`: shipped 25, 24, 25, 25 of 28, control 21, 21, 21, 20, BETTER +4.00 ±0.71); version `9056182`; notes `afc426a`; this file |
| `npm test` on `rel/4.4` | **green** on `9056182` (4.4.0, every change in; after it, notes and this file only) | node suite **3,634/3,634** (786 suites; 87a9460's 3,627 + G7's 7); render 25, style 74 and 123, tab traversal 43, modal focus 179, field contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown 62, workbench 53, MCP secrets 19, transport 24 (14 suites) |
| release preconditions | **met** | `rel/4.4` a fast-forward of `rel/4.3` and of `main`; `package.json`, lockfile and `CLIENT_INFO` at 4.4.0; `npm ls` clean (exit 0; `--all` only platform-optional packages unmet); `npm audit` 8 (1 critical, 7 high — `tar`, `app-builder-lib`, `builder-util`, `builder-util-runtime`, `dmg-builder`, `electron-builder`, `electron-builder-squirrel-windows`, `electron-publish`: electron-builder 24's tree; 4.3.0 has 11) |

Every switch and its default in 4.4.0: `FORCED_TOOLS_ON_TOP` **on**, `FILE_TOOLS_FIRST` **on**,
agent `toolsByPhase` **off** (and every other agent experiment off, as 4.3 left them),
`libraryRerank` **off**, `libraryHyde` **off**. The version is 4.4.0.

## What is left

- **Colin:** 4.3.0, then 4.4.0 (*Release 4.4.0*); the dry run of `4.4/builder26` and, on green,
  its merge (decision 5); decisions 1 and 3.
- The same grammar-and-no-thinking pairing in plan mode, the outline and deep research's planner
  (F, *seen*) — measure whether it costs them on a `<think>` family.
- A suite where the library's ranking aids could show a gain: 5 of 28 cases are in their domains.
- `long-discount-rules` on the 35B needs a run longer than this harness's chunk to be measured.
- The night's agent runs were rerun on a kill (both sides alike); a harness with no ten-minute
  ceiling would not need to.
