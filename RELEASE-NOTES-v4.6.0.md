# Sigma Oasis v4.6.0 — a second connection for the agent, and the scorers made honest

4.5 measured the 35B-A3B at two to three and a half times the 9B's speed on agent work, and the app
could not use it. It had one connection, and pointing that connection at the 35B would have taken
the library and memory's embedding model with it. 4.6 gives the agent a connection of its own,
off until you turn it on. The eval's scorers are fixed where 4.5 caught them out: a report that
names what it is missing is no longer read as "done", and a narrow no-break space now reads as a
space. The installers are built by electron-builder 26, and `npm audit` reads 5 instead of 13. Four
things were measured: the 35B through the new connection, the sample answer again on the corrected
scorer, why re-rank costs citations, and a third agent pass of the 9B on the Arc Pro B65. None of
them changes a default. 4.6.0 follows 4.5.0 and is built on it. The plan and its status are
`ROADMAP-v4.6.md`.

## What you will notice

- **The agent can have a server of its own.** Through 4.5, LM Studio's address served everything:
  chat, embeddings (the library, memory, tool ranking), titles, the model pin and the agent.
  **Settings → LM Studio → Agent connection** gives the agent a second address and model. That
  covers agent chats, the `sigma` command and scheduled agent jobs. Everything else stays on LM
  Studio, and the app's own tools keep asking LM Studio with the chat's model when the agent uses
  them.
  - **Off by default,** and off in every settings file written before 4.6. While it is off, the
    agent's requests are 4.5.0's byte for byte.
  - **Pointing it at a llama-server:** start llama.cpp's `llama-server` on this machine, turn the
    switch on, and give the address. The field's default, `http://127.0.0.1:8080/v1`, is
    llama-server's own port. On the PC these notes were measured on, the 35B-A3B is at
    `http://127.0.0.1:8081/v1`. Then pick the model from the server's own list (*The server's
    model* means the first one it lists) and press **Test**. The address must be on this machine
    (`localhost`, `127.0.0.1`, `::1`), as LM Studio's must. Any other address reverts to the
    default, and the card says so. The agent's requests are a model server's traffic: direct, never
    proxied, and its host is allowed out only while the connection is on. Sigma never loads or
    unloads a model there.
  - **The window** the agent budgets its history against is the one that server gives a request,
    read from llama-server's `/props`. Started with `--kv-unified`, that is the whole context, shared
    by every slot. On the B60's 35B that is 98,304 tokens across three slots, so other clients'
    requests at the same moment draw on the same pool.
  - **When it fails, the agent says so and stops,** naming the connection. Before a task, that
    happens if the server does not answer or does not serve the model; during one, if it stops
    answering. It never falls back to LM Studio. Turn the switch off to run the agent on LM Studio
    again.
  - **What you see:** the card's status line ("off — the agent runs on LM Studio", or the model and
    its address) and Test. An agent chat's header and panel name the model and the address, and
    each turn is labelled with the model that ran it.
- **`sigma` follows the same setting.** With the connection on, it checks that server first (exit 1,
  in words, if the server is down or lacks the model) and runs the agent there. `--base-url` names a
  server for one run instead, and `--model` names a model. `--json`'s last line carries
  `connection: { via, baseUrl, model }`, where `via` is `agent` or `main`.
- **Built by electron-builder 26.** The installers are packaged by electron-builder 26.15.3 instead
  of 24, under the same file names. The Mac builds are signed and notarized the same way, through
  our own keychain and Apple's notary service, now configured with `mac.notarize: true`. On
  Windows, `npm run build` now finishes on a machine where 24 stopped while extracting
  winCodeSign's symlinks.
- **`npm audit` reads 5 instead of 13.** Builder 24's 8 advisories are gone. Builder 26 brought 8 of
  its own: http-cache-semantics (GHSA-ch52-4w7c-c8xp, no patched version), reached through its
  `@electron/get` 3 → `got` 11. Those are removed by overriding `@electron/get` to ^5.1.0, the
  version Electron 44 already uses, so there is now one copy of it. Everything in that chain is
  build-time: it downloads Electron and the packager's tools, and none of it ships in the app. The 5
  left are below (*Not in this release*).

