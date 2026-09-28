# Roadmap: Sigma Oasis 3.0 — the calm harness

2.x made a small local model answer honestly: it grounds, cites, computes and says what it
could not check. 3.0 makes it **work** — a folder-scoped agent that reads, edits, runs and
checks its own work the way Claude Code and the DeepSeek harnesses do — and makes it
**restful**: a mode with nothing on screen but the conversation. Both run on LM Studio on
your machine, and the privacy core does not move: nothing leaves without your say-so, and
every tool the agent touches goes through the same approvals, budgets and logs as before.

Decided with the owner on 2026-09-28: VIBE is visuals only (night lagoon, no sound) with the
full engine running underneath; all four agent capabilities ship; the code stays MIT and the
signed builds are what is sold; the release is merged, tagged and published by CI.

## Ships in 3.0

| # | Feature | What it is |
| --- | --- | --- |
| 1 | **VIBE mode** | The whole window becomes a slow night lagoon — drifting caustic light, an electric cyan/violet glow that breathes while a reply surfaces — and nothing else but the conversation and one composer. Tools, memory, the library and the checks all still run; none of it is drawn. Replies are asked to be short. ⌘⇧V or the 〰 button enters, Esc leaves. Honors reduced motion. |
| 2 | **Agent workspace** | Open a folder and give a task. The agent lists, globs, greps and reads (with line numbers and ranges), edits by exact search-and-replace with the diff shown before a byte lands, runs commands with your OK, keeps a visible to-do list, and loops until the work is done or it needs you. |
| 3 | **Permission modes** | Per task: *Ask* (every edit and command), *Accept edits* (edits inside the folder land without a prompt; commands still ask), *Read-only* (the agent investigates and plans, touches nothing). |
| 4 | **Checkpoints** | Every file the agent changes is snapshotted first; *Undo changes* on the task restores them all. |
| 5 | **SIGMA.md** | A project's standing instructions for the agent, read from the folder's root — the `CLAUDE.md` idea, on disk and in git with the code it describes. |
| 6 | **Subagents** | The agent hands a focused job — explore, review, general — to a subagent that works in a fresh context with its own tool set and returns a summary. The parent's context stays small, which on a 9–35B local model is the difference between finishing and drowning. Visible nested under the call that made it. |
| 7 | **Background tasks** | Agent tasks run in the main process, not the window: switch chats, keep talking, and a tasks tray shows each task's state, its to-dos and its last step. A finished task says so. |
| 8 | **`sigma` CLI** | The same engine in a terminal: `sigma` for an interactive session in the current folder, `sigma -p "…"` for one-shot. Approvals are prompts in the terminal; it reads the app's server and model settings, so nothing is configured twice. Ships inside the app and runs on the app's own runtime — no Node install needed. |
| 9 | **Long-horizon context** | Agent sessions keep the full tool history while it fits the loaded context, and elide the oldest tool output (with a note saying how to get it back) when it does not — so a 60-round task does not fall off the end of an 8K window. |
| 10 | **MCP environment values in the keychain** | The in-flight branch: an MCP server's environment values are encrypted with the OS keychain, and the privacy audit reads the stored state instead of asserting it. |
| 11 | **3.0 release** | Version 3.0.0, release notes, README, onboarding copy that introduces the three ways to use the app (Chat, VIBE, Agent). |

## Launch checklist — needs the owner (not code)

Selling builds of MIT code works when what is sold is the convenience and trust around the
code: signed, notarized installers, updates that arrive on their own, and support. These are
the pieces that make that true:

1. **A store.** Lemon Squeezy or Paddle (both merchant of record: they collect and remit VAT
   and sales tax, which Gumroad and raw Stripe leave to you). A one-time price with a year of
   updates is the common shape for a local-first desktop tool.
2. **Where installers live.** Today every tag publishes free installers on public GitHub
   Releases and bumps the public Homebrew cask. That is compatible with MIT and incompatible
   with selling downloads. Choose one: keep GitHub Releases public and sell support and early
   access, or move installers and the update feed to private storage the store links to. The
   second changes the auto-updater's feed (`electron-updater`'s generic provider) and the
   Homebrew cask, and is a release-pipeline change of its own.
3. **Windows code signing.** The Windows installer is unsigned and triggers SmartScreen.
   A paid product needs an OV or EV certificate (or Azure Trusted Signing); CI already has the
   slot for it.
4. **A landing page** with the VIBE mode as the hero — it is the screenshot that sells the
   calm — and the agent workspace as the proof of power; the privacy audit screen as the proof
   of the promise.
5. **Support channel** (email or Discord) and a privacy statement that says in one line what the
   app contacts, and that the store is the only party that learns who bought it.

## After 3.0 (3.x)

- Parallel subagents when LM Studio is serving parallel requests.
- Git awareness for the agent: a branch per task, a commit per checkpoint.
- Hooks (run a command before or after a tool) and custom slash commands in app and CLI.
- A VS Code extension that drives the `sigma` CLI.
- VIBE with voice: push-to-talk in, the local voice out.
