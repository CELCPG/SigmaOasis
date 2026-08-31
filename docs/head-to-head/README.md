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
- **`probes`** — what the task **makes happen**: the turn shape the prompt and
  the fixtures produce, and the observables that shape puts in play. It is the
  task's justification, and it is what a reviewer should argue with if they
  think a task is unfair. It states no build's behaviour. See *Neutrality*.
- **`setup`** — fixtures, settings and driver actions the task needs (see
  *Fixtures* below). Anything the driver must do beyond typing lives here.
- **`mechanicalChecks`** — assertions a **script** decides from the captured
  run: a regex over visible text, a timing threshold, the presence or absence
  of a DOM affordance, a count, a computed contrast ratio. No check anywhere in
  this file asks a model to grade anything.
- **`question`** — what a blind critic is asked. Non-directional: it asks how
  much, how many, or what the reader ends up with. A question that asks *which
  run* is worse has the verdict in it before anything is measured.
- **`measure`** — what to report from both runs, in numbers, in both
  directions. Every entry survives a fix: a count of markers that resolve and a
  count that do not is still informative once every marker resolves, where *does
  the app resolve markers* stops being informative the moment one build says yes.
- **`decide`** — how to weigh what was measured, stated symmetrically, including
  what to do when neither run was put to the test.
- **`offlineSafe`** — true for all 18. Nothing in this set reaches the internet.

The file also carries, in `crossCutting`, the questions asked of **every** task
alongside its own. Each one is scored in its own column (see *Scoring*):

| id | what it asks |
|---|---|
| `self-consistency` | does anything the application says on this screen contradict anything else it says on the same screen |
| `record-consistency` | does what the application says about this turn agree with what the run's own record shows the turn did |

Both presuppose nothing, apply to every build, and need no knowledge of what
changed, because both are an **agreement relation between two things the run
itself produced**. No standard is imported from outside the run, which is what
makes them neutral — and is also the limit of what they can see (*What a column
cannot see*, below). They catch the class of repair a per-task question misses:
an app that prints a banner saying it found nothing while marking two passages
as cited is wrong in a way no single dimension's question thinks to ask about.

A question earns a place here only if every build has the property, no task
names it, a critic can count it from artifacts both runs already produce, and
its answer is an agreement between two things the run produced. **A column whose
wins only ever land where the task column already won has stopped adding
evidence** and should be retired, the same way a task that passes on every build
should be.

---

## Neutrality

The task set is written twice over: for the people building against it, and for
the people judging against it. Those two readers want opposite things, and for
eight rounds the first one won.

A task description that says *the strip only lists the first lookup's passages*
is a defect report. It dates: it is true of one build, on one day. A critic who
reads it knows what to look for and which arm to expect it in, and a
question-writer who reads it is holding an inventory of what at least one build
is known to get wrong. Round 8 recorded that all 18 `probes` fields were written
that way and that four quoted constants only one build could produce.

The same task is exactly as sensitive when it is written as *this prompt
produces a turn with two lookups and citations spanning both*. That names the
same coordinate. It just does not say which value is the good one, and it is
true of every build — including one that gets it right.

So the rule is: **a descriptive field names what the task does, never what a
build does with it.** No source path, no class name or custom property, no code
identifier, no number with a unit, no ratio, no version, no viewport size, no
interface glyph, no string quoted off the screen. Any of those is a fact about
an implementation, and a task that states one has stopped describing an
experiment and started describing a result.

`test/h2hTaskNeutrality.test.ts` enforces this on `probes`, `question`,
`measure`, `decide`, the file's own notes, and **every string under
`crossCutting`, whatever it is called** — that block is walked structurally
rather than field by field, so a question or a scoring rule added there is
guarded on the day it is added rather than on the day someone remembers to
extend a list. It is a check on what may be *written*; `make-critic-tasks.mjs`
is a filter on what a critic may *read*. Two fields are deliberately outside it:

