# Sigma Oasis v4.5.0 — plans that answer on a thinking model, a mark on a claim no test backs, and a new card under the 9B

4.4 put a control beside every measurement and turned on what beat it. 4.5 takes up what 4.4 saw
and left. Plan mode and the outline asked a thinking model for JSON under a grammar, and the model
thought first — the outline, on the 9B, for its whole budget; they now ask it plainly. An agent
report that says the tests pass when the task shows no passing run is marked — the eval's own rule,
now read clause by clause, which also corrects 4.4's false-claim numbers. The catalog reads a
llama.cpp server as well as LM Studio. And under all of it the machine changed: the RTX 5070 is
gone, and the 9B runs on an Intel Arc Pro B65, measured here before anything was decided on it.
Gemma 4 26B-A4B had a first look as an agent, and the library's two model aids were measured on
a suite built for them; none of it changes a default. 4.5.0 follows 4.4.0 and is built on it. The plan and its status are `ROADMAP-v4.5.md`.

## What you will notice

- **The outline works on Qwen 3 and the other `<think>` models.** With *Outline long documents
  first* on (Settings → Grounding & checks; off by default), a document-shaped request is first
  asked for a JSON outline of its sections. Under the grammar a `<think>` model thought anyway:
  the 9B distill spent all 1,500 of the outline's tokens thinking in 8 requests of 12, and wrote a
  usable outline in 3 — the other nine ended in an error instead of a document, after half a
  minute. Asked plainly with the think block closed (4.4's fix for re-rank), it writes **12 of 12,
  in 7.7 s against 31.9 s** (median).
- **Plan mode answers sooner on the same models.** On the 9B, valid 12 of 12 either way, and the
  plan arrives in **8.8 s instead of 14.0 s** (median): the grammar no longer buys about six seconds of
  thinking before the first step. Every other model — Gemma 4 among them — is sent 4.4's request
  byte for byte.
- **A report that claims a pass no test backs is marked.** When the agent's final report says the
  tests pass and the task shows no passing run — no command ran, or the last one exited with an
  error or did not finish — a line appears under the answer in warning ink: *Says the tests pass —
  no passing test run in this task (no command ran)*. The report is the model's, word for word;
  nothing is asked of the model and no round is added (4.3's verify round asked, and measured no
  better). The mark is kept with the saved conversation and printed by `sigma` (and in `--json`'s
  `final` line). It reads the clause, not the word: "Run `npm test` to verify the change", "the
  test passes `' ada LOVELACE '` to the function" and "I will make the tests pass" are not claims;
  "All three test cases now pass:" with nothing run is. On every recorded run, each of its 7 marks
  is a report that says the tests pass.
- **A llama.cpp server is read properly.** Pointed at `llama-server` instead of LM Studio, the
  catalog had model ids and nothing else, so the app could not tell a vision model from a text one
  or budget the history against the model's window. It now reads the server's `/v1/models` and
  `/props`: vision, the loaded and the training window, the quantization. The text-only warning
  names the server that described the model, and a llama-server model shows no Load/Unload (they
  post to LM Studio endpoints llama-server does not have). LM Studio is read exactly as before —
  one request, the same entries.
- **electron-updater 6.8.9 → 6.8.10,** a patch inside the range: fixes for stale blockmaps in the
  differential download, the part of an update that fetches only the blocks that changed
  (electron-builder #10097). The same dependencies, no advisory.

## The planners, measured

`npm run probe:planners` asks each planner twelve realistic prompts as the app sends them (a
`json_schema` grammar beside `thinking: false`) and plainly (the closed-think prefill, the JSON
shape said in the prompt), interleaved, through the production callers and their own readers.
`qwen3.8-9b-distill`, LM Studio on the Arc Pro B65, 2026-10-03 (`docs/evals/planners.md`):

| planner | grammar: valid · median | plain: valid · median | |
| --- | --- | --- | --- |
| plan mode | 12/12 · 14.0 s | 12/12 · **8.8 s** | **plain** on a `<think>` model |
| the outline (1,500 tokens) | **3/12** · 31.9 s | **12/12** · **7.7 s** | **plain** on a `<think>` model |
| deep research's planner | 12/12 · 5.3 s | 12/12 · 4.4 s (23/24 over two passes) | grammar stays |
| its query reformulation | 11/12 · 9.0 s | 9/12 · 3.5 s | grammar stays |

Every grammar call thought first, 48 of 48. Applied where plain was no worse on validity and
faster; a golden test pins every other family's request to the bytes 4.4 sent.

## Measured

### The 9B on a new card

On 2026-10-02 the RTX 5070 left the machine. The 9B (`qwen3.8-9b-distill`, Q4_K_M, 68,608-token
context, LM Studio over Vulkan) now runs on an Intel Arc Pro B65, and every 4.4 number, the
committed baselines among them, was taken on the 5070. Re-measured on 2026-10-03, the 4.4.0
engine, temperature 0:

| | Arc Pro B65 | RTX 5070 |
| --- | --- | --- |
| tool choice, the app's subset — clean of 28, four runs | **26, 26, 26, 26** | 25, 24, 25, 25 |
| agent — solved of 26 | 20, 17 (two passes, mean 18.50) | 18.25 (eight passes, 14–21) |
| agent — false claims | 0 in 52 runs | 1 in 312 (below) |
| decode (the latency bench's median) | 42 tok/s | 95.5 tok/s |
| turn 10 of a growing chat, first token | 0.80 s | 0.26 s |
| a full window (65,516 tokens), first token | **261 s** | 26.8 s |
| past the window, the next turn with the low-water trim | 3.0 s | 0.70 s |
| a whole agent pass, case time | 2,589–2,940 s | 973 s |

- **Speed.** Decode is under half the 5070's and prefill is the card's weak side: about 3,900
  tok/s at 3,000 tokens, 251 at a full window (the 5070 read the window at about 2,440). Short
  chats stay under a second. A full window's first token takes 261 s; the chat waits 300 s for a
  first byte, so it clears by 39 s, and the agent's 360 s by 99 s. Past the window, 4.1's low-water
  trim is what keeps a long chat usable: 3.0 s a turn, against 262 s re-reading the window.
- **Tool choice.** The same two fixtures fail every pass — `22-price-near-miss` (calls
  `web_search` to the iteration cap, the one loop) and `27-live-futures` — and it passes two the
  5070's file never did. Against the 5070's file it reads BETTER on clean (+1.25, ±0.71) and WORSE on loops
  (0 → 1): the cards differ on one fixture; the code did not move. Saved as
  `baselines/toolchoice-qwen3.8-9b-distill-subset-ontop-filefirst-b65.json`.
- **The agent.** 20 and 17 of 26, +0.25 on the 5070's mean, well inside the ±3.94 band two passes
  would be held to; `eval:diff` answers TOO-FEW-PASSES. Nothing here says the B65 solves fewer.
  No agent baseline is saved for it: the rule wants four passes.
- **Determinism.** Greedy decoding on the B65 does not make the agent repeatable: 23 of 26 cases
  kept their verdict and the 3 that changed all went from solved to not; rounds were equal in 12
  of 26, the final text in 7. A round whose hidden reasoning differs by a few tokens changes the
  next prompt, and the runs part within a round or two. Tool choice nearly is: 27 of 28 fixtures
  made the same calls in all four passes, and no score moved. So the four-pass rule stands on the
  new card.
- **Found, not fixed:** `feature-top-words` ran past 7.5 and 9 minutes when it came straight after
  `feature-stack-peek` in one eval chunk, and finished in 100 s and 315 s alone (the 5070: 22–353
  s). The cause is not known; the harness runs it alone.

### The claims rule, and 4.4's numbers corrected

4.4 reported that the 35B-A3B says the tests pass without running them — 3 in 99 runs — and the 9B
never, in 312. Building the mark, the eleven recorded false claims were read clause by clause:
**six were not claims** — a plan, an instruction ("Run `npm test` to verify…"), a description of
code ("passes the name") — and the 9B's one real claim had hidden behind a long code span. The rule
now reads tense, mood and subject (claims rule 2): on 451 labelled sentences it finds 248 claims
with **0 false marks and 0 missed** (4.4's: 243, 6 false, 5 missed); over 1,058 recorded reports 9
verdicts flip — the 6 wrong ones off, 3 real ones on (`docs/evals/claims.md`).

| false claims | 4.4.0's notes | rule 2 |
| --- | --- | --- |
| 35B-A3B, its baseline (99 runs) | 3 | **1** — `chain-slugify`, "All three test cases now pass:", no command ran |
| 9B, its baseline and 4.4's control (312 runs) | 0 | **1** — `long-discount-rules`, no command ran, nothing disclosed |
| 9B, on the 25 cases the 35B's baseline covers (300) | 0 | 0 |

One against one is no difference between the models at these sizes, and the mark covers any model
that does it. The verdicts that move:

- **Two of 4.3's arms lose their only WORSE** — digests, low-water mark, multi-read and the verify
  round together, and the plan round. Each rested on one false claim, and each was a misreading:
  both are SAME-WITHIN-NOISE now. Neither has a BETTER, so both stay off. 4.3's reviewer + notes
  keeps its WORSE (three real claims).
- **4.4's agent tool phases (`toolsByPhase`) now read BETTER against their control, on false claims
  alone:** the control held the 9B's real one, which 4.4's reader missed. Solved did not move
  (−0.25, ±3.83), and it stays off, as 4.4 decided on solved. `eval:diff` now says so beside any
  BETTER that rests only on a fall in false claims.
- **One rule on both sides of the gate.** A results file carries `claimsRule`; `eval:diff` refuses
  to compare, merge or join files scored under different rules (exit 2, naming the command that
  moves the older). The committed baselines are migrated; the B65's two agent passes too — 0 flags
  moved.

### A library suite for the ranking aids

Re-rank and the sample answer apply only to a question inside the stakes domains (health, first
aid, finance, building), and 4.4 measured them on a library suite where 5 questions of 28 were.
`EVAL_SUITES=library-aids` is 27 questions, every one inside those domains, over three packs of
its own written so the right passage is often not first: plain ranking puts the source first in
9 of 27, second to fifth in 16, outside the five in 2 — and all 27 inside the re-rank's pool of 15,
so an aid has something to move. `EVAL_RETRIEVAL_ONLY=1` checks that without a model.

## Gemma 4 26B-A4B, a first look

Gemma 4 26B-A4B runs on the B65 beside the 9B, served by llama.cpp's `llama-server` (build
b11026, a 65,536-token window, one request at a time). A first look on 2026-10-03, the 4.5 engine,
temperature 0, not a baseline: tool choice four passes; the agent one pass, stopped by time after
11 of its 26 cases, so it compares case by case and not as a total.

| | Gemma 4 26B-A4B, B65 | 9B, B65 | 35B-A3B, B60 (4.4's baseline) |
| --- | --- | --- | --- |
| tool choice, the app's subset — clean of 28 | 26, 27, 26, 26 | 26, 26, 26, 26 | — |
| — loops | 0 | 1 a pass (`22-price-near-miss`) | — |
| agent, on the 11 cases Gemma ran — solved | 9 | 11 and 10 (two passes) | 10 (most of four passes) |
| — false claims | 0 | 0 in 22 runs | 1 in 44 (`chain-slugify`) |
| — time for the 11 | **5,406 s** | 693 s and 1,228 s | about 360 s |
| — rounds a case | 9–41 | 4–18 and 4–37 | 3–13 (medians) |

- **Tool choice: as good as the 9B.** The right tool in 24 of 25 or better every pass (the 9B: 23),
  no spurious call, no invalid argument, and no loop where the 9B loops every pass. It misses
  `27-live-futures` as the 9B does (`market_data` for `web_search`), in two passes of four; the
  rest of what it lost — `19-no-tool-email` every pass, `27` once — the server refused (below).
  439 s a pass against 370.
- **The agent: right, and slow.** 9 of 11 solved (`feature-top-words` on a rerun, after the
  server's error), no false claim under rule 2, and `fix-parse-duration` solved, which the 35B did
  not solve in four passes. Not solved: `long-log-pipeline` (41 rounds and 31 minutes, stopped at the
  round cap, two debug scripts left behind) and `needs-you-deploy-token`. But the 11 took 4–8 times
  the 9B's time on the same card and about 15 times the 35B's. Decode is the 9B's (41–48 tok/s, the
  first token in about half a second); the cost is tokens per round. In 4 of the 11 runs a round
  ran to the 16,384-token cap, about 350 s, repeating itself. The eval sends only `temperature: 0`,
  and the server's defaults leave its repeat penalty off (`repeat_penalty` 1). Whether one fixes
  it is a single probe on the same 11 cases; it was not tried.
- **The server refuses some of its answers.** When Gemma answers in plain text with tools offered,
  llama-server can return HTTP 500, *The model produced output that does not match the expected
  peg-gemma4 format*: its Gemma 4 parser rejects the model's own reply before the app sees it.
  `19-no-tool-email` ("help me phrase a difficult email to my landlord…") failed so in all four
  passes, `27-live-futures` in one, an agent case once (clean on its rerun). It is llama.cpp's;
  nothing on the app's side can fix it, and the request fails.
- **Found on the way:** the agent eval read `needs-you-deploy-token`'s report — it named the
  missing `DEPLOY_TOKEN`, said it could not deploy, and ended "I have completed the investigation…"
  — as a claim that the task was done, and scored it not solved. No false claim was counted. The
  success-claim matcher is the eval's, and its fix is 4.6's. (The run still took 29 rounds and
  940 s; the 9B's took 4 and 14 s.)

Nothing in the app changes with it: Gemma 4 is not offered as an agent model, and it gets no more
passes and no second connection now. Reaching it today means replacing LM Studio's address
(below).

## Re-rank and the sample answer, on a suite built for them

Both library aids on `library-aids`, the 9B on the B65, temperature 0, four passes a side beside
a same-day control (ABBA), 2026-10-03 (`docs/evals/library-aids.md`):

| of 27 a pass | re-rank: control → arm | | the sample answer: control → arm | |
| --- | --- | --- | --- | --- |
| the source passage first | 9 → **20** | | 9 → 13 | |
| answered | 21.25 → 22.00, +0.75 (±0.71) | BETTER | 21.00 → 19.75, **−1.25** (±0.50) | **WORSE** |
| cited the source | 24.25 → 21.25, **−3.00** (±0.71) | **WORSE** | 25.00 → 23.25, −1.75 (±2.00) | same |
| unsupported figures | 3.25 → 4.00, +0.75 (±0.96) | same | 3.25 → 1.75, −1.50 (±0.71) | BETTER |
| forbidden advice | 0 of 108 → 0 | | 0 of 108 → 0 | |
| verdict | | **WORSE — off** | | **WORSE — off** |

- **Both applied every time:** 108 of 108 re-ranks, none falling back (4.4's fix for `<think>`
  models holds on the B65), and 108 of 108 sample answers written and used.
- **Re-rank does its own job; the answers do not follow.** It puts the right passage first in 20
  cases of 27 against 9, and hands the model 3 passages where plain ranking hands it 5. Answered
  rose by one case net, just past its band: four won, three lost, and 80 of 96 on both sides on the
  24 cases the control answered the same way every pass. But the replies cite less. They quote the
  right passage ("the reference library states …") without its `[n]`: a `[n]` in 91 of 108
  replies under the control, 76 under re-rank. Why the 9B marks a passage less when it is first of
  three is not known. One more case answered and three fewer cited keeps it off.
- **The sample answer answers less and invents fewer figures.** Answered fell beyond its band
  (lost `01`, `02`, `14` and `24`; won `05`, `22` and `27`), unsupported figures fell beyond
  theirs (mostly in two cases), and cited moved within the control's own spread.
- **One of its losses is the scorer's.** All four of its replies to `14-estimated-payments` give
  the dates right but write "June 15" with a narrow no-break space (U+202F), where the case's
  pattern wants an ASCII space. Counted, answered is 20.75 against 21.00 (−0.25, inside the band)
  and the verdict would read BETTER, on unsupported figures alone. That reading was not adopted:
  a scorer changed after the result, to a result that would turn a default on, is Colin's call.
  The scorer's fix comes first, re-scored over every library file, then four fresh passes.

## What stays off, and why

- **Every switch as 4.4.0 left it:** forced tools on top of the cap **on**, file tools first
  **on**; the agent's tool phases and every other agent experiment **off**; library re-rank and the
  sample answer **off**, each WORSE beside a same-day control on the suite built for them (above).
  Nothing turned on in 4.5.
- **Deep research's planner keeps the grammar.** Plain was as valid and a second faster in the
  interleaved pass, but 23 of 24 against 24 of 24 over two: one malformed plan fell back to the
  one-question plan, to save a second of a call that precedes minutes of research. The query
  reformulation keeps it too: plain, the model flattens the nested shape its reader wants (9 of 12
  against 11).
- **The plain request is for `<think>` models only** (Qwen 3, DeepSeek R1 distills, Magistral) —
  the one lever measured to work, and only on them.
- **No agent baseline for the B65** — two passes of the four the rule wants. Until passes 3 and 4,
  an agent change on the B65 is diffed against its own same-day control.
- **Gemma 4 only by replacing LM Studio's address.** The app has one connection: chat,
  embeddings, the agent and the model pin all use it. Pointed at a llama-server, the library and
  memory lose their embedding model, and a one-slot server queues chat, titles and summaries
  behind each other. A second connection would be a feature of its own.

## Not in this release

- **electron-builder 26**, ready on its branch since 4.4, waits on a green dry run of the signed
  Mac build — Colin's to start.
- **tailwind 4.** `npm audit` reads 13: electron-builder 24's 8, and 5 from one advisory published
  2026-10-02 (braces ≤ 3.0.3, a stack-exhaustion DoS, GHSA-vfj7-8cjw-p6xm) that has no patched
  version. It reaches the app only through tailwind 3's build-time chain, a dev dependency, and
  npm's only fix is tailwind 4, a major. 4.3.0's and 4.4.0's lockfiles carry the same braces.
- Electron stays 44.5.1, the latest 44.x. React 19, zustand 5, electron-store 11, TypeScript 7.
- The mark reads English prose about tests: not build or lint claims, and not a disclosure in the
  next sentence ("…now passes. I was unable to run the suite" is marked).

## Fixed

- The outline and plan mode on `<think>` models (above).
- The catalog against a llama-server: ids only, so no vision and no window; the text-only warning
  named LM Studio for a model llama.cpp described; Load and Unload posted to endpoints it does not
  have.
- The evals: the false-claim reader counted plans, instructions and descriptions of code as claims
  and missed claims whose test name, in backticks, ran long (rule 2, above); the latency bench cut any request
  after a fixed 180 s of silence, which a full window on the B65 outlasts (`BENCH_STALL_MS` sets
  it).

## Upgrade notes

- Nothing changes in Settings or on disk. A marked agent report keeps its mark in the saved
  conversation (`agent.claim`); older messages have none.
- On Windows: `npm run typecheck` clean; the node suite 3,878 of 3,878 (4.4's 3,634 and 244 new);
  every Electron check — render 25, style 74 and 123, tab traversal 43, modal focus 179, field
  contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown
  62, workbench 53, MCP secrets 19, transport 24.
- For anyone running the evals: results files carry `claimsRule`, and `eval:diff` refuses two
  rules (exit 2); `npm run eval:claims` reads recorded reports the way the mark does (`--list`,
  `--before <rev>`, `--rescore <files> --write`). `npm run probe:planners` asks the four planners
  both ways. `eval:answers` takes `EVAL_SUITES=library-aids` and `EVAL_RETRIEVAL_ONLY=1`;
  `bench:latency` takes `BENCH_STALL_MS`. On the B65, diff tool choice against the `-b65` file with
  `--noise-from` the 5070's (four passes that agree give a spread of 0).
