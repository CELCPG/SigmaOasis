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

## The agent

## Underneath

## Measured

## Not in this release

## Upgrade notes
