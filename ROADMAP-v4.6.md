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

## Status

(Filled in by J10.)
