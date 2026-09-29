# Roadmap: Sigma Oasis 4.0 — the whole app to one standard

3.0 made the window calm and gave it an agent. What it did not do is bring every surface up to
the standard the chat sets. Settings is fourteen flat tabs in an opaque box, with five kinds of
checkbox and two save models nobody is told about. The first screen offers four topics that show
nothing the app can do. The agent is a coding agent, measured on one run, that a 9B model drives
slowly. 4.0 is the release where all of that changes at once — and, in this app's habit, where
every change to what a model does is judged against a suite before it ships.

Written 2026-09-28 against main at `2ac3c2e` — 3.1's M3, M4, the VIBE polish (V1, V2) and the
speed items (S1–S6) landed — with `eval:agent` and the 3.1.0 notes on `feat/m1-agent-baseline`
and the M2 candidates on `feat/m2-speed-candidates`, both unmerged, and no v3.1.0 tag. Nothing
below is built. The measurement work in `ROADMAP-v3.1.md` is the entrance to this release, not a
rival to it; where an item there moves here, the table below says so.

## Four tracks

| Track | What it claims | Changes what a model does? | Gate |
| --- | --- | --- | --- |
| **S** — Settings | Settings looks and works like the rest of the app | No | Render checks, both themes; screenshot scenes |
| **A** — Agentic leaps | Small models solve more tasks in fewer rounds | Yes | `eval:agent` against M1's baselines |
| **C** — Common-use agent | The agent works on documents, folders and the web, not only code | Yes | New `eval:agent` kinds, with baselines |
| **F** — The front door | The first screen shows the three ways in and what this machine can do | No | Render checks; the tool-choice suite unchanged |
| **E** — Everything else | Setup, models, the palette, a11y, Windows | Mostly no | Named per item |

## Where 3.1's items land

| `ROADMAP-v3.1.md` item | Lands | Why |
| --- | --- | --- |
| M1 `eval:agent` baselines | **Before anything in A or C** | The suite is built (twenty cases, on `feat/m1-agent-baseline`). The baseline is not: both attempts stopped when the bench GPU's PCIe link began reporting corrected errors by the thousand a minute and LM Studio died mid-case. Every A and C item is scored against it, so it needs a sound machine first (E9, decision 8). |
| M2 speed (context low-water mark, batched reads) | A1 | Built and tested on `feat/m2-speed-candidates`, unmeasured; the round cap waits on the baseline's longest-round figures. |
| M3 VIBE arm of `eval:tools` | **Done, 3.1** | Matches the no-VIBE arm on all 24 fixtures on the 9B; the 35B-A3B run is owed. Found that VIBE's line had suppressed `memory_save` (0 of 3), fixed. |
| M4 main-process delay | **Done, 3.1** | PDF extraction in a worker: 320 ms p99 to 19–22 ms. Render windows measured at 22 ms and left alone. C1's office extraction goes through the same worker path. |
| S1–S6 speed, V1–V2 VIBE | **Done, 3.1** | S6's model-fit verdict (`lib/modelFit.ts`) and S2's warm-on-keystroke are what E1 and F1 build on. |
| D1 hooks, D2 slash commands, D3 git worktrees | A8, C7, A9 | 3.2's "daily tool" items are 4.0's agent track. |
| D4 VS Code, D5 CLI socket | Unchanged, 3.2/owner | Not touched by 4.0. |
| `useLMStudio.ts` extraction | **Done, 3.1** | 1,662 lines to 599; the turn in `chatTurn.ts`, the tail in `turnTail.ts`. |

---

## Track S — Settings

### S0. The review: what "cheap" is, specifically

Captured from the built renderer (`scripts/capture-screenshots.js` with a settings scene, S6)
and read from the fourteen tab files. The chat around the modal is glass: 24px radius, a light
streak on every panel, ambient orbs, uppercase tracked section labels in the right panel. The
modal is not:

1. **The box is opaque and small.** `SettingsModal.tsx` draws `bg-panel-dark` (#0a0a0c), no glass,
   no streak, 80vh tall and 768px wide, with a 160px text-only rail of fourteen labels in no order
   a user would predict (Connection, Models, Pipeline, General, Agent, Tools, Search, Privacy,
   Voice, Memory, Library, MCP, Jobs, Skills). The one surface in the app that ignores
   `sigma_oasis_visual_style_guide.md` is the one that says what the app is.
2. **Five kinds of checkbox, no switch.** Every boolean is a bare `<input type=checkbox>`, in
   five variants: top-aligned with nested help, the same with `mt-1`, centred with help in a
   separate paragraph, `accent-accent` with no size and no help, and fully unstyled browser
   default (MCP and Jobs "On", MCP's per-tool boxes). No `role=switch` exists anywhere.
3. **Four label sizes, four button paddings, three status-dot palettes.** Labels are `text-sm
   font-medium` in five tabs, `text-xs font-medium text-ink-secondary` in two, a `text-xs`
   wrapper in three, plain `text-xs` elsewhere. Bordered buttons come in `px-2.5 py-1`, `px-3
   py-1`, `px-3 py-1.5` and `px-3 py-2`; a `BUTTON` constant is redefined locally in Agent, Jobs,
   Library and Skills with different values. Dots are `green-500` in four tabs, `emerald-500` in
   two, `neutral-400` in one, and two sizes. The shared `FIELD` class from `settings/helpers.tsx`
   is used by three tabs; the other eleven inline their own.
4. **Two save models, unmarked.** Connection, Models, Pipeline, General, Agent, Tools, Search,
   Privacy, Voice and Memory write a draft that *Save* commits. Library, MCP, Jobs, Skills, the
   standing grants, the CLI installer, the Brave key, the knowledge base and the audit actions
   apply at once. Nothing on screen says which a control is. Two buttons — *Test proxy* and
   *Test connection* — save the whole draft as a side effect.
5. **Eleven destructive actions with no confirmation.** MCP, Jobs and Skills *Remove*; Tools
   *Revoke* and *Revoke all*; Memory's per-source ✕ and *Forget them*; Privacy *Forget* and
   *Clear*; the Brave key's *Remove*; the CLI's *Remove*. Only Library's pack *Remove*, the audit
   *Purge all* and the footer's *Reset to defaults* are guarded, each a different way.
6. **Models is 140 controls on one scroll.** Five slots by default, each some 27 controls with
   two native `<details>` blocks, under an eval card that belongs to a different concern. The
   seven grounding toggles (auto-correct, playbooks, self-review, workbench checks, ledger, fact
   ledger, outline) sit under the heading *Second opinion*, which they are not.
7. **Tools is a list of 27 checkboxes with the wire name in monospace on the right** and no
   description of any tool, grouped by nothing, though the tool table (`src/shared/tools/index.ts`)
   already groups them by domain and carries a decision-rule description for each.
8. **Help lives in tooltips** on Library's buttons, MCP's approval select, Privacy's exports,
   the sampling presets and the CLI installer — invisible on a touchpad, absent on keyboard.
9. **Diagnostics and settings share tabs.** Privacy is a promise, an audit, an update toggle, a
   proxy form, three shopping settings, a RAM page cache, an encrypted log and a network log.
   Memory is a status probe, three settings and a knowledge base.
10. **Nothing is searchable and nothing is linkable.** The renderer says "Settings → …" in 65
    places outside Settings itself (composer chips, the right panel, the privacy audit, empty
    states, error notices); `openSettingsAt` can open a tab and no more.

### S1. The shell

A settings surface that is a glass panel like every other: `glass-panel` at 24px, the streak,
90vh and up to 1,100px wide so Models and Tools stop scrolling inside a scroll. The rail gets
icons, uppercase tracked group headers in `PanelSection`'s style, and an order that reads as a
story:

| Group | Tabs |
| --- | --- |
| **Setup** | LM Studio (was Connection), Roles (was Models), Appearance & chat (was General) |
| **Intelligence** | Grounding & checks (new; from Models), Pipeline, Memory |
| **Capabilities** | Tools, Agent, Search & research, Voice |
| **Knowledge** | Library, Skills, MCP |
| **Automation** | Jobs |
| **Privacy** | Privacy, Activity (new; from Privacy) |

The header shows the tab's name and one line saying what it governs; every tab opens with that
line rather than the six different intro styles today. A search field in the rail filters every
control by label, help and keywords (S5). Arrow keys move the rail; `⌘,` opens; `⌘F` inside
focuses the search; Esc closes as today.

### S2. One control kit

Every tab is rebuilt from a small set of components, in `components/settings/kit/`, each with
one look in both themes and one keyboard behaviour:

| Component | Replaces | Notes |
| --- | --- | --- |
| `Switch` | every checkbox | `role=switch`, `aria-checked`, a track and thumb in the accent, Space toggles; label left, help under it, control right |
| `Row` | ad-hoc `<label>` blocks | label, help, and a control slot; the one place label size and help colour are set |
| `Section` | `border-t` dividers and bare `<div className="text-sm font-medium">` | title, one-line description, optional right-side action |
| `Field`, `Select`, `Textarea` | inline classes | the `FIELD` surface, one padding, one focus ring; `Textarea` grows to its content |
| `Segmented` | General's theme control, Search's provider cards, Agent's radio list | one component for a 2–4 way exclusive choice; a `cards` variant with a hint per option |
| `Stepper` | number inputs | with min, max, unit and step; typed values still allowed |
| `Slider` | five sliders in two widths | value shown at the right, not in the label |
| `Chips` | the sampling preset pills and the accent swatches | |
| `ActionRow` | button + readout pairs (Test, Refresh, Re-check, Run eval, Look up) | button left, result inline right, busy state in the button |
| `DangerRow` | every unguarded Remove/Revoke/Forget/Clear | the action names what goes; a second click or an inline confirm within four seconds, the way *Reset to defaults* already works |
| `StatusDot` | three palettes | one palette: `ink-ok`, `ink-warn`, `ink-danger`, `ink-muted`; one size |
| `Notice` | amber wells, grey wells, plain xs lines | `info`, `ok`, `warn`, `danger`; `role=status` |
| `Card` | bordered `rounded-xl` and `glass-panel rounded-xl` | one card |
| `Disclosure` | native `<details>` in Models | the existing animated `Disclosure` with a header |

A render check, `settingsKitCheck`, walks every tab in the built app and fails on any
`<input type=checkbox>` or `<input type=radio>` inside Settings, any button with no text and no
`aria-label`, any label outside a `Row`, and any control without a help string or a `title`.
`fieldContrastCheck` keeps running as it does.

### S3. Apply as you go

The draft-and-Save model goes. Every control applies when it commits — a switch on click, a
field on blur or Enter, a slider on release — the way macOS System Settings and VS Code work, and
the way four of the fourteen tabs already do. What replaces the safety Save gave:

- **A toast per change**, bottom of the panel: "Theme: Dark — Undo", four seconds. Undo puts the
  one value back.
- **Reset per section**, not per app: *Reset to defaults* moves from the footer into each
  `Section`'s overflow menu and names what it resets. The global reset stays under Privacy,
  guarded as today.
- **No control saves another.** *Test proxy* and *Test connection* test what is on screen; the
  values have already applied, so there is nothing to save silently.
- **Fields that can break the app commit deliberately.** The server address and a slot's model
  are `Field`s that apply on Enter or blur, never on keystroke, and the address shows the
  loopback warning before it commits, as it does now.
- The live theme and font preview stay, and become simply the setting.

The `settings` IPC already takes the whole object; this needs a `settings:patch` that takes a
path and a value, so a toggle does not rewrite the models array, and so the toast knows what to
undo. The store's `setSettings` keeps working for the tabs that batch.

### S4. Tab by tab

**LM Studio** (was Connection). A status hero: the dot, "Connected — 4 models, 2 loaded", the
address as one `Field` with the loopback note, *Test* as an `ActionRow`. Under it, the detected
models as rows — name, quantization, context, loaded or not, and which role uses it — instead
of a monospace bullet list. E2's load and keep-loaded controls land here.

**Roles** (was Models). A list first: one row per slot with its colour dot, role name, model,
specialty chip, and a switch; the profile, eval and model-fit lines (3.1's S6) stay under the
model. A slot whose model id the server no longer lists — the bench machine's Assistant named
`_disabled-qwen3.8-9b` for weeks — shows it in the row with a one-click re-pick from what is
loaded, instead of failing at the first message. Clicking a row
opens the slot's detail in place (a `Disclosure`), where the persona and standing rules are two
growing `Textarea`s, capability and specialty share a `Row`, and *Tools* and *Sampling* are two
`Disclosure`s with a summary ("6 of 27 tools · Qwen3 defaults"). The tool-choice eval card moves
to the bottom, an `ActionRow` with its progress. The pipeline order moves here as a `Section`,
which retires the Pipeline tab.

**Grounding & checks** (new). The seven grounding toggles, second opinion, claim checking and
outline-first, each a `Switch` with the help it already has, grouped: *Before the reply*
(playbooks, outline), *After the reply* (auto-correct, self-review, claim check with its
`Stepper`, workbench checks), *Across replies* (ledger, fact ledger). Second opinion's reviewing
role is a `Select` shown when it is on.

**Appearance & chat** (was General). Theme as `Segmented` with a *System* option added; font
size as `Slider`; a *Density* segmented (comfortable, compact) that sets a root class the chat
already tolerates; reduced motion as a `Switch` that overrides the OS query; VIBE; tool-call
details, response stats and reasoning display as a *Chat* section; context management and the
plan settings as *Long conversations*. History limit as a `Stepper`. *About* keeps the update
row, as an `ActionRow`.

**Agent.** The default mode as `Segmented` cards (Ask first, Accept edits, Read-only) with the
hints they have; steps and command time limit as `Stepper`s; the two switches; then *Shell*: the
shell the agent will use on this machine, detected and shown (Git Bash found at …, or cmd.exe),
which today is decided silently in `command.ts`; then *The sigma command* as a `Card` with an
`ActionRow` (Installed at … · Update · Remove).

**Tools.** Grouped by the tool table's own domains — Files, Web, Research, Calculators, Notes,
Memory, Library, Workbench, Shopping, Market — each group a `Section` with a header switch that
toggles the group, and each tool a `Row`: the label, the first sentence of its decision-rule
description as help, a budget chip where `turnBudget` is set, and a `Switch`. Wire names go
behind a *Show tool ids* toggle in the section header. The working directory is a `Field` with
*Browse…*; the Workbench card becomes a status `Card` with an `ActionRow`; standing grants a
`Section` of `DangerRow`s.

**Search & research.** Provider as `Segmented` cards; then *Search* (results per search, confirm
every query, the JavaScript renderer) and *Deep research* (budget, approve plans) as two
sections instead of one grid that pairs a slider with a select.

**Privacy.** The promise; the audit as a scorecard `Card` (rows with the dot palette, and each
row's *where* a deep link, S5); automatic updates; the proxy as a `Segmented` mode with host and
port `Field`s that carry labels; the three shopping controls under *Shopping*.

**Activity** (new). The network activity log, the pages read this session, and the session audit
log — the three things in Privacy that are records rather than settings. Each with its
`ActionRow`s and `DangerRow`s.

**Memory.** A status `Card` (embedding model resolved, chunks indexed, the mixed-model warning);
the two settings; the knowledge base as a table with a `DangerRow` per source.

**Library, Skills, MCP, Jobs.** The same shape for all four: a list of `Card`s with a `StatusDot`,
a switch where there is one, and actions in one order (primary, secondary, danger); an *Add…*
button that opens the form as a sheet over the list rather than a permanent form beneath it;
`DangerRow` on every Remove. Library keeps its progress bar and *Try a lookup*; MCP keeps the
2-second refresh and the stderr log behind a `Disclosure`.

**Voice.** Two `Card`s, Text-to-speech and Push-to-talk, each with its status `ActionRow`. The
whisper paths become `Field`s with *Browse…* and their help below, not inside the label.

### S5. Search and deep links

Every `Row` registers `{ tab, section, id, label, help, keywords }` in a settings index. The rail
search filters tabs and rows and highlights matches; `⌘K` gains *Settings: …* entries from the
same index (E4). `openSettingsAt` takes a row id as well as a tab, scrolls to it and pulses its
`Row` once. The 65 places that say "Settings → X" become links to the row they mean:
the composer's armed-tools chip, the right panel's roles note, every privacy-audit row's *where*,
the onboarding checklist's fix buttons, the agent header's mode, and `docs/` text becomes
`sigma://settings/<id>` where the docs are rendered in-app.

### S6. Gate

- `settingsKitCheck` green; `fieldContrastCheck` green; both themes.
- `scripts/capture-screenshots.js` gains `settings-<tab>-<theme>` scenes, and README shows one.
- Every control keyboard-operable, verified by a check that tabs through a tab and asserts
  every `Row`'s control received focus.
- No behaviour change on the wire: `eval:tools` and the trace schema hash unchanged, because no
  tool description or order moves.

---

## Track A — Agentic leaps for small models

The premise: a 9B model is not short of intelligence per token, it is short of tokens per
minute and of window. Every item here spends fewer tokens per solved task, or puts the right
ones in the window, and each is shipped only if `eval:agent`'s solved rate holds or rises on the
stable set and false claims and collateral do not rise. Baselines first (M1) — and 3.1's VIBE
arm is the caution: a one-line prompt change silently stopped a 9B saving memories, and only the
suite saw it. A1 starts from the code already on `feat/m2-speed-candidates`.

### A1. Speed, as 3.1 specified

M2 verbatim: the context low-water mark so elision stops discarding the KV cache every round;
the round generation cap tried at 8K and 4K; `read_file` taking several paths. Measured as
prompt-processing time per round and rounds per solved task.

### A2. Tool results shaped for a small reader

The cheapest lever. Every result is text a model must read, and today most results are raw:

- `run_command` on a test runner returns the runner's output whole. Recognise the common
  runners (node's, `pytest`, `vitest`, `jest`, `go test`, `cargo test`) and put a digest first:
  "3 failed, 41 passed", then each failure's name, file:line and message, then the raw tail.
  The model reads the digest and stops.
- `grep` groups hits by file with counts and shows two context lines only when asked.
- `list_directory` shows sizes and a `(binary)` mark, so the model stops opening images.
- `edit_file` returns the edited window (ten lines either side) so the follow-up `read_file`
  that every model makes to check its work is unnecessary — and the prompt says so.
- Every truncation says what it kept and how to get the rest, as `read_file` already does.

*Measured:* prompt tokens per solved task, rounds per solved task, on M1's stable set.

### A3. Think when it matters

Qwen3-class models think before every tool call, and most of 3.0's thirteen minutes was that.
Two phases need thought — the plan and the report — and the rounds between them mostly need a
call. The lever is the one 3.1's S3 measured and shipped for small talk: on the `<think>`
families (`THINK_TAG_MODELS`), the round begins with the thinking block already closed
(`shared/thinking.ts`), which cut a greeting's first word from 0.6–2.4 s to 0.13–0.21 s with the
same reply. `enable_thinking`, `/no_think` and `reasoning_effort` were measured inert on LM Studio
in v1.4.1 and are not the plan. Per model family, in `modelProfiles.ts`: a **thinking budget by
phase** — thought on the first round and on any round after a failed check, none on a round
whose last result was a successful read, and a `max_tokens` on the round with the
thinking-channel recovery for families outside the tag list. The profile is a prior; the suite
says whether it holds.

*Measured:* wall time per solved task, with solved held. The risk is exactly the one the suite
scores: a plan made without thought that solves less.

### A4. Plan, then act on one thing at a time

The engine has `todo_write` and the chat has structured plan generation (`plan.ts`, grammar-
constrained where the server allows). Put them together: for a task the first round judges as
three steps or more, the plan is a structured-output round whose steps become the checklist,
and each step then runs as its own focus — the system prompt names the current step, the
history carries the plan and the step's own rounds, and earlier steps' tool output is the first
thing context fitting sets aside. A small model that holds one step at a time holds it well.

*Measured:* solved on the chain, feature and long kinds; elisions per task.

### A5. A verify round that cannot be skipped

False claims are the number the agent's honesty rests on. Before the report, when any file
changed and a test command exists (from `SIGMA.md`, the case, or the last command run), the
engine runs one more round whose only offered tool is `run_command` and whose prompt says: run
the check, then report with its exit code. A report that names a passing check the timeline
does not show is rewritten by the engine with the line "no check ran" — the grounding checks'
rule, applied to the agent.

*Measured:* false claims on all kinds; solved must hold.

### A6. Ask, as a tool

The *needs you* kind measures whether the agent stops and names what it lacks. Today it can
only say so in a report. `ask_user` becomes a tool: a question and, optionally, choices; the
task pauses in the *paused* state the round cap already uses, the chat shows the question as a
card with the choices as buttons, the answer is the next user message, and the CLI prompts.
Helpers cannot ask; they report.

*Measured:* the needs-you kind — the missing thing named, nothing changed, no success claimed.

### A7. A reviewer before the report

Helpers exist. The *review* helper becomes a switch (Settings → Agent, off by default): before
reporting, the agent hands the diff of everything it changed to a review helper, which returns
either "no problems" or a list, and the list becomes one more round. It costs a task one
helper; the question is what it buys.

*Measured:* solved and collateral with the switch on and off; shipped on if solved rises or
collateral falls outside noise, otherwise off with the result in `docs/evals.md`.

### A8. Hooks, as 3.2 specified

D1 verbatim: `.sigma/hooks.json` with after-edit, before-command and task-end commands, each
under the standing-grant rule, each a line on the timeline, and an after-edit failure handed to
the model. A formatter hook is the difference between an edit that lands and an edit that lands
and then fails lint in CI.

### A9. Git worktrees, as 3.2 specified

D3 verbatim, and here for one added reason: C2's folder chores are the first tasks a user will
run on a folder that is not a repository, and D3's rule that the app does the git and hands the
model none of it is what keeps the two cases the same shape.

### A10. Notes the agent keeps about a folder

`SIGMA.md` is the user's. `.sigma/notes.md` is the agent's: at the end of a task it may propose
an edit to it — how the tests run, where the entry points are, what surprised it — shown as a
diff like any edit, landing under the task's mode. The next task in that folder reads it after
`SIGMA.md`. The prompt rule: "notes are facts about this folder you verified, not the task's
story; keep them under forty lines."

*Measured:* M1's cases run twice on the same scratch folder; rounds per solved task on the
second run.

---

## Track C — The agent for everyone's folders

The agent's tools are the ones agentic CLIs converged on, which is to say a programmer's. The
folders most users own are Documents, Downloads, a year of photos and a spreadsheet they dread.
Each C item adds a capability and the `eval:agent` kind that measures it, with three cases and
a reference solution each, scored the way the existing kinds are.

### C1. Documents: read and write the files people actually have

The Workbench (Pyodide) is the engine. `read_document(path)` turns `.docx`, `.xlsx`, `.pptx`,
`.pdf`, `.csv` and `.md` into structured text with headings, tables and sheet names — PDF
through the existing extractor in `pdf.ts`, the rest through pure-Python libraries staged into
the sandbox the way skill helpers are (`openpyxl` is in Pyodide's own package set; `python-docx`
and `python-pptx` are pure Python over `lxml`, which Pyodide ships; the first spike confirms the
set and the size). `write_document(path, content)` goes the other way from Markdown or from a
sheet description, and the edit shows in the chat as the text diff of what the document says.
The Python runs in the sandbox with the file mounted under `/work`; the host's disk is never
mounted, as now, and the bytes come back through the checkpointed write path.

*Kind* `office`: total a column and add it to the sheet; fill a letter template from a CSV;
merge two spreadsheets on a key. *Solved when* the hidden check reads the file back and finds
the figures.

### C2. Folder chores

`move_file`, `copy_file`, `rename_file`, `make_directory`, and `delete_file` — which sends to the
system trash and never removes. All inside the folder, all checkpointed: checkpoints today record
content; they gain a journal of moves so Undo reverses a rename or a move, and a trash so Undo
restores a delete. A move is shown on the timeline as "Moved a → b", and in *Ask first* is
approved like an edit. The danger list (`commandDanger.ts`) already refuses `rm -rf` in a
command; a typed tool is how the model never needs one.

*Kind* `tidy`: sort a Downloads folder into folders by type and month; find and remove
duplicate files by hash, keeping the oldest; rename a batch of photos by their EXIF date.
*Solved when* the hidden check finds the layout the case describes and nothing lost; *undo*
must restore the original layout byte for byte.

### C3. A recipe is a skill with an agent method

`docs/skill-format.md` gains `agent.md`: a method for a task, not a turn. A skill with one fires
in an agent chat when its trigger matches the task, and its text follows `SIGMA.md` in the
prompt. The app ships four, the ones the front door offers (F3): *Tidy a folder*, *Summarize
what is here*, *Fill a template from data*, *Fix the failing test*. A skill's helpers stage into
the sandbox for C1's tools as they do for `run_python`.

### C4. Web tasks, read-only

The agent already has `web_search`, `fetch_webpage` and `deep_research` through the app's audited
transport. Add `browse(url, instruction)`: the headless renderer (Settings → Search's JavaScript
option) loads the page, the page script (`pageScript.ts`) extracts what the instruction asks —
the table, the prices, the links matching — and returns text. No form is submitted, no cookie
persists between calls, no login. It is `fetch_webpage` for pages that are applications.

*Kind* `gather`: collect a table from three pages into one CSV; find the newest release on a
project's page and write its notes to a file. *Solved when* the file holds the figures the case
lists; the activity log shows only the case's hosts.

### C5. Standing agent tasks

Jobs gains a fifth kind: a **read-only agent task** in a folder, on the schedule Jobs offers.
"Every Monday, summarize what changed in this folder since last week"; "every morning, read the
new files in my inbox folder and list what needs a reply." Read-only means no edit, no command
and no confirming tool — the rule every job already lives by — so nothing runs unasked and
nothing needs a grant. The digest conversation gets the report.

### C6. Files into an agent chat

Dropping a file on an agent chat copies it into `<workspace>/.sigma/inbox/` and tells the model
where it is; a task with no folder gets a scratch folder for the same purpose, so "summarize
these three PDFs into one page" needs no folder picking. The inbox is named in the timeline and
cleared by Undo.

### C7. Slash commands, as 3.2 specified

D2 verbatim: `.sigma/commands/*.md` and the app's own folder, `$ARGUMENTS`, in the composer and
in `sigma`. A command is text; a recipe (C3) is a method. Both are shortcuts to typing.

### C8. MCP tools for the agent

`AGENT_APP_TOOLS` lists the app's own tools an agent may hold. MCP servers that are on join it
under the server's own approval mode, with the same untrusted marking the chat applies, and the
agent's budget for them is the chat's. This is the item that lets a user's own filesystem or
calendar server be the agent's, and it changes nothing about how a server is trusted.

*Measured:* `eval:agent` unchanged with no server on; the MCP suite's on-the-wire checks with
the fixture server, from an agent chat.

---

## Track F — The front door

### F0. What is wrong with "Start a conversation"

The screen (`EmptyState.tsx`) is a logo, a heading that is a label, a tagline, four topic cards
and two pills. The topics — a budget, first aid, home repair, "dig into a question" — are
subjects, not demonstrations: three of them work on any chatbot, and the one that shows the app
(*Money, explained*) routes to a role that ships disabled, so the shortcut silently does nothing
for a new user. The cards prefill a sentence the user must then read and send. The two other
ways in, which 3.0 made equal in the rail, are afterthoughts under the grid. The screen knows
nothing: not whether a model is loaded, not what the user did yesterday, not that a task is
running in another chat, not that a digest arrived overnight. And the agent's own empty state
(`AgentEmpty`) is a second, different screen.

### F1. Three doors, equal

The top of the screen is the three ways in as three glass tiles, the same three the rail offers:
**Ask** (a chat, the composer below), **Work in a folder** (the agent; opens the folder picker),
**Just talk** (VIBE). Each has a verb, a one-line "what this is for", and its shortcut. The
heading becomes the user's own: the time of day and nothing else ("Good evening"), or the
project's name when inside one, with the project's instructions summarized in one line under it.

### F2. Pick up where you left off

Under the doors, when there is anything to show: the two most recent chats as rows (title, when,
the role that answered), a running task's *Working now* card with its checklist progress, and an
unread digest from Jobs. Nothing is shown when nothing is there; the screen is never padded.

### F3. Try what this machine can do

Six cards at most, each a capability the app has that a cloud chat cannot do privately, each
naming the tool or mode it runs and greyed with a reason when that tool is off — and the reason
is a link to the row that turns it on (S5). The set is chosen from what is enabled, in this
order of preference:

| Card | Runs | Shown when |
| --- | --- | --- |
| Summarize a document I drop in | attachments, `analyze_file` | always |
| Check the math in this spreadsheet | `run_python` | the Workbench is running |
| Research this, with the sources | `deep_research` | search is configured |
| Tidy my Downloads folder | agent + the *Tidy* recipe (C3) | always; opens the picker on Downloads |
| Fix the failing test | agent + the *Fix* recipe | always |
| What do you remember about me? | `memory_search` | memory has anything |
| Look something up in the library | `reference_lookup` | a pack is installed |
| Compare prices for … | `shop_compare` | shopping tools are on |

A card's click puts a short prompt in the composer as today — a sentence, not a paragraph — or,
for the agent cards, starts the picker. Cards carry the tool's colour from the style guide
(search teal, code amber, memory lavender, files coral), so the first screen teaches the colours
the chat then uses.

### F4. State, when it matters

When LM Studio is not running or no model is loaded, the doors give way to one card that says
so and offers the fix — the onboarding checklist's items, in place, rather than a modal. After
an update, one line: "3.1 → 4.0 · what changed", opening the notes. In VIBE nothing changes.

### F5. One empty state

`AgentEmpty` and `EmptyState` become one component with a mode. An agent chat's empty state is
the same screen with *Work in a folder* already chosen: the folder, the mode and the model as
they are in the header, the recipe cards (C3) in place of the capability cards, and the two most
recent tasks on this folder.

*Gate:* render checks for every combination (no server, no model, empty, populated, in a
project, agent chat); the reduced-motion check; the tool-choice suite unchanged, because the
starters' prompts are the only text that reaches a model and they are shorter than today's.

---

## Track E — Everything else

### E1. Setup that knows the machine

First run asks LM Studio what is loaded and, when nothing is, reads the model catalog
(`modelCatalog.ts`) against the machine's GPU memory — the bench machine's 12 GB fits a 9B at
speed and a 27B or 35B only with a window that makes first tokens take a minute — and suggests a
starting model and a context size, with the reason. The suggestion is a line and a copyable
`lms` command, not an install: the app does not download models. 3.1's S6 already judges a
model *after* a slow reply (`lib/modelFit.ts`: 8 s to the first word at under 150 tokens a
second); E1 is the same judgement made *before* — from the loaded window, the quantization and
the card — and its five measured slow replies are the fixture the rule is written against.

### E2. Models that stay loaded

The eval work found what every long session finds: LM Studio unloads a model loaded on demand
when another client asks for a different one, and the app is that other client to itself
(`modelPin.ts`). Roles gains *Keep loaded* per slot and LM Studio gains *Load* and *Unload* on
each detected model — through the `lms` CLI when it is installed, or LM Studio's native REST
API where the running version offers a load call; the spike says which, and the row says which
it is using. The status hero (S4) shows loaded versus evicted honestly.

### E3. The right panel and the header agree with Settings

The chat header's mode, model and folder controls, the right panel's roles and strategy notes
and the composer's chips are built from the S2 kit's `Segmented`, `Select` and `Chips`, so a
control looks the same in the chat as in Settings. No behaviour change.

### E4. The palette knows Settings and recipes

`⌘K` lists every settings row (S5) and every recipe and slash command (C3, C7) beside the
actions it has. Typing "proxy" opens Privacy at the proxy row.

### E5. Accessibility

Every icon button gets an `aria-label`; the modal, the palette and the sheets trap focus; the
`Switch` and `Segmented` follow the ARIA patterns; the chat's tool blocks and the agent timeline
get `aria-live` announcements for state changes (a step landed, a task paused); and a check runs
axe-core's rules over every scene `capture-screenshots.js` knows. Reduced motion is already
honoured everywhere it should be.

### E6. Debt that gates the above

M4 is measured and the PDF worker landed in 3.1; C1's office extraction runs through the same
`pdfOffThread.ts` path and `bench:main-loop` gains a phase for it, held to the same 20 ms p99.
`useLMStudio.ts` is 599 lines and stays under 600. `SettingsModal.tsx`'s two dozen `useState`
hooks of tab state move into the tabs that own them as S4 rebuilds each. `library.ts` (1,690)
and `search.ts` (1,536) split along their seams when C1 and C4 touch them, as 3.1 said.

### E9. A suite that knows when the machine is unsound

Both `eval:agent` baseline attempts were lost to the bench GPU's PCIe link, and nothing in the
run said so until the owner read the driver's counters. The eval runners (`eval:agent`,
`eval:tools`, `eval:answers`) read the GPU's corrected-error counters where a vendor tool exists
(`nvidia-smi -q` on the bench machine) before the run and after each case, print the delta, and
mark a run whose count moved as *machine*, beside *server*, so it is excluded and named rather
than scored or lost. The app's own model-fit line (S6) gains the same source: a reply that was
slow while the counters moved says "the GPU reported errors during this reply", not "the model
does not fit".

### E7. Windows

L2's signed installer, still owed and still the owner's account. The shell the agent uses shown
in Settings → Agent (S4). The Git Bash detection tested on CI's Windows leg with and without
Git installed.

### E8. Export and import settings

A settings profile (`.sigma-settings.json`) — everything except keychain values, which are named
and left blank — exported from Privacy and imported on first run or from Settings. For a user
moving machines, and for a paid build whose buyer has a second computer.

---

## Decisions for the owner

1. **Apply-as-you-go** (S3) versus keeping Save. The recommendation is apply-as-you-go with a
   toast and Undo; it removes the two-model problem outright. If Save stays, it must be one model
   for all fourteen tabs, which means Library, MCP, Jobs and Skills gain a draft they do not want.
2. **The tab order and names** in S1. "Roles" for Models, "LM Studio" for Connection,
   "Grounding & checks" and "Activity" as new tabs, Pipeline retired into Roles.
3. **Office-file libraries in the installer** (C1): tens of megabytes of Python wheels shipped
   with the app, or downloaded on first use through the audited transport and named in the
   privacy audit.
4. **`delete_file` to the trash** (C2): the one tool that touches something outside the folder
   (the system trash). The alternative is a `.sigma/trash/` inside the folder, which Undo owns
   completely and which the user empties.
5. **A reviewer by default** (A7), if the suite says it pays: it doubles the model time of every
   task that edits.
6. **The first screen's greeting** (F1): a time-of-day line, or the app's name as today.
7. **Model loading through `lms`** (E2): the app running a CLI the user installed, under the
   same grant rule as any command, or the REST route only.
8. **Where the baselines run** (M1, E9). The bench machine's GPU reported PCIe errors under
   sustained load twice on 2026-09-28. Until it is sound — a reseated card, a driver, a different
   slot — or a second machine runs LM Studio, no A or C item can be measured, and 4.0-beta and
   4.0 cannot ship as gated. The alternative is to build A behind switches that default off and
   ship 4.0-alpha alone; that is a version without the agentic claim.

## Sequencing

| Release | Contents | User-visible claim | Gate |
| --- | --- | --- | --- |
| **3.1.0** | Merge `feat/m1-agent-baseline` (the suite, the notes, the version) and tag; `feat/m2-speed-candidates` stays a branch until measured | VIBE polished and quick; a suite for the agent | The suites green on three systems (they are, per the notes); the baseline stays owed and the notes say so |
| **Baselines** | M1 on a sound machine, then M2 measured from its branch | The agent, measured | `eval:agent` baselines committed; E9's counters flat through the run |
| **4.0-alpha** | S1–S6, F1–F5, E3–E5, E9 | Settings and the first screen that look like the app | Render checks, both themes; no wire change (`eval:tools` and the schema hash unchanged) |
| **4.0-beta** | A1–A7, A10, E2, E6 | A 9B that solves more, faster, and never claims a check it did not run | `eval:agent` within noise or better on every A item; false claims down |
| **4.0** | C1–C6, C8, A8–A9, C7, E1, E7, E8 | The agent for documents, folders and the web; recipes; standing tasks | The `office`, `tidy` and `gather` kinds with baselines; the MCP suite from an agent chat |

S and F come first because they change no model behaviour and need no LM Studio run, so they
can be built while the machine question (decision 8) is settled and M1's baselines are taken;
A comes before C because C's new kinds are scored by A's engine and would otherwise be measured
twice. 3.1.0 ships first because its notes and version are written and its suites are green,
and the baseline it owes is owed by the machine, not the branch.

## Measuring it

The standing rules hold: temperature 0, three passes, the stable set judged and the flaky set
reported, no model grading a model, `.eval-results` baselines committed and diffed, a null
result shipped off with the number in `docs/evals.md`. New this release: three `eval:agent`
kinds (`office`, `tidy`, `gather`), each with a reference solution the harness proves against
before any model runs, the way the existing twenty are; a `settingsKitCheck` and an axe pass
in the Electron checks; and a second-visit run (A10) that reuses M1's cases.

## Not planned

| Idea | Why not |
| --- | --- |
| A settings sync or cloud profile | E8 exports a file. Accounts and sync were rejected in 2.x for the reasons given then. |
| Settings as a separate window | The modal-in-window keeps the chat visible for the deep links (S5) and needs no second `BrowserWindow`; a detached window is a later, separate decision. |
| An agent that submits forms or logs in (C4) | `browse` reads. Acting on a website is a different promise and a different audit row. |
| Parallel helpers | Still parked on the 3.1 measurement: one LM Studio server queues a second request. |
| A second model provider | Rejected before. C1's libraries run in the sandbox, not on a server. |
| A model-graded reviewer as the false-claim check (A5) | The engine's own rule — a claim with no matching command on the timeline is not a claim — needs no model and cannot be talked round. |
| Downloading models from the app (E1) | The app suggests and LM Studio installs; the privacy audit stays one line shorter. |
