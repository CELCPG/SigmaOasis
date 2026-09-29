# Roadmap: Sigma Oasis 3.1 — the agent, measured

3.0 shipped an agent that works and a mode that rests. It did not ship two things the rest of the
app has always had: a suite that says how often the agent works, and a way to buy the build. The
agent's whole record is one live run — one repository, one model, two bugs, thirteen minutes — and
every earlier feature in this app earned its default from a suite, not a run. The launch checklist
in `ROADMAP-v3.0.md` is untouched: every tag still publishes free installers to public GitHub
Releases and bumps the public Homebrew tap, and the Windows installer is unsigned.

So 3.1 measures before it adds. A small 3.0.1 ships the fixes waiting on branches and, once the
owner's accounts exist, a signed Windows installer. 3.1 builds `eval:agent` and spends it on the
agent's speed. 3.2 makes the agent a daily tool on top of those numbers. 3.3 is reach, and each of
its items waits on a decision only the owner can make.

Written 2026-09-28 against v3.0.0 (`63e7eb0`). **Status: L1 landed in v3.0.1 (tagged 2026-09-28),
with the Windows CI leg. L2 did not, so the 3.0.1 Windows installer is still unsigned. v3.1.0 was
tagged 2026-09-28 on `fcb820e` (PR #13): the agent suite (M1's `eval:agent`), M3, M4, V1–V2 and
S1–S6, and the `useLMStudio.ts` extraction. M1's baseline is still owed — both attempts stopped
on the bench GPU's PCIe errors — and M2 is built on `feat/m2-speed-candidates`, unmeasured. What
follows 3.1 is `ROADMAP-v4.0.md`, which takes 3.2's D1–D3 into its agent track.**

## What 3.0 left, and where it lands

| Item (`RELEASE-NOTES-v3.0.0.md`) | Lands | Why there |
| --- | --- | --- |
| Parallel helpers | Parked, with the measurement that reopens it | One LM Studio server queues a second request. See *Not planned*. |
| Git awareness | 3.2 (D3) | It changes what Undo means; `eval:agent` has to exist first to show it costs nothing. |
| Web tools in the CLI | 3.2 (D5), if decided | The route that does better than loopback-only touches a stated promise. |
| VIBE's wider tool-choice run | 3.1 (M3) | Owed with the next `eval:tools` pass, which 3.1 runs. |

## 3.0.1 and launch — what makes it sellable

### L1. Five fix branches main does not have

Nine commits on five branches, none of them in main (`git cherry main <branch>`), each still
checked out in a worktree under `.claude/worktrees/`:

| Branch | What it holds | Merging into main today |
| --- | --- | --- |
| `fix/orphaned-plans` | Nothing survives a restart still claiming a process that is gone | 2 conflicts |
| `fix/jobs-bundled-imports` | The job runners and the Jobs tab's watchlist load their modules in the built app; three ledger-job freshness fixes | 1 conflict |
| `fix/settings-field-contrast` | Settings fields legible in the dark theme, and a check that holds the class | clean |
| `fix/lf-checkout` | Every text file checks out LF | clean |
| `fix/test-source-crlf` | Tests that pin source across a line break read it LF on every checkout | 1 conflict |

The first two are bugs in the built app that 3.0.0 users have now. Rebase each branch on main,
rerun the suites, merge or close — none left standing — and ship the result as 3.0.1.

Two of the five exist because the suite read different bytes on a Windows checkout, and CI runs
macOS and Linux only (`ci.yml`). The CLI's Windows launcher (`sigma.cmd`) and the agent's choice
of Git Bash or `cmd.exe` run only on a Windows machine, and no CI job is one. Add `windows-latest`
to the matrix once the LF branches land.

*Gate:* the node suite and every Electron check green on macOS and Linux as today, and the node
suite green on Windows in CI.

*(v3.0.1: done. All five merged, one merge commit per branch, in PR #6 (`1b5ab3d`); none closed.
`windows-latest` joined `ci.yml`, and on it the whole suite passes, the Electron checks as well as
the node suite. The five worktrees are removed.)*

### L2. Windows signing

The release's Windows job runs `electron-builder --win --publish never` and signs nothing, so
SmartScreen warns on every download of a product that is now for sale. Two routes, both needing an
account only the owner can open:

- **Azure Trusted Signing** — Microsoft's managed signing: a monthly fee and an identity
  validation, with no key to hold. The job authenticates to Azure and signs.
- **An OV certificate** — since June 2023 a new certificate's key must live in hardware or a
  cloud HSM, so CI signs through the vendor's cloud signing tool, not a `.pfx` kept in a secret.

Either one is a `win.sign` script (electron-builder 24, the version in use, takes one) and a step
in the Windows job. The macOS job already fails on purpose when its signing secrets are missing, so
an unsigned build is never published; the Windows job gets the same rule.

*Gate:* the job runs `signtool verify /pa` on the installer and fails without a valid signature.

### L3. Where installers live — the decision the store depends on

- **(a) Keep them public.** What is sold is support, early builds and paying for the work; the
  store links to the same installers. No pipeline change, and the weakest reason to pay.
- **(b) Store-hosted installers.** The store (Lemon Squeezy or Paddle, merchant of record, as
  `ROADMAP-v3.0.md` says) hands a buyer the installers. GitHub Releases keep the source, the
  notes and the checksums. The Homebrew tap is retired or points at the store. The auto-updater
  reads a feed at a stable URL (`electron-updater`'s `generic` provider) — and because the app
  has no license gating, by the owner's 3.0 decision, that feed is readable without a key. That is
  consistent with MIT: anyone may build from source, and what the store sells is the signed,
  notarized build that updates itself. The store page should say so rather than let it be found.

Code for (b): `electron-builder.yml`'s publish provider and `release.yml`'s upload job move to the
new storage, the tap-bump job goes, and `RELEASING.md` is rewritten. Installed copies move with
one last build published the old way that carries the new feed: `electron-updater` reads the
provider from the running build, so each copy switches on its next update.

*Gate:* an installed 3.0.x updates to a test build through the new feed on all three platforms
before the first paid build ships.

### L4. The store, the page, the promise

Owner's, with code where there is code: the store account and a price (a one-time price with a
year of updates is the usual shape for a local-first desktop tool). A landing page with VIBE as the
hero, the agent's timeline as the proof of power and the privacy audit as the proof of the promise;
the page is a static build from `scripts/capture-screenshots.js` output, and its host is the
owner's choice. A support channel, and the one-line privacy statement: what the app contacts, and
that the store is the only party that learns who bought it.

## 3.1 — the agent, measured

### M1. `eval:agent`

`scripts/eval-agent.ts`, run as `LMSTUDIO_EVAL=1 npm run eval:agent -- <model-id>` so CI stays
offline, with `EVAL_PASSES` and `EVAL_CASES` as in the other suites and results and baselines in
`.eval-results/`. It runs under plain Node rather than Electron — the engine is plain Node, which
the CLI proves — driving `runAgentTask` over the CLI's loopback transport.

A case is a folder, `test/fixtures/agent/<case>/`:

- `repo/` — copied fresh into a scratch folder for every pass.
- `task.md` — the prompt, as a user would type it.
- `check/` — hidden tests, copied in only after the task ends. The agent never sees them.
- `case.json` — the kind, the files a correct solution touches, and the commands the host runs.

Twenty cases:

| Kind | Cases | What it asks | Solved when |
| --- | --- | --- | --- |
| fix | 3 | One seeded bug and a failing test | The hidden checks pass |
| chain | 3 | A second bug that surfaces only once the first is fixed (3.0's live case, as it was) | The hidden checks pass |
| feature | 3 | A small addition specified in the task | The hidden checks pass |
| refactor | 3 | A rename or an extraction across files | The hidden checks pass; behaviour pinned |
| read-only | 3 | Explain or locate, in *Read-only* | The report names the file and symbol the case lists; nothing changed |
| needs you | 3 | A task the folder cannot satisfy (a missing credential, a file outside it) | Nothing changed, no success phrase in the report, and the report names the missing thing the case lists |
| long | 2 | A fix sized to cross the history budget on a 16K window | The hidden checks pass; also M2's timing case |

Cases use Node's built-in test runner, so a case needs only Node on the PATH. The host accepts
edits (*Accept edits* mode) and runs a command only if it is the case's test runner with its
arguments and no shell operators; anything else is declined and counted. The suite never runs a
command the model made up.

Scored mechanically, from the event stream and the disk:

- **Solved** — the hidden checks pass.
- **False claim** — the report says the tests pass while the last test command's exit code was
  not 0, or no test command ran at all. The phrase list is fixed, the way the grounding checks
  match theirs. This is the number the agent's honesty rests on.
- **Collateral** — files changed outside the case's list.
- **Undo** — every checkpoint restored, then the folder compared byte for byte with a pristine copy.
- **Cost** — rounds, tool calls, wall time, prompt and completion tokens (`usage` events),
  elisions (`context_elided`).
- **End** — done, paused at the round cap, stopped or error.

Two models, three passes each at temperature 0: `qwen3.8-9b`, the suites' standing model, and
`qwen3.8-35b-a3b-distill`, 3.0's live run.

*Gate:* the suite runs, both baselines are committed, and `docs/agent.md`'s *Measured* and
`docs/evals.md` print its table, stable set and flaky set named, in place of the single run. There
is no pass mark for 3.1 itself: the baseline is the deliverable. From then on every agent change
is judged against it — solved may not fall outside the stable set's noise, and false claims and
collateral may not rise on the stable set at all.

*(Built and shipped in 3.1.0: the suite, its twenty cases each proven to fail untouched and pass
with a reference fix, and its scoring rules pinned in `test/agentEval.test.ts` — `docs/evals.md`,
"The agent, measured". Each run also records its longest single round, which M2's cap needs.
**Owed: both baselines.** The 9B's first attempt, 2026-09-28, stopped on the bench machine: its
GPU's PCIe link began reporting corrected errors under load, thousands a minute, LM Studio died
mid-case, and a second attempt brought the errors straight back — so nothing from either is
reported. It found one rule missing: a reply cut off mid-stream arrives as a bare `terminated`,
which the exclusion rule now knows. The baselines run once the machine is sound; the 35B's was
already deferred by the owner.)*

### M2. Speed, where the suite says it is

Most of 3.0's thirteen minutes was the model thinking before each call. Three changes to try, each
shipped only if M1's median wall time per solved task falls while solved, false claims and
collateral hold:

1. **Context fitting that keeps the cache.** `fitContext` (`src/main/agent/context.ts`) elides the
   oldest tool result, one at a time, until the history is just under budget. The next round's
   output pushes it over again, and the next-oldest result goes. Each elision rewrites a message
   near the start of the history, and a local server reuses its KV cache only up to the first
   token that changed — the rule `lib/grounding.ts` and `lib/toolSelection.ts` already design the
   chat around. So once a task crosses the budget, every round may reprocess nearly the whole
   history. The fix is a low-water mark: when over, elide down to about 70% of the budget, so the
   history's start changes once every several rounds instead of every round. Measured as
   prompt-processing time per round on M1's two long cases, before and after.
2. **A lower cap on one round's generation.** `DEFAULT_ROUND_MAX_TOKENS` is 16,384 when the slot
   sets none, with the thinking-channel recovery taking over at the cap. Try 8K and 4K. The risk
   is exactly what M1 measures: a cap that cuts reasoning the model needed shows as a lower solve
   rate.
3. **Fewer rounds spent reading.** `read_file` takes one path, and a first round of exploration
   often wants three. Letting it take several, each windowed as today, changes only the agent's
   own schema — the chat's pinned tool hash does not move. Measured as rounds per solved task.

*(Built, not shipped: candidates 1 and 3 — `LOW_WATER` at 70% in `fitContext`, and `read_file`'s
`more_paths` for up to three more files — each with its tests, on the branch
`feat/m2-speed-candidates`. Their gate is M1's baseline, so they wait for it. Candidate 2 waits for
the same run: each run now records its longest round, so the baseline itself says whether any round
comes near 8K or 4K, and a cap nothing reaches changes nothing.)*

### M3. VIBE's tool-choice run

`eval:tools` gains a VIBE arm: the same fixtures with VIBE's system-prompt line in place,
`EVAL_PASSES=3`, both models, beside the arm without it. 3.0's figure (7 in 8, on the one
what-time-is-it question) becomes a suite's.

*Gate:* correct-tool and spurious-call rates within the no-VIBE arm's noise floor. If they are
not, the placement is revisited. The result goes in `docs/evals.md` either way.

*(Built: `EVAL_VIBE=1`, its results kept out of the model picker's score. On qwen3.8-9b-distill the
gate failed on the 3.0 line and passes on its replacement. With no flaky fixture in either arm,
one fixture moved: "remember that my favorite band is Phish" called `memory_save` 0 times in 3
with VIBE on, 3 in 3 without — and the reply said "I've saved that". The placement stayed; the
wording changed, to a line that says it shapes only the final reply and that tools work as always,
and with it the VIBE arm matches the arm without VIBE fixture for fixture (21 of 24 on every pass,
54/63 correct, 0/9 spurious), with replies still in short prose. `docs/evals.md`, "VIBE's
tool-choice arm". Owed: the 35B-A3B arm — an hour or more of the server that `eval:agent`'s
baselines also need.)*

### M4. The main process, now that tasks live in it

Since 3.0 an agent task runs in the main process: its stream, its stall timer, its approvals. Two
things still do heavy synchronous work there. `src/main/ipc/pdf.ts` inflates up to 40 MB of
streams with `zlib`'s synchronous calls, and `render.ts` opens a window per page. v2.4 left both
"for the release that measures them"; a running agent is the reason to measure. Record main-loop
delay (`perf_hooks.monitorEventLoopDelay`) while a task streams and a large PDF is attached or a
pack folder re-indexes. If the p99 is over 100 ms, extraction moves to a `worker_threads` worker
and the render window is pooled, both specified since v1.4.7.

*Gate:* the delay, before and after, printed with the change; the node suite.

*(Built. `npm run bench:main-loop` runs inside Electron's own main process with a stream held
open from a stand-in server in another process, and drives the app's code at its caps. On the
bench machine (Electron 44, Windows):*

| phase | loop delay p99 before | after | the stream's longest gap before | after |
| --- | --- | --- | --- | --- |
| the stream alone | 16.5 ms | 16.4–16.6 ms | 32 ms | 32–33 ms |
| a PDF at the caps (40 MB inflated), three times | **320 ms** | **19–20 ms** | **355 ms** | **32–33 ms** |
| a folder pack at 8M characters, then the first lookup | 23 ms | 18–20 ms | 102 ms | 95–107 ms |
| five pages rendered | 22 ms | 21–23 ms | 37 ms | 35 ms |

*Only PDF extraction crossed 100 ms, so only it moved: `extractPdfText` runs unchanged in a
`worker_threads` worker (`pdfOffThread.ts`, `pdfWorker.ts`, a second main-process entry), for
attachments, folder packs and fetched PDFs alike; a worker is measured to load from inside the
asar. The render window is not pooled: five windows cost the loop 22 ms at p99, which is nothing
to buy back. The nearest to the line is the folder pack's single worst stall, 88–99 ms at its
maximum — the first lookup building the BM25 index over 8M characters in one pass; under the
p99 rule it stays, and it is the next thing to move if a library outgrows the cap.
`docs/measuring-main-loop.md`.)*

## 3.1 — VIBE, polished and quick

Added 2026-09-28 at the owner's request, after a VIBE session on the bench machine (an RTX 5070,
12 GB) where "hello" took 24–60 s to its first word and "how many cm is 6 foot 3" took eleven
minutes. The session's own records say where the time went — the stats each reply saves, LM
Studio's server log, and the conversation export — and most of it was not VIBE. **Status: V1, V2
and S1–S3 shipped in #8; S5 and S6 are built on `feat/speed-s4-s6`; S4 is measured and needs nothing.**

