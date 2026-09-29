# Checklist: Sigma Oasis 4.0 — every checkpoint, graded

The working record for `ROADMAP-v4.0.md`. Each checkpoint is one branch and one PR; it ends
with a grade against the rubric below, written here with its evidence, and a checkpoint under
an A is reworked before the next begins. The owner's decisions of 2026-09-28 that shape it:

| Decision | Chosen |
| --- | --- |
| Scope of this run | Tracks S, F and E ship on; tracks A and C are built behind switches that default **off** and stay off until `eval:agent` baselines exist on a sound machine and each item passes its gate. |
| Save model (S3) | Apply as you go: every control applies on commit, a four-second Undo toast, reset per section. Save, Cancel and *No changes* go. |
| Release path | 3.1.0 first: `feat/m1-agent-baseline` fast-forwarded onto main and tagged. Then each 4.0 checkpoint is a branch and a PR, merged through the browser as CELCPG; 4.0.0 tagged at the end. `feat/m2-speed-candidates` stays a branch until measured. |
| Review cadence | Autonomous: self-graded against the rubric, reworked to an A, reported at the end. |

## The rubric

Five criteria, each met or not, with the evidence named. **A** is all five met. **B** is one
partially met. **C** is one missing. Anything under A is reworked and regraded; the record keeps
every grade, so the rework is visible.

| Criterion | Met when |
| --- | --- |
| **1. Correct** | `npm run typecheck` clean; the node suite green; every Electron check the change can reach green (render, style, tab traversal, modal focus, field contrast, plan accessibility, main bundle, and the checks the checkpoint adds). Numbers recorded. |
| **2. Complete** | Every sentence of the roadmap item is built or explicitly deferred here with a reason. Nothing quietly narrowed. |
| **3. Consistent** | Built from the S2 kit where the kit applies; both themes; the style guide's surfaces; no wire change unless the item claims one (`eval:tools` fixtures and the trace schema hash unchanged for S, F and E). |
| **4. Verified** | The change was seen: a screenshot scene or a live check in the built renderer, and a check that holds the class of defect the item fixes, not an enumeration. |
| **5. Recorded** | `docs/` updated where the docs describe the surface; the 4.0 release notes draft gains its paragraph; the roadmap item's status line says *built* with the commit. |

## Checkpoints

Status marks: ☐ not started · ◐ in progress · ☑ done and graded A.

### 0. Ship 3.1.0

- ☑ 0.1 The branch reached main as PR #13 (`fcb820e`, a merge commit, by the parallel 3.1 session); version reads 3.1.0.
- ☑ 0.2 Node suite green locally on Windows on the 3.1.0 tree: 3,049 of 3,049 (this session, before the merge).
- ☑ 0.3 Annotated tag `v3.1.0` on `fcb820e`, pushed (the 3.1 session's; this session's own tag attempt found it already there).
- ☐ 0.4 Release workflow green; draft release left for the owner. *(To read in the browser once the run finishes.)*
- ☑ 0.5 Roadmap 3.1's status line updated in the docs PR.

**Grade:** A on 0.1–0.3 and 0.5 with the evidence above; 0.4 pending the workflow.

### 1. The documents

- ☑ 1.1 `ROADMAP-v4.0.md` and this checklist ride the S2 PR rather than a PR of their own: one browser merge fewer, and the kit is what the roadmap's first track describes.
- ☑ 1.2 `ROADMAP-v3.1.md` status updated: 3.1.0 tagged on `fcb820e`; M1's baseline owed to the machine; M2 on its branch.
- ☑ 1.3 `RELEASE-NOTES-v4.0.0.md` opened as a draft with the headings, filled by each checkpoint.

**Grade:** A — three documents, each named and in the PR; nothing deferred.

### S2. The control kit (first, because every tab needs it)

