# Sigma Oasis v3.0.0 — the calm harness

2.x taught a small local model to answer honestly: to ground, cite, compute and say what it
could not check. 3.0 gives it two new ways to be used. **The agent** works — give it a folder and a
task, and it reads, edits, runs your tests and checks its own work until the task is done, in the
app or from your terminal. **VIBE** rests — a mode with nothing on screen but the conversation, on
slow night water, with the whole engine still running underneath. As before, everything runs on
LM Studio on your machine, every change and command is yours to approve, and what was measured is
written down with its caveats.

## What ships

**The agent.** *⚡ Agent task* in the rail opens a chat on a folder you choose. Its tools are the
ones agentic CLIs converged on — `list_directory`, `glob`, `grep`, `read_file` (numbered, windowed),
`edit_file` (exact search-and-replace), `write_file`, `run_command`, `todo_write` — held to the
folder: `..`, absolute paths elsewhere and writes through a symlink that leaves it are refused. Three
modes per chat: *Ask first* (every edit a diff to Apply or Discard, every command a dialog), *Accept
edits* (edits land, checkpointed and on the record; commands still ask) and *Read-only* (nothing that
writes or runs is offered). Commands always ask, and *Always allow* is the same standing grant the
chat's terminal tool mints — that exact command, in that exact folder. The turn is drawn as a
timeline: each step one line in words, in the order it happened, opening into the diff or the
command's output; a checklist above it; what changed, Continue and **Undo** below it. Undo restores
every file the turn changed from checkpoints kept on disk — except a file changed since, which it
leaves alone and names. `docs/agent.md` is the whole account.

**Helpers.** The `task` tool hands a focused job to a helper that starts with an empty context and
reports back once — *explore* and *review* read-only, *general* with the parent's permissions — so a
broad search does not fill a local model's window. Its steps render inside the call that started it.

**Background tasks.** A task runs in the main process, not in the window: switch chats, start a
second task, keep chatting in a third. The rail's *Working now* card lists what is running with its
time, checklist progress and Stop; a task that finishes behind other windows posts a desktop
notification. The window can reload and relearn what is running; a task marked running after a
restart is marked stopped, with the reason; deleting a chat stops its task. VIBE follows an agent
chat's task too — it breathes while the task works, and its Stop stops the task.

**`sigma`.** The same engine in a terminal — `sigma` for a session in the current folder, `sigma
"task"` for one task (exit code 0 done, 3 paused), `--read-only`, `--accept-edits`, `--json`.
Approvals are prompts (`a` to accept for the session); `/mode`, `/model`, `/undo`, `/clear` in a
session; Ctrl+C stops a task. It reads the app's settings for the server, model and limits, refuses a
server that is not on this machine, and has no web tools. Settings → Agent installs a launcher onto
the PATH that runs it on the app's own runtime, so there is no Node to install.

**SIGMA.md.** A project's standing instructions for the agent, read from the folder's root at the
start of every task; AGENTS.md or CLAUDE.md are read when there is none.

**VIBE.** ⌘⇧L (or *〰 Vibe* in the rail, the palette, Settings → General) turns the window into a
night lagoon — a WebGL caustic network that flows over deep blue, a breath of light while the model
works, words that surface as they arrive — with one composer and nothing else. Tools, recall, the
library and every check still run; none of it is drawn. What is never hidden: a file change waiting
for Apply, an ephemeral chat's *not saved*, a server that is not answering, and why a turn that ended
with nothing ended. Reduced motion makes the lagoon one still frame. Esc leaves.

**The agent's plumbing, shared.** The engine (`src/main/agent/`) is plain Node — the app and the
CLI run the same code — and it reuses the chat's own loop, so the recoveries measured on these models
since 1.x (argument repair, repeat reuse, prose-call and thinking-channel recovery, per-tool budgets)
come with it. Long tasks fit the loaded window by setting aside the oldest tool output, with a note
saying how to fetch it again; one round's generation is capped at 16K tokens when the slot sets none.

