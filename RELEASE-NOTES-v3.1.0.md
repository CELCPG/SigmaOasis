# Sigma Oasis v3.1.0 — VIBE, polished and quick; a suite for the agent

3.1 measures before it adds. VIBE loses a box it never meant to draw, gains a light that says it
is thinking, and stops claiming it saved things it did not. A greeting is answered in a fifth of a
second on a model that fits the card, a chat no longer re-reads itself from the top every turn,
and a PDF no longer stops an agent's stream. The agent gets the suite every other part of the app
already had — twenty repositories it must fix, extend, refactor, explain or refuse, scored off the
disk — though its first baseline waits on the bench machine's hardware. Pinned by 3,049
node checks and every Electron check, on macOS, Linux and Windows.

## VIBE

- **No box in the composer.** The app-wide focus ring outranked VIBE's own style, and Chromium
  counts a text field as focus-visible after a mouse click, so every session drew a 2px accent
  rectangle inside the rounded glass. The pill's soft glow is the focus indicator now.
- **A light that says it is thinking.** The 12-pixel breathing dot is a geodesic sphere of light —
  42 points, 120 edges — turning, rippling, a comet on a tilted ring, breathing on the lagoon's
  4.8 seconds. One still frame under reduced motion. It never names what it is waiting on.
- **VIBE no longer claims a save it did not make.** Measured by the tool-choice suite with VIBE's
  line in place: asked "remember that my favorite band is Phish", the 9B called `memory_save` in 0
  of 3 runs with VIBE on and 3 of 3 without — and replied "I've saved that". The line now says VIBE
  changes only how the final reply reads, and that tools work as they always do; with it the VIBE
  arm matches the arm without VIBE on every one of the 24 fixtures, and replies stay short prose.

## Speed

Most of a slow "hello" on the bench machine was model fit, not the app: a 27B 1-bit quant at a
262K window read the prompt at about 40 tokens a second. What was the app's:

- **A coin-flip tool ranking no longer moves the toolbox.** Tools ride the system block, so a
  swapped tool re-read the whole conversation. v1.4.5 meant indecisive rankings to hold the list
  and implemented that for the first turn only; now it holds on every turn — and small talk never
  moves it at all ("thanks!" and "lol" had cleared the bar).
- **A greeting is answered without thinking first.** Pure small talk on a `<think>` model starts
  its first round with thinking closed: first word in 0.13–0.21 s instead of 0.6–2.4 s on the 9B,
  the same reply. Anything with a question, a number or a go-ahead thinks as before.
- **The model loads while you type** — at the first keystroke and on entering VIBE, not at Enter.
- **The app says when the model does not fit.** A reply that waited 8 s or more for its first word
  while reading under 150 tokens a second says so under its stats, with what usually fixes it; VIBE
  readers find the same line beside the slot in Settings → Models.
- **Measured, nothing to build:** a post-answer check costs the next turn about 80 ms of prompt
  cache, with one slot or two — LM Studio restores earlier prompts.
- **A PDF no longer stops an agent's stream.** Extraction runs in a worker thread: a PDF at the
  caps held the main process 320 ms at p99 and silenced a running stream for 355 ms; now 19–22 ms
  and 32 ms, the same as nothing running. Render windows are left as they are: five renders cost
  the loop 22 ms.

## A suite for the agent

3.0 shipped the agent on one live run. `npm run eval:agent -- <model>` runs the shipping engine —
the same `runAgentTask` the app and the `sigma` CLI run — on twenty small repositories: seeded
bugs, bugs that surface only once the first is fixed, small features, refactors, read-only
questions, tasks the folder cannot satisfy, and two long enough to overflow a 16K window. It scores
what the agent leaves behind: tasks solved, by hidden tests the agent never sees; false claims that
the tests pass; edits outside the task; whether Undo restores the folder byte for byte; and the
cost in rounds, time, tokens and the longest single round. Before any model runs, every case is
proven to fail untouched and to pass with a reference fix.

- **Its baseline is owed.** The first attempt stopped on the bench machine, not on anything the
  suite measures: two minutes in, the GPU's PCIe link began reporting corrected errors by the
  thousand a minute, and LM Studio died mid-case; a second attempt brought the errors straight
  back. Nothing from either is reported. The baseline runs once the machine is sound, and every
  agent change after it is judged against it.
- **What the attempt found.** LM Studio dying mid-reply reaches the engine as a bare `terminated`,
  which the rule that sets server failures aside did not know — the case it cut short was scored
  instead of excluded. It knows it now.

## Underneath

- **`useLMStudio.ts` is the hook again: 1,662 lines to 599.** One model's turn moved to
  `hooks/chatTurn.ts` and everything after its last token to `hooks/turnTail.ts`, verbatim; the
  tail runs under node:test for the first time.
- **One Undo.** The app and the CLI each had their own; it is one function now, and the agent suite
  scores the one users get.
- **A nested test runner no longer passes everything.** A `node --test` started from inside Node's
  own test runner reported success whatever its tests did; commands the agent runs no longer inherit
  that state. The app never runs inside a test runner, so no user saw it.
- New measuring tools: `npm run eval:agent`, the VIBE arm of `eval:tools` (`EVAL_VIBE=1`), and
  `npm run bench:main-loop`.

## Measured

On Windows: `npm run typecheck` clean; the node suite 3,049 of 3,049; the Electron checks —
render 25, style 74 and 123, tab traversal 43, modal focus 179, field contrast 22, plan
accessibility 175, main bundle 20, markdown 62, MCP secrets 19, transport 24. The Workbench's
checks need the Python runtime, which CI fetches, and run there on all three systems.

## Not in this release

- **The agent's baseline, and the speed changes it gates.** A low-water mark for context fitting,
  so a long task stops re-reading its history every round, and `read_file` over several files at
  once are built and tested on the branch `feat/m2-speed-candidates`; a lower cap on one round's
  output needs the baseline's longest-round figures first. Each ships when the baseline says it
  makes the agent faster without making it solve less.
- **The 35B-A3B runs** of VIBE's tool-choice arm and of the agent suite.

## Upgrade notes

- Nothing to migrate: settings, conversations, projects and packs read as they did in 3.0.1.
- PDF text is extracted by a second main-process entry, `pdfWorker.js`, built beside the main
  bundle; a build without it extracts in the main process as before.
- The MCP client introduces itself to servers as `sigma-oasis 3.1.0`.