Where the time went, in the order it costs:

| Cause | Measured | Whose |
| --- | --- | --- |
| Models that do not fit the card | `prism-ml/bonsai-27b` is a 1-bit quant (Q1_0) loaded at a 262,144-token window: 2,378 prompt tokens read at about 40 a second, replies at 3–6 tokens a second. The 35B-A3B's weights are 21.7 GB on a 12 GB card. The same 2,010-token VIBE prompt on `qwen3.8-9b-distill`, resident on the card (7.9 GB with a 68K window) and read from scratch with nothing cached, answered "hello" in **1.1 s**. | The owner's setup |
| Thinking before trivial answers | "6 foot 3 in cm": 3,795 tokens of thinking, 540 s, then one sentence. "yo whats up?": 2.2 s of thinking on a 9B. | S3 |
| The prompt re-read from the top each turn | LM Studio's log: within a turn the next round resumes at 95.5% of the prompt in a second; across turns it starts at 0% and takes 20–60 s | S1, S5 (S4 ruled out the checks) |
| Loading after Enter | "hello" on a 27B (2026-09-14): 14 s before the request went out, then 60 s to the first token — the shape of models loading on demand, though that turn's log does not say so | S2 |
| Two clients on one server | A 35B reply stalled for 60 s while an agent run started on the same server, which was restarted mid-session | Nobody's code — one LM Studio queues |

