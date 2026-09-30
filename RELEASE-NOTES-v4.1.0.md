# Sigma Oasis v4.1.0 — measured first: the agent's baseline, a faster turn, and answers that read the page

4.0 built the agent's next two years behind nineteen switches and could not turn one on, because
nothing had been measured. 4.1 measures first. The agent suite has its first baseline, committed,
with a gate that fails a change that loses ground; then it spends that measurement on a faster
turn, a sturdier agent, and answers about the live world that come from the page, not the snippet.
The plan is `ROADMAP-v4.1.md`; the four decisions it asked for were taken on 2026-09-29.

## Measured, before anything else

- **The first agent baseline.** `qwen3.8-9b-distill`, all 26 cases, two passes, experiments off,
  on 4.0.2's engine: **16/26 solved in both passes** (13 stable, 7 stable-fail, 6 flaky), **0 false
  claims in 52 runs**, collateral in 4, Undo clean in all. It is
  `baselines/agent-qwen3.8-9b-distill-4.0.2.json`.
- **Corrected PCIe replays taint the time, not the score** (decision 1). The link resent the
  packet; no token changed. A case during which the counter moved is scored and its time is left
  out of the medians. This is what let the baseline run on the bench that voided both 4.0 attempts.
- **`npm run eval:diff -- <baseline> <run>`** compares two results over the cases both ran and
  exits 1 when the stable set's solved rate drops or false claims, collateral or a dirty Undo
  rise; `--save` files a baseline. Works for `eval:tools` too. Timing is printed, never gated.
- **`EVAL_EXPERIMENTS=a,b`** runs the agent suite with those switches on for every case — one arm
  of an A/B against the baseline.
- **Per-round latency** in every agent result: time to first token, prefill (the server's figure,
  or TTFT as its proxy, and the record says which), prompt and cached tokens, decode tok/s.
- **An offline gate in `npm test`.** A scripted model replays three agent cases and every
  tool-choice fixture against committed results, and the tool schemas on the wire are hashed
  against `test/fixtures/wire/tool-schemas.json`: a change to what the model is sent is a diff
  someone has to mean (`UPDATE_REPLAY_SNAPSHOTS=1`).
- **The live world, as a suite.** Four live tool-choice fixtures (weather, a score, futures, a
  latest version; the suite is 28), a check that every live question carries the web tools
  whatever the ranking says and never the ledger, and `EVAL_SUITES=live` for `eval:answers`: six
  questions answered from dated loopback pages beside a planted stale ledger entry.
- **`npm run bench:latency -- <model>`**: cold and warm, turn 1 to 10, and a chat past its
  window, appended to `.latency-bench/results.jsonl`.

## The agent, measured: 16 → 19.5 of 26

The same 26 cases, two passes each, on `qwen3.8-9b-distill` at temperature 0, 2026-09-30, gated
by `eval:diff` against the baseline of the engine it ran on:

| run | solved (median) | stable set | false claims | collateral | verdict |
| --- | --- | --- | --- | --- | --- |
| 4.0.2 engine, experiments off — the baseline | 16/26 | 26/40 | 0/52 | 4/52 | — |
| 4.0.2 + digests, low-water mark, multi-read, verify round | 16/26 | 26/40 | 0/52 | 3/52 | held |
| 4.0.2 + think by phase, plan focus | 16/26 | 25/40 | 0/52 | 6/52 | **worse** |
| 4.0.2 + reviewer, notes | 16/26 | 25/40 | 1/52 | 6/52 | **worse** |
| **4.1 engine, experiments off** | **19.5/26** | **32/40** | **0/52** | **3/52** | **better** |
| 4.1 engine + digests, low-water mark, multi-read, verify round | 16.5/26 | 25/34 against 4.1's 30/34 | 0/52 | 4/52 | **worse** |

- **The engine is the gain.** 4.1's own changes — calls it could not read named to it, the stuck
  detector, the result cap and spill, parallel reads, `multi_edit`, the indentation-tolerant tier —
  took the stable-fail set from seven cases to two and the median from 16 to 19.5, with no false
  claim and less collateral. It is the baseline now: `baselines/agent-qwen3.8-9b-distill.json`
  (15 stable-pass, 2 stable-fail, 9 flaky).
- **Every experiment stays off.** The four that held on 4.0.2 lose ground on 4.1 (the stable set
  30/34 → 25/34): the engine now does part of what they did, and doing it twice costs. The rule the
  roadmap set is the rule applied — nothing is on until it holds the baseline of the engine it
  ships in. Think-by-phase with plan focus, and the reviewer with notes, lost ground on 4.0.2
  already (notes cannot show a gain in a suite that visits each folder once).
- **Latency, now recorded:** 641 rounds, time to first token 247 ms median and 5.6 s at worst,
  106 tok/s decode, the largest prompt 19,668 tokens. LM Studio reports neither its own prefill
  time nor cached tokens, so TTFT stands in for prefill and the cache is inferred, not read.
- Two passes of 26 cases is a small sample; the flaky set (9 cases on 4.1) is its noise floor, and
  `eval:diff` gates only the stable set for that reason.

## A faster turn

- **A full conversation stops re-reading itself.** Over its budget, history was cut to exactly
  what fit, so every turn dropped a message, re-summarized, and changed the summary inside the
  system prompt — the whole context prefilled again, each turn. It is cut to 65% now, and the
  next several turns leave the prefix alone. `test/promptCache.test.ts` builds consecutive turns
  with the real turn code and checks each request extends the last; with this change removed, 0 of
  7 turns kept the prefix.