## The scorers, made honest

Three defects 4.5 found in the eval's own scoring are fixed. Each fix was made as a change of its
own, with every recorded result re-scored and every verdict that moved listed. None of them touches
the app's behaviour.

- **A needs-you report is read clause by clause (claims rule 3).** A needs-you case is solved only
  if the agent stops and asks without claiming success. The old matcher read Gemma's
  `needs-you-deploy-token` report as a claim that the work was done. That report named the missing
  `DEPLOY_TOKEN`, said it could not deploy, and ended "I have completed the investigation…". Read
  against a labelled set, the old matcher also missed most real claims. Those were the usual ways a
  report says it did the work: "**Fixed.** Created `shared/format.js` …", "- Updated `src/vat.js`",
  a "Files changed" table row, "Done.". On the 339 clauses (96 of them claims, labelled before the
  matcher changed), the old matcher scored precision 97.6% and recall **41.7%**; rule 3 scores 100%
  and 100%. The rule was written looking at that set, so 100% shows it fits the set, not unread
  text. The baselines, the replay fixture and every rule-2 results file were re-scored, and 2
  solved verdicts moved. Gemma's deploy-token run went from not solved to solved, and one 9B
  `needs-you-outside-folder` run went from solved to not solved on its "Files changed" row. The
  app's mark is unchanged: it reads the test-pass claim, which is still rule 2's, and it marks no
  needs-you report (`docs/evals/claims.md`).
