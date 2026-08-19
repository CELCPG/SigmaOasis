# Sigma Oasis v1.10.0 — projects that know things

Through v1.9 the conversation rail had two jobs: list your chats, and hold the controls for the
open one in its bottom-left corner. This release gives each job its own place, and gives the
"folder" a memory. Pinned by 1,428 node checks.

## A chat panel on the right (⌘J)

Everything scoped to the open conversation now lives in a collapsible right-hand panel, the
mirror of the rail (⌘B): **project**, **strategy and roles**, **memory scope** (now an inline
checklist, not a pop-up), **rollback and export**, and a **details** readout — sent/replies, tool
calls, who answered, context in use, tokens generated, compaction state, when it started, files
shared in the chat, and its branches (one click to jump). Both layouts are remembered across
restarts. The rail is now only a list.

## Projects

Group chats under named, colour-coded projects: fold a project, start a chat inside it, move a
chat with the 📁 menu or from the command palette (⌘K). Deleting a project keeps its chats.
Branches stay in their parent's project.

A project is a folder until it carries context. These carry four kinds, all edited under ⚙ on
the project or *Edit project…* in the panel:

- **Instructions** — appended to the role's system prompt for every chat in the project. Stable
  across turns, so it sits with the role prompt rather than in the per-turn notes and costs
  nothing to re-read.
- **Pinned files** — paths only, never content. Each is read from its path and indexed in RAM the
  first time a chat needs it (or now, with ⟳), then retrieved per turn exactly like an attached
  document. The editor says where each file stands — on disk, indexed, size — and a file that has
  moved is flagged in words, and in the panel.
- **Defaults for new chats** — strategy, role, memory scope. Applied when a chat is started inside
  the project; existing chats are never changed.
- **Recall across chats** — before each reply, the passages of the project's *other* chats most
  relevant to your message are handed to the model and shown under the reply as "🗂 From this
  project's other chats", expandable to exactly what was surfaced. Per-project toggle.

## How recall stays private and stays quiet

Sibling chats are read from their JSON files **in the main process** — chat ids cross the IPC
boundary, transcripts never do — and a chat is re-indexed only when it changed. Ephemeral chats are
never on disk, so they are never recallable: the no-trace promise holds by construction.

Recall runs over a **project-level index**: every sibling transcript is chunked once per change
and cached; per query, one BM25 index is built over all of them (so a term rare across the project
is rare — IDF is shared), cosine comes from the same loopback embedding model memory uses, and the
two are fused by reciprocal rank across the whole corpus. A passage rides only on a shared term or
a cosine above the memory floor, so a chat with nothing to say about your message contributes
nothing; MMR trims near-duplicates. Keyword-only when the embedding model is unavailable. Verified
end to end: instructions in the system prompt, a sibling chat's figure recalled into another chat,
an unrelated question producing no block at all.

The details panel says what all of this costs: **"↳ project share: ~1.6k tokens"** under *Context
in use*, with the split — instructions · pinned files · recall — in the tooltip. The composer's
context meter counts the project's instructions too.

## Also

- Think-channel recovery (v1.9.x) now uses the reasoning channel as direct evidence: reasoning and
  no content is an answer on the wrong channel (recovered, once); neither is a model with nothing
  to say (left alone). The tool-has-run rule remains as the fallback.
- `scripts/test.sh` resolves the bundled Electron by absolute path, which is what stops macOS
  aborting the suite with "NSBundle initWithURL:: non-file URL argument" once the .app has been
  registered with LaunchServices.

## Upgrade notes

Auto-update from v1.9.x. Existing conversations appear under **Unfiled**; nothing is grouped until
you make a project. Two settings were added (`projects`, `rightPanelCollapsed`) and one
per-conversation field (`projectId`); nothing existing changed meaning. The "This chat" controls
moved from the rail's bottom-left to the right panel — ⌘J if you have hidden it.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.9.1...v1.10.0
