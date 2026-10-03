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

4.6.0 follows 4.5.0 on `main`. J8 landed, so the signed Mac build under electron-builder 26 is
dry-run on `main` after it is pushed and before the tag (decision 4, *Release 4.6.0*).

## Decisions for Colin

Final at J10b (2026-10-03), after J2, J5m and J7. J10a's draft 3 and 4 are now 4 and 5; 6 and 7
are new, and both are 4.7 work. Only 4 stands between `rel/4.6` and the tag, and it is a step of
*Release 4.6.0*.

1. **The agent connection ships off; turning it on with the 35B is yours.** 4.6.0 adds
   `settings.agentConnection`, off by default and on every 4.5 config; while it is off the agent's
   requests are 4.5.0's byte for byte (`test/agentRequests.test.ts`, 15 hashes). J2 ran the 35B
   through it: 22 and 23 of 26 solved; on G6's 25 cases 21 and 22 against G6's 21, 21, 21, 19
   (+0.80, ±1.17, two passes) and against the 9B on the B65's 20, 17, 17; `long-discount-rules` 2 of
   2, which the 9B has not solved on the B65; an ordinary case 22 s (median); all 357 chat requests
   to `:8081`, none to LM Studio. **Recommendation:** offer the 35B as an opt-in agent model through
   the connection (Settings → LM Studio → Agent connection: `http://127.0.0.1:8081/v1`,
   `qwen3.8-35b-a3b`); the 9B stays the default. The caveat is the shared B60: `:8081`'s
   `--kv-unified` pool of 98,304 cells across 3 slots also serves the heartbeat, Keeper and Optimus
   (all three slots were busy in two of J2's chunks, and pass 2's median solved case slowed from 20 s
   to 27 s). In Gaming mode the B60 is off: the agent then stops with a message naming the
   connection, and turning the switch off runs it on LM Studio again.
2. **The sample answer (HyDE) stays off.** J4's four fresh passes on the corrected scorer, beside a
   same-day control: cited the source 25.75 → 23.50 (**−2.25**, ±0.76) WORSE, unsupported figures
   3.25 → 1.00 (−2.25, ±0.71) BETTER, answered −0.25 (±1.35) SAME, forbidden advice 0 of 108 on
   both sides. J10a's correction stands beside it: 4.5's WORSE (answered −1.25) was partly the U+202F
   artifact, and re-scored it reads answered SAME and unsupported BETTER. That reading was taken on
   a scorer changed after the data, which is why J4 ran fresh; J4's WORSE is the one that counts.
   **Recommendation:** leave it off, with no more passes planned.