- ☑ S2.1 `components/settings/kit/`: `Switch`, `Row`, `Section`, `Field`, `Select`, `Textarea`, `Segmented`, `Stepper`, `Slider`, `Chips`, `ActionRow`, `DangerRow`, `StatusDot`, `Notice`, `Card`, `Button`, and `Fold` (the disclosure with a header). Sixteen files plus `tokens.ts`.
- ☑ S2.2 `kit/tokens.ts`: one `LABEL`, one `HELP`, one `FIELD`, `buttonClass(kind, size)` in four kinds and two sizes, one `Tone` palette through the ink variables. The focus ring is the app's element-level rule in `index.css`, which the kit never overrides.
- ☑ S2.3 `Switch` is a `<button role="switch" aria-checked>`: Space and Enter toggle as a button's click; the Row wires `aria-labelledby` and `aria-describedby` to it.
- ☑ S2.4 `DangerRow` uses `dangerClick` from `lib/settingsKit.ts`: one click arms, a second within `DANGER_ARM_MS` acts, a later one arms again; the armed button says what the second click will do.
- ☑ S2.5 `test/settingsKitCheck.ts`: boots the built app on a seeded profile, walks the rail, opens every fold, and holds eight rules (bare checkbox or radio; a button, field, select, textarea or range without `data-kit`; an unnamed button; a control outside `[data-row]`; a Row without `[data-help]`; a label off the kit's size, read against the root the font-size setting scales; a raw-palette dot). On this tree it passes General and reports 60 bare checkboxes, 100 hand-written buttons, 96 hand-written controls and 21 raw dots across the other thirteen tabs — so it is wired into `scripts/test-render.sh` in S4, when those tabs are rebuilt, and named in the S2 grade as deferred for that reason.
- ☑ S2.6 `test/settingsKit.test.ts`: 13 tests over `clampStep`, `parseTyped`, `dangerClick`, `segmentedKey`, the settings index and `describeValue`.
- ☑ S2.7 (added) Settings → General rebuilt on the kit as the exemplar: three sections, eleven rows declared once in `ROWS`, screenshots in both themes.

**Grade:** see the record.

### S3. Apply as you go

- ☑ S3.1 No patch IPC after all: `hooks/settingsApply.ts` writes the whole settings object through the `setSettings` call that always existed, because conf rewrites the file whole either way — the roadmap's reason for a patch protocol did not hold. One new IPC instead, `store:defaultSettings`, for per-section reset.
- ☑ S3.2 `SettingsToasts` at the panel's foot: "*Label*: *value* — Undo", `TOAST_MS` (4 s), newest three kept; Undo writes the previous object back, on disk too.
- ☑ S3.3 The kit's semantics: `Field` and `Textarea` commit on Enter or blur (Escape restores), `Switch`, `Segmented`, `Chips`, `Select` and `Stepper` on change, `Slider` on release with a live preview.
- ☑ S3.4 The server address is a `Field` (commit on Enter or blur) with the loopback warning shown on the live value; a slot's model is a `Select`, which commits once. Tabs not yet rebuilt reach the store through a 600 ms-debounced bridge in the modal, so a role name typed letter by letter is one write and one toast — the bridge goes with S4.
- ☑ S3.5 Save, Cancel, *No changes* and the unsaved-changes prompt are gone; the footer holds the toasts and a two-click *Reset to defaults*. (The roadmap put the global reset under Privacy; it stays in the footer, where a reader looks for it — a one-line deviation, stated.)
- ☑ S3.6 `Section` takes `onReset`, drawn as a two-click Reset in its header; General's three sections reset their own keys from `store:defaultSettings`.
- ☑ S3.7 *Test proxy* and *Test connection* no longer write settings.
- ☑ S3.8 `test/settingsApply.test.ts` (4 tests, against the real store: apply, Undo on disk, a nested leaf's toast, a no-op writes nothing); `firstChange` and `pushToast` in `settingsKit.test.ts`; the toast seen in a capture after a switch click; the discard prompt's code is gone.

**Grade:** see the record.

### S1. The shell

- ☑ S1.1 `glass-panel glass-popover`: the 24px radius and the streak, 90vh, up to 1,100px. The plain glass surface was tried first and the chat read straight through it in the dark theme (0.05 alpha); the popover surface (0.96) is the app's own rule for a panel over text, and both themes were shot on it.
- ☑ S1.2 `settings/tabs.ts` is the registry — key, label, description, group, icon, keywords — and `settings/icons.tsx` sixteen line glyphs. The rail draws the registry's order under uppercase group headers; Grounding & checks and Activity are in the registry and join the rail when S4 builds them (`BUILT` in the modal). Pipeline retires into Roles in S4.
- ☑ S1.3 The header shows the tab's label and description from the registry.
- ☑ S1.4 The search field narrows the rail by label, description and keywords, at word starts ("tor" finds Tor, not calculators); rows join in S5.
- ☑ S1.5 The rail is a vertical `tablist` with roving focus: arrows and Home/End move and select (the same `segmentedKey` model); `⌘F` or Ctrl+F inside the panel focuses the search; `⌘,` and Esc as before; focus containment is `useModalPresence`'s, unchanged.
- ☑ S1.6 `fieldContrastCheck` now finds the rail by `data-settings-rail` (a header sits between the rail and the tab body); `test/settingsTabs.test.ts` pins the registry (4 tests).

**Grade:** see the record.

### S4. The tabs

Each a sub-checkpoint on its own branch when large; graded together.

- ☑ S4.1 **LM Studio**: a status card with the dot, the count loaded, *Test* and its readout; the address as a `Field` that commits on Enter or blur and refreshes the list; the models as rows — id, kind, quantization, context, loaded — with the roles that use each.
- ☑ S4.2 **Roles**: a `Fold` per slot with its colour, name, model, specialty and switch on the header; "not on the server" on the header and a `Notice` beside the picker when the model is gone; persona and rules as growing textareas; capability and specialty side by side; accent as swatch `Chips`; Code Mode keeps its aria-label; Tools and Sampling as inner folds with summaries; the pipeline as a section (each enabled role a list row with its order, arrows and a switch); the tool-choice eval as the last section, its runner moved out of the modal. `SlowReadingNote` (3.1's S6) kept. `CollaborativeMode.tsx` deleted.
- ☑ S4.3 **Grounding & checks**: *Before the reply* (playbooks, outline), *After the reply* (auto-correct, workbench checks, self-review, second opinion, reviewing role, claim check, claims per reply as a `Stepper`), *Across replies* (ledger, fact ledger). Each section resets its own keys.
- ☑ S4.4 **Appearance & chat**: Appearance, Chat, Long conversations, About — as S2 built it. *System* theme, density and a reduced-motion switch are deferred to E5 (accessibility), where the root class they set is wired; stated here rather than half-built.
- ☑ S4.5 **Agent**: the mode as `Segmented` cards, two steppers, two switches; *This machine* shows the shell `run_command` will use, through a new `agent:shell` IPC; the `sigma` command as a `Card` with Install/Update and a two-click Remove.
- ☑ S4.6 **Tools**: the working directory with *Browse…*; the Workbench as a status card; `TOOL_GROUPS` from the tool table (ten domains, no wire change) each a `Card` with a group switch and a row per tool — label, the rule's first sentence (`toolSummary`), the budget as a chip; *Show tool ids* as a row; grants as `DangerRow`s with *Revoke all* in two clicks.
- ☑ S4.7 **Search & research**: provider `Segmented` cards; SearXNG address; the Brave key with a two-click Remove; results, confirm, JavaScript pages; *Test connection* as an `ActionRow` that saves nothing; Deep research as its own section.
- ☑ S4.8 **Privacy**: the promise; the audit as a `Card` scorecard with the kit's dots (rows' *where* become links in S5); updates; the proxy as `Segmented` cards with a labelled host `Field` and port `Stepper`; *Test proxy*; Shopping; the session audit log's switches.
- ☑ S4.9 **Activity** (new tab): the network log with Refresh and a two-click Clear; pages read this session with a two-click Forget; audit logs on disk with Export, Export traces and a two-click Purge all.
- ☑ S4.10 **Memory**: a status card; recall switch, slider and embedding model; the knowledge base as `DangerRow`s (Forget in two clicks), *Add document* as the section's action.
- ☑ S4.11 **Library, Skills, MCP, Jobs**: cards with one action order (secondary, then danger, then the switch); *Add a server* and *Add a job* as `Fold`s opened by the section's primary button, rather than a sheet — the fold keeps the list in view and needs no overlay inside a modal; Remove in two clicks on every pack, skill, server and job; MCP's stderr behind a `Fold`; the aria-labels the checks seed on (`… interval`, `… approval`, `Value of …`, `… code mode`) kept, and the watched-item picker found by `[data-row="jobs.watchedItem"]` in `fieldContrastCheck` and `mainBundleCheck`.
- ☑ S4.12 **Voice**: Text-to-speech and Speech-to-text sections; the whisper paths as `Field`s with *Browse…* and their help beneath; *Re-check* as an `ActionRow`.
- ☑ S4.13 `settingsKitCheck` joins `scripts/test-render.sh`; `SettingsModal.tsx` holds the open tab and the search and nothing else (from two dozen `useState`s to two); the S3 bridge for un-rebuilt tabs is gone. Rows that only hold cards are `bare` (id kept for search and links, no repeated help), after a first capture showed the section's sentence printed twice.

**Grade:** see the record.

### S5. Search and deep links

- ☑ S5.1 The index: every tab declares its rows once with `defineRows` (`{ id, label, help, keywords }`, ids `tab.key`) and registers them at import (`registerRows`), so the index exists before any tab is drawn. Sections are not indexed separately; a row's tab is its id's first segment.
- ☑ S5.2 The rail search reads tabs (label, description, keywords) and rows (label, help, keywords), at word starts; a tab whose rows match stays in the rail with up to six matching rows listed under it, each a jump to that row.
- ☑ S5.3 `openSettingsAt` takes a tab key or a row id (`SettingsTarget` in `shared/failure.ts` is now the registry's keys plus `tab.row`); the modal opens the tab, opens every fold on it so the row is in the tree, scrolls the row to centre and lights it once (`.kit-row-flash`).
- ☑ S5.4 The privacy audit's every row carries a `target` (`targetForKey`) and its *where* line is a link; the composer's "can write files / run commands" chip, the right panel's empty-chain and no-sources lines and the plan block's tools note are links; the claim-check remedy keeps its control. The other references are prose in chat messages, tooltips and code comments, which cannot hold a control — every one of them was renamed to the tab's new name (Roles, LM Studio, Appearance & chat, Search & research, Roles › Pipeline), by a script over `src/`, so no sentence in the app names a tab that no longer exists. Sixty-five references at the count; nine are controls now, the rest are prose that says the right name.
- ☑ S5.5 `test/settingsLinks.test.ts` (6 tests): every rail tab declares rows; every row belongs to a rail tab; the shared `SettingsTabKey` list matches the registry (read from the source); every privacy-audit target is a row that exists, with a settings object that fires every check; the remedy and chip targets exist; `settingsPath` reads as a path.

**Grade:** see the record.

### S6. The gate

- ☑ S6.1 `scripts/capture-screenshots.js` takes `settings-<tab>-<theme>` (the tab's key), opens Settings on it over the chat scene with the window shown inactive so the modal paints; `docs/screenshots/settings-tools-dark.png` and `settings-models-light.png` captured with it and shown in the README's new 4.0 section.
- ☑ S6.2 In `settingsKitCheck`, a ninth rule: from each tab's first control, real Tab key events must reach every enabled control in every row and list row; a control the key never reaches is named. Passes on all fifteen tabs.
- ☑ S6.3 `git diff main -- src/shared/tools/defs test/fixtures` touches one line: the `label` of `web_search` (the Settings label, not the wire description), renamed with the tab. `TOOL_DEFS`' order and every description and parameter block are as on main, so `TOOL_SCHEMAS` — what the eval scores against and the trace schema hash fingerprints — is unchanged; `TOOL_GROUPS` and `toolSummary` are additive.
- ☑ S6.4 `docs/settings.md`: the panel, every tab, apply as you go, the kit, links, and the names that changed. README, `docs/ledger.md` and `docs/workbench.md` say the new names; the historical release notes and `docs/evals.md` keep theirs.

**Grade:** see the record.

### F. The front door

- ☐ F1 Three doors (Ask, Work in a folder, Just talk); greeting line; project line.
- ☐ F2 Pick up where you left off: two recent chats, running tasks, unread digests; nothing when empty.
- ☐ F3 Capability cards from the table, chosen by what is enabled, greyed with a deep link when off, coloured by tool family.
- ☐ F4 No-server and no-model states in place of the doors; the update line.
- ☐ F5 `AgentEmpty` merged into the one component with a mode; recipe cards where C3's recipes exist (placeholders until then, hidden when none).
- ☐ F6 Render checks for every state; reduced-motion; `eval:tools` unchanged; screenshot scenes updated (`welcome-light`, `agent-dark`).

**Grade:** —

### E. Everything else

- ☐ E1 Setup that knows the machine: the pre-reply model-fit judgement from window, quant and card; a copyable `lms` line; node tests against S6's five slow replies.
- ☐ E2 Keep loaded, Load and Unload — after a spike says which route (`lms` under the grant rule, or REST); the LM Studio hero shows loaded versus evicted.
- ☐ E3 The chat header, right panel and composer chips rebuilt from the kit; no behaviour change.
- ☐ E4 `⌘K` lists settings rows, recipes and slash commands.
- ☐ E5 Accessibility: `aria-label` on every icon button; focus traps; ARIA patterns on the kit; `aria-live` on the timeline; an axe pass over every scene.
- ☐ E6 Debt: `bench:main-loop` gains an office-extraction phase when C1 lands; `useLMStudio.ts` stays under 600 lines; `library.ts` and `search.ts` split when touched.
- ☐ E7 Windows: the detected shell shown in Settings → Agent; Git Bash detection tested with and without Git on CI's Windows leg. (Signing stays the owner's account.)
- ☐ E8 Settings export and import, keychain values named and left blank.
- ☐ E9 GPU corrected-error counters read by the eval runners before and after each case; a run whose count moved is *machine*, excluded and named; the model-fit line says when the counters moved.

**Grade:** —

### A. Agentic leaps — built behind `agent.experiments.*`, default off

Each item is code, engine tests against the scripted model, and a switch in Settings → Agent
under *Experiments* that says it is unmeasured. None is claimed in the notes as an improvement.

- ☐ A1 M2's low-water mark and multi-file `read_file`, from `feat/m2-speed-candidates`.
- ☐ A2 Result digests: test runners, grep grouping, directory sizes, `edit_file`'s window.
- ☐ A3 Thinking by phase via the closed think block.
- ☐ A4 Plan-then-act with focus windows.
- ☐ A5 The verify round and the report rewrite.
- ☐ A6 `ask_user` as a tool, in the app and the CLI.
- ☐ A7 The reviewer helper switch.
- ☐ A8 Hooks.
- ☐ A9 Git worktrees.
- ☐ A10 `.sigma/notes.md`.

**Grade:** —

### C. Common-use agent — built behind `agent.experiments.*`, default off

- ☐ C1 `read_document` and `write_document` through the sandbox; the library set confirmed by a spike; the `office` kind's three cases with reference solutions, proven by `test/agentEval.test.ts`.
- ☐ C2 Folder chores: move, copy, rename, mkdir, delete-to-trash; the checkpoint journal; the `tidy` kind.
- ☐ C3 `agent.md` in skills; four shipped recipes.
- ☐ C4 `browse`; the `gather` kind.
- ☐ C5 The read-only agent job kind.
- ☐ C6 The inbox for dropped files.
- ☐ C7 Slash commands.
- ☐ C8 MCP tools for the agent.

**Grade:** —

### R. Release 4.0.0

- ☐ R1 Version 4.0.0; `RELEASE-NOTES-v4.0.0.md` complete, with *Not in this release* naming every A and C switch as unmeasured and off.
- ☐ R2 README screenshots re-captured; `docs/` current.
- ☐ R3 Full suite green on Windows locally and in CI on three systems.
- ☐ R4 Annotated tag on the merge commit; Release workflow green; draft release left for the owner.

**Grade:** —

## The grade record

| Checkpoint | Round | 1 Correct | 2 Complete | 3 Consistent | 4 Verified | 5 Recorded | Grade | What the rework changed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | node 3,049/3,049 on the 3.1.0 tree | 0.1–0.3, 0.5 done; 0.4 is the workflow's | — | tag on `fcb820e` on origin | 3.1 roadmap status line | A (0.4 pending) | — |
| 1 | 1 | — | three documents | — | in the PR | — | A | — |
| S2 | 1 | typecheck clean; node 3,062/3,062; fieldContrast 22/22; modalFocus 179/179 | S2.1–S2.7; S2.5's wiring deferred to S4, with the reason | kit only; both themes shot | General screenshots; the check passes General and reports 60/100/96/21 across the old tabs | notes draft, checklist, 3.1 status | **A** | Round 1 found two of the check's own rules wrong (a switch named by `aria-labelledby` read as unnamed; label size read in px against a scaled root) and a blank stepper field clamping to the floor — all three fixed before grading. |
| S2 | 2 | CI on PR #14: node 3,065/3,065 on three systems; styleCheck 73/74 | — | — | — | — | B → A | CI read the fold's ▼▶ glyph as prose in the muted ink (the rule forgives the glyph on the same line; the JSX had wrapped it). One line moved; pushed as `905305b`. Local runs had not caught it because the style check was not in the S2 run's list — every later round runs the whole `test-render.sh`. |
| S3 | 1 | typecheck clean; node 3,069/3,069; fieldContrast 22/22; modalFocus 179/179 | S3.1–S3.8, with S3.1's patch IPC replaced by the existing whole-object write (reason stated) and the global reset kept in the footer (stated) | apply through one function; the kit's commit semantics | the toast seen in a capture after a switch click; `settingsApply.test.ts` against the real store | notes, checklist | **A** | — |
| S1 | 1 | typecheck clean; node 3,073/3,073; fieldContrast 22/22; modalFocus 179/179; mainBundle 20/20 | S1.1–S1.6 | the popover surface after the plain glass read through; both themes shot | rail, header, search seen in captures; `settingsTabs.test.ts` | notes, checklist | **A** | Round 1's first capture showed the chat through the panel in the dark theme; the popover surface (the app's own rule for a panel over text) replaced it before grading. |
| S4 | 1 | typecheck clean; node 3,073/3,073; modalFocus 179/179; mainBundle 20/20; settingsKit 11/11; fieldContrast 21/22; style 73/74; chrome 122/123 | S4.1–S4.13; S4.4's System theme, density and reduced motion deferred to E5 (stated) | every tab on the kit; six tabs shot | the kit check over fifteen tabs | notes, checklist | B | fieldContrast could not find a slot's Code Mode select by its aria-label (a control inside a Row dropped its explicit label for the row's); styleCheck read the fold glyph as prose; chromeContrast's three settings class strings named markup the old tabs drew. |
| S4 | 2 | fieldContrast 22/22; style 74/74; chrome 123/123; settingsKit 12/12 (a ninth rule, S6.2) | as above | as above | as above; a first capture showed a section's sentence printed twice on three tabs — `bare` rows | as above | **A** | An explicit `label` now wins over the row's for every kit control; the glyph is on one line; the chrome check reads the kit's tokens for its three settings strings. |
| S5 | 1 | typecheck clean; `settingsLinks.test.ts` 6/6; fieldContrast 22/22; style 74/74; chrome 123/123; settingsKit 11/12 | S5.1–S5.5 | links through one component | the rail search with rows and a deep link landing on Tools › Web search, both captured | notes, checklist, `docs/settings.md` | B | The audit's link buttons carried no `data-kit`, and the kit check refused them on Privacy. |
| S5 | 2 | settingsKit 12/12 | as above | as above | as above | as above | **A** | `SettingsLink` is `data-kit="link"`. |
| S6 | 1 | node 3,076/3,079; `test-render.sh` whole: render 25, style 74 and 123, tab traversal 43, modal focus 179, field contrast 22, settings kit 12, plan accessibility 175, main bundle 20, markdown 62, MCP secrets 19, transport 24 (Workbench skipped: no runtime here; CI fetches it) | S6.1–S6.4 | — | the ninth kit rule; README screenshots from the shipping capture script | `docs/settings.md`; README, `docs/ledger.md`, `docs/workbench.md` renamed | B | Three node tests pinned the old names or the old shape: the privacy audit's `where` for the Brave key, the router's note naming Models, and the plan block counting a Settings link among its action buttons. |
| S6 | 2 | node 3,079/3,079; Electron checks as above | as above | as above | as above | as above | **A** | The two names updated in their tests; the plan test's button count now leaves out `data-kit="link"` — a way into Settings is not one of the plan's actions. |