### V1. The composer's focus box — built

The app-wide focus ring (`textarea:focus-visible`, `index.css`) outranks `.vibe-input`'s own
`outline: none`, and Chromium counts a text field as focus-visible after a mouse click and after
the focus the composer takes by itself. So every VIBE session drew a 2px accent rectangle inside
the rounded glass. Measured in the built renderer with a real click into the field: `outline: solid
2px rgb(79, 255, 209)` before, `none` after. The pill's own `:focus-within` glow is the focus
indicator, for keyboard and mouse alike. The full view's composer draws the same ring on a click,
for the same reason; it is unchanged here, and the same one-line rule fixes it if the owner wants
it gone there too.

### V2. The thinking orb — built

The 12-pixel breathing dot is replaced, in the same place and with the same `role="status"` and
"Thinking" label, by a geodesic sphere of light: an icosahedron subdivided once (42 points, 120
edges) turning on two axes, its surface rippling on a travelling wave, a tilted ring round it
carrying a comet spark, cyan into violet, breathing on the lagoon's 4.8 s. It is a 2D canvas, not a
second WebGL context beside the lagoon's; a 144-pixel canvas of short lines costs nothing a GPU
notices. Under reduced motion it is one still frame and its halo holds still. It says that
something is happening, never what: naming the tool is the noise VIBE removes.

