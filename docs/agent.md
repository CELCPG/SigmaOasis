# The agent (v3.0)

A chat answers. An agent *works*: give it a folder and a task, and it searches the files, reads
what it needs, edits with every change shown as a diff, runs your tests with your OK, keeps a
checklist you can watch, and carries on until the task is done or it needs you. This page is what
it does, what it will not do, and what the app enforces around it.

## Starting one

- **⚡ Agent task** in the rail (or *New Agent Task…* in the palette, ⌘K) asks for a folder and
  opens an agent chat on it. *New Agent Task Without a Folder* gives an agent with no files and no
  commands — the web, the library and Python, as enabled under Settings → Tools — for research
  that takes more than one turn.
- The chat's header says what it works on (the folder), how freely (below), and on which model.
  Each is changeable there and applies from the next task; while a task runs they are fixed,
  because the running task was started with them.
- The model is the slot you pick in the header; with none picked, a slot whose specialty is
  *coding*, then the chat's own slot, then the first enabled one.

## How freely — three modes

| Mode | Edits | Commands |
| --- | --- | --- |
| **Ask first** (default) | Shown as a diff in the chat with Apply and Discard; nothing is written until Apply | Each one confirmed in a dialog |
| **Accept edits** | Land without asking — the diff is still on the record, and the file is checkpointed first | Each one confirmed |
| **Read-only** | Not offered at all | Not offered at all |

Commands always ask. *Always allow* in the dialog mints a standing grant bound to **that exact
command in that exact folder** — the same grants as the chat's terminal tool, listed and revocable
under Settings → Tools. A declined edit or command is final for that step: the agent is told not
to propose it again, and to adapt or ask.

## What it can do

| Tool | What it does |
| --- | --- |
| `list_directory`, `glob`, `grep` | Find: a folder's contents, files by pattern (`*.ts` matches names at any depth, `src/**/*.test.ts` a path), lines by regular expression (`path:line: text`). Dependency trees, build output and `.git` are skipped. |
| `read_file` | Read with line numbers, 400 lines at a time, with `offset`/`limit` for the rest. Binary files are refused by name. |
| `edit_file` | Exact search-and-replace; must match once (or `replace_all`). The file must have been read in this task first. |
| `multi_edit` (4.1) | Several `edit_file` changes to one file in one call, applied in order, each to the text the one before left. All land or none do: one diff to review, one checkpoint, and a failed edit names which one and leaves the file untouched. |
| `write_file` | A new file, or a whole-file rewrite of one already read. |
| `run_command` | A shell command in the folder — a login shell on macOS/Linux, Git Bash on Windows when installed (cmd.exe otherwise). Output keeps its start and its end; a time limit (Settings → Agent) stops the whole process tree. |
| `todo_write` | The checklist you see above the steps. |
| `read_spill` (4.1) | The middle of a result that was cut to fit (below), a window at a time, by the id the cut named. |
| `task` | Hand a focused job to a **helper**: *explore* (read-only investigation), *review* (a read-only second look at changes), *general* (a self-contained sub-task that may edit). A helper starts with an empty context and returns one report, so a broad search does not fill the agent's own window. Helpers cannot start helpers. |
| the app's own tools | Web search and page reading, deep research, the reference library, memory search, dates and the Python sandbox — each only when enabled under Settings → Tools, and only if *Let the agent use the app's own tools* is on under Settings → Agent. |

