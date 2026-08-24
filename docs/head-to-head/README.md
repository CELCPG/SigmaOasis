# Head-to-head protocol

The shared task set for comparing two builds of Sigma Oasis on the six dimensions
where the app's own audit found it weakest. `tasks.json` holds 18 tasks, three per
dimension. Both builds get the same 18 prompts, the same fixtures, the same
machine, and the same driver script.

The point of this set is not to score answers. Every task is built so that the
verdict is a property of the **interface and the plumbing**, not of the model:
whether a number is disclosed as unsourced, whether a citation can be clicked,
whether a stop reads as a stop, whether the layout holds, whether the app hands
itself back after a hang. A 9B model and a 70B model should score the same on a
build that behaves well, and the same as each other on a build that does not.

---

## The six dimensions

| Dimension | The question it asks | Tasks |
|---|---|---|
| `verifiability` | When the app cannot back a claim, does it say so? | V1, V2, V3 |
| `plan-transparency` | Does the plan block show what actually happened? | PT1, PT2, PT3 |
| `tool-honesty` | Is the reply's account of its own tool use checked? | TH1, TH2, TH3 |
| `time-to-useful` | How long is the screen useless, and is the wait named? | TTU1, TTU2, TTU3 |
| `failure-recovery` | When something breaks, does the user get a cause and a next step? | FR1, FR2, FR3 |
| `visual-craft` | Does the interface hold up under real content and real users? | VC1, VC2, VC3 |

---

## Task schema

Each entry in `tasks.json` carries:

- **`id`** — stable identifier (`V1`, `PT2`, …). Never renumber; retire instead.
- **`dimension`** — one of the six above.
- **`prompt`** — the literal text typed into the composer. Nothing is
  paraphrased at run time; the driver types this string exactly.
- **`probes`** — the specific weakness the task is built to expose, named down
  to the file and the code path. This is the task's justification and it is
  what a reviewer should argue with if they think a task is unfair.
- **`setup`** — fixtures, settings and driver actions the task needs (see
  *Fixtures* below). Anything the driver must do beyond typing lives here.
- **`mechanicalChecks`** — assertions a **script** decides from the captured
  run: a regex over visible text, a timing threshold, the presence or absence
  of a DOM affordance, a count, a computed contrast ratio. No check anywhere in
  this file asks a model to grade anything.
- **`criticQuestion`** — the single question a blind critic answers by
  comparing two captured runs without being told which build produced which.
- **`offlineSafe`** — true for all 18. Nothing in this set reaches the internet.

---

## Rules

1. **Local only.** No task may touch the internet. Web-shaped behaviour is
   served by loopback fixtures, which the egress allowlist permits because the
   app's own settings point at them. If a run makes an outbound request to any
   non-loopback host, the run is void.
2. **Never loosen a check to make a build pass.** A threshold that a build
   cannot meet is a finding, not a bug in the task. Tolerances, cases and
   assertions are frozen for the duration of a comparison.
3. **The app claims nothing it has not measured**, in either direction. A task
   that cannot be decided mechanically does not belong in this file.
4. **Both builds, same session shape.** Same machine, same LM Studio model and
   the same loaded context length, same window size, same theme, same settings
   except where a task's `setup` says otherwise.
5. **Never screenshot inside a timed window.** Screenshots make subsequent CDP
   messages slow, which corrupts every timing in `time-to-useful`. Screenshots
   are taken after the timed window closes, or in tasks that measure no time
   (`VC1`).
6. **Order and isolation.** Run tasks in file order. Each task starts a new
   conversation, except `VC3`, which is a follow-up inside `V1`'s conversation,
   and `FR1`, which needs a conversation with several turns already in it.
   `TTU2` requires a fresh app launch with a fresh userData directory, because
   it measures a cold Pyodide boot.
7. **Three runs per task per build.** Report the median for timings and the
   worst case for correctness-of-disclosure checks. A build that discloses
   correctly two runs in three has not passed.

---

## Fixtures

All fixtures bind to `127.0.0.1`. Nothing else is reachable during a run.

### 1. Loopback search fixture

`src/main/ipc/search.ts` reaches a SearXNG provider at
`${searxngUrl}/search?q=…&format=json` and expects
`{ "results": [ { "title", "url", "content", "publishedDate" } ] }`. Point
Settings → Search → SearXNG URL at the fixture and it becomes the entire web.
`src/main/ipc/net.ts` allows it because the allowlist is derived from settings,
and `src/main/ipc/loopback.ts` is what makes a loopback host legal to save.

The fixture is seeded per task:

| Task | Seeding |
|---|---|
| `TTU1` | sleep 8000 ms, then return three valid results (inside the 15 s transport timeout, so the search succeeds) |
| `TH2` | HTTP 500 for the query, so the record lands `status: 'error'` |
| `TH1` | reachable but never queried — `web_search` must be *enabled* so the model's claim is about a tool that could have run |