`lib/vibeOrb.ts` is the motion, pure and deterministic in time (`test/vibeOrb.test.ts`: the mesh,
the bounds, the breath's period); `components/vibe/VibeOrb.tsx` only draws it.

### S1. A coin-flip ranking no longer moves the toolbox — built

v1.4.5 wrote the rule — "an indecisive ranking must not be allowed to move anything" — and
implemented it only for a conversation's first turn. With an incumbent, the indecisive branch
called the same function as the decisive one, which takes the new selection whenever the old one
does not cover it. Replayed with nomic-embed-text-v1.5 against the 20-tool Assistant slot: "yo
whats up?" then "just testing out your new vibe mode and its super cool", both indecisive, and the
second swapped `list_directory` for `reference_lookup`. Tools render inside the system block, so
the swap cost the conversation's whole prompt cache — that turn's 27 s re-read in the server log.
`holdTurnTools` keeps the incumbent outright when the ranking is indecisive; replayed after the
fix, the list holds across all three small-talk turns.

### S2. The model loads while the reader types — built

A message's first keystroke, in either composer, and arriving in VIBE, pin the composer's model
(`hooks/warmModel.ts`). The pin is one promise per server and model (`modelPin.ts`), so the turn's
own pin finds the load finished or joins it in flight: a cold load overlaps the typing instead of
following Enter. At most once per model per 15 s; on a resident model it costs one loopback GET.

### S3. A greeting is answered without thinking first — built, measured

When the whole message is small talk — greetings, thanks, "what's up", a name, an emoji; no digit,
no question behind the greeting, and not "ok" or "sounds good", which are go-aheads — the first
round begins with thinking already closed (`shared/thinking.ts`), the lever measured for this job
in v1.4.1 where `enable_thinking`, `/no_think` and `reasoning_effort` were inert. It rides the first
round only, and tools stay on the wire. Only on the `<think>`-delimited families the closed block
is measured on (`THINK_TAG_MODELS`); `bonsai-27b` is outside them and still thinks.

Measured on `qwen3.8-9b-distill` with the app's own VIBE system prompt and six tools (2,010 prompt
tokens), two passes each, temperature 0.3:

| Message | First word, thinking | First word, quick | Reply |
| --- | --- | --- | --- |
| hello | 0.64–0.85 s | 0.13 s | Identical: "Hello! How can I help you today?" |
| yo whats up? | 0.60–2.43 s | 0.14–0.21 s | Same register, shorter |
| thanks! | 1.79–2.08 s | 0.21 s | Same |

*Gate for release:* the VIBE arm of `eval:tools` (M3) with S3 on. A greeting is never a tool
question, but that arm is where it would show. *(Met on the 9B: none of the suite's 24 prompts is
small talk, so S3 cannot move it, and the arm matches the arm without VIBE — see M3.)*

### S4. The post-answer checks do not evict the conversation — measured, nothing to build

The worry: after "6 foot 3" was answered, a recompute check sent its own request to the same 27B,
and if LM Studio serves both from one cache slot, every checked turn would leave the next to re-read
the conversation from the top.

Measured 2026-09-28 on `qwen3.8-9b-distill` (32K window), three passes, loaded with one cache slot
(`lms load --parallel 1`) and then two: a conversation of about 4,300 tokens, its next turn sent
with nothing between, and — in a fresh conversation each time — the same with a recompute-shaped
check on the same model between the two turns. The server log holds the run's 30 requests and no
others.

| Next turn's first token | 1 slot | 2 slots |
| --- | --- | --- |
| Nothing between | 204 ms | 206 ms |
| A check between | 287 ms | 281 ms |
| The same prompt read from scratch | 1,573–1,617 ms | 1,599–1,600 ms |