- **`prompt` and `setup` are frozen.** They are the experiment, and eight rounds
  of recorded runs are comparable only because they have not moved. `setup` is
  also the one descriptive field the critic view keeps, so what is still in it —
  two quoted labels on PT2, a version parenthetical on VC1, two internal
  identifiers on FR3 — is pinned as an inventory that fails the suite if it grows.
- **`mechanicalChecks` is a script's assertion list.** It has to name concrete
  DOM facts to be decidable at all, so it remains a defect inventory in machine
  form. Nothing but the scoring script may read it — not a critic, not the
  person writing the critic's prompt.

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
   except where a task's `setup` says otherwise. Where a task measures a theme
   (`VC2`, `VC3`) it measures **both**, in one run, on one screen: two runs
   would produce two different replies and therefore two different Tab orders,
   and a light-versus-dark difference could not be attributed to the theme. The
   run puts the theme back before its own artifacts are taken.
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
- `reply.md` / `messages-raw.json` — the **raw markdown**, un-rendered. See
  "What the renderer was handed" below; everything else in this list is
  `innerText`, and therefore post-render.
- `dom/` — `outerHTML` of the assistant message and of any plan block, captured
  at the moments a task's checks name (e.g. `PT2` needs a pre-cancel and a
  post-cancel snapshot).
- `timings.json` — `t0` (Enter keydown) and every marked timestamp, from
  `MutationObserver` on the message body. No screenshots inside this window.
- `snapshots/styles-<scope>-<theme>.json` — for every text node in the scope a
  task names, the two colours a contrast ratio is computed from: the ink
  composited over its effective background, that background, the stack of
  surfaces that produced it (each layer with its own alpha, all the way down to
  something opaque — `backgroundResolved` says whether it got there), and the
  font metrics that decide which threshold applies. Written once per scope per
  theme. The ratio itself is not computed here — it is a pure function of two
  RGB triples and belongs to the scoring pass.
- `snapshots/tab-traverse-<theme>-<destination>.json` — one entry per Tab
  press: the focused and unfocused computed styles, which of them differ, the
  surface the stop is on, whether anything is drawn over it, and every
  activation the walk performed.
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
guarantee, and no access to Pass 1. They answer that task's `question` and each
question in `crossCutting`, report every entry in the matching `measure` for
**both** runs, and weigh each by its own `decide`. Nothing else. All of them are
phrased so they can be answered from the two captures alone.

The critic reads those from a prompt document, not from `tasks.json`: the
document is written by someone who did not build the changes, and the task file
a critic may open is the generated `tasks-for-critics.json`. The person writing
that document may read `probes`, `question`, `measure`, `decide` and
`crossCutting` — that is what the neutrality rule is for — but never
`mechanicalChecks`.

A build wins a dimension by taking at least two of its three tasks on Pass 1.
Pass 2 breaks ties and, more usefully, catches the case where both builds pass
the script and one of them is still plainly worse to use.

**A tie is three different results**, and Pass 2 must say which one it has:
the task was insensitive to what changed; the run never exercised the thing the
task measures; or both builds really do behave the same. Only the third is a
statement about the builds.

### Columns

Pass 2 produces **one verdict per question**, not one per task. They are
aggregated into columns and the columns are reported side by side:

```
task                A 0 · B 3 · tie 14 · void 1
self-consistency    A 0 · B 1 · tie 15 · void 1 · contested 4/17
record-consistency  A 1 · B 2 · tie 14 · void 1 · contested 6/17 · quiet wins 1
```

**The columns are never added together.** Two reasons, and the second is the one
that bites. The headline stays the task column, because the six dimensions are
what the app's own audit chose and a cross-cutting question is not one of them;
summing would let a build that moved nothing a task asks about report a task
win. And the columns are **not independent** — the same repair can win two of
them, so a sum double-counts one fix and hides that it did.

So the answer to *is a tie on the task question plus a win on consistency a
win?* is **no: it is a tie and a win, which is two facts.** A round's summary
sentence carries both numbers or it carries neither.

Three figures come out of the columns rather than out of any one of them:

- **seen only by a cross-cutting column** — tasks the task column tied or voided
  where a cross-cutting column named a winner. This is the class of result
  rounds 8 and 9 threw away, and it is reported in **both directions**: a column
  that can only add wins is a column that flatters.
- **scored in more than one column** — the overlap. A column whose wins all sit
  here has restated the task column rather than added to it.
- **contested** — tasks where at least one run gave the question something to
  bite on. A column of ties over eighteen tasks contested on none of them says
  the property was never in play, which is a different claim from two builds
  behaving alike, and the win/loss/tie line cannot tell them apart. **The
  denominator is `contested`, not 18.** A column that bit on nothing anywhere
  and was silent on most of what it looked at is named as *never put in play*,
  in the same words as a column measuring the record's coverage: both are
  columns whose ties are a fact about the instrument or the tasks rather than
  about either build, and both read identically in the win/loss/tie line.

**The cheapest way to pass any cross-cutting question is to print less**, so
every one of them reports a volume figure — statements made, statements the
record could settle — beside the count it is scored on. A win by the run that
said less is flagged `quiet` and is **still a win**: a build that removed one
half of a contradiction has fewer statements and fewer contradictions and is
right to have won. The flag is for a human to read; nothing decides on it.

`docs/head-to-head/score-round.mjs` does the aggregation from
`verdicts/round-N.json`, and refuses to score a file that invents a column the
task set does not ask, leaves a task out of a column, or reports a contested
denominator it has no counts for. `unrecorded` is a verdict: a question that was
put and whose answer was not kept is not a tie, and the file may not round it
into one.

### What a column has to say about its own evidence

Round 11 wrote both cross-cutting columns as eighteen ties and the scorer could
only print `contested unknown — no counts kept`. Every critic that round had
reported a statement count and a disagreeing-pair count per task per run; none
of it reached the file. **A column that was never put in play looked exactly
like a column both builds passed.**

So a cross-cutting column now declares what stands behind it, in the same three
words the verdicts use — and a column that declares nothing is refused:

| `evidence` | means | what the printout says |
| --- | --- | --- |
| `counted` | the numbers are in this file, task by task and run by run | `contested N/M`, plus why the rest was uncontested |
| `unrecorded` | the critics counted and the round did not write it down | `contested unrecorded`, and a paragraph saying the ties cannot be read as agreement |
| `unasked` | the question was not put this round | nothing; the column already says `NOT ASKED` |

`unrecorded` is deliberately cheap to write. A round that lost its numbers can
always be honest about it; what it can no longer be is silent. A column that
claims `counted` and carries nothing is refused, and so is one that claims
`unrecorded` and carries something — a real measurement labelled as an absence
throws the evidence away just as thoroughly.

Under `counted`, each task carries one block per run:

```json
"V1": {
  "verdict": "tie",
  "A": { "volume": 11, "settleable": 8, "count": 1, "unsettleable": { "absent": 2, "byNature": 1 } },
  "B": { "volume": 9,  "settleable": 6, "count": 0, "unsettleable": { "absent": 2, "byNature": 1 } }
}
```

**What each field means when it is zero** is the whole reason there are four of
them rather than one:

- `volume` — statements the application made about its own behaviour. **Zero
  means it said nothing about itself**, and zero on both sides is a tie about
  the task, not about the builds.
- `settleable` — how many of those this column could actually decide. **Zero
  under a volume above it means the run talked and not a word of it could be
  checked** — a fact about the capture. Both questions' `decide` already orders
  a critic to report this beside the count; carrying it rather than deriving it
  from `volume` minus the unsettleable split is what lets a miscount be caught
  instead of absorbed.
- `count` — disagreeing pairs, or contradictions. **Zero is an earned agreement
  only when `settleable` is above zero**; otherwise it is the column failing to
  look, which is what a lone zero cannot distinguish.
- `unsettleable.absent` / `.byNature` — optional, and optional *together*. Given,
  they must account exactly: `settleable + absent + byNature = volume`. Left out,
  the tie is reported as unsettleable with the kind not stated rather than as an
  agreement.

