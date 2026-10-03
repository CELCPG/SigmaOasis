# Roadmap: Sigma Oasis 4.6 — a second connection for the agent, and the scorers made honest

Written by Apex on 2026-10-03 at 13:00 ET, after Colin said "go" on 4.6. 4.3.0, 4.4.0 and 4.5.0 were
all published that morning: main and Latest are 4.5.0 (`6563200`), and Homebrew serves 4.5.0. Work
runs on `rel/4.6` (worktree `so-wt/int46`) from tracks `4.6/<name>` (worktrees `so-wt/46-<name>`).
Nothing leaves the PC without Colin's OK: no push, no tag, no release.

## Why

Since the RTX 5070 left on 10/2, the 9B (LM Studio, Arc Pro B65) runs about 2.4× slower than it
did. On Gemma's 11 cases, the 35B-A3B on the B60 (`:8081`) solved 10 in about 360 s. The 9B took
693 s and 1,228 s over its two passes on the B65.

Sigma has one connection (`settings.baseUrl`). Chat, embeddings, the agent and the model pin all
share it, so moving the agent to the 35B would cost nomic's embeddings (the library and memory).
Colin decided 4.5's decision 12 (HQ decision 99): **a second connection is the 4.6 track.**

4.5 also found three scorer defects, each a 4.6 item:
- the needs-you success-claim matcher;
- the library scorer's Unicode spaces;
- `eval:diff` comparing a `library` file with a `library-aids` file.

## The goals

| goal | what | where | model |
| --- | --- | --- | --- |
| J1 | **The agent connection.** An optional second connection (base URL, model, its own catalog via 4.5's llama-server reader) used only by the agent: the in-app agent, `sigma` and the agent eval. Chat, embeddings, titles, the library and the model pin stay on LM Studio. Off by default, and when off the requests are byte-identical to 4.5.0's. A Settings → Connection card with the same loopback/LAN rules as today. Accessibility suites green | `4.6/agentconn` | Opus |
| J2 | **The 35B through it.** `eval:agent` on the 35B *through the app's agent connection*, against 4.4 G6's 35B baseline (rescored to rule 2, 1 false claim in 99), so the plumbing is proven, not just the model. Then the recommendation on offering the 35B as the agent model (4.4 decision 3) | after J1 | Sonnet |
| J3 | **Scorers.** (a) The needs-you success-claim matcher: a labelled set and a fix, with every recorded run re-scored and every flip listed, as claims rule 2 did. (b) The library scorer normalises Unicode spaces (U+202F and kin): re-score every library file and list what moves. (c) `eval:diff` refuses a `library` vs `library-aids` comparison, like the claim-rule refusal | `4.6/scorers` | Sonnet |
| J4 | **The sample answer (HyDE) again**, on `library-aids` with J3's scorer: four fresh passes beside a same-day control. It turns on only if BETTER beyond the band with no new forbidden answer | after J3 | Sonnet |
| J5 | **Re-rank's citing loss**: why the 9B cites a re-ranked source less (`[n]` in 91 → 76 of 108). Read the saved replies and prompts, find the mechanism, and measure a fix only if one is found | `4.6/rerank-cite` | Sonnet |
| J6 | **Gemma's repeat-penalty probe**: the 11 measured cases with a repeat penalty through the engine's `sampling` override. Nothing changes on Gemma's server: its build and flags stay put during the triage shadow week (to 10/9) | `.eval-results` only | Sonnet |
| J7 | **The 9B's B65 agent passes 3 and 4**, then a B65 agent baseline (4 passes, 2 sessions). Also look into the order-dependent `feature-top-words` runaway, which runs long straight after `feature-stack-peek` | `4.6/b65agent` | Sonnet |
| J8 | **electron-builder 26 on 4.6**: rebase `4.4/builder26` onto `rel/4.6`, prove the Windows build, run the full `npm test`, and get `npm audit` down to braces' 5. A Mac dry run needs the branch pushed (Colin's call) | `4.6/builder26` | Sonnet |
| J10 | **Integration**: tracks on `rel/4.6`, the full `npm test`, 4.6.0 release-ready (version, notes, decisions) | `rel/4.6` | Opus |

The rule is unchanged: **a switch turns on by default only if its arm is BETTER beyond the noise
band, beside a same-day control, with zero new false claims.** A new setting that is off by default
(J1) ships off. Turning it on is Colin's.

## How it runs

