# Sigma Oasis v4.4.0 — the tools a question asks for, and a control beside every measurement

4.3 gave the gate a noise band and kept every switch off. 4.4 gives every measurement a control run
the same night beside it, and with it decides what 4.3 left open: forced tools now ride on top of
the chat's tool cap instead of pushing out the tools the question ranked, and a turn that names a
file reaches the file tools. Both were measured BETTER beside a same-day control; everything else
measured — the agent's tool phases, the library's re-rank and sample answer — stays off. Under it:
the 35B-A3B's agent baseline, owed since 4.1, the build chain on vite 7, and a way to dry-run the
signed Mac build without cutting a release. 4.4.0 follows 4.3.0 and is built on it. The plan and its
status are `ROADMAP-v4.4.md`.

## What you will notice

- **Forced tools no longer push out the ranked picks.** The chat puts at most six tools on a turn,
  four of them always on, and through 4.3 a turn the web pair was forced onto (a live question, or
  one the web classifier sends to the web) lost both ranked places to it: "what time is it right
  now?" reached the model without the clock, which then called the date calculator, and "save a
  note titled 'gift ideas'…" without `create_note`, so it reached for `memory_save`. Forced tools now
  ride on top of the cap, and both questions get their tool. The price is two more tool schemas on
  such a turn — eight instead of six — and on a conversation the web tools stay with (sticky since
  4.1), every turn after. When a single tool is forced, it now displaces the lowest-ranked pick,
  as the code's comment always said, not the last one in the list.
- **File requests reach the file tools.** "Read the file notes/todo.md and summarize it" ranked
  `read_note` and `list_directory` into the two ranked places and `read_file` fourth; "save this
  shopping list to a file called groceries.txt" put `write_file` ninth. The notes tools'
  descriptions say "file" in their *Do not use* lines, and an embedding does not read a "not". A
  turn that names a local file — a path with an extension, or a document or data file name — now
  puts `read_file`, `write_file` and `propose_patch` (those the slot has) in the ranked places
  first. Narrow on purpose: a web address, a folder or `node.js` is not a file, and "open my
  budget spreadsheet" names none, so it is left to the ranking.
- **Library re-rank works on Qwen 3** — and the other models that think in `<think>` tags (DeepSeek
  R1 distills, Magistral) — when you turn it on (Settings → Grounding → *Re-rank library
  passages*). Asked under a JSON grammar, the 9B distill spent all 80 of its tokens thinking and
  answered nothing: in the library suite's first four passes it fell back to the usual order in 20
  re-ranks of 20, so re-rank had never once applied for it. A `<think>` model is now asked plainly
  with the think block closed, and the 9B answers in 0.2 s — 20 of 20 applied. It stays off by
  default: working, it did not beat the library without it (below).

## Measured — every verdict beside a same-day control

A committed baseline is another day's: on 9/30 two runs of unchanged code differed by four cases
in their means. So the eval runners now run a **control** — the engine with every switch off — in
the arm's own session, interleaved pass by pass (`EVAL_CONTROL=1`, ABBA), and tag every results
file with its session; `eval:diff` says which base it read on the second line of every diff, and a
BETTER against anything but the same-day control says it cannot turn a switch on. **A switch turns
on by default only if its arm is BETTER beyond the noise band beside a same-day control, with no
new false claim.** `qwen3.8-9b-distill` on the RTX 5070, temperature 0, four passes a side,
2026-10-01 night and 2026-10-02:

| switch | arm against its same-day control | verdict |
| --- | --- | --- |
| forced tools on top of the cap (`FORCED_TOOLS_ON_TOP`) | the 20 tools a fresh install turns on: clean 21, 21, 21, 21 → **23, 23, 23, 23** of 24 (±0.00) — `09-datetime`, `10-create-note` gained, nothing lost · the whole toolbox: 21 → 23 of 28 | **BETTER — on** |
| file tools first (`FILE_TOOLS_FIRST`) | default tools: 21 → **22** of 24 (±0.00) — `02-read-file` · the whole toolbox: 21 → 23 of 28 — `02`, `03-write-file`; nothing lost | **BETTER — on** |
| both, as 4.4 ships | default tools: 20.75 → **24.00** of 24 (±0.71) · the whole toolbox (10/2): 20.75 → **24.75** of 28 (±0.71) — six gained, `26-live-score` and `27-live-futures` lost to `market_data`, which is off by default | **BETTER** |
| the agent's tool phases (`toolsByPhase`, 4.1) | solved 18, 19, 18, 13 → 17, 17, 15, 18 of 26 (17.00 → 16.75, ±3.83); false claims 0 in 104 runs a side; collateral 1.75 → 3.00 a pass (±1.26) | SAME-WITHIN-NOISE — off |
| library re-rank, working at last | answered 26.50 → 26.75 of 28 (±1.41); cited the source 17.75 → 15.75 (±2.68); unsupported figures 3.75 → 2.75 (±1.78); forbidden advice 0 in 112 runs a side | SAME-WITHIN-NOISE — off |
| the library's sample answer | answered 26.25 → 26.75 of 28 (±0.71); cited 20.50 → 21.00 (±1.53); forbidden advice 0 in 112 runs a side | SAME-WITHIN-NOISE — off |

- No tool-choice arm made a spurious call, looped or sent an invalid argument. That suite repeats
  itself at temperature 0 pass after pass, so its bands are zero where both sides did — a fixture
  that moved, moved every time.
- The agent's tool phases: the three cases the control solved every time and the arm did not
  (`chain-csv-totals`, `fix-weekend`, `tidy-sort-downloads`) are where to look if they are tried
  again. At this spread a 2-case change needs about fifteen passes a side.
- The library: only 5 of its 28 cases are in the aids' domains (health, first aid, finance,
  building), and the second session's first three passes (one control, two re-rank) shared the 9B
  with an eval run that had outlived its chunk; without them neither side has the four passes the
  gate needs.
- The tool-choice baselines for the chat's selection are re-recorded as 4.4 ranks and selects
  (`baselines/README.md`): **25, 24, 25, 25** of 28 with both switches on, **21, 21, 21, 20** with
  both off. 4.3's ranked on each tool's name and description together, where the app ranks on the
  description alone; its numbers are not comparable with these.
- The agent's default engine made no false claim in 312 runs on the 9B: the 9/30 baseline's 208
  and the night's control's 104.

## The 35B-A3B's agent baseline

Owed since 4.1: `qwen3.8-35b-a3b` in llama-server on the B60, one request at a time, four
passes, saved as `baselines/agent-qwen3.8-35b-a3b.json` (`EVAL_GPU=none` keeps the 5070's health
watch off a server it cannot see).

| on the 25 cases all four passes share | 35B-A3B | 9B, the night's control | 9B, the 8-pass baseline (9/30) |
| --- | --- | --- | --- |
| solved a pass (of 25) | **21, 21, 21, 19 — 20.70** | 18, 18, 18, 13 — 16.75 | 17.88 |
| false claims | **3 in 99 runs** | 0 in 100 | 0 in 200 |
| collateral a pass | 1.01 | 1.75 | 2.25 |
| median time a solved case | 21 s | 17 s | 16 s |
| median rounds · decode | 6 · 68 tok/s | 9 · 102 tok/s | 9 · 106 tok/s |