Anything that does not add up is refused with exit 2 as *counted from different
lists*, which is the existing refusal extended rather than a new one: half a
comparison, more settleable statements than statements, disagreements found
among nothing settleable, and counts kept for one run and not the other all land
there. `contested N/M` also reports `uncounted K` when `M` is short of the
round's tasks, so a column counted on two of eighteen cannot print a ratio that
reads like a column contested on half of what it saw.

### Where the counts come from

The critics already produce these numbers, in prose. Three ways to get them into
the file, and the round took two:

- **Parse the prose** — rejected. Round 9's reports are not in the repository and
  round 11's were a task notification; a parser for prose that no longer exists
  is tested against nothing, and prose that *nearly* parses yields a number
  rather than a refusal.
- **Refuse a file with no counts** — taken, as the `evidence` declaration above.
  It makes silence visible. On its own it makes nothing easier to keep, and **a
  schema nobody can fill is worse than no schema.**
- **Ask for a machine-readable block** — taken, as `critic-counts.mjs`. The
  critic appends one header line and one line per run, per question, per task,
  *beside* the prose and not instead of it.

```
COUNTS V1 self-consistency run-2
  run-1 statements 11 settleable 8 found 1 unsettleable-absent 2 unsettleable-by-nature 1
  run-2 statements 9 settleable 6 found 0 unsettleable-absent 2 unsettleable-by-nature 1
```

`node docs/head-to-head/critic-counts.mjs block` prints that spec for the prompt
document, generated from `crossCutting` so a question added there gets a block
without anyone remembering to add one. `critic-counts.mjs read <report…> --key
<staging>/_key.json` reads filled blocks back into a column, checking the same
arithmetic the scorer does and refusing rather than guessing. **The verdict word
rides in the header**, so the word and the numbers behind it are written in one
place at one moment — round 11's word survived and its numbers did not precisely
because they were written in two.

The blinding survives it: a critic writes `run-1` and `run-2`, which is all a
critic knows. Turning those into `A` and `B` needs `_key.json`, which is withheld
from critics, and without it the tool stops at the run labels and says so.

What it costs, stated rather than buried: a critic now emits a structure as well
as an argument, which is one more thing to get wrong; a malformed block costs a
human re-read rather than producing a number nobody counted; a fixed vocabulary
in front of a critic is a mild pull toward counting what the block asks for
rather than what the question asks for, which is why the prose stays mandatory
and the block is checked against itself rather than against the prose; and none
of it recovers a number from a round already judged.

### When a round overrules its critics

A file may carry `columnsAsReported` beside `columns` — the critics' raw
verdicts, and the reading the round stands behind. Round 11 carried both and
explained the difference in a paragraph, so the printout showed a corrected
column with no sign that anything had been corrected. **A paragraph explaining
one correction reads exactly like a paragraph explaining nine.**

```json
"corrections": [
  {
    "task": "V1",
    "columns": ["self-consistency", "record-consistency"],
    "from": "B", "to": "tie",
    "rule": "a difference that would vanish under identical tokens is not a difference",
    "why": "…"
  }
]
```

The check runs both ways, because each direction hides something different. A
difference between the two readings that no correction names is a verdict
quietly overruled. A correction matching no difference is a rule invoked over
nothing — the appearance of rigour with no verdict behind it. Both are refused,
and the printout carries `verdicts overruled after reporting N of M` with the
rule beside each one.

### What a column cannot see

Both cross-cutting questions are **agreement relations**, which is what makes
them neutral and is exactly what they are blind to:

- **A screen that is consistently wrong.** A build whose screen agrees with
  itself and with the record about a falsehood scores perfectly in both columns.
  Neither imports a standard from outside the run, by design.
- **Presentational inconsistency.** One fact drawn two different ways on one
  screen is not two statements contradicting each other. Round 9 fixed exactly
  that and it scores nothing here either.
- **Silence.** The volume figure makes a quiet screen visible; it does not
  penalise one. That is a judgement left to a reader on purpose.
