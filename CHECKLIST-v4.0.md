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

- ☐ S3.1 `settings:patch` IPC: a path and a value; main merges, persists, returns the new settings; the renderer store applies the same patch.
- ☐ S3.2 A toast at the panel's foot: "*Label*: *value* — Undo", four seconds; Undo re-patches the previous value.
- ☐ S3.3 Fields commit on Enter or blur; switches, segmented, chips and steppers on change; sliders on release.
- ☐ S3.4 The server address and a slot's model commit deliberately, with the loopback warning shown before commit.
- ☐ S3.5 Save, Cancel and *No changes* removed; the footer holds the toast region and the global reset under Privacy.
- ☐ S3.6 Per-section reset in each `Section`'s menu, naming what it resets.
- ☐ S3.7 *Test proxy* and *Test connection* no longer call `setSettings`.
- ☐ S3.8 Tests: the patch merge (node); the toast's undo (render check); an unsaved-changes prompt no longer exists.

**Grade:** —

### S1. The shell

- ☐ S1.1 Glass panel at 24px with the streak, 90vh, up to 1,100px wide.
- ☐ S1.2 The rail: icons, uppercase tracked group headers, order — Setup (LM Studio, Roles, Appearance & chat), Intelligence (Grounding & checks, Pipeline*, Memory), Capabilities (Tools, Agent, Search & research, Voice), Knowledge (Library, Skills, MCP), Automation (Jobs), Privacy (Privacy, Activity). *Pipeline retires into Roles in S4.
- ☐ S1.3 Header: the tab's name and its one-line description.
- ☐ S1.4 A search field in the rail (wired in S5).
- ☐ S1.5 Arrow keys move the rail; `⌘,` opens; `⌘F` inside focuses the search; Esc closes; focus trapped.
- ☐ S1.6 Modal-focus and tab-traversal checks green with the new rail.

**Grade:** —

### S4. The tabs

Each a sub-checkpoint on its own branch when large; graded together.

- ☐ S4.1 **LM Studio**: status hero; address `Field`; *Test* `ActionRow`; model rows (name, quant, context, loaded, used by).
- ☐ S4.2 **Roles**: slot rows; stale-model warning with re-pick; detail `Disclosure`; Tools and Sampling disclosures with summaries; eval `ActionRow` at the foot; pipeline order as a `Section`; Pipeline tab retired.
- ☐ S4.3 **Grounding & checks**: the seven toggles grouped *Before / After / Across*; second opinion; claim check `Stepper`.
- ☐ S4.4 **Appearance & chat**: theme (Light / Dark / System); font; density; reduced motion; VIBE; Chat section; Long conversations section; About `ActionRow`.
- ☐ S4.5 **Agent**: mode as `Segmented` cards; steppers; switches; the detected shell; the `sigma` `Card`.
- ☐ S4.6 **Tools**: grouped by domain with header switches; per-tool `Row` with description, budget chip, switch; *Show tool ids*; working directory; Workbench `Card`; grants as `DangerRow`s.
- ☐ S4.7 **Search & research**: provider cards; Search section; Deep research section.
- ☐ S4.8 **Privacy**: promise; audit scorecard with deep links; updates; proxy `Segmented` with labelled host and port; Shopping.
- ☐ S4.9 **Activity**: network log; pages read; session audit log.
- ☐ S4.10 **Memory**: status `Card`; settings; knowledge base table with `DangerRow`s.
- ☐ S4.11 **Library, Skills, MCP, Jobs**: card lists; *Add…* as a sheet; `DangerRow` on Remove; MCP's log behind a `Disclosure`.
- ☐ S4.12 **Voice**: two cards; whisper paths as `Field`s with help below.
- ☐ S4.13 `fieldContrastCheck` and `settingsKitCheck` green on every tab; `SettingsModal.tsx` holds no tab state.

**Grade:** —

### S5. Search and deep links

- ☐ S5.1 A settings index: every `Row` registers `{ tab, section, id, label, help, keywords }`.
- ☐ S5.2 The rail search filters tabs and rows and highlights matches.
- ☐ S5.3 `openSettingsAt` takes a row id, scrolls to it and pulses the `Row` once.
- ☐ S5.4 Every "Settings → …" reference in the renderer becomes a deep link (65 at the count of 2026-09-28).
- ☐ S5.5 A node test that every id referenced by a deep link exists in the index.

**Grade:** —

### S6. The gate

- ☐ S6.1 `capture-screenshots.js` gains `settings-<tab>-<theme>` scenes; README shows one.
- ☐ S6.2 A keyboard check: tab through each Settings tab and assert every `Row`'s control received focus.
- ☐ S6.3 `eval:tools` fixtures and the trace schema hash unchanged (no tool description or order moved).
- ☐ S6.4 `docs/settings.md` written: every tab, what it governs, apply-as-you-go, deep links.

**Grade:** —

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