It solves more (+2.82 a pass against the 9B's baseline, ±2.73) in fewer rounds, and it makes false
claims the 9B does not: all three are reports that the tests pass with no test run behind them
(`needs-you-tax-rate`, `read-only-why-failing`, `chain-slugify`). One run the server dropped is
left out of its pass. `long-discount-rules` is not in it: on the 35B it finished inside the
harness's 8.5-minute chunk 2 times in 7. Whether it is offered as an agent model is Colin's
decision; nothing in the app changes with it.

## The build chain

- **vite 5 → 7.3.6, electron-vite 2 → 5.0.0, @vitejs/plugin-react 4 → 5.2.0.** electron-vite 5
  deprecates `externalizeDepsPlugin()`; `build.externalizeDeps: true` on main and preload says the
  same thing, and the main and preload bundles load exactly the modules they did (electron,
  electron-store, electron-updater and Node's own).
- Same source, both chains: main +477 B (+0.06%), preload identical, the renderer −60,207 B
  (−3.15%), all of it in the JavaScript — the same code printed by a newer esbuild — its CSS and
  the `sigma` CLI byte-identical. The renderer dev server serves the app with React refresh and still refuses a
  file outside the project.
- **Advisories: 11 → 8.** The vite, esbuild and electron-vite advisories are gone; the 8 left (1
  critical, 7 high) all come with electron-builder 24 — `tar`, `app-builder-lib`, `builder-util`,
  `builder-util-runtime`, `dmg-builder`, `electron-builder`, `electron-builder-squirrel-windows`,
  `electron-publish` — and electron-builder 26 clears them (below).

## A dry run for the signed Mac build

`release.yml` runs only on a pushed version tag, so a change to how the Mac build is signed could
only be tried by cutting a release. `.github/workflows/release-dryrun.yml` is its macOS job started
by hand (`workflow_dispatch`): the same steps in the same order — the credentials preflight,
`npm ci`, the typecheck and `npm test`, the keychain, `electron-builder --mac --publish never`
(sign, notarize, staple), the macOS floor stamp — then both DMGs kept for seven days as a workflow
artifact, and the app in each checked: `codesign --verify --deep --strict` with a *Developer ID
Application* authority, `spctl` saying *Notarized Developer ID*, `stapler validate`. No release, no
draft, no Homebrew bump, a read-only token. `test/releaseDryrun.test.ts` (7 tests) fails if it
gains a publish path or token, or if `release.yml`'s macOS steps change without it. RELEASING.md
says how to run it; GitHub lists it once the file is on the default branch, which this release puts
there.

## Fixed

- Library re-rank on `<think>` models (above).
- One forced tool displaced the last tool in the list rather than the lowest-ranked pick; it now
  displaces by rank. No measured question moved (the chat forces the web pair together, and two
  forced tools take both ranked places whatever their order).
- The evals: the chat-selection arm ranked on `name: description` where the app ranks on the
  description alone; the library suite scored correct advice under a "**Do NOT:**" lead-in as
  forbidden (5 flags → 0 on rescoring); the library's aids asked "the first chat model LM Studio
  lists" in the suite instead of the model under test.

## Not in this release

- **electron-builder 26** is ready on its own branch, `4.4/builder26`: the Windows installer and
  its update feed (`latest.yml`, the same fields as 24's) are built, the full suite is green, and
  with the build chain `npm audit` reads 0. It waits on a green dry run of the signed Mac build, which needs the branch pushed and
  the workflow run — Colin's.
- Plan mode, the outline and deep research's planner send the same grammar-without-thinking
  request re-rank did; with larger budgets they likely think first and answer late rather than not
  at all — unmeasured, for 4.5.
- React 19, zustand 5, tailwind 4, electron-store 11, TypeScript 7.

## Upgrade notes

- Nothing changes in Settings or on disk. A turn the chat forces the web pair onto can carry eight
  tool schemas instead of six.
- On Windows: `npm run typecheck` clean; the node suite 3,634 of 3,634 (4.3's 3,603 and 31 new);
  every Electron check — render 25, style 74 and 123, tab traversal 43, modal focus 179, field
  contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown
  62, workbench 53, MCP secrets 19, transport 24.
- For anyone running the evals: `EVAL_CONTROL=1` runs the same-day control beside an arm
  (`eval:agent`, `eval:tools`, `eval:answers`), `EVAL_SESSION` tags sliced runs, and `eval:diff`
  takes `--paired` (one session's files, sorted by their tags) and `--noise-from <baseline>`
  (no side read as quieter than a committed baseline). `eval:tools` adds `EVAL_TOOLSET=default`,
  `EVAL_FORCED_ON_TOP=1` and `EVAL_FILE_TOOLS_FIRST=1`; `eval:answers` adds
  `EVAL_LIBRARY_ASSIST=rerank|hyde`; `EVAL_GPU=none` for a server the 5070's watch cannot see.