- **A turn where nothing was in play.** Both columns inherit the
  model-dependent trigger: zero against zero is a tie whether both builds were
  tested and passed or neither was tested at all. `contested` shows which; it
  does not remove the problem.
- **The record is not the reader's.** A `record-consistency` win is a win for
  the app's account of itself, measured against artifacts no user ever sees. It
  is not evidence the screen is more useful.

---

## Adding a task

A new task earns its place only if all of these hold:

- its `probes` names a **specific** observable it puts in play, and says so as a
  property of the task — a sentence only one build could falsify is a defect
  report, not a probe;
- a real person would plausibly type its `prompt` verbatim;
- every `mechanicalChecks` entry is decidable by a script from the capture;
- its `question` is answerable from two blind captures and names no run;
- every `measure` entry is a number or a quotation that stays informative after
  the thing it measures is fixed;
- `decide` says what to do when the two runs come out the same, and what to do
  when neither was put to the test;
- it runs with the network off, and `offlineSafe` says so truthfully;
- its outcome does not depend on model size or on world knowledge the local 9B
  model would not have.

If a task starts passing on every build, it has stopped measuring anything —
retire it and write a harder one. Do not weaken it.

Run `node docs/head-to-head/make-critic-tasks.mjs` after any edit; the suite
fails if `tasks-for-critics.json` is stale, if a new field is one the generator
neither keeps nor drops, or if a descriptive field carries a build fingerprint.

---

## Running it

The harness is five files:

- `scripts/h2h-instrument.ts` — what the harness is, and whether it is the right
  one for the build it was pointed at. See *Which harness measured this* below.
- `scripts/h2h-fixtures.ts` — the loopback servers described above, as a
  reusable module (and a small CLI for poking one by hand). Each keeps a request
  log; a run whose fixture was never contacted is marked `INVALID` rather than
  scored.
- `scripts/h2h-preconditions.ts` — the environment facts a task's setup says
  must hold, and how to tell whether they did. A fixture guard only sees tasks
  that have fixtures; this covers what the *machine* had to supply. TTU2's
  "resources/pyodide present locally" is the case that motivated it: with the
  runtime absent, every Python block failed on it and the run still scored
  `VALID` with an empty reason list.
- `scripts/h2h-capture.ts` (`scripts/h2h-capture.sh`) — one task, one arm, one
  run directory. `--app <dir>` points it at a build other than this repo's,
  which is what makes an A/B possible; `--settings`, `--packs`, `--requires`,
  `--search-fixture`, `--lm-fixture`, `--pre-actions` and `--actions` carry a
  task's setup in. Seeded settings are read back out of the *running* app and
  the run fails if it did not take them.
- `scripts/h2h-run.sh` — one arm, many tasks. Reads the prompt from
  `tasks.json` and the executable setup from `task-setup.json`.

Judging adds two more, in this directory:

- `make-critic-tasks.mjs` / `make-blind-pairs.mjs` — the view a critic may read,
  and the staged pairs it reads it against.
- `critic-counts.mjs` — the counts block a critic fills in beside the prose, and
  the transcriber that turns filled blocks into a column. See *Where the counts
  come from* above. Its output is a document a blind judge reads, so it is
  guarded for build fingerprints in `test/h2hTaskNeutrality.test.ts` alongside
  the task view rather than trusted because of where it was generated from.
- `score-round.mjs` — Pass 2's verdicts, aggregated into columns. It reads
  `verdicts/round-N.json`, which is **the round's record**: one entry per task
  per column, with the volume figures each column is guarded by. Round 9's
  critics answered the self-consistency question on all eighteen tasks and
  nobody wrote the answers down; that column cannot be recomputed and the file
  says `unrecorded` rather than pretending it was a tie. Rounds 10 and 11 kept
  their verdicts and lost the counts behind them, so their cross-cutting columns
  declare `evidence: "unrecorded"` and the printout says in words that their
  ties may not be read as agreement.