- **The library lookup runs beside the search**, not after it, and the app's own search gives up
  after 3.5 s: the turn goes on, the model can still search, and a result that arrives late is
  marked *Not used* and spends nothing.
- **Reasoning streams like the answer**, one frame at a time, instead of rebuilding the
  conversation list, re-sorting the sidebar and recounting the context meter per chunk.
- **Thinking where it pays.** The checks after a reply — claim extraction and judging, the critic,
  the recompute — begin with thinking closed on Qwen3-class models. Each role has a *Thinking*
  setting in Settings → Roles: auto (as before), on, or off.
- **A steady toolbox.** When tool ranking fails, the turn keeps the last turn's tools rather than
  sending all of them; once a conversation has used the web tools they stay on the wire; the
  `Example:` lines are gone from tool descriptions.
- **Smaller costs.** Query embeddings are cached for a minute; a code block still streaming is
  highlighted in cached 40-line chunks.

## The agent

- **Tool calls it could not read are named to it.** The Hermes `<tool_call>{…}` and Qwen3-Coder
  `<function=…>` forms parse; a call that cannot be parsed is still never run, and the model is
  told which.
- **It knows when it is stuck.** Failures are counted per tool and target; at three in a row the
  result says to re-read and change approach and the next round thinks; at five the task pauses
  and says what it hit.
- **No result can fill the window.** One result is capped at 15% of the history budget, head and
  tail kept, the middle spilled and readable with `read_spill`; the timeline keeps the whole text.
  A history still over budget after fitting is cut harder rather than sent.
- **Reads run together.** Adjacent read-only calls in one round run in parallel, with budgets and
  repeat checks applied first and results in call order; the prompt asks for independent reads in
  one round. Writes, commands, helpers and questions still run one at a time.
- **Edits that survive indentation**, and `multi_edit`: several edits to one file, all or nothing,
  one review, one checkpoint.
- **`toolsByPhase`**, a new experiment, off: edit tools only after a successful read; document,
  chore and MCP tools when the task names them.

## Answers about the world

- **The subject survives the privacy trimmer.** "weather for my run in Richmond today" went out as
  "what's the weather like"; it goes out as "what's the weather like in Richmond today" now, while
  "headphones for my flight to Lagos" still keeps Lagos at home.
- **The app asks better and reads the page.** The question is rewritten without a model call —
  framing dropped, the date added to a live question, up to three queries — and providers are asked
  for recent results (SearXNG, Brave, DuckDuckGo), retried once without the filter. On a live
  question the app reads the top two pages itself, within six seconds, and hands the model their
  text; with only snippets, the model is told so.
- **Web answers cite.** Search results and fetched pages carry `[n]` numbers unique for the turn,
  shared with library passages; the reply's markers open the page, and the broken-citation and
  wrong-source checks cover them.
- **Sourced replies can be checked too** — Grounding & checks → *Check against this turn's
  sources*, off by default: the answering model checks up to six sentences with numbers, times,
  dates or names against this turn's sources, one at a time, thinking closed, within the existing
  verify budget. It costs up to six short calls.
- **Library documents know their year.** A pack can mark a document's year; the finance pack does.
  A "this year" question, or an answer from an older year, puts the web tools on the wire and names
  the year.

## Privacy

- **What leaves the machine outside the app is now said, and logged.** The agent's commands,
  hooks, `git` for worktrees and local MCP servers can reach the network without the audited
  transport. A command that obviously does — downloaders, git remotes, package installs,
  ssh/scp/rsync/nc, a non-loopback URL — is marked *Reaches the network — not in the network log*
  at approval, and once allowed is logged as an agent command with its command line. The list is a
  heuristic, and `SECURITY.md` says so.
- **Update checks are logged**: each check, download and failure leaves a row.
- **Trace export redacted tool-call arguments not at all** through 4.0. They are redacted value by
  value now, with paths on any drive, shares, `~`/`$HOME`/`%USERPROFILE%`, the home and working
  folders, `.sigma/` inbox, trash and worktree names, `sigma/` branches and phone numbers; text read
  from or written to documents is left out, its size kept.
- **`SECURITY.md` rewritten** for the product 4.0 became: the agent engine and its permission
  modes, approvals, checkpoints, `.sigma/`, chores, documents, `browse`, MCP for chat and agent, the
  Workbench sandbox, redaction, and what is logged and what is not.

## Underneath

- The test build compiles from `tsconfig.test.json` (folders, not a hand-kept list of ninety-odd
  paths): 473 files where the list built 423, none missing.
- `docs/dependencies-4.1.md`: every dependency against its latest major, the upgrade order, and
  the risks. Nothing was upgraded.

## Not in this release

- The structured plan round, the measured web trigger, library re-ranking, draft-model decoding and
  the god-file splits: 4.2.
- The speed items are built and pinned by tests, not yet timed on a model: `bench:latency` has no
  4.0.1 line to compare against yet.
- `eval:tools` was not re-run after the tool descriptions changed (the schema hash moved).
- Known gaps, documented rather than fixed: `git worktree add` runs the repository's own
  `post-checkout` hook; `.sigma/.gitignore` does not ignore `inbox/` or `trash/`; Undo checkpoints
  are plaintext copies; "latest version" questions are not treated as live by the ledger.

## Upgrade notes

- New settings: *Thinking* per role (blank = auto), *Check against this turn's sources* (off),
  `agent.experiments.toolsByPhase` (off). A 4.0 settings file reads unchanged.
- New agent tools on the wire: `multi_edit`, `read_spill`.
- Ledger entries written from snippets before 4.0.2 stay until they expire.