The fixture logs every request; several tasks assert on that log to confirm the
run is comparable.

### 2. Loopback LM Studio shim

A proxy on `127.0.0.1` in front of the real LM Studio. `normalizeBaseUrl` in
`src/main/ipc/store.ts` only accepts a loopback base URL, so the shim is the
supported way to inject a transport-level fault.

| Task | Behaviour |
|---|---|
| `FR1` | For the tagged turn: HTTP 200, then one SSE frame `data: {"error":{"message":"… context length of only 8192 tokens"}}`, then `[DONE]` — the measured LM Studio over-context case |
| `FR2` | Accept the POST, return 200 `text/event-stream`, then write nothing and never close |
| `FR3` | Proxy normally, except any request whose system message contains `REVIEW_INSTRUCTION` (see `src/renderer/src/lib/deliberation.ts`) gets a 200 with an immediately-closed empty stream |

Everything else passes through untouched.

### 3. The shipped library packs

`packs/` is the offline reference corpus and needs no fixture at all — it is
what makes the retrieval tasks runnable with the network off. The tasks lean on
documents that ship in the repo:

- `packs/food-safety/leftovers.md`, `safe-minimum-internal-temperatures.md` — V1, TH1, TH3
- `packs/finance/standard-deduction.md` — V2
- `packs/preparedness/water.md`, `build-a-kit.md` — PT1
- `packs/home-safety/smoke-alarms.md`, `carbon-monoxide-indoors.md` — PT2, TH2
- *(nothing covers dripping taps — that absence is the point of V3)*

`test/fixtures/library/` holds the matching retrieval cases if a task needs a
pinned expected passage set.

### 4. Pyodide

`resources/pyodide` is local. `TTU2` needs it present and needs the runtime
**cold** — a fresh userData directory per run.

---

## Capture

For each run the driver records:

- `transcript.json` — every message, every tool-call record (name, args,
  result, status), and the turn's trace export (`docs/trace-export.md`).
- `dom/` — `outerHTML` of the assistant message and of any plan block, captured
  at the moments a task's checks name (e.g. `PT2` needs a pre-cancel and a
  post-cancel snapshot).
- `timings.json` — `t0` (Enter keydown) and every marked timestamp, from
  `MutationObserver` on the message body. No screenshots inside this window.
- `styles.json` — computed styles for the nodes `VC2` and `VC3` measure, in
  both themes.
- `fixture.log` — every request each fixture served.
- `shots/` — screenshots, taken only after timed windows close.

Drive the app over CDP. A working launcher and probe already exist:

```
env -u ELECTRON_RUN_AS_NODE OASIS_UD=<userdata-dir> \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  <launcher>.js --remote-debugging-port=<port>

ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS=--experimental-websocket \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron <driver>.js
```

Typing into the composer needs the native value setter plus
`dispatchEvent(new Event('input', { bubbles: true }))`; submit with a bubbling
`keydown` Enter. `Page.captureScreenshot` works but slows every subsequent CDP
message — see rule 5.

Note that the renderer ships **no `data-testid` anywhere**. Every DOM check in
`tasks.json` is written against what a user can actually see: visible text,
accessible names, computed styles, bounding rectangles. That is deliberate — a
check that needs a test hook is a check the user cannot verify.

---

## Scoring

Two passes, kept apart.

**Pass 1 — mechanical.** A script evaluates every entry in `mechanicalChecks`
against the captured run. Output per task: `PASS` / `FAIL` plus the task's
headline numbers (each task names its own). This pass is the record. It is
reproducible, it involves no judgement, and it is what any disagreement is
settled against.

**Pass 2 — blind critic.** A reviewer is given two captured runs of one task,
labelled only `Run A` and `Run B`, with no build identity, no commit, no order
guarantee, and no access to Pass 1. They answer that task's `criticQuestion` and
nothing else. Every `criticQuestion` is phrased so it can be answered from the
two captures alone.

A build wins a dimension by taking at least two of its three tasks on Pass 1.
Pass 2 breaks ties and, more usefully, catches the case where both builds pass
the script and one of them is still plainly worse to use.

---

## Adding a task

A new task earns its place only if all of these hold:

- it names a **specific** code path it is designed to expose, in `probes`;
- a real person would plausibly type its `prompt` verbatim;
- every `mechanicalChecks` entry is decidable by a script from the capture;
- its `criticQuestion` is answerable from two blind captures;
- it runs with the network off, and `offlineSafe` says so truthfully;
- its outcome does not depend on model size or on world knowledge the local 9B
  model would not have.

If a task starts passing on every build, it has stopped measuring anything —
retire it and write a harder one. Do not weaken it.