`task-setup.json` is this file's `setup` prose written so a machine can run it:
settings, packs, fixtures, `requires` and driver actions per task id. If the two
ever disagree, `tasks.json` is the requirement and `task-setup.json` is the bug.

A task states a precondition twice over, and both are enforced: implicitly, in
the setup it already carries (`settings.tools.run_python` of `true` is what
"resources/pyodide present locally" looks like once it is machine-readable), and
explicitly in `requires`. Neither can be deleted without the other still holding
the run to it, and a `requires` id the harness has no check for fails the run
rather than passing quietly.

```
# arm B — the current build
bash scripts/h2h-run.sh --arm B-current  --model qwen3.8-9b V1 TH2 PT2

# arm A — a baseline build in a git worktree, same driver, same tasks
bash scripts/h2h-run.sh --arm A-baseline --model qwen3.8-9b \
     --app ../oasis-baseline --port 9344 V1 TH2 PT2
```

Runs land in `.h2h-runs/<arm>/<taskId>-<timestamp>/`. Beyond the artifacts the
capture always wrote, a run now carries `fixtures/` (every request each fixture
served), `snapshots/` (DOM captured at the moments a task names, per-text-node computed
styles for the tasks that measure ink, and keyboard-traversal records), and in
`run.json`: `instrument` (which harness measured this, and what it could
measure), `driverActions` (everything the driver did and when), `turns` (one
entry per turn, for the multi-turn tasks), `setup.seededSettingsVerified`,
`preconditions` (each declared capability and whether it was really there),
`screenAtTurnEnd` (the theme the run finished in, and whether a modal was
covering the app when its artifacts were taken), `record` (what the run kept a
record *of*, what it did not, and what no record could settle — see below), and
`validity`.

### Which harness measured this

The arms are builds, named by `--app <dir>`. The harness is a *third* checkout —
whichever one `h2h-capture.sh` was invoked from — and until round 11 nothing
related the two or recorded the second at all.

Round 10 paid for that. It built `textSettledMs`, `textGrewAfterTurnEndChars`
and `streamEdgeAtTurnEnd` into the capture, then ran its sweep from a repo root
sitting on `main`. All 36 `run.json` files came out without them. Both arms used
the same harness, so the comparison was sound; the round's own instrument work
was simply never exercised, and no artifact could say so.

Two guards and one record now cover it.

- **The capture refuses a stale harness.** A build's checkout carries the
  harness it expects, at `<appRoot>/scripts/h2h-capture.ts`. If it knows a
  measurement the running harness cannot emit, the run stops with **exit 5**
  before the app is launched and before a run directory exists;
  `h2h-run.sh` treats that as a sweep-level abort, not one more failed task.
  The test is a *subset*, not equality: the running harness may measure more
  than the build's copy, never less. That is what lets the baseline arm — always
  an older commit, always knowing less — through without an exemption anyone has
  to remember to set.
- **Staging refuses two arms measured by different harnesses.**
  `make-blind-pairs.mjs` compares each pair's `instrument.sourceSha` and
  `measures`. The capture cannot see this: each capture observes only its own
  arm. Runs predating the block record no instrument and are staged as legacy.
- **`run.json` records the instrument.** `instrument.measures` is every figure
  that harness knew how to emit, read structurally out of its own source rather
  than listed by hand, so it cannot drift from what the file contains.

That last one is for the critic, and it closes a real ambiguity: **a name in
`measures` with no value below was measured and came back null; a name that is
not in `measures` could never have been recorded at all.** Before it, those two
were the same JSON, and a question about a missing figure had no honest answer.

Everything in `instrument` describes the harness, which is identical in both
arms — staging asserts that rather than assuming it, which is what makes the
block safe to read blind. The fit check's own result is arm-identifying (the
harness is *ahead of* the older build and level with the newer one), so it lives
in `_arm.json` with the rest of the metadata a critic does not open.

### Driver actions