3. **Re-rank stays off, and its two candidates wait on `4.6/rerank-cite` for 4.7.** J5 found where
   4.5's citing loss sits but not why. With the source first of re-rank's passages, a reply marks it
   `[n]` in 50 of 80 (62.5%), against 32 of 36 in the control. Every re-rank prompt carries both a
   made-up 1 / 0.75 / 0.5 score ladder and three passages instead of five, so the two causes are
   confounded. **C1** (`366f386`, the passages' real scores) recovered two of the three lost points,
   four passes beside a same-day control: cited **−1.00** (±0.00) against 4.5's −3.00, still WORSE;
   answered +0.25 and unsupported +0.25 SAME. **C1 + C2** (`563d729`, five passages with the model's
   picks first) got two passes only (TOO-FEW-PASSES; cited −1.50, ±1.41). Both are inert while
   re-rank is off: the default path's 27 turn messages are byte-identical. **Recommendation:**
   `libraryRerank` stays off and the branch stays unmerged. 4.7 runs C1 + C2's other two passes and
   merges a candidate only if cited comes level.
4. **The Mac dry run of `main` before the `v4.6.0` tag.** `rel/4.6` builds with electron-builder
   26.15.3 (`mac.notarize: true`) and overrides `@electron/get` to ^5.1.0 (ESM-only, Node ≥ 22.12;
   CI runs Node 24). Neither has signed or notarized on a Mac. Windows packaging is proved on this
   PC, from an empty cache with six downloads through `@electron/get` 5, and 4.4.0's dry run of
   `main` went green today, but with builder 24. *Release 4.6.0* puts the dry run between pushing
   `main` and the tag, so it builds exactly the commit the tag will name, from the workflow already
   on `main`, and no second branch is pushed. Pushing `main` publishes nothing: no tag and no release
   follow, and CI runs. **Recommendation:** run it that way. If it is red, nothing is tagged: the fix
   goes onto `rel/4.6`, `main` moves forward to it, and the dry run runs again, while 4.5.0 stays
   Latest. A 403 "A required agreement is missing or has expired" at the notary preflight comes from
   Apple's agreement, not the build: accept it, then re-run about 10 minutes later. Green does not
   prove an in-place update from 4.5.0 to a builder-26 build. The run keeps both DMGs for 7 days
   (`dryrun-installers-mac`) to try that on a Mac.
5. **`npm audit` reads 5, all braces via tailwind 3.** The 5 are braces, chokidar, fast-glob,
   micromatch and tailwindcss: one advisory (GHSA-vfj7-8cjw-p6xm, braces ≤ 3.0.3, no patched
   version), all build-time, through tailwind 3, a dev dependency. npm's only fix is tailwind 4, a
   major. 4.5.0 shipped at 13: builder 24's 8 and these 5. Builder 26 brought 8 of its own
   (http-cache-semantics through `@electron/get` 3, GHSA-ch52-4w7c-c8xp, no patched version), and
   the override removes them. **Recommendation:** accept the 5 for 4.6.0 and take tailwind 4 as a
   track of its own. `RELEASING.md` says when the override goes: when electron-builder's own
   `@electron/get` moves to ^5 (27.0.0-alpha.9 has, 26.17.0 has not), or when http-cache-semantics
   ships a patch.
6. **Claims rule 4, "a prediction is not a claim", for 4.7.** J2's one false claim (pass 1,
   `read-only-why-failing`) is the last clause of a fix it proposed in a read-only run: "That removes
   both leading and trailing whitespace before splitting, so the result is `'Ada Lovelace'` and the
   test passes." Nothing changed and nothing ran. Rule 2 reads the clause as a claim because no frame
   applies (the 35B wrote it flat, with no "should"). One more frame in `asserted()` would fix it: a
   clause that opens *That/This/It/Which* and a change verb and reaches the pass verb through *so*.
   Over every recorded report it flips 1 of the 551 read as claims (this one) and loses 0 of the 248
   labelled claims. Without the *so*, it would also take a genuine `chain-slugify` claim. The app's
   mark reads the same rule, so it would stop marking such a sentence, which is still an unhedged
   assurance about an outcome nobody ran. **Recommendation:** rule 4 in 4.7: a labelled entry, a
   test, `CLAIMS_RULE` 4 and the baselines re-scored.
7. **A false-claim line across unequal pass counts.** False claims are never banded, so any rise in
   the rate reads WORSE. J2's diff reads WORSE on that line alone: 1 in G6's 99 runs and 1 in J2's
   50, the same count over half the runs, and that one is decision 6's prediction. Every other line
   reads SAME. **Recommendation (4.7, `eval:diff`):** when the two sides' pass counts differ, say so
   beside a false-claim WORSE whose count did not rise, as it already does beside a BETTER that rests
   on false claims alone (4.5's decision 3). Whether such a line should decide a verdict is the
   gate's rule, and so your call.

## Release 4.6.0

`rel/4.6` is release-ready and pushed nowhere. It is a fast-forward of `main` (`6563200`, 4.5.0,
which is also `origin/main` as of the last fetch). Unlike 4.3.0–4.5.0, a dry run of the signed Mac
build comes between pushing `main` and the tag (decision 4). In the main checkout:

```bash
cd C:/Users/clong/Projects/SigmaOasis           # the main checkout, on main, clean
git fetch origin
git merge --ff-only rel/4.6                       # main → rel/4.6's tip
git push origin main                              # runs CI only; the release's guard needs the commit on origin/main
# The dry run of the signed Mac build, on main (no gh CLI on this PC: the browser, signed in as CELCPG):
#   Actions → Release dry run → Run workflow → Use workflow from: main (ref empty) → Run workflow
#   (where gh exists: gh workflow run release-dryrun.yml --ref main && gh run watch)
# Wait for it to go green. Red: stop here, no tag (decision 4).
git tag -a v4.6.0 -m "Sigma Oasis 4.6.0 — a second connection for the agent, and the scorers made honest"
git push origin v4.6.0                            # runs .github/workflows/release.yml
# Wait for the Release run (guard, macOS, Windows, Linux, publish to the draft, Homebrew), then publish the draft.
```

This is for Colin to run, or to OK for Apex to run. Nothing here has been run.

- **The dry run.** Its *Say what is being built* step must name `main`'s new commit (`rel/4.6`'s
  tip), version 4.6.0 and `electron-builder: 26.15.3`. Green means builder 26 signed both DMGs with
  the Developer ID identity through our own keychain, notarized and stapled them, and the app in
  each passed the checks (`codesign --verify --deep --strict`, the authority, `spctl`,
  `stapler validate`). Red at the preflight or the keychain import points to the secrets; the 403
  agreement error is decision 4's; red at *Build, sign & notarize* points to builder 26 or the
  override (`RELEASING.md`, *Dry-running the signed Mac build*).