LM Studio's engine keeps earlier prompts and restores them, so a check costs the next turn about
80 ms, not a re-read, with one slot as with two. Nothing is built: the fix sketched here — the
checks sent with the conversation's prefix, or the prefix re-primed after them — would buy those
80 ms. The cross-turn re-reads in the owner's log were the toolbox moving (S1, S5). Not measured:
a window so large that the stored prompt may not fit the server's cache, the 262K case — which S6
names when it costs the reader anything.

### S5. Small talk never moves the toolbox — built

`MIN_RANK_SPREAD` (0.07) is a property of the scores, not of the words, and it calls some greetings
decisive. Measured 2026-09-28 against the owner's 20-tool Assistant slot with nomic-embed-text-v1.5:
3 of 25 everyday pleasantries cleared it — "thanks!" and "thank you" reaching for
`reference_lookup`, "lol" for `memory_search` — and each could swap a tool and spend the
conversation's prompt cache. `rankingMayMove` now requires a decisive ranking *and* words that are
not small talk (S3's classifier), so a greeting keeps the incumbent.

The roadmap asked `eval:tools` to decide, and it cannot see the change: none of the 268 user
prompts across the 156 fixture files in `test/fixtures` (tool choice, answers, multi-turn and the
rest) is small talk, so every suite's input takes the same path as before. The other option — the
spread read without the always-on tools — would change decisiveness on every turn, and is not
taken.

### S6. Say when the model does not fit — built

A reply that waited at least 8 s for its first word, having read its prompt at under 150 tokens a
second, says so under its stats line — shown with the stats off too, since it answers "why is this
slow" — and says what usually fixes it: a smaller model or quant, full GPU offload, or a shorter
context window, naming the loaded window when it is 131,072 or more. It also says the other thing
a long wait can be: LM Studio busy with another client's request. VIBE draws no stats, so the same
sentence stands beside the slot in Settings → Models, from the model's most recent reply only — a
model reloaded well since loses its verdict with its next measured reply.

The floor, from the bench's own replies: every slow one read at 33–86 tokens a second (the 27B,
bonsai at a 262K window, a 9B partly on the CPU); the 9B on the card, about 2,000. Only a long
wait is judged, because a cached prompt is read in a blink by any model, and a partly cached one
overstates the rate — which can hide a slow model but never accuse a fast one.
`lib/modelFit.ts`; `test/modelFit.test.ts` holds all five measured slow replies and the fast one.

### What the owner can change today

- **Settings → Models → Assistant** still names `_disabled-qwen3.8-9b`, which LM Studio no longer
  has. `qwen3.8-9b-distill` is installed and fits the card with room for a 68K window.
- In LM Studio, load the 27B and the 35B-A3B at 16–32K rather than 262K, and keep them for the
  agent, where a long wait is expected. `bonsai-27b`'s 1-bit quant is slow on this card whatever
  its window.
- `eval:agent` and a chat share one server: a run in progress holds the chat's replies.

## 3.2 — the agent as a daily tool

### D1. Hooks

A project's `.sigma/hooks.json` names commands for three moments: after an edit lands (a
formatter, a linter), before a command runs (a non-zero exit declines it and says why), and when a
task ends (the tests). A hook is a command, so it lives under the rule every command does: the
first run asks, *Always allow* grants that exact command in that exact folder, and nothing runs
unasked. That matters more for hooks than for anything else, because a hooks file in a repository
someone else wrote is someone else's command. `SIGMA.md` is instructions and never permission;
`hooks.json` is held the same way. A hook's output is a line on the timeline, and an after-edit
hook's failure is handed to the model, so a lint error becomes the next round's input rather than
the user's discovery. The CLI reads the same file and asks the same questions.