**Edit matching forgives four things and guesses none.** An exact match is tried first. Then:
LF text against a CRLF file (the edit lands in the file's own line endings), `read_file` line
numbers pasted into the search, trailing spaces, and (4.1) a wrong margin — a block quoted at the
wrong depth is found with leading whitespace ignored, and the new text is moved by the same shift,
so a Python block lands at the depth it replaces. Each only when it finds exactly one place; the
margin only when one shift explains every line (tabs against spaces is not a shift).
An ambiguous search is an error with the count; a miss names the closest line. Measured as the
common failure of small models' edits, and pinned in `test/agentEngine.test.ts`.

## SIGMA.md — a project's standing instructions

A `SIGMA.md` at the folder's root is read at the start of every task and put in the agent's
instructions: how to run the tests, the style to keep, what not to touch. It lives in the repository
with the code it describes. When there is no `SIGMA.md`, an `AGENTS.md` or `CLAUDE.md` is read
instead, so a project already set up for another agent works unchanged.

## Experiments (v4.0) — off until measured

Settings → Agent → *Experiments* lists twenty-one switches, each off. Every one changes how the
agent works in a way that ought to help a small model, and not one has been measured against
`eval:agent`'s baseline on a sound machine — so none is on by default and none is described
anywhere as an improvement. They are here so the measurement can happen with the shipped build,
switch by switch. The engine reads them per task (`AgentTaskSpec.experiments`); the CLI reads the
same settings.

| Switch | What it changes when on |
| --- | --- |
| Context fitting keeps the cache (A1) | Once the history is over budget, old tool output is set aside down to 70% of the window rather than to just under it, so the start of the history moves once every several rounds and the server's prompt cache survives between. |
| `read_file` takes several files (A1) | `more_paths`: up to three more files in one call, each windowed as a single read. |
| Tool results shaped for a small reader (A2) | A test runner's output leads with its totals and failures; `grep` groups hits by file; a listing shows sizes; an edit returns the lines around it. |
| Think when it matters (A3) | Which rounds think is the model family's prior (4.2, `agentThinkingProfile` in `lib/modelProfiles.ts`), read off what the last round did: the first round, a round after a failure or a stuck note, and the likely report (after a passing check that followed an edit, or once every step is ticked) think; a round after a successful read, edit or other call does not. On a `<think>`-tag family (Qwen3, Magistral) "does not" means the round starts with the block already closed; the R1 distills close it only after a read. A family that thinks in its own tokens (Gemma 4, gpt-oss) cannot be closed, so a quiet round gets half the round cap (8K) instead, and a round that ends with nothing but thinking is told so in words rather than handed another family's tags. The plan-in-view message no longer counts as the user speaking (4.0 read it so, and with A4 on every round thought). Helpers keep thinking. |
| Plan, then one step at a time (A4) | The checklist is the plan: each round after the first ends with a transient message naming the steps and the one in progress, and when a step is marked completed the tool output before that round is set aside before the budget asks. |
| A plan round, evidence per step (4.2, A4) | Before the first call of a task's first turn, one request with no tools asks for the steps as JSON — grammar-constrained (`response_format` with a schema) where the server takes it, asked again without it where the server answers HTTP 400, and read tolerantly either way (a fence, prose around it, a numbered list). On a `<think>` family that request starts with the block closed. Three steps or more become the checklist, in the history as the model's own `todo_write`; fewer, and the task runs as it would have. Then: the plan rides each round as A4's transient message, never in the system prompt, so the prompt's start and the server's cache stay put; a step's output is set aside when it is ticked; a tick is taken back — once per step — unless a tool result since the step began shows it done (after a change, a passing command or a read that followed it); and after a check fails following a change, or a stuck warning, one more structured request revises the steps still to do. Once a task: a plan revised twice is a plan the model is not following. |
| A verify round that cannot be skipped (A5) | When a file changed after the last successful command and a command is known, one more round offers `run_command` alone before the report; a report that still claims a passing check the timeline does not show gets a sentence saying so, in the text you read. |
| `ask_user` as a tool (A6) | The agent may ask you one question, with up to six choices; the task pauses, the question and its choices show on the turn (and in the terminal), and your next message is the answer. Helpers cannot ask. |
| A reviewer before the report (A7) | Before the report, a *review* helper reads the diff of everything the task changed; its findings become one more round, or "no problems" ends it. |
| Hooks (A8) | `.sigma/hooks.json` names commands for three moments — `afterEdit` (with `{file}`), `beforeCommand` (with `{command}`) and `onEnd`, five each at most. Each runs under the same approval and standing grants as any command, and each is a line on the timeline; a failed after-edit hook is told to the model. |
| A worktree per task (A9) | In a git repository with a commit, the task works in `.sigma/worktrees/<slug>` on branch `sigma/<slug>` (the first words of the task and the minute); the folder you look at is untouched, Undo restores the worktree, the next turn carries on there, and the report names the branch. Not a repository: the task runs in the folder and no worktree is reported. |
| Notes about a folder (A10) | `.sigma/notes.md` — what the agent verified about this folder — is read after `SIGMA.md` at the start of every task here, and the agent is asked to add to it before its report, as an edit you see like any other. |
| Documents: read and write (C1) | `read_document` turns `.docx`, `.xlsx`, `.pptx`, `.pdf` (in the app), `.csv`, `.md` and `.txt` into text with headings, bullets, pipe tables and sheet names; `write_document` makes a `.docx` from Markdown, an `.xlsx` or `.csv` from rows or CSV text, a `.md` or `.txt` from text. The Office formats are read and written directly (ZIP and XML, no library). A document edit is reviewed as the diff of what it says, checkpointed as bytes, and Undo puts the old bytes back. |
| Folder chores (C2) | `move_file` (a file or a whole folder; rename is a move), `copy_file`, `make_directory`, `delete_file` — inside the folder, the destination never overwritten, each approved in *Ask first* as one line, each checkpointed so Undo reverses a move and restores a delete. Delete sends to the system trash in the app and to the folder's `.sigma/trash/` from the CLI; nothing is removed outright. |
| Recipes (C3) | A method for a task: four ship — *Tidy a folder*, *Summarize what is here*, *Fill a template from data*, *Fix the failing test* — and an installed skill's `agent.md` joins them. When a trigger phrase is in the task the recipe rides the system prompt after `SIGMA.md`, named, and the report says if it was departed from. |
| `browse`, read-only (C4) | `browse(url, instruction)`: the headless renderer (the one Settings → Search & research offers for JavaScript pages) loads the page and returns what the instruction asks for — the links, the lines with an amount, or the passages matching the words. No form is submitted, no cookie is kept, no login; every request is in the activity log. In the app only. |
| A read-only agent task as a job (C5) | Jobs gains a kind: a task in a folder on the schedule Jobs offers, in *Read-only* — no edit, no command, no question — whose report is the digest. Fifteen minutes at most, twenty rounds at most. |
| Files into an agent chat (C6) | Dropping files on an agent chat copies them into the folder's `.sigma/inbox/` (never overwriting; a numbered suffix on a clash) and puts a line in the composer naming where they landed. |
| Slash commands (C7) | `.sigma/commands/<name>.md` in the folder, and the app's own `commands/` folder, become `/name` in the composer and in `sigma`; `$ARGUMENTS` is what followed the name. A folder's command wins a name. |
| MCP tools for the agent (C8) | MCP servers that are on join the agent's tools under the server's own approval mode and per-tool switches, exactly as in a chat. |
| Tools by phase (4.1, A5) | A shorter list on the wire: the edit tools join once a read has succeeded; document tools when the task names a document, chore tools when it speaks of moving, renaming or deleting, an MCP tool when it names the server or the tool — or once the model uses one. The list only grows (every change re-reads the prompt on a local server), and a call to a tool held back still runs: it is not advertised, not forbidden. |

`.sigma/` is the folder's own: notes and hooks are yours to commit; `worktrees/` and the
ignore file that hides it never show in `git status`.

## Long tasks

- A task runs up to *Steps before a task pauses* (Settings → Agent, 40 by default); then it pauses,
  says so, and carries on when you press **Continue**.
- **Context.** Before every request the history is fitted to the model's loaded window: the oldest
  tool output is replaced by a note naming the tool and saying how to fetch it again, the four most
  recent results are never touched, and only if that is not enough are whole early rounds dropped —
  never a call without its result. The turn says when this happened.
- **No one result fills the window (4.1).** A tool result may take at most 15% of the history's
  budget. A longer one keeps its head and its tail — what the output is, and how it ended — and the
  middle goes to a store for the task, with a note in its place naming the `read_spill` call that
  returns it (and, for a file, the `read_file` offset). The record on the turn keeps the whole.
  When eliding old output is not enough, the recent results are cut harder the same way before any
  round is dropped, and if even dropping rounds is not enough, every result but the last is set
  aside; 4.0 sent the oversized request as it stood.
- **Stuck (4.1).** Failures are counted per tool and target (the path, the command, the pattern).
  At three in a row the failing result says so — re-read, change approach — and the next round
  thinks; at five the task stops, paused, and says which wall it hit. A read between two failed
  edits of a file does not reset the count; a success at the same target does, and a change that
  lands resets the count of every command, because running the tests again after a fix is the
  method.
- **Reads side by side (4.1).** When one round asks for several reads in a row — `read_file`,
  `grep`, `glob`, `list_directory`, `read_document`, `read_spill`, page reading, the library,
  memory search, the date — they run together; results reach the model and the timeline in the
  order they were asked for, and budgets and repeats are charged before anything is sent. An edit,
  a command, a helper or a question runs alone, and `web_search` does too: its providers are
  rate-limited. The prompt asks for independent reads in one round.
- **Calls written as text (4.1).** A model whose server did not lift its call out of the text —
  Gemma's markup, the `<call>` and JSON forms, and now the Hermes/Qwen
  `<tool_call>{"name", "arguments"}</tool_call>` form and Qwen3-Coder's `<function=…>` — still has
  it run. One that cannot be read is not run, and no longer dropped in silence: the model is told
  which call did not run, twice a turn at most.
- One round's generation is capped when the slot sets no limit, so a model caught in a reasoning
  loop cannot think for an hour: 16K tokens by default, 8K or 4K under Settings → Agent → *Longest
  single step* (4.2; `EVAL_ROUND_MAX_TOKENS` for `eval:agent`, to measure whether the smaller caps
  cost a solved task). At the cap the thinking-channel recovery takes over, and a call cut off is
  told so and asked for in smaller parts (4.0.2).
- **Steering.** Type while a task works and the note is handed to the model at its next step; the
  chat shows where it landed.

## Background tasks

A task runs in the app's main process, not in the window. Switch chats, start another task in
another agent chat, keep talking to a model in a third — it carries on. The rail's **Working now**
card lists every running task with its time, its checklist progress and a Stop button; a task that
finishes while the window is not in front sends a desktop notification (Settings → Agent), which
opens its chat when clicked. Only one task runs per chat at a time. A window that closes stops the
tasks it started; a task still marked running after a restart is marked stopped, with the reason.

## Undo

Every file a turn changes is checkpointed before its first change — to disk, under the app's data
folder, so Undo survives a restart. **↶ Undo changes** on the turn puts each file back as the task
found it (a file the task created is removed) — except a file that has changed since the task last
wrote it: that later change is somebody's work, so it is left alone and named. Deleting the chat
stops its task and deletes its checkpoints.

## Its own server — the agent connection (4.6)

The agent can run on a server of its own while chat, embeddings, titles, the library and the model
pin stay on LM Studio: **Settings → LM Studio → Agent connection** (off by default; the details are
in [settings.md](settings.md#the-agent-connection-46)). On this PC that is the 35B-A3B in
llama-server on the B60 (`http://127.0.0.1:8081/v1`), two to three and a half times the 9B's speed
on agent work. Agent chats, `sigma` and agent jobs all follow it. If that server does not answer or
lacks the model, the task stops with a message that names the connection; it is never moved back to
LM Studio unasked.

## The `sigma` command

The same engine in a terminal. **Settings → Agent → Install the sigma command** puts a launcher on
your PATH (`sigma.cmd` in `%LOCALAPPDATA%\Microsoft\WindowsApps` on Windows, `~/.local/bin/sigma`
elsewhere) that runs the CLI on the app's own runtime — no Node to install.

```bash
sigma                              # a session in the current folder
sigma "fix the failing test"       # one task, then exit (0 done, 3 paused, 1 otherwise)
sigma --read-only "explain this repository"
sigma --json -p "…"                # one JSON event per line, for scripts
```

It reads the app's settings for the server, the model and the agent limits, so nothing is
configured twice. Approvals are prompts: `y`, `n`, or `a` — accept every edit, or this exact
command, for the rest of the session. A one-shot run with no terminal to ask declines edits and
commands and says so; `--accept-edits` lets edits land. In a session, `/mode`, `/model`, `/undo`,
`/clear` and `/help`; Ctrl+C stops a task.

With the app's agent connection on, `sigma` runs there too, after the same check (exit 1, in words,
when that server is down or lacks the model); `--base-url` names the server for one run instead, and
`--json`'s last line carries `connection: { via, baseUrl, model }` — `via` is `agent` or `main`.

## What it will not do

- **Leave the folder.** Every path resolves inside it; `..`, an absolute path elsewhere, and a
  write through a symlink that points out of it are all refused.
- **Talk to anything but LM Studio on this machine — from the CLI.** The CLI has no web tools and
  refuses a server address that is not loopback; the agent connection (4.6), when it is on, is a
  server on this machine under the same rule. In the app, the agent's requests go through the
  same audited transport as a chat's (the egress allowlist, the network activity log), and the
  app's own tools keep their own rules. **A command is the exception, in both** (v4.1): it is a
  program with sockets of its own, so what `run_command` or a hook sends is outside the allowlist,
  the proxy and the log. One that obviously reaches the network — `curl`, `git fetch`, `npm
  install`, `ssh`, a URL — says *reaches the network — not in the network log* in its approval, and
  in the app a row under `command` records that it ran, with its command line. SECURITY.md, *What is
  logged, and what is not*.
- **Run a command without asking**, in any mode, unless you granted that exact command in that
  exact folder.
- **Pretend.** The closing report is asked to name what was changed and how it was checked, and
  never to claim a check that did not run; the timeline shows every step, so the claim can be read
  against what happened.

## Measured

On a small repository with two bugs and a failing test, `qwen3.8-35b-a3b-distill` through LM Studio
read the test and the source, fixed the first bug, ran the tests, read the new failure, found the
second bug (a numeric sort that sorted as strings), fixed it and ran the tests to green —
eight rounds and nine tool calls, about thirteen minutes on this machine, most of it the model thinking before each
call. An independent run of the tests afterwards passed. The engine's behaviour against a scripted
model — review, decline, accept, re-read after edit, helpers, pause, stop, failure, context fitting
— is pinned in `test/agentEngine.test.ts`; the window's half in `test/agentTurn.test.ts`; the CLI,
end to end over HTTP, in `test/cli.test.ts`.

That is one run. The suite meant to replace it is `eval:agent` (v3.1): twenty repositories —
fixes, chained bugs, features, refactors, read-only questions, tasks that need you, and two long
enough to overflow a 16K window — scored for tasks solved, false claims that the tests pass,
collateral edits, whether Undo restores the folder, and cost. How it scores is in `docs/evals.md`;
its baselines are owed — the first attempt stopped on a hardware fault on the bench machine, not on
anything the suite measures (`docs/evals.md`, *Baselines*).
