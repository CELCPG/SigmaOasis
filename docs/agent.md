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
| `write_file` | A new file, or a whole-file rewrite of one already read. |
| `run_command` | A shell command in the folder — a login shell on macOS/Linux, Git Bash on Windows when installed (cmd.exe otherwise). Output keeps its start and its end; a time limit (Settings → Agent) stops the whole process tree. |
| `todo_write` | The checklist you see above the steps. |
| `task` | Hand a focused job to a **helper**: *explore* (read-only investigation), *review* (a read-only second look at changes), *general* (a self-contained sub-task that may edit). A helper starts with an empty context and returns one report, so a broad search does not fill the agent's own window. Helpers cannot start helpers. |
| the app's own tools | Web search and page reading, deep research, the reference library, memory search, dates and the Python sandbox — each only when enabled under Settings → Tools, and only if *Let the agent use the app's own tools* is on under Settings → Agent. |

**Edit matching forgives three things and guesses none.** An exact match is tried first. Then:
LF text against a CRLF file (the edit lands in the file's own line endings), `read_file` line
numbers pasted into the search, and trailing spaces — each only when it finds exactly one place.
An ambiguous search is an error with the count; a miss names the closest line. Measured as the
common failure of small models' edits, and pinned in `test/agentEngine.test.ts`.

## SIGMA.md — a project's standing instructions

A `SIGMA.md` at the folder's root is read at the start of every task and put in the agent's
instructions: how to run the tests, the style to keep, what not to touch. It lives in the repository
with the code it describes. When there is no `SIGMA.md`, an `AGENTS.md` or `CLAUDE.md` is read
instead, so a project already set up for another agent works unchanged.

## Long tasks

- A task runs up to *Steps before a task pauses* (Settings → Agent, 40 by default); then it pauses,
  says so, and carries on when you press **Continue**.
- **Context.** Before every request the history is fitted to the model's loaded window: the oldest
  tool output is replaced by a note naming the tool and saying how to fetch it again, the four most
  recent results are never touched, and only if that is not enough are whole early rounds dropped —
  never a call without its result. The turn says when this happened.
- One round's generation is capped at 16K tokens when the slot sets no limit, so a model caught in
  a reasoning loop cannot think for an hour; at the cap the thinking-channel recovery takes over.
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
deletes its checkpoints.

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

## What it will not do

- **Leave the folder.** Every path resolves inside it; `..`, an absolute path elsewhere, and a
  write through a symlink that points out of it are all refused.
- **Talk to anything but LM Studio on this machine — from the CLI.** The CLI has no web tools and
  refuses a server address that is not loopback. In the app, the agent's requests go through the
  same audited transport as a chat's (the egress allowlist, the network activity log), and the
  app's own tools keep their own rules.
- **Run a command without asking**, in any mode, unless you granted that exact command in that
  exact folder.
- **Pretend.** The closing report is asked to name what was changed and how it was checked, and
  never to claim a check that did not run; the timeline shows every step, so the claim can be read
  against what happened.

## Measured

On a small repository with two bugs and a failing test, `qwen3.8-35b-a3b-distill` through LM Studio
read the test and the source, fixed the first bug, ran the tests, read the new failure, found the
second bug (a numeric sort that sorted as strings), fixed it and ran the tests to green —
twelve steps, about thirteen minutes on this machine, most of it the model thinking before each
call. An independent run of the tests afterwards passed. The engine's behaviour against a scripted
model — review, decline, accept, re-read after edit, helpers, pause, stop, failure, context fitting
— is pinned in `test/agentEngine.test.ts`; the window's half in `test/agentTurn.test.ts`; the CLI,
end to end over HTTP, in `test/cli.test.ts`.