*Gate:* engine tests that a changed hook command asks again, and M1's fix cases with a formatter
hook on: solved within noise.

### D2. Custom slash commands

A markdown file in `.sigma/commands/` (the project's) or in the app's data folder (the user's)
becomes `/name` in the app's composer and in a `sigma` session, with `$ARGUMENTS` taking what
follows. It is text that becomes the prompt: no permission of its own, and nothing runs that the
prompt would not have run. It is not a skill: a skill is a method the app selects for a turn
(`docs/skill-format.md`); a command is a shortcut the user types. The CLI's own `/mode`, `/model`,
`/undo`, `/clear` and `/help` cannot be shadowed.

*Gate:* the render suite for the composer's command menu; `test/cli.test.ts` for the session.

### D3. Git awareness — opt-in, and done by the app

In a folder that is a git repository, a task may run in its own worktree on its own branch,
`sigma/<slug>`, made from the current commit, with each landed edit committed there under the
step's line on the timeline. A worktree rather than a checkout: the user's own working tree never
moves under their editor, and two background tasks on the same repository stop sharing one folder.
Today nothing prevents that: 3.0 refuses a second task in the same conversation
(`src/main/ipc/agent.ts`), not a second task in the same folder. The app does the git. It is not a tool the model is handed, and it never
pushes, never moves another branch and never runs a command on the destructive list. When the task
ends, the branch is the user's to merge. Undo means what it means today — every file back, except
one changed since, which is named and left alone — and on a branch nothing else has touched it
also removes the worktree and the branch.

A fresh worktree has none of the ignored files: no `node_modules`, no virtualenv. The first
version links nothing and says so on the timeline; a task-start hook (D1) or a line in `SIGMA.md`
runs the install.

*Gate:* engine tests that the user's branch and working tree are byte-identical before and after
a task, that nothing is pushed, and that Undo matches Undo without git; M1 with git on, solved
within noise.

### D4. A VS Code extension

`sigma --json` already prints one event per line. What it lacks is a way to answer an approval
without a terminal: today a run with none declines edits and commands. Add `--approvals=stdio`,
which writes each approval request as a JSON line and reads the answer as one. The extension
spawns `sigma` through the launcher Settings → Agent installs, draws the timeline in a panel,
opens proposed edits in VS Code's own diff editor and commands in a modal with the same three
answers. It holds no model code and no settings of its own. Publishing it to the Marketplace is the
owner's call.

*Gate:* `test/cli.test.ts` gains the stdio approval protocol; the extension's own integration test.

### D5. Web and MCP tools in the CLI, through the app — a decision first

3.0 kept the CLI on loopback "until it can do better". Doing better means the CLI's web and MCP
calls go through the running app — the egress allowlist, the activity log, the proxy — and do not
exist when the app is not running. That needs a channel into the app: a named pipe on Windows, a
Unix socket elsewhere, owned by the user and refusing anyone else. It is not a network port, but
it is a listener, and `STRATEGY-openclaw-adoptions.md` says the app opens **no listening port** and
owns **no inbound surface**. Either the promise is restated precisely — no network port; one
user-only local socket, present only while the CLI is installed, named in the privacy audit — and
this is built, or the CLI stays loopback-only and the item closes. Nothing is built before the
decision.

## 3.3 — reach

Each of these reverses or restates something already decided, so each starts with the owner.

### R1. VIBE with voice

Most of it exists: dictation through whisper.cpp (`src/main/ipc/voice.ts`, found when the user has
installed it) and read-aloud through the system's voices (`lib/voice.ts`). VIBE with voice is
push-to-talk in VIBE's one composer and replies read as they surface, with the lagoon's breath
following the voice. It reverses a 3.0 decision — VIBE was set as visuals only, no sound. A second
decision rides with it: whether whisper.cpp and a model ship in the installer, adding tens of
megabytes, or stay the user's install as today.

*Gate:* the privacy audit gains a microphone row; every voice VIBE offers reports `localService`;
the activity log over a voice session shows no new host; VIBE's render and reduced-motion checks.

### R2. Resident mode

Background tasks (3.0) and standing questions (v2.6) stop when the app quits. A resident mode — a
tray or menu-bar icon, the window closes and the main process stays, and quitting is explicit —
lets both finish. v2.6 deferred it as "a later, separate decision", and it changes a stated
property: the app runs **nothing while it is closed**. If built: off by default, a row in the
privacy audit, the icon always showing while resident, and no new network access or listener.

*Gate:* the jobs and agent tests with no window open; the audit row; `docs/jobs.md` updated.

## Debt alongside

- **`useLMStudio.ts` is 1,659 lines**, 202 more than at v2.4, which set a 500-line target and left
  the verification tail's extraction for later. Do it in 3.1, the way the loop itself was
  extracted: no behaviour change, the node suite as the gate, tests landing beside each piece.
- `library.ts` (1,690 lines) and `search.ts` (1,536) — split along their seams when next touched,
  not as a project of their own.
- Once L1 lands, remove the five worktrees and delete the branches already merged into main:
  `claude/charming-germain-9469f6`, `claude/serene-ardinghelli-33ee87`,
  `claude/upbeat-fermat-847b70`, `claude/xenodochial-einstein-1189e7`, `feat/mcp-env-keychain`,
  `fix/linux-modal-focus`, `release/v3.0.0` and `worktree-agent-a88dae82b61150a0a`.
  *(Done with 3.0.1: the worktrees are removed, and every branch merged into main is deleted,
  locally and on GitHub.)*

## Decisions for the owner

1. Where installers live: public, or store-hosted with an update feed that needs no key (L3).
2. The Windows signing route, and the account behind it (L2).
3. The store, the price, the landing page's host, the support channel (L4).
4. Whether the CLI may reach the app over a user-only local socket (D5).
5. Whether VIBE gets sound, and whether whisper.cpp ships in the installer (R1).
6. Whether a resident mode exists at all (R2).

## Sequencing

| Release | Contents | User-visible claim | Gate |
| --- | --- | --- | --- |
| **3.0.1** | L1; L2 if the account is ready; Windows in CI — **landed: L1 and Windows in CI; not L2** | The restart and ledger-job fixes; a signed Windows installer | Suites green on macOS and Linux, node suite on Windows; `signtool verify` in the job |
| **Launch** | L3, L4 | A build you can buy | An installed copy updates through the new feed on three platforms |
| **3.1 — the agent, measured** | M1–M4, `useLMStudio.ts` | How often the agent solves a task, on a 9B and a 35B-A3B, whatever the numbers are; long tasks faster | `eval:agent` baselines committed; the VIBE arm of `eval:tools` |
| **3.1 — VIBE, polished and quick** | V1–V2, S1–S6 — **built: V1, V2, S1–S3, S5, S6; S4 measured, nothing to build** | No box in VIBE's composer; an orb while it thinks; a greeting answered in a fifth of a second on a model that fits the card | The node suite; S3 in the VIBE arm of `eval:tools`; S4's measurement (a check costs the next turn 80 ms) |
| **3.2 — a daily tool** | D1–D4; D5 if decided | Hooks, commands, a branch per task, VS Code | `eval:agent` within noise with each one on |
| **3.3 — reach** | R1, R2, as decided | Talk to VIBE; tasks that outlive the window | The privacy audit's new rows; no new host in the activity log |

L1 comes first because two of its branches fix bugs 3.0.0 users have now. M1 comes before M2
because a speed change with no solve rate beside it is a guess, and before all of 3.2 because D1–D3
each change what the agent does on every task.

## Measuring it

The standing rules: temperature 0, three passes, the stable set judged and the flaky set reported,
no model grading a model, `.eval-results` baselines committed and diffed. A feature whose suite
shows a null result ships off, with the result in `docs/evals.md`. One new suite is owed
(`eval:agent`) and one new arm (VIBE in `eval:tools`).

## Not planned

| Idea | Why not |
| --- | --- |
| Parallel helpers | One LM Studio server serving one model queues a second request. Reopen when two concurrent requests on the bench machine give clearly more total tokens per second than one — a measurement of minutes, worth repeating with each LM Studio release. |
| Interpreter allowlists | Still a pattern match; grants stay byte-exact. |
| MCP over HTTP, resources, prompts | No measured need since v2.5. |
| License keys or paywalls in the app | The owner's 3.0 decision: the code stays MIT, and the build is what is sold. |
| A second model provider; cloud sync, accounts, telemetry | Rejected before, for the reasons given then. |
| Training in the app | Closed as designed in v2.8. |