- **Units:** at most ~60 minutes each, as Workboard cards on `apex-runs` titled "Sigma 4.6 · J…". Builders are native subagents, and Apex verifies each unit.
- **The machine lock:** `.eval-results/4.6-2026-10-03/step.sh` is 4.5's harness. It has `run`, detached `start`/`wait`/`stop`, Clerk holds, a gaming check and an orphan reaper. GPU evals, full `npm test`, builds and `npm ci` all go through it.
- **Sizing for the B65:** units are about half the size the 5070 handled. B65 work (J4, J6, J7) runs one unit at a time. J2 runs on the B60, which is shared with the heartbeat, Keeper and Optimus.
- **`node_modules`:** track worktrees junction it to `int45`'s (4.5.0's lockfile). J8 makes its own copy.

## Release order

4.6.0 follows 4.5.0 on `main`, and its release section will carry the commands. If J8 lands, a dry
run of the signed Mac build goes before the tag.

## Decisions for Colin

Draft at J10a (2026-10-03), after the three code tracks were merged. J10b adds what J2, J5 and J7
leave. Only 3 stands between `rel/4.6` and the tag.

1. **The agent connection ships off.** 4.6.0 adds `settings.agentConnection`. It is off by default
   and off on every 4.5 config, and while it is off the agent's requests are byte-identical to
   4.5.0's (`test/agentRequests.test.ts`, 15 hashes). Turning it on and pointing it at the 35B
   (Settings → Connection: `http://127.0.0.1:8081/v1`, `qwen3.8-35b-a3b`) is Colin's call. J2's
   recommendation (the 35B through the connection, against 4.4 G6's 35B baseline) comes with J10b.
2. **The sample answer (HyDE) stays off.** It has been measured twice on `library-aids`, each time
   beside a same-day control. 4.5's H5b read WORSE (answered −1.25 ±0.50). J3 then found that drop
   was partly the U+202F scorer artifact: re-scored, H5b reads answered SAME and unsupported figures
   BETTER, a reading taken on a scorer changed after the data. So J4 ran four fresh passes on the
   corrected scorer: cited the source **−2.25** beyond ±0.76 (WORSE), unsupported figures −2.25
   beyond ±0.71 (BETTER), answered −0.25 within ±1.35, no forbidden advice on either side. Verdict
   WORSE; the default does not change.
3. **The signed Mac build under electron-builder 26 needs a dry run before 4.6.0 ships.**
   `rel/4.6` now builds with electron-builder 26.15.3 (`mac.notarize: true`) and overrides
   `@electron/get` to ^5.1.0. Windows packaging is proved on this PC, the Mac side is not. The dry
   run (`release-dryrun.yml`, already on `main`) needs either Colin's OK to push `4.6/builder26` (or
   `rel/4.6`) and dispatch it on that branch, or a dry run of `main` after the merge and before the
   tag. CELCPG/SigmaOasis is public, so a pushed branch is visible to anyone; a push alone starts no
   workflow. Steps and what green proves: `RELEASING.md` and J8's notes.
4. **`npm audit` reads 5, all braces via tailwind 3.** The 5 are braces, chokidar, fast-glob,
   micromatch and tailwindcss, all high and build-time only. The fix is tailwind 4, a major
   upgrade and not a 4.6 item. The recommendation is to accept the 5 for 4.6.0. Builder 26's own
   8 (http-cache-semantics through `@electron/get` 3) are gone with the override. `RELEASING.md`
   says when to drop the override: when electron-builder's own `@electron/get` moves to ^5
   (27.0.0-alpha.9 has, 26.17.0 has not), or when http-cache-semantics ships a patch.

## Status (2026-10-03 17:00, J10a: the code tracks on `rel/4.6`, nothing pushed)

