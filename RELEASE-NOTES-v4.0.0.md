# Sigma Oasis v4.0.0 — draft

*Filled in by each checkpoint of `CHECKLIST-v4.0.md`; the roadmap is `ROADMAP-v4.0.md`. Nothing
here is released until the version reads 4.0.0 and the tag is on main.*

## Settings

- **A shell that belongs to the app.** Settings was an opaque box with fourteen labels in a
  column. It is the app's glass now, wider and taller, with a rail of sixteen tabs under six
  headers — Setup, Intelligence, Capabilities, Knowledge, Automation, Privacy — each with an icon
  and a line saying what it governs, a search field that narrows the rail as you type, and arrow
  keys that move along it. Connection is *LM Studio*, Models is *Roles*, General is *Appearance
  & chat*; the keys the app links to did not change.
- **One control kit.** Every control in Settings is one of sixteen components
  (`src/renderer/src/components/settings/kit/`): a switch where there were five kinds of
  checkbox, one label size where there were four, one button in four kinds where there were four
  paddings, one status palette where there were three. A new check, `settingsKitCheck`, walks
  every tab in the built app and refuses a bare checkbox, a hand-written control, an unnamed
  button, a control outside a row, and a row with no help.
- **Apply as you go.** Ten tabs wrote a draft that *Save* committed and four applied at once, and
  nothing on screen said which; two *Test* buttons saved the whole draft as a side effect. Now
  every control applies when it commits — a switch on click, a field on Enter or blur, a slider on
  release — and a line at the panel's foot says what changed and offers Undo for four seconds.
  Each section has its own two-click Reset; *Reset to defaults* is the same two clicks for
  everything. Save, Cancel, *No changes* and the unsaved-changes prompt are gone.
- **Every tab rebuilt.** *LM Studio* is a status card, the address, and the detected models as
  rows that say which role uses each. *Roles* folds each slot to one line — colour, name, model,
  specialty, its switch — with the detail inside, warns when a slot's model is no longer on the
  server and offers the picker right there, and takes in the pipeline order; the Pipeline tab is
  retired. *Grounding & checks* is new: the seven grounding switches, second opinion and claim
  checking, grouped by when they act. *Tools* is the tool table's own ten domains, each with a
  switch for the group and a row per tool that says in one sentence what the model reads, with
  budgets as chips and the wire names behind a switch; standing grants revoke in two clicks.
  *Agent* shows the shell it found on this machine. *Search & research* splits into its two
  subjects. *Privacy* keeps the promise, the audit and the switches; *Activity* is new, holding
  the network log, the pages read and the audit files. Library, Skills, MCP and Jobs are card
  lists with one action order, their add-forms folded until wanted, and Remove in two clicks
  everywhere — eleven one-click deletions are gone.
- **Search, and links that land.** The rail's search reads every setting's label and help, not
  only the tab names, and lists the rows it finds under their tabs; a click opens the tab, scrolls
  to the row and lights it once. Where the app used to say "Settings → Tools" in a sentence, it
  now links to the row it means — the privacy audit's every line, the composer's "can write files"
  chip, the right panel's empty-chain and no-sources notes, the plan block's tools note — and
  every sentence that cannot hold a link names the tab as the rail now does.

## The first screen

- **Three doors, and what this machine can do.** The screen before the first message no longer
  offers four topics; it offers the three ways in that the rail does — Ask, Work in a folder,
  Just talk — under a greeting for the hour, then what you left off (the last two conversations,
  any task still working, a digest that arrived today), then six cards that each show something
  this machine can do that a cloud chat cannot do privately: summarize a document you drop in,
  check the math in a spreadsheet, research with the sources, tidy a folder, fix the failing
  test, ask what it remembers about you. A card whose tool is off is greyed with the reason and
  opens the setting when clicked. When LM Studio is not answering, or no role has a model, the
  doors give way to the fix. An agent chat opens on the same screen with its tasks.

## The agent