`waitMs`, `waitForText`, `waitForSelector`, `clickText`, `pressStop`, `key`,
`viewport`, `snapshot`, `styles`, `screenshot`, `theme`, `tabTraverse`,
`prompt` (a follow-up turn in the same conversation) and `waitTurnEnd`.
`clickText` matches a control by the text a user can see; `key` goes through
`Input.dispatchKeyEvent`, so Tab really moves focus. Anything marked `optional`
is recorded and stepped over on failure; anything else fails the run.

`tabTraverse` walks Tab stops and, where its `activate` route says so, presses
them: Enter first, then Space, both real key events and never a click, with the
page compared before and after so an activation that did not fire is recorded
as not having fired. That is what lets a traversal follow the app's own answer
*into* Settings rather than stopping at the button that opens it. A traversal
that opens a surface must declare an `exit` — the control that closes it — so
the run's later artifacts show the app in the state the task describes;
screenshots are the one artifact `make-blind-pairs.mjs` cannot scrub, and
Settings → General renders the app's version number.

`theme` switches the running app through its own Settings panel, control by
control (Settings → General → the theme → Save). That is the only path that
moves the persisted setting, the renderer's store and the screen together: the
renderer reads settings once at mount and has no settings-changed event, so a
write straight to the settings API leaves the store stale and the panel
repaints from it the moment it opens or closes. The action reads back all three
— the setting, the class the stylesheet keys on, and a colour that actually
rendered — and fails the run rather than producing a capture labelled `dark`
of a light screen.

### What the renderer was handed

Every text artifact the harness scores comes from `innerText`, deliberately: it
returns rendered, *visible* text, so a collapsed block contributes its header
and nothing else — what was actually on screen. The cost is that all of it is
post-render by construction. A rendering defect cannot be diagnosed from such a
run, because the run records the defect's output and never its input.

So the capture also writes, **in addition to** and never in place of the
rendered text:

- `reply.md` — the final assistant message's raw markdown.
- `messages-raw.json` — `{ index, role, content, reasoning }` per message.

Both are read through `window.api.listConversations()`, the app's own
already-exposed API for its sidebar, reached the same way `auditExport` is. No
code path exists in the product for the harness's benefit.

Diffing `reply.md` against `reply.txt` is what separates *the model wrote it
that way* from *the app drew it that way*: a character present in `reply.md`
and absent from `reply.txt` was lost by the renderer. Round 6's V3 currency
loss (`docs/evals.md`) was settled exactly this way and could not have been
settled without it.

Both files are deliberately narrow — role, content, reasoning. `modelId`,
`roleName`, `stats` and the conversation title are arm tells and are dropped
before the file is written, because these are staged into blind pairs like any
other artifact: neither name begins with `_`, so `make-blind-pairs.mjs` copies
them, and both extensions (`.md`, `.json`) are in its `SCRUBBABLE` set, so
absolute paths are replaced with `/RUN` and `/ARM/` as they are everywhere else.

An ephemeral (no-trace) conversation is never persisted, by design, so no raw
markdown can be recovered from one. `reply.md` is then empty and `run.json`
`rawMarkdown.error` says why. That is a gap in the artifact, not a failed run.

### The turn's own record

Three tasks (`PT1`, `TH1`, `TH2`) cross-check what the transcript *shows*
against what the app *records* as having run. `task-setup.json` turns the
session audit log on for those, and the capture exports it to
`trace/audit.jsonl` at the end of the run through the app's own
Export-audit path — the launcher answers the native save dialog with a fixed
path, which is the only part of the app the harness touches, and it touches the
dialog rather than anything that decides what gets written. `run.json`
`auditExport` records the entry count and whether the hash chain verified.

#### Why the audit is not turned on everywhere

Round 10 scored a `record-consistency` column over all eighteen tasks and found
something to bite on in four of them. Across the thirty-six recorded runs the
application makes **120 statements about its own behaviour on the turn**, and
the audit could settle **9**. On **31 of 36 runs it could settle nothing at
all**. A column that only fires where a record exists is measuring the record's
coverage, not the application.

Turning the audit on for every task is the obvious repair and it is refused,
for two reasons that both matter:

