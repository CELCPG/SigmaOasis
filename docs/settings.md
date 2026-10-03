# Settings (v4.0)

`⌘,` (Ctrl+, on Windows and Linux), the gear in the rail, or *Settings* in the palette. This page
is what the panel holds, how a change takes effect, and how the rest of the app points into it.

## The panel

A glass panel with a rail of sixteen tabs under six headers, a header that says what the open tab
governs, and a foot that says what just changed. The rail's search field narrows the rail as you
type: it reads every tab's name and description and every setting's label and help, and lists the
settings it finds under their tabs — click one to land on it. Arrow keys move along the rail;
`⌘F` (Ctrl+F) inside the panel goes to the search; Esc closes.

| Group | Tab | What it governs |
| --- | --- | --- |
| Setup | **LM Studio** | The server address, whether it answers, what it has loaded and which role uses each model. The agent connection (4.6): a second server for the agent alone, off by default — below. |
| | **Roles** | Each role: its model, persona, standing rules, capability and specialty, colour, thinking (v4.1: auto / on / off), a draft model (v4.2: none by default), Code Mode, its own tool list and sampling. The pipeline order. The tool-choice eval. |
| | **Appearance & chat** | Theme, font size, what a reply shows, reasoning display, what happens when a conversation outgrows the window, plan mode, updates. |
| Intelligence | **Grounding & checks** | What the app does before a reply (playbooks, outlines, re-ranking library passages and expanding library questions — v4.2, both off by default), after it (auto-correct, workbench checks, the source check — v4.1, off by default — self-review, second opinion, claim checking) and across replies (the conversation ledger, the fact ledger). |
| | **Memory** | Whether memories are recalled automatically, how many, the embedding model, and the knowledge base. |
| Capabilities | **Tools** | The working directory, the Workbench, every tool by domain with a switch for the group and one per tool, and the standing grants. |
| | **Agent** | How freely a new agent chat works, its step and time limits, the shell it uses here, and the `sigma` command. |
| | **Search & research** | The search provider and its key or address, results per search, confirmation, JavaScript pages; the deep research budget and plan approval. |
| | **Voice** | Replies read aloud; push-to-talk through whisper.cpp. |
| Knowledge | **Library** | Reference packs: yours, curated, ZIM files; try a lookup. |
| | **Skills** | Installed skills. |
| | **MCP** | Servers, their switches, approvals and tools; add one. |
| Automation | **Jobs** | Standing questions and their schedules; add one. |
| Privacy | **Privacy** | The promise, the audit, update checks, the proxy, shopping, the session audit log. |
| | **Activity** | What the app contacted, what it read this session, and the audit log files. |

## Apply as you go

There is no Save. Every control applies when it commits — a switch on click, a select or a
stepper on change, a slider when you let go, a text field when you press Enter or leave it
(Escape puts the old value back). A line at the panel's foot says what changed, with **Undo** for
four seconds; Undo puts that one value back, on disk too.

Each section has a **Reset** in its header that puts its own settings back to their defaults;
**Reset to defaults** at the panel's foot does the same for everything. Both take two clicks — the
first arms, the second acts, and the button says what the second will do.

Every remove, revoke, forget, clear and purge in Settings takes the same two clicks.

## What the controls are

Every control in Settings is one of the kit's: a switch, a segmented choice, a select, a field, a
stepper, a slider, chips, an action button with its readout, a two-click danger button. Each has
one look in both themes and one keyboard behaviour: Space or Enter toggles a switch, arrows move a
segmented choice, arrows step a stepper, Tab reaches every one. `test/settingsKitCheck.ts` walks
every tab in the built app and refuses a control that is not the kit's, a control outside a row,
a row with no help, a label at another size, a status dot in another palette, and a control the
Tab key does not reach.

## The agent connection (4.6)

Through 4.5 the app had one connection: LM Studio's address served chat, embeddings (the library,
memory, tool ranking), titles, the model pin and the agent. **Settings → LM Studio → Agent
connection** gives the agent a server of its own — llama.cpp's `llama-server`, for one, running a
bigger or faster model than the one LM Studio serves — while everything else stays where it was.

- **Off by default**, and off in every settings file written before 4.6. Off, the agent's requests
  are the 4.5 requests byte for byte (`test/agentRequests.test.ts`).
- **On**, the agent — agent chats, the `sigma` command and scheduled agent jobs — talks to that
  server and only that server. Chat, embeddings, titles, summaries, the library and the model pin
  stay on LM Studio. The app's own tools, when the agent uses them, keep asking LM Studio with the
  chat's model.
- **The address** follows the main address's rule: a server on this machine (`localhost`,
  `127.0.0.1`, `::1`), or it reverts to the default (`http://127.0.0.1:8080/v1`, llama-server's own
  port) and the card says so. The agent's requests are a model server's traffic — loopback, direct,
  never proxied — and its host joins the egress allowlist only while the connection is on.
- **The model** is picked from that server's own list, read with the same reader the LM Studio card
  uses (for llama-server: `/v1/models` and `/props` — the model, its quantization and window).
  *The server's model* (no name) means the one it lists first. Sigma never loads or unloads a model
  there.
- **The window** the agent budgets its history against is the one that server gives a request:
  llama-server's `/props` `default_generation_settings.n_ctx`. Started with `--kv-unified`, that is
  the whole context (98,304 for the B60's 35B with three slots), shared by every slot — other
  clients' requests at the same moment draw on the same pool. Started without it, it is one slot's
  share.
- **When it fails** the agent says so and stops, naming the connection: before a task, if the server
  does not answer or does not serve the model; during one, if it stops answering. It never falls
  back to LM Studio. Turn the connection off to run the agent on LM Studio again.
- **What you see**: the card's status line and Test; an agent chat's header and panel name the model
  and the address; each turn is labelled with the model that ran it.

`sigma` reads the same setting from the app's file (`--base-url` names a server for one run instead,
`--json`'s last line says which connection ran the task), and `eval:agent` takes the same route with
`EVAL_AGENT_BASE_URL` (docs/evals/agent.md).

## Links into Settings

Where the app says *Settings → Tools* in a sentence it can make a control, it is a link — the
privacy audit's every row, the composer's chip that says a model can write files or run commands,
the right panel's notes about an empty pipeline or no memory sources, the plan block's note about
tools. A link opens the tab, scrolls to the setting and lights it once. In code, a target is a tab
key or a row id (`tools`, `tools.web_search`); `openSettingsAt` takes either, and
`test/settingsLinks.test.ts` proves every target the app uses lands on a row that exists.

## Names that changed in 4.0

| Was | Is |
| --- | --- |
| Connection | LM Studio |
| Models | Roles |
| General | Appearance & chat |
| Pipeline | Roles › Pipeline |
| Search | Search & research |
| Privacy (the network log, pages read, audit files) | Activity |
| Models (second opinion, grounding) | Grounding & checks |

The keys the app links to (`connection`, `models`, `general`, …) did not change, so a link written
against 3.x still opens the right tab.