## Measured

**The agent, live.** A small repository with two bugs and a failing test, `qwen3.8-35b-a3b-distill`
through LM Studio, *Ask first*: the agent read the test and the source, proposed the first fix (applied
from its diff), ran the tests, read the new failure, found the second bug — a numeric sort that sorted
as strings — proposed that fix (applied), ran the tests to green and reported both. An independent run
of the tests afterwards passed; Undo then restored the file exactly as it was. The same task through
the engine alone took eight rounds (nine tool calls) and about thirteen minutes on this machine, most of it the model
thinking before each call — which is why the timeline shows the newest line of the model's reasoning
beside a clock while it thinks, rather than a spinner.

**VIBE's one line, and where it goes.** VIBE asks for brevity and changes nothing else. The first
build put that request on the turn's own notes, as every per-turn addition is placed, and it cost the
mode its tools: asked *"What time is it right now?"*, turns called `get_current_datetime` 1 time in 13
across four wordings and two models, against 7 in 7 with VIBE off — one turn's reasoning even said it
would call the tool, and then it answered with an invented time. In the system prompt, the same kind of
line kept the call, 7 in 8. It ships there; toggling VIBE mid-conversation costs one re-read of that
conversation's history. The table is in `docs/evals.md`.

**The date.** The system prompt stated the UTC date (tomorrow's, from 8 PM on the US east coast) with
no weekday, and `get_current_datetime` returned no weekday either; a 9B model named the day wrong four
times in four, once straight after reading the clock. Both now state the local date with its weekday,
and the model named the day correctly in every run after.

**The suites.** 2,800+ node tests, including the engine against a scripted model (review, decline,
accept, re-read after edit, helpers, pause, stop, failure, context fitting), the agent timeline
rendered from events, VIBE's markup, and the CLI end to end over HTTP; and every Electron check
(render, style, contrast, tab traversal, modal focus, plan accessibility, markdown, Workbench, MCP
secrets, transport).

## Not in this release

- **Parallel helpers.** Helpers run one after another: a single local server serving one model is
  not two, and running them side by side would only queue at LM Studio. When LM Studio serves
  parallel requests well on ordinary hardware, the engine's loop is where it would change.
- **Git awareness** — a branch per task, a commit per checkpoint. Undo covers the files a turn
  changed; git remains yours.
- **Web tools in the CLI.** The app's egress allowlist, activity log and proxy are the app's; a CLI
  that reached the web would do it outside all three. It stays loopback-only until it can do better.
- **A wider tool-choice run with VIBE on** — the placement above is eight runs, not a suite; it is
  owed with the next `eval:tools` pass.

## Upgrade notes

- Settings gain `vibeMode` (off) and an `agent` group (40 steps, 120 s commands, *Ask first*, the
  app's tools on, notifications on); older settings files are filled in at start. Conversations gain
  an optional `agent` field, and messages an optional `agent` turn state; older builds ignore both.
- Agent checkpoints live under the app's data folder in `agent-checkpoints/`, one folder per chat,
  removed with the chat.
- `get_current_datetime` now leads with the weekday and names the time zone
  (`Monday, September 28, 2026 at 12:25 PM EDT`); the ISO timestamp is unchanged after it.
- The chat's tool table is unchanged, so its pinned schema hash is too; the agent's tools are its own.
- `ToolResult` gains an optional `display` — what the record shows when it differs from what the
  model is handed (an edit: one line to the model, the diff to the reader).
- The destructive-command list, now shared by the terminal tool, the agent and the CLI, also flags
  Windows recursive deletes and the git commands that discard uncommitted work or rewrite a remote
  branch.
- Selling builds: 3.0 is still MIT. The launch checklist for paid builds — a store, where
  installers live, Windows signing — is in `ROADMAP-v3.0.md`.