- **The tag's run**, as for 4.5.0. The guard wants the tagged commit on `origin/main` (pushed first)
  and `package.json` at 4.6.0 (`c14baa9`, "4.6.0: version", with the lockfile's two root entries
  and `CLIENT_INFO`). Each build job runs `npm ci` on J8b's lockfile (builder 26.15.3, the override,
  `libc` kept). The macOS job also runs the typecheck and `npm test` (green here, below) and signs
  as the dry run did. The assets keep `electron-builder.yml`'s `Sigma-Oasis-${version}-…` names,
  which the publish and Homebrew jobs look for. New this time: the Windows and Linux jobs are
  builder 26's first on a CI runner, because the dry run is macOS only (Windows packaging was proved
  on this PC). A red job is re-run or fixed before anything is published. The tag stays where it
  is, and the publish job creates or reuses the one draft.
- **Publish** the draft with `RELEASE-NOTES-v4.6.0.md` as its body and **Latest** set (4.5.0 was
  published through the API with `make_latest: "true"`). The run's Homebrew job bumps the cask from
  the draft's DMGs.

`npm audit` reads 5 (decision 5), and `release.yml` has no audit step.

## Status (2026-10-03 17:26, J10b: 4.6.0 release-ready on `rel/4.6`, nothing pushed)

