# Roadmap: Sigma Oasis 4.3 — a gate that knows its noise, and the measurements 4.1 owed

Written by Apex the night of 2026-09-30, against `main` at 4.2.0 (`e1a5272`), from the list the 4.2
notes and the 4.1 status left: a gate that can tell a change from the noise, the tool-choice and
answer suites re-run on the descriptions 4.1 changed, the latency bench's first line, and the
dependency upgrades. Built the same night on `rel/4.3`; the status is at the end.

## Where 4.2.0 stands

- **The release ran clean, and is a draft.** The tag's run (Actions run 36706904583, 2026-09-30
  11:10–11:26 UTC) passed all six jobs — the main guard, macOS signed and notarized (13½ min),
  Windows, Linux, the publish job and the Homebrew bump. Draft release 399976042, named "4.2.0",
  carries all eleven assets the publish job checks for (both DMGs and blockmaps, the setup exe and
  its blockmap, the AppImage, `packs.zip`, the three `latest*.yml`) and an **empty body**. The tap
  was bumped (`CELCPG/homebrew-tap` 164bca7: version 4.2.0 and both checksums), so `brew install
  --cask sigma-oasis` points at downloads that 404 until the draft is published.
- **4.1.0 and 4.0.2 were never tagged.** 4.0.1 users update straight to 4.2.0; its release body
  wants 4.1's notes as well as 4.2's.
- **The gate cannot decide.** The same engine scores single passes from 14 to 21 of 26 on the 9B;
  `eval:diff`'s two-pass stable-set gate calls an unchanged engine WORSE. Every experiment default
  4.1 and 4.2 decided was decided by medians read beside a gate that could not be trusted.
- **Owed since 4.1:** `eval:tools` and `eval:answers` (with the new `live` suite) not re-run since
  4.1 dropped the descriptions' Example lines; `bench:latency` never run, so no Track S saving
  was ever timed; no dependency upgraded (`npm audit`: 18 advisories, 1 critical).

## E — measurement