- **Eleven experiments, every one off.** Settings → Agent → *Experiments* lists eleven switches,
  each a change to how the agent works that ought to help a small model, and each unmeasured:
  `eval:agent`'s baseline has not run on a sound machine, so none is on by default and none is
  called an improvement here. Context fitting that keeps the server's prompt cache; `read_file`
  taking several files; tool results shaped for a small reader (a test run says "3 failed, 41
  passed" and the failures first); thinking only on the rounds that need it; the plan kept in
  view and a finished step's output set aside; a verify round the report cannot skip, and a
  report that claims a check the timeline lacks says so; `ask_user` as a tool, with choices you
  click; a reviewer reading the diff before the report; hooks from `.sigma/hooks.json`; a git
  worktree per task on its own `sigma/` branch; and `.sigma/notes.md`, what the agent verified
  about a folder, read at the start of the next task there. Each is pinned against the scripted
  model in `test/agentEngine.test.ts`, described in `docs/agent.md`, and waiting for the
  measurement that would turn it on.
- **Eight more, for everyone's folders — also off.** The agent's tools were a programmer's; the
  folders most people own are Documents and Downloads. Behind eight further switches: documents
  read and written — `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.csv` — with no library and no sandbox,
  the Office formats read and written directly, a document edit shown as the diff of what it
  says and undone byte for byte; folder chores as typed tools (move, copy, make a folder, delete
  to the trash) that Undo reverses; recipes, four shipped and any skill's `agent.md`; `browse`
  for pages that are applications, read-only; a read-only agent task as a job kind; files
  dropped on an agent chat landing in the folder's inbox; slash commands from
  `.sigma/commands/`; and MCP servers as the agent's tools. Two new `eval:agent` kinds, *office*
  and *tidy*, with three cases each and reference solutions, measure the first two when the
  baseline can run.

## Underneath

- **The machine, read.** Settings → LM Studio says what the GPU is, from its own tool, and judges
  every listed model against it before its first slow reply — fits, tight, or does not, with the
  `lms load … --context-length` line that would fix a window too large for the card. It warns
  when the card has been reporting PCIe errors, and the agent suite marks a case during which the
  counter rose as the machine's, not the model's.
- **Load, Unload, Keep loaded.** Every model on the LM Studio tab has Load and Unload on your
  click, through the same routes the app already pins with; a role marked *Keep loaded* is
  pinned for a month idle rather than an hour.
- **Settings as a file.** Export every setting to JSON for a second machine and import it back;
  credentials stay in the keychain and the file says which to enter again.
- **Names for every control.** A new check reads the shipped build's accessibility tree over the
  front door, a conversation, every Settings tab and the palette, and refuses a control with no
  name; its first run found eight icon buttons that announced only their emoji. The agent's
  timeline announces its steps as they land. `⌘K` lists every setting.

## Measured

- Nothing about the agent's experiments is measured in this release: `eval:agent`'s baseline
  has not run on a sound machine (the bench's GPU was reporting PCIe errors through the
  release, and the runner now excludes a case during which the counter moved and says so).
  What *is* measured is the engine against the scripted model — 3,200-odd node tests, every
  experiment on and off — and the app against its own checks: every control in Settings on
  the kit, every control in the shipped build named to a screen reader, contrast, focus,
  tab order, the plan block's accessibility, the bundle, the Markdown, MCP secrets and the
  transport. The counts are in `CHECKLIST-v4.0.md`'s grade record.
- The model-fit judgement on the LM Studio tab is pinned against the bench's own cases
  (`test/gpuFit.test.ts`); the numbers are the card's, from `nvidia-smi`, never a guess.

## Not in this release

- **Every agent experiment is off**, and none is an improvement until measured: context fitting
  to a low-water mark, multi-file `read_file`, result digests, thinking by phase, plan focus,
  the verify round, `ask_user`, the reviewer, hooks, worktrees, notes, documents, chores,
  recipes, `browse`, agent jobs, the inbox, slash commands, MCP tools for the agent. Each is
  a switch under Settings → Agent → Experiments that says so.
- The `gather` eval kind (web tasks) — the eval runs offline against the disk and has no page
  fixture to render; `browse` is pinned on its extraction alone.
- Undo of the inbox: files dropped into `.sigma/inbox/` stay until you remove them.
- The System theme, density and reduced-motion settings the roadmap listed under Appearance;
  the in-app update line; the `lms` CLI as a load route (the REST routes do the job).
- Measured baselines for any of the above. The next release is the one that turns a switch on.

## Upgrade notes

- Settings tabs were renamed: *Connection* is **LM Studio**, *Models* is **Roles**, *General* is
  **Appearance & chat**, *Search* is **Search & research**; *Pipeline* lives inside Roles;
  *Grounding & checks* and *Activity* are new. Every link into Settings lands on the row it
  names; nothing you had set moved.
- Settings apply as you go. There is no Save: a change lands when the control commits, with a
  four-second Undo at the panel's foot. *Reset to defaults* asks twice.
- New keys in the settings file: `agent.experiments` (every key false), `keepLoaded` on a role.
  A settings file from 3.x reads unchanged; a 4.0 export (Privacy → *Move to another machine*)
  names the credentials it left blank.
- `.sigma/` is the agent's folder inside yours — notes, hooks, commands, an inbox, a trash, and
  worktrees — created only when an experiment that uses it is on. `.sigma/.gitignore` hides the
  plumbing from git; notes, hooks and commands are yours to commit.
- The CLI's `sigma` reads the same experiment switches from the app's settings file.