| goal | state | measured |
| --- | --- | --- |
| J1 the agent connection | **done — merged** (`725b219`; track tip `f4239d5`) | `settings.agentConnection`: off by default and on 4.5 configs. Off = the 4.5 base URL and model as given (`agentRequests`' 15 hashes unchanged). On = that server and its model, checked first through 4.5's llama-server reader (`:8081`'s `--kv-unified` pool gives a per-request window of 98,304). When that server is down or lacks the model, the task is refused in words naming the connection, with no fallback to LM Studio. Chat, embeddings, titles, the library and the model pin stay on LM Studio. Also: the Settings → Connection card, the agent chat's label, `sigma`, and `eval:agent` (`EVAL_AGENT_BASE_URL` / `EVAL_AGENT_MODEL`; results record `connection` only on such runs), docs and `SECURITY.md`. `npm test` on the tip: 3,916 / 3,916 (835 suites) + all 14 Electron suites, the on-state card walked |
| J2 the 35B through it | **done**: two passes through the agent connection; results only (`.eval-results/4.6-2026-10-03/j2/`), no branch | The 35B (`qwen3.8-35b-a3b`, llama-server on the B60, `:8081`) through `EVAL_AGENT_BASE_URL`: **22 and 23 of 26** solved. On G6's 25 cases **21 and 22** against G6's 21, 21, 21, 19 (+0.80, ±1.17; two passes, so the band does not call it). `long-discount-rules` 2 of 2 (142 s, 1,304 s; not in G6); `needs-you-tax-rate` solved once (G6: 0 of 4); otherwise G6's stable fails (`fix-parse-duration`, `needs-you-outside-folder` with its collateral, `tidy-duplicates`). Median solved case 22 s (G6: 21 s), median rounds 6 (6), decode 69.8 tok/s (68.4). The tails are rounds at the 16,384-token cap (607 s, 1,304 s). Routing: all 357 chat completions and 12 catalog reads went to `:8081`, none to LM Studio. Other clients' tokens were 3.6% of the server's, and all three slots were busy in two chunks. False claims 1 in 52 (decision 6); `eval:diff` reads WORSE on that line alone (decision 7) and SAME on the rest. Re-scored to rule 3 on `rel/4.6`: 0 flags moved. The recommendation is decision 1 |
| J3 scorers | **done — merged** (`3a80f14`; track `ba05884`) | (a) **claims rule 3**: a needs-you success claim is read by clause. On a labelled set of 339 clauses (96 claims), the old matcher scored P 97.6 / R 41.7 and rule 3 scores 100 / 100. The baselines, the replay fixture and the recorded rule-2 files were re-scored (backups kept): 2 solved flips (Gemma's DEPLOY_TOKEN report unsolved → solved; a 9B outside-folder run solved → unsolved on a "Files changed" table row). (b) The **library scorer** reads Unicode spaces, dashes and quotes as plain ones and stamps its version. Over 46 files and 1,447 runs exactly 4 answered flags moved (H5b's HyDE `14-estimated-payments`), re-rank's 0. (c) **`eval:diff` refuses** a `library` file against a `library-aids` file (exit 2). `npm test`: 3,933 / 3,933 (836 suites) + 14 Electron suites |
| J4 the sample answer again | **done — merged** (docs, `8a43023` in `3a80f14`), **stays off** | the 9B on the B65, four fresh passes on J3's scorer beside a same-day control (ABBA): answered −0.25 (±1.35, SAME), cited **−2.25** (±0.76, WORSE), unsupported −2.25 (±0.71, BETTER), forbidden 0 / 108 both, applied 108 / 108. WORSE: `libraryHyde` stays off (decision 2) |
| J5 re-rank's citing loss | **partial, moved to 4.7**: `4.6/rerank-cite` (`9051e2d`) not merged | Located, not explained. From the saved replies and the replayed prompts (the app's own code, 27 of 27 lookups reproduced), the loss sits in one cell. With re-rank and the source first, `[n]` appears in 50 of 80 replies (62.5%), against 32 of 36 in the control and 24 of 24 with the source second or third. Every re-rank prompt has both the made-up 1 / 0.75 / 0.5 ladder and three passages instead of five. The candidates are inert while re-rank is off (the default path's 27 turn messages are byte-identical). **C1** `366f386`, the passages' fused scores, four passes beside a same-day control: cited 25.00 → 24.00 (**−1.00**, ±0.00) WORSE (4.5: −3.00); answered +0.25 (±0.71) and unsupported +0.25 (±0.50) SAME; forbidden 0 of 108; `[n]` with the source first 65 of 80 (81%). **C1 + C2** `563d729`, five passages with the picks first: two passes only, TOO-FEW-PASSES (cited −1.50, ±1.41). `libraryRerank` stays off (decision 3) |
| J6 Gemma's repeat penalty | **moved to 4.7**: not run | The B65 runs one unit at a time, and J4, J5m and J7 used it. Nothing changed on Gemma's server (the triage shadow week runs to 10/9) |
| J7 the 9B's B65 agent | **partial, moved to 4.7**: `4.6/b65agent` holds nothing (results in `.eval-results/4.6-2026-10-03/j7/`) | Pass 3 covered 25 of 26 cases: `long-discount-rules` was killed mid-round at its 2,370 s budget and not saved. **17 of 25 solved**, 0 false claims, collateral 2 (`needs-you-outside-folder`, `needs-you-tax-rate`), 1,486 s for the 25 (the 5070's medians: 710 s). Passes 1–3 on those 25: **20, 17, 17**; verdicts were equal in all three in 21 of 25 cases, rounds in 10. Pass 4 was not run, so there is no B65 agent baseline. `feature-top-words` straight after `feature-stack-peek` did not run away this time (2 of 3 such chunks have, 0 of 2 alone). Each slow stretch is a single long generation (7.5k to over 16k tokens) at the step that writes the implementation. What it wrote is not logged; the cause is unknown |
| J8, J8b electron-builder 26 | **done — merged** (`d8217ca`; track `1ca0597`) | electron-builder 24 → **26.15.3** (`mac.notarize: true`; the keychain step stays, since 26.15.3 has 24's partition-list bug). The lock stays on 4.5's chain (libc kept; electron-updater 6.8.10, vite 7.3.6, electron-vite 5.0.0 unchanged). `overrides: {"@electron/get": "^5.1.0"}`: builder 26's `@electron/get` 3 pulled in `got` 11 and http-cache-semantics (GHSA-ch52-4w7c-c8xp, no patched version), and with the override `npm audit` goes 13 → **5** (decision 4). Windows packaging is proved from an empty cache (6 downloads through `@electron/get` 5, checksums validated), and 26 does not hit 24's winCodeSign symlink failure here. `npm test` on the tip: 3,878 / 3,878 (824 suites) + 14 Electron suites. The signed Mac build is unproved (decision 3) |
| J10a integration, code tracks | **done** | Merged in order with no conflicts: `725b219` agentconn (the tree is its tip), `3a80f14` scorers (`docs/evals/agent.md` auto-merged with both parts kept), `d8217ca` builder26 (`package.json` auto-merged: builder 26, the override and J3's `eval:library-rescore`; the lock is builder26's byte for byte). `node_modules` is now its own: the junction to `int45`'s was removed and `npm ci` ran through the lock (400 packages, the lockfile untouched, `npm ls` exit 0, one copy of `@electron/get` 5.1.0). `npm audit` reads **5** (the braces chain, 0 critical). `test:replay` 65 / 65. `eval:claims` over the baselines at rule 3: 359 runs, 0 defects, 0 misses. `eval:diff` refuses rule 2 against rule 3, and `library` against `library-aids` both ways (exit 2). J2's connection-stamped results re-score to rule 3 with 0 flags moved and the connection kept, then compare. `npm run build -- --publish never`: electron-builder 26.15.3 packaged win32/x64 (`Sigma-Oasis-4.5.0-setup.exe`, NotSigned, as release Windows builds are). **`npm test` on `d8217ca`: 3,971 / 3,971 (847 suites: 3,878 + J1's 38 + J3's 55) + all 14 Electron suites** |
| J10b 4.6.0 | **done** | "4.6.0: version" `c14baa9` (`package.json`, the lockfile's two root entries edited by hand with no npm run and `libc` untouched, and `CLIENT_INFO`); `RELEASE-NOTES-v4.6.0.md` (`8ccb22c`); this file's final Decisions, *Release 4.6.0* and *What is left (4.7)*. `4.6/rerank-cite` and `4.6/b65agent` are not merged (J5, J7). `npm test` on `55b48aa`, below |
| `npm test` on `rel/4.6` | **green** on `55b48aa` (every merged 4.6 track, the version, the notes and this file's J10b); after it, only this row | node suite **3,971 / 3,971** (847 suites, 0 failed, cancelled or skipped: 4.5.0's 3,878 + J1's 38 + J3's 55; the version adds none, and `test/version.test.ts` reads 4.6.0 in all three places); all 14 Electron suites: render 25, style 74 and 123, tab traversal 43, modal focus 179, field contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown 62, workbench 53, MCP secrets 19, transport 24 (through the lock, 306 s; `.eval-results/4.6-2026-10-03/j10/npmtest-55b48aa.log`). Release check: `main` (`6563200`) is an ancestor of `rel/4.6`; `package.json`, the lockfile's two root entries and `CLIENT_INFO` all read 4.6.0 (the lockfile's 13 `libc` entries kept); `git status` clean |

Every switch and its default in 4.6.0 is as 4.5.0 left it: `FORCED_TOOLS_ON_TOP` **on**,
`FILE_TOOLS_FIRST` **on**, the agent's `toolsByPhase` **off** (and every other agent experiment
off), `libraryRerank` **off**, `libraryHyde` **off**. Nothing turned on in 4.6. New in 4.6 and off
by default: the agent connection (`settings.agentConnection`). The version is 4.6.0.

## What is left (4.7)

- **Re-rank's citing loss, finished.** C1 + C2's other two passes beside a same-day control; merge
  `4.6/rerank-cite` only if cited comes level (decision 3). C2 alone would show whether the
  three-passage block is the rest of the loss.
- **The 9B's B65 agent baseline.** `long-discount-rules` alone (up to 3,000 s, `step.sh`'s cap per
  chunk) and pass 4, then the baseline from H1's two passes and J7's two (two sessions).
- **The `feature-top-words` runaway.** A run of 5, 6, 7, 9 with a long deadline and a per-case stream
  capture, to see what the long generation is.
- **Gemma's repeat-penalty probe** (J6), after the triage shadow week (10/9), and a newer llama.cpp
  for the peg-gemma4 HTTP 500 (4.5's decision 11).
- **Claims rule 4**, the prediction frame (decision 6).
- **`eval:diff`'s false-claim line across unequal pass counts** (decision 7).
- **The 35B through the connection, passes 3 and 4**, if it is to have a baseline of its own under
  the connection; J2 compared against G6's direct one (decision 1).
- **A way back when the agent's server is down.** J1 never falls back to LM Studio unasked, and in
  Gaming mode the B60 is off, so today the way back is the switch in Settings (decision 1).
- **tailwind 4**, for the `npm audit` 5, as a track of its own (decision 5). Dropping the
  `@electron/get` override when electron-builder's own moves to ^5 (`RELEASING.md`).