1. **A gate with a noise band** (Colin's first 4.3 item). At least four passes a side; every gated
   line a per-pass rate read against `band = 2·√(σb²/nb + max(σr, σb)²/nr)`, σb measured when a
   baseline is saved and stored in it; BETTER / SAME-WITHIN-NOISE / WORSE, or TOO-FEW-PASSES.
   False claims never banded. Several runs of one arm merge. Proof: 4.1 against 4.2 with
   experiments off — byte-identical requests — must come out SAME-WITHIN-NOISE.
2. **Re-run `eval:tools` and `eval:answers`** on the 9B; baselines only if the runs are clean.
3. **`bench:latency`'s first line**, beside any earlier one.
4. *(found tonight)* **The live suite measures its fixture.** Its pages are
   `http://127.0.0.1:<port>/…`; `fetch_webpage`'s description says *HTTPS only, private addresses
   refused*, and 7 of the 8 misses in three passes gave local or internal pages as the reason they
   read nothing. Serve the fixture under a
   public-looking HTTPS origin the test seam maps to loopback (`src/main/ipc/search/ssrf.ts` —
   the one hole in the fetch guards, so a decision), then judge the 4.1 gate (≥ 90%).
5. *(found tonight)* **`eval:tools` should record each fixture's wire set** in the subset arm, so
   a miss can be read as a ranking miss or a choice.
6. *(found tonight)* **Think-harder's review budget on reasoning models:** twice the review spent
   1,999 of 2,000 completion tokens thinking and returned nothing. Close its thinking (as S4 did
   for verification) or give it room.
7. *(found tonight)* **The library suite's forbidden patterns** cannot see a negation ("stay away
   from windows" is flagged) and are counted in no summary line.
8. **Re-decide the experiments at four passes a side** against the new baseline: `planRound` (two
   passes; one false claim — WORSE whatever the band), `thinkByPhase` with 4.2's family profiles
   (never measured), re-rank, the sample-answer expansion, draft models (unmeasured).

## D — dependencies (docs/dependencies-4.1.md)

Patches and minors first, one group a commit, the whole `npm test` after each; majors only where
the notes give the procedure and it can be proved here.

1–6. electron 44.5.1; dompurify 3.4.16 (an XSS advisory); highlight.js 11.12; postcss and
   autoprefixer; @types/node 24.19; `npm audit fix` without `--force`.
7. marked 12 → 18 — the notes' first major, on the XSS path, done by their procedure.
8. electron-builder 26 — nine of the advisories left, `tar` critical among them; needs a Mac and a
   release-workflow dry run. The Windows half is on the track `4.3/builder26` (`0126690`, not
   merged): 26 refuses 24's `mac.notarize: { teamId }` for *every* platform's build, so
   `notarize: true` (the team id from `APPLE_TEAM_ID`); with that, the Windows installer, its
   blockmap and `latest.yml` come out under the release's names, `latest.yml` field for field as
   24 wrote it for v4.2.0, and the app.asar packs the same 52 packages at the same versions.
9. The build chain (vite 7, electron-vite 5, plugin-react 5); then React 19, zustand 5, tailwind
   4, electron-store 11, TypeScript 7.

## F — found and fixed on the way

1. `npm run test:replay` passed `--only` to `scripts/test.sh`, which never read it: it ran the
   whole suite while the docs said otherwise.
2. An `EVAL_SUBSET=1` tool-choice run was written as a whole-toolbox run (`arm: 'full'`,
   `toolchoice-*.json`): the picker folded it over the full view's number, and `eval:diff` would
   have merged the two arms.
3. `bench:latency` called the history planner without the low-water mark or the trim floor, so it
   timed S1's cost and never its saving.

## Carried from 4.1, still open

- The worktree `post-checkout` hook and the `.sigma/.gitignore` gaps.
- A signed Windows installer (4.0's E7).

## Decisions for Colin

1. **Publish v4.2.0** — paste a body (4.1's notes and 4.2's: 4.0.1 users land on 4.2.0 with
   neither) and a title in the usual "Sigma Oasis v4.2.0 — …" form; the tap already points at it.
2. **The agent baseline is eight passes from four runs** — the 4.1 engine's two runs and the 4.2
   engine's two, byte-identical on the wire. Keep it, or keep the 4.1 runs alone (four passes; σ
   1.29 of 26, which understates the spread between runs: the 4.2 engine's two runs alone differ
   by four cases).
3. **marked 18 is merged** into `rel/4.3` (`020e839`). Keep it, or `git revert -m 1 020e839`.
4. **The live fixture** — let the test seam map one public-looking HTTPS origin to the loopback
   server (E4), or re-word the suite; either way the 4.1 gate waits for it.
5. **electron-builder 26** — `4.3/builder26` has the config change and the Windows proof; when to
   merge it, and how to dry-run the signed Mac half: a `v*` tag runs the real release (and the tap
   bump), so a dry run wants a `workflow_dispatch` path or a throwaway repo.
6. **No 4.3.0-dev.** Release branches keep the last released version until the release commit
   ("4.1.0: version", "4.2.0: version" bump `package.json`, the lockfile and `CLIENT_INFO`
   together); `rel/4.3` follows that and still says 4.2.0.

## Status (2026-10-01 01:00, 4.3.0 on `rel/4.3`)

| item | state | measured |
| --- | --- | --- |
| E1 the band | **done** — `src/main/agent/evalDiff.ts`, 27 unit tests, the replay gate on it | 4.1 (18, 21, 20, 19) against 4.2 off (14, 16, 17, 21): **SAME-WITHIN-NOISE**, solved −2.50 a pass against ±3.21, collateral +1.25 against ±1.35; both ways. The 4.1 gate called the 4.1 engine's own second run a REGRESSION |
| E1 the baseline | **done** — eight passes, four runs, σ 2.49 of 26 | a four-pass run gets ±3.05; a 2-case change needs ~13 passes a side to resolve |
| E2 `eval:tools` | **done**, baselines committed (both clean, no spread) | whole toolbox 22, 22, 22, 22 of 28; the app's subset 23, 23, 23, 23; spurious 0/12; on the 24 fixtures shared with 9/28's subset run, 21 then and now |
| E2 `eval:answers` | **done**, three passes (no baselines: `eval:diff` reads agent and tool-choice files only) | library answered 80/84, cited 55/84, unsupported 14/84; quant bare 28/60, Workbench **59/60**; think-harder 30/58 against 29/60; live 10/18, ledger 0/18, wrong day 0/18 |
| E3 `bench:latency` | **done**, two lines, and S1's scenarios added | cold 1.0–1.1 s, warm 73 ms, turn 1 → 10 223–264 ms, decode 95–100 tok/s; past the window, next turn **27.5 s without the low-water mark, 0.70 s with it** |
| E4–E8 | open | — |
| D1–D6 | **done**, each with the full `npm test` | advisories 18 → 11 |
| D7 marked 18 | **done**, merged from `4.3/marked` | 25 samples: identical HTML but for three rendering-neutral changes |
| D8 electron-builder 26 | track `4.3/builder26`, not merged — Windows proved, Mac needs Colin | advisories 11 → 3 on the track |
| D9 the build chain and the rest | open — planned in docs/dependencies-4.1.md | the 3 left after D8 |
| F1–F3 | **done** | — |
| `npm test` on `rel/4.3` | green | node suite 3,584/3,584; render 25, style 74 and 123, tab traversal 43, modal focus 179, field contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown 62, workbench 53, MCP secrets 19, transport 24 |

Measured on Windows, `qwen3.8-9b-distill` on the RTX 5070 (the installed app sharing it, the Clerk
task paused). Draft notes: `RELEASE-NOTES-v4.3.0.md`.