- **It would stop measuring the shipped app.** The session audit is opt-in and
  off by default, and it is not free: every user input, assistant output and
  tool call is then encrypted with the machine keychain, hash-chained against
  the previous line, and appended to disk through a serialized queue — inside
  the process whose latency this bench publishes as the product's. This project
  spent three rounds recovering from a baseline arm that was quietly not the
  shipped build. Doing it to *both* arms makes it harder to notice, not less of
  a fault.
- **It would not settle the claims anyway.** The audit's contents are fixed by
  what it is for — an append-only record of what was *said*, with no system
  prompts, no recalled memory and no compaction notes. Session start, user
  input, assistant output, tool call. No step boundaries, no playbook identity,
  no timings. Making it settle those means growing the product's audit log to
  serve the bench, which is the same fault pointing the other way.

#### `run.json` `record` — what the run kept a record *of*

The column's question names "the run's own record" and, until this block
existed, no artifact said what that was; each critic decided for themselves and
several decided it meant `trace/audit.jsonl` alone. `record` is the list:

- `configuration` — the switches live in the app when the turn ran, read out of
  the same `getSettings()` call the harness already makes to verify the seed.
  It settles **capability, not exercise**: a line saying a check ran while that
  check was switched off is a contradiction; a line saying it ran while it was
  on is merely possible. Values are switches, small enums and counts only —
  `_settings-in-app.json` stays a withheld sidecar because it carries a
  loopback port, a filesystem path and a model id. `notCovered` names every
  settings group left out *with the reason*, and a group nobody has decided
  about is stamped `UNDECIDED` in the artifact rather than silently missing.
- `library` — the reference corpus the turn was given, through the app's own
  already-public `libraryList()`, on **every** run rather than only those that
  install a pack. Read *after* the turn: `library:list` loads every pack into
  memory, so reading it beforehand would warm a cache the turn itself would
  have paid to fill, and the harness would become a participant in the timings
  it publishes. An empty library is what settles a claim to have retrieved from
  one.
- `driverClock` — the only clock in the directory the application did not
  produce. It **bounds** rather than measures: a stated duration longer than
  the whole run cannot have happened; one that fits inside it is not confirmed.
- `kept` / `notKept` — one entry per record, with what each settles. An absent
  audit says *the app was never asked to keep one*, which is a property of the
  staging and never of the build; before this, `auditExport: null` could not be
  told from an export that failed.
- `beyondAnyRecord` — the claims **no** artifact here can settle, named in the
  artifact instead of rediscovered by each critic. A figure the app timed with
  its own clock is the type case: a record of it is the same number written
  down twice, agrees by construction, and is evidence of nothing.
  - **v2.5, plan steps.** The app's session audit now carries a line per plan
    step boundary — for its own reasons, not this bench's: a plan step produces
    text the reader is shown, and a transcript of what was said that omitted it
    was incomplete against its own contract. So on a run that kept an audit, a
    plan header reading `3/3 steps done` over a record holding two finished
    steps is a **contradiction**, and `kept.session-audit` claims exactly that.
    It does not claim the other direction. The application writes the screen and
    the record both, so agreement between them is consistency and not
    corroboration, and `beyondAnyRecord` keeps that half — the same line
    `configuration` has always drawn between capability and exercise.

None of this changes what the application does. Every value comes through an
API the product already exposes and the harness already calls; no product file
is touched. What changed is what gets written down.

With it, statements the record can settle go from **9 of 120 to 55**, with a
further **41 settleable in part** (that a playbook was applied at all, not
which one), **14 unsettleable by nature** and **10 still wanting a record the
task did not stand up**. Runs where nothing at all is settleable fall from
**31 of 36 to 6** — `PT2`, `PT3` and `VC2` in both arms, whose only
self-statements are plan step boundaries.

`score-round.mjs` reports the difference: a column now says whether it was
uncontested because the question was *settled and agreed*, because *nothing
could settle it*, or because it was *never in play*, and prints a warning when
its ties are mostly the second — the case where it is reporting on the capture
rather than on either build.