- **The library scorer reads Unicode spaces, dashes and quotes as plain ones.** In 4.5, four replies
  that wrote "June 15" with a narrow no-break space (U+202F) failed a pattern written with an ASCII
  space. Results now carry `libraryScorerRule`. Over 46 library files and 1,447 runs, exactly those 4
  answered flags moved (the sample answer's `14-estimated-payments`), and re-rank's moved 0.
- **`eval:diff` refuses a `library` file against a `library-aids` file** (exit 2, both ways, and a
  merge of them), as it refuses two claim rules: the two compare different questions, not two
  engines. The suite comes from the file's `librarySuite`, which `library-aids` control files now
  record too.

## Measured

### The 35B through the agent connection

The 35B-A3B (`qwen3.8-35b-a3b`, llama-server on the Arc Pro B60, `:8081`) ran the agent eval through
the app's agent connection on 2026-10-03: two passes, temperature 0, compared with its 4.4 baseline,
which ran on the B60 without it.

| | 35B, through the connection | 35B, direct (4.4's baseline) | 9B, B65 |
| --- | --- | --- | --- |
| passes | 2 | 4 | 3 |
| solved, on the 25 cases all three ran | **21, 22** | 21, 21, 21, 19 | 20, 17, 17 |
| `long-discount-rules` | **2 of 2** (142 s, 1,304 s) | not in the baseline | 0 of 3 |
| false claims | 1 in 52 runs | 1 in 99 | 0 in 77 |
| a solved case, median | 22 s | 21 s | — |
| the 25 cases, one pass | 1,197 s and 758 s | — | 1,486 s |
| decode, median of runs | 69.8 tok/s | 68.4 tok/s | — |

- **The plumbing is proved.** All 357 chat requests of the two passes, and 12 catalog reads, went to
  `:8081` with the 35B's id. None reached LM Studio. The eval takes the app's own route:
  `EVAL_AGENT_BASE_URL` builds an agent connection, and every case passes the same check before it
  runs.
- **The model is the one 4.4 measured.** +0.80 on the baseline's mean (±1.17), from two passes, so
  `eval:diff` does not call it by the band. It failed the same cases the baseline always fails,
  except `needs-you-tax-rate`, which it solved once (0 of 4 in the baseline). It finished
  `long-discount-rules` both times, a case the 9B has not solved on the B65.
- **Long tails.** A case where one round runs to the 16,384-token cap takes 10 to 22 minutes:
  `read-only-why-failing` 607 s, `long-discount-rules` 1,304 s. An ordinary case takes about 20 s.
- **The server is shared.** The B60's llama-server also serves other clients on this PC: three slots
  over one `--kv-unified` pool. During the two passes, other clients' tokens were 3.6% of the
  server's, all three slots were busy at times, and the second pass's median solved case was 27 s
  against the first's 20 s. An agent turn waits behind other clients, and a long agent run slows
  them.
- **Its one false claim is a prediction.** In a read-only run that changed nothing and ran nothing,
  the report's last clause proposed a one-line fix: "That removes both leading and trailing
  whitespace before splitting, so the result is `'Ada Lovelace'` and the test passes." The claims
  rule reads it as a claim. A frame for that shape would flip that one report of the 551 read as
  claims and lose none of the 248 labelled claims. It is 4.7's, because a rule change re-scores
  every file. `eval:diff` reads the false-claim line WORSE on its own (1 in 99 → 1 in 50 on the
  shared cases), which is the same count over half the runs. Every other line reads SAME.

### The sample answer, again

4.5 measured the sample answer (HyDE) WORSE on `library-aids`, and part of that was the U+202F
artifact above. Re-scored, 4.5's passes read answered within the band and unsupported figures
BETTER. That reading came from a scorer changed after the data, so it was not used. Instead, four
fresh passes on the corrected scorer ran beside a same-day control (ABBA): the 9B on the B65,
2026-10-03 (`docs/evals/library-aids.md`).

| of 27 a pass | control | the sample answer | | |
| --- | --- | --- | --- | --- |
| answered | 20.75 | 20.50 | −0.25 (±1.35) | same |
| cited the source | 25.75 | 23.50 | **−2.25** (±0.76) | **WORSE** |
| unsupported figures | 3.25 | 1.00 | −2.25 (±0.71) | BETTER |
| forbidden advice | 0 of 108 | 0 of 108 | | |

It was used in 108 of 108 runs. It invents fewer figures and cites the source less, so the verdict
is WORSE and it stays off.

### Re-rank's citing loss

4.5's re-rank put the right passage first far more often, and the replies cited it less: `[n]` in
76 of 108 replies against 91. The saved replies, and the prompts replayed through the app's own
lookup (27 of 27 reproduced exactly), show where the loss sits. It is in one place: re-rank with the
source first. There, a reply marked it in 50 of 80, against 32 of 36 in the control and 24 of 24
when re-rank put the source second or third. The sample answer also moves the source up, but keeps
five passages and their own scores, and it lost almost nothing there (16 → 15). The lost replies are not
wrong. They quote the passage in prose ("According to your reference notes…") without its number.

Every re-rank prompt differs from the control in two ways at once. Its scores are a made-up ladder
(1, 0.75, 0.5), and it shows three passages instead of five. Two candidates were measured, each
beside a same-day control on `library-aids`:

| of 27 a pass | 4.5's re-rank | C1: the real scores | C1 + C2: and five passages |
| --- | --- | --- | --- |
| passes a side | 4 | 4 | 2 |
| cited the source | 24.25 → 21.25, **−3.00** (±0.71) | 25.00 → 24.00, **−1.00** (±0.00) | 25.50 → 24.00, −1.50 (±1.41) |
| answered | +0.75 (±0.71) | +0.25 (±0.71) | −0.50 (±1.00) |
| unsupported figures | +0.75 (±0.96) | +0.25 (±0.50) | +0.50 (±1.41) |
| `[n]` with the source shown first | 50 of 80 | 65 of 80 | 32 of 40 |
| verdict | WORSE | WORSE | too few passes |

Honest scores won back two of the three lost points, but cited is still below the control, and the
control's spread was zero. C2's two passes are not enough to call. Neither candidate is in 4.6.0.
Both wait on their branch for 4.7, and re-rank stays off.

### The 9B on the B65, a third agent pass

The third of the four passes a B65 agent baseline needs: 17 of 25 solved and 0 false claims. The
26th case, `long-discount-rules`, was stopped at its 2,370 s budget in the middle of a round. Over
the three passes on the same 25 cases: 20, 17, 17. Verdicts were equal in all three in 21 cases and
rounds in 10, so the agent on the B65 is still not deterministic. The 25 took 1,486 s, against the
RTX 5070's 710 s (medians). There is no baseline yet.

`feature-top-words` straight after `feature-stack-peek` did not run away this time. Two of three
such chunks have, and neither run alone has. LM Studio's log shows what a runaway is: one
generation of 7,500 to over 16,000 tokens, at the step where the model writes the implementation,
not a growing prompt or contention with other requests. The three saved solved runs agree to within a
few tokens a round through round 6 and part from round 7 or 8. What the long generation says is not logged. The
cause is not known.

## What stays off, and why

- **Every switch is as 4.5.0 left it.** Forced tools on top of the cap: **on**. File tools first:
  **on**. The agent's tool phases and every other agent experiment: **off**. Library re-rank and the
  sample answer: **off**, each WORSE on citing beside a same-day control (above). Nothing turned on
  in 4.6.
- **The agent connection is off.** A new setting ships off, and turning it on is yours. Pointed at
  the 35B, it solved as many as its 4.4 baseline (+0.80, within the band), finished
  `long-discount-rules`, which the 9B has not finished on the B65, and runs an ordinary case in
  about 20 s. Two caveats. The server is shared with
  whatever else uses it. And when that server is off, the agent stops until the switch goes back
  off.
- **No fallback to LM Studio.** A task meant for one model is never moved to another unasked. The
  agent says which connection failed and stops.
- **No B65 agent baseline:** three passes of the four the rule wants. Until the fourth, an agent
  change on the B65 is diffed against its own same-day control.

## Not in this release

- **tailwind 4.** `npm audit` reads 5, all one advisory (GHSA-vfj7-8cjw-p6xm, braces ≤ 3.0.3, a
  stack-exhaustion DoS, no patched version). It reaches us only through tailwind 3's build-time
  chain (braces, chokidar, fast-glob, micromatch, tailwindcss), a dev dependency, and npm's only fix
  is tailwind 4, a major.
- **Re-rank's two candidates,** on their branch until C1 + C2 has four passes (above).
- **The prediction frame for the claims rule,** and a note in `eval:diff` when a false-claim line
  compares unequal pass counts. Both are 4.7's.
- **Gemma's repeat-penalty probe** did not run: the B65 runs one measurement at a time, and this
  release's took it. The agent connection takes any model server on this machine, but Gemma 4 is not
  recommended as the agent's model. 4.5 measured it at 4 to 8 times the 9B's time, and its
  llama-server build returns HTTP 500 on some plain-text replies made with tools offered.
- Electron stays 44.5.1, and electron-updater 6.8.10.

## Fixed

- The eval's needs-you reading, the library scorer's Unicode spaces, and `eval:diff` across library
  suites (above).
- `library-aids` control results recorded no suite, so `eval:diff` could not tell them from
  `library` files. They record it now.
- `npm run build` on Windows stopped at winCodeSign's symlink extraction under electron-builder 24.
  26 does not fetch that archive.

## Upgrade notes

- Nothing changes until you turn the agent connection on. A 4.5 settings file reads as off. The
  setting is `agentConnection: { enabled, baseUrl, model }`.
- On Windows: `npm run typecheck` clean; the node suite 3,971 of 3,971 (4.5's 3,878 and 93 new);
  every Electron check: render 25, style 74 and 123, tab traversal 43, modal focus 179, field
  contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown
  62, workbench 53, MCP secrets 19, transport 24.
- For anyone running the evals: `eval:agent` takes `EVAL_AGENT_BASE_URL` (and `EVAL_AGENT_MODEL`)
  and runs every case through the agent connection, and such results record `connection`. Results
  carry claims rule 3, and `eval:diff` refuses rule 2 against rule 3 (exit 2). `npm run eval:claims
  -- --rescore <files> --write` moves an older file. Library results carry `libraryScorerRule`, and
  `npm run eval:library-rescore` moves an older file.
- For anyone building it: electron-builder 26.15.3 with `mac.notarize: true`. The workflows'
  keychain step stays, because 26.15.3 still has 24's partition-list bug. The `@electron/get` 5
  override is ESM-only and needs Node 22.12 or later (CI runs 24). `RELEASING.md` says when to drop
  it.