| goal | state | measured |
| --- | --- | --- |
| J1 the agent connection | **done — merged** (`725b219`; track tip `f4239d5`) | `settings.agentConnection`: off by default and on 4.5 configs. Off = the 4.5 base URL and model as given (`agentRequests`' 15 hashes unchanged). On = that server and its model, checked first through 4.5's llama-server reader (`:8081`'s `--kv-unified` pool gives a per-request window of 98,304). When that server is down or lacks the model, the task is refused in words naming the connection, with no fallback to LM Studio. Chat, embeddings, titles, the library and the model pin stay on LM Studio. Also: the Settings → Connection card, the agent chat's label, `sigma`, and `eval:agent` (`EVAL_AGENT_BASE_URL` / `EVAL_AGENT_MODEL`; results record `connection` only on such runs), docs and `SECURITY.md`. `npm test` on the tip: 3,916 / 3,916 (835 suites) + all 14 Electron suites, the on-state card walked |
| J2 the 35B through it | **in progress** (J2b) | the 35B on `:8081` through the app's agent connection; then the comparison with 4.4 G6's 35B baseline and the recommendation (decision 1) |
| J3 scorers | **done — merged** (`3a80f14`; track `ba05884`) | (a) **claims rule 3**: a needs-you success claim is read by clause. On a labelled set of 339 clauses (96 claims), the old matcher scored P 97.6 / R 41.7 and rule 3 scores 100 / 100. The baselines, the replay fixture and the recorded rule-2 files were re-scored (backups kept): 2 solved flips (Gemma's DEPLOY_TOKEN report unsolved → solved; a 9B outside-folder run solved → unsolved on a "Files changed" table row). (b) The **library scorer** reads Unicode spaces, dashes and quotes as plain ones and stamps its version. Over 46 files and 1,447 runs exactly 4 answered flags moved (H5b's HyDE `14-estimated-payments`), re-rank's 0. (c) **`eval:diff` refuses** a `library` file against a `library-aids` file (exit 2). `npm test`: 3,933 / 3,933 (836 suites) + 14 Electron suites |
| J4 the sample answer again | **done — merged** (docs, `8a43023` in `3a80f14`), **stays off** | the 9B on the B65, four fresh passes on J3's scorer beside a same-day control (ABBA): answered −0.25 (±1.35, SAME), cited **−2.25** (±0.76, WORSE), unsupported −2.25 (±0.71, BETTER), forbidden 0 / 108 both, applied 108 / 108. WORSE: `libraryHyde` stays off (decision 2) |
| J5 re-rank's citing loss | **in progress** (J5m) | no mechanism proven from the saved replies (the score ladder and the three-passage block are confounded in every re-rank prompt); candidate C1 (honest scores, `366f386`) is being measured beside a same-day control. `4.6/rerank-cite` not merged |
| J6 Gemma's repeat penalty | **not started** | B65 work runs one unit at a time |
| J7 the 9B's B65 agent | **in progress** | passes 3 and 4 and the B65 agent baseline; `4.6/b65agent` not merged |
| J8, J8b electron-builder 26 | **done — merged** (`d8217ca`; track `1ca0597`) | electron-builder 24 → **26.15.3** (`mac.notarize: true`; the keychain step stays, since 26.15.3 has 24's partition-list bug). The lock stays on 4.5's chain (libc kept; electron-updater 6.8.10, vite 7.3.6, electron-vite 5.0.0 unchanged). `overrides: {"@electron/get": "^5.1.0"}`: builder 26's `@electron/get` 3 pulled in `got` 11 and http-cache-semantics (GHSA-ch52-4w7c-c8xp, no patched version), and with the override `npm audit` goes 13 → **5** (decision 4). Windows packaging is proved from an empty cache (6 downloads through `@electron/get` 5, checksums validated), and 26 does not hit 24's winCodeSign symlink failure here. `npm test` on the tip: 3,878 / 3,878 (824 suites) + 14 Electron suites. The signed Mac build is unproved (decision 3) |
| J10a integration, code tracks | **done** | Merged in order with no conflicts: `725b219` agentconn (the tree is its tip), `3a80f14` scorers (`docs/evals/agent.md` auto-merged with both parts kept), `d8217ca` builder26 (`package.json` auto-merged: builder 26, the override and J3's `eval:library-rescore`; the lock is builder26's byte for byte). `node_modules` is now its own: the junction to `int45`'s was removed and `npm ci` ran through the lock (400 packages, the lockfile untouched, `npm ls` exit 0, one copy of `@electron/get` 5.1.0). `npm audit` reads **5** (the braces chain, 0 critical). `test:replay` 65 / 65. `eval:claims` over the baselines at rule 3: 359 runs, 0 defects, 0 misses. `eval:diff` refuses rule 2 against rule 3, and `library` against `library-aids` both ways (exit 2). J2's connection-stamped results re-score to rule 3 with 0 flags moved and the connection kept, then compare. `npm run build -- --publish never`: electron-builder 26.15.3 packaged win32/x64 (`Sigma-Oasis-4.5.0-setup.exe`, NotSigned, as release Windows builds are). **`npm test` on `d8217ca`: 3,971 / 3,971 (847 suites: 3,878 + J1's 38 + J3's 55) + all 14 Electron suites** |
| J10b | **next** | `4.6/rerank-cite` and `4.6/b65agent` when J5m and J7 finish, the measurements, the version and the notes. J2's results were recorded under claims rule 2 (its branch predates J3), so they are re-scored to rule 3 before their diff on `rel/4.6` |
