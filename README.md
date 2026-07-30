# 🧠 Sigma Oasis

**A private, local-first desktop AI chat app powered by [LM Studio](https://lmstudio.ai).**

Sigma Oasis is a cross-platform (macOS + Windows + Linux) desktop application, inspired by the
Claude Desktop UI, that talks to models running locally in LM Studio via its OpenAI-compatible
API. It supports **up to 3 model "roles"** simultaneously, **agentic tools** (file I/O, terminal,
web search, notes), **@mention routing**, and a **collaborative pipeline** mode — all while keeping
**every byte of data on your machine**. No cloud, no telemetry.

---

## ✨ Features

- **Local & private** — connects only to your LM Studio server (`http://127.0.0.1:1234/v1` by default). The only other outbound paths are the privacy-preserving `web_search` / `fetch_webpage` tools (provider of your choice), the opt-in JavaScript page renderer (which contacts a page's own origin and nothing else), and update checks (opt-in, off by default) — all enforced by a built-in egress allowlist and visible in a network activity log.
- **Multi-model roles (up to 3)** — each slot has its own model, role name, system prompt, and color accent.
- **Three ways to use your models**
  - **Independent mode** — pick the active model from the top bar; each conversation keeps its thread.
  - **@mention routing** — type `@Coder write a sort function` to route a single message to a specific role.
  - **Collaborative pipeline** — your message flows through an ordered chain of models, each building on the previous one's output.
  - **Orchestrated mode** — an orchestrator model reasons about your request and **delegates to the other roles as tools** (`consult_model`), reads their answers, consults again if needed, then synthesizes the final reply. Specialists run with their own persona, tools, and memory; delegation loops are structurally impossible and consultations are capped per turn. Every delegation appears as an expandable "🤝 Consulted …" block.
- **File & image attachments** — drag & drop or use the 📎 button. Images are sent to vision-capable models (multimodal `image_url` parts); text files are inlined into context (truncated at 20 K chars). Attaching a PDF from disk is not supported yet — but a model can read a PDF on the web with `fetch_webpage`.
- **Voice chat, fully local** — 🔊 any reply can be read aloud with your OS's on-device voices, and an optional **voice mode** auto-reads replies. Push-to-talk 🎙️ records your voice and transcribes it **locally with [whisper.cpp](https://github.com/ggerganov/whisper.cpp)** plus a ggml model — `brew install whisper-cpp` on macOS/Linux, or `whisper-cli.exe` from the whisper.cpp releases on Windows. Both are auto-detected; override the paths under Settings → Voice. No audio ever leaves your machine.
- **Long-term local memory (RAG)** — a built-in vector store embedded via LM Studio's `/v1/embeddings`. Relevant memories are **automatically recalled into every conversation**; models can save/search/forget memories with dedicated tools; notes are auto-indexed; and you can add documents under **Settings → Memory**. Everything stays on disk as local JSON.
Vectors are tied to the model that produced them — if you switch embedding models, **Settings →
Memory** flags the sources that need re-indexing rather than returning meaningless matches.
- **Agentic tools** via OpenAI tool-calling — file read/write, directory listing, terminal (with a confirmation dialog), web search, date/time, and a local notes store.
- **Polished chat UI** — streaming tokens, markdown rendering, syntax-highlighted code blocks with a Copy button, typing indicator, collapsible tool-call blocks, and per-message role badges.
- **Local persistence** — settings via `electron-store`; conversations and notes as JSON in your OS app-data directory.
- **Dark mode by default**, with a light theme, adjustable font size, and configurable history limit.

---

## 📦 Prerequisites

1. **[LM Studio](https://lmstudio.ai)** — download, install, and:
   - Open the **Developer / Local Server** tab.
   - Load at least one model (e.g. a Llama / Qwen / Mistral GGUF).
   - Click **Start Server** (default port `1234`). LM Studio then exposes an OpenAI-compatible API at `http://127.0.0.1:1234/v1`.
2. **[Node.js](https://nodejs.org) 18+** and npm (only needed to run/build from source).

---

## 🚀 Run in development

```bash
npm install
npm run dev
```

This starts the Vite dev server (with hot reload for the React renderer) and launches the Electron app.

---

## 🏗️ Build for distribution

```bash
# Build for your current OS
npm run build

# Or target a specific platform
npm run build:mac    # → dist/*.dmg
npm run build:win    # → dist/*-setup.exe (NSIS installer)
```

Packaged installers are written to the `dist/` folder:
- **macOS** → `.dmg`, built for both `arm64` and `x64` (`npm run install:mac` builds only this Mac's architecture)
- **Windows** → `.exe` (NSIS installer)
- **Linux** → `.AppImage`

> To create a quick unpacked build for testing without an installer: `npm run build:unpack`.

---

## ⚙️ Configuring models

Open **Settings** (gear icon, bottom-left) → **Models**. For each of the 3 slots:

1. **Enable** the slot with the checkbox.
2. Choose a **Model** from the dropdown (auto-populated from LM Studio's `/v1/models`).
3. Give it a **Role name** (e.g. `Assistant`, `Researcher`, `Coder`). This becomes its badge and its @mention handle.
4. Write a **System prompt** describing the model's persona/instructions.
5. Pick a **color accent** (blue / purple / green).

Under **Settings → Connection** you can change the LM Studio base URL and test the connection.

---

## 💬 Using @mention model switching

In any conversation, prefix or embed a mention of a role name (spaces removed, case-insensitive):

```
@Coder refactor this function to be O(n)
@Researcher what are the tradeoffs of gRPC vs REST?
```

The message is routed to that model regardless of the current mode. The reply shows the routed model's role badge.

---

## 🔗 Using Collaborative Pipeline mode

1. In **Settings → Pipeline**, tick the models you want to participate and reorder them with the ◀ ▶ buttons.
2. In a conversation, switch the top-bar toggle from **Independent** to **Collaborative**.
3. Send a message. It goes to the **first** model; that model's output is forwarded as context to the **second**, and so on. Each model posts its own reply with its role badge, so you can watch the chain build up.

Example pipeline: `Researcher → Coder → Assistant` — research the problem, write the code, then summarize.

---

## 🛠️ Agentic tools

Tools use LM Studio's OpenAI-compatible **tool calling**. When a model requests a tool, Sigma Oasis
executes it **in the Electron main process** (never the renderer) and feeds the result back to the
model. Each call appears as a collapsible **"Tool Used: …"** block showing the arguments and result.

| Tool | Description |
| --- | --- |
| `read_file` | Read the contents of a local file. |
| `write_file` | Write/overwrite a local file — **off by default**; confirms each write when no working directory is set. |
| `list_directory` | List entries in a directory. |
| `run_terminal_command` | Run a shell command — **off by default**; shows a confirmation dialog before every run, with destructive patterns (e.g. `rm -rf`, `dd`, `curl \| sh`) flagged as dangerous. |
| `web_search` | Web search via your chosen privacy-preserving provider — self-hosted **SearXNG**, **Brave Search API**, or **DuckDuckGo** (Settings → Search). Queries are sanitized (emails, tokens, paths, etc. redacted) before they leave the machine. |
| `fetch_webpage` | Fetch and read a public web page or **PDF** (HTTPS only, scripts/ads/site chrome stripped). Private/internal addresses are refused (SSRF guard). Pass a `query` and the page is split into passages and **ranked** — the model gets the parts that answer the query instead of the first few thousand characters. Outbound links are returned so a citation can be followed directly. Re-reading a page already fetched makes no new network request. |
| `deep_research` | Research a question across many sources in **one call** — plans sub-questions, searches, reads and ranks the best pages, checks what is still unanswered, and returns a brief with numbered citations. See below. |
| `get_current_datetime` | Return the current local date/time. |
| `create_note` | Save a note to the local notes store. |
| `list_notes` | List saved note titles. |
| `read_note` | Read a note by title. |

**Enable/disable tools** and set a **working directory** under **Settings → Tools**. Disabled tools
are not exposed to the models at all.

The **working directory** does two things: relative paths resolve against it, and it acts as a
**boundary** — `read_file`, `write_file`, and `list_directory` refuse any path that resolves outside
it. Leave it empty for unrestricted paths; every `write_file` call is then confirmed individually.

> ⚠️ **Security note:** `run_terminal_command` and the file tools operate on your real filesystem,
> and a model can be influenced by anything it reads — web search results, attached documents, files
> on disk. `write_file` and `run_terminal_command` ship **disabled**; the terminal tool always asks
> for confirmation. Set a scoped working directory before enabling write access.
> All text returned from the web (`web_search`, `fetch_webpage`) is fed back to models wrapped in an
> explicit **"untrusted external content"** marker, so the trust boundary is visible to both the
> model and you.

---

## 🔒 Privacy, search & network egress

Sigma Oasis's promise — *your data is never sold and never leaves your machine without your say-so* —
is enforced structurally, not just by policy:

- **Egress allowlist.** Every request the main process makes goes through an allowlist derived from
  your settings: your loopback LM Studio server, plus the one search provider you chose. Anything
  else is blocked before it is sent and recorded as blocked.
- **Network activity log.** Settings → **Privacy** shows every request (newest first): purpose,
  origin, status, time. Only origins are recorded — never full URLs — so your queries stay private
  even in the log. With search disabled, this list should show nothing but LM Studio.
- **Update checks are opt-in.** The app can check GitHub Releases for updates, but only if you
  enable it (Settings → Privacy or General). Manual "Check now" always works.
- **Pages you read are never written to disk.** Web pages a model reads are chunked and embedded in
  RAM so only relevant passages are surfaced; the index is discarded on quit and never becomes part
  of your long-term memory unless you explicitly save it. Settings → **Privacy** shows how much is
  held and lets you forget it immediately.

### Deep reading: relevance instead of truncation

A long reference page has to be cut down before it fits in a model's context. Cutting it at the
first 8,000 characters — what v0.6 did — usually removes the part that answers the question and
burns the budget the next four sources needed.

Instead, a fetched page is split into passages, embedded locally through LM Studio's
`/v1/embeddings`, and ranked against what the model is actually looking for:

- **Hybrid ranking.** Semantic (embedding) and keyword (BM25) rankings are fused with Reciprocal
  Rank Fusion. Embeddings catch paraphrase and synonym; BM25 catches the exact tokens embeddings are
  weak on — version numbers, error codes, API names — and neither is trusted alone.
- **Works with no embedding model.** If LM Studio has none loaded, retrieval degrades to keyword-only
  and says so, rather than failing.
- **Near-duplicates removed.** Overlapping passages are pruned (MMR) so the results aren't five
  windows onto the same paragraph, and survivors are shown in page order with a position and score.
- **Local only.** Chunking, embedding and ranking all happen on your machine; the page text is the
  only thing that ever crossed the network, and it already did.

Alongside ranking, reading a source now handles the things that used to make deep research
impractical:

- **Site chrome is removed properly.** Menus, cookie banners and "related stories" rails are stripped
  by class and id, not just by tag, and the article container is picked by text density. When no
  distinct article can be identified, the model is told so rather than left to guess.
- **PDFs are read.** Papers, filings and standards are extracted directly (including the ToUnicode
  font maps modern PDF producers use). If a PDF is encrypted, is a scan with no text layer, or uses an
  encoding that cannot be decoded, Sigma Oasis says exactly that instead of returning garbled text —
  a model cannot tell mojibake from content, so guessing is worse than refusing.
- **Links come back.** An agent that reads a page can follow a citation directly instead of going
  back to the search provider, which saves both a round-trip and another query on the wire.
- **Repeated searches are served locally.** Identical queries within ten minutes are answered from
  RAM, so the provider sees one query instead of five. This also keeps bursts inside the rate limits
  DuckDuckGo and Brave's free tier enforce.

### Deep research: many sources, one tool call

`web_search` and `fetch_webpage` are enough for a quick lookup. For a real question, chaining them by
hand runs into two walls: the agentic loop stops after 8 consecutive tool rounds, and every page a
model reads stays in the conversation. A search plus a fetch costs two rounds, so an improvising model
gets about **four sources per turn** — and the pages it read have already crowded out the room it needed
to reason about them.

`deep_research` moves the whole crawl into the main process, inside a single tool call:

```
plan → search → select → read → reflect → (one more round) → synthesize
```

Twenty pages can be searched, fetched, ranked and discarded without any of it touching the
conversation. Only the synthesized brief and its citations come back. The orchestration is code, not
model improvisation, so it is bounded and repeatable rather than a matter of how well the model
happened to plan.

- **Planned, then checked.** A local model decomposes the question into sub-questions and keyword
  queries. After reading, coverage is assessed **mechanically** — enough high-scoring text per
  sub-question — and a second round targets only what is still open. Asking a model to grade its own
  work would return "yes" nearly always, and the second round would never happen.
- **Every phase has a budget.** Rounds, searches, pages, distinct domains and wall clock, chosen by
  **Settings → Search → Deep research budget** (quick / standard / thorough). Limits are checked before
  each action, not reported after, and any limit that stopped the run is disclosed in the result.
- **Sources are ranked before they are fetched.** Snippets are scored against the sub-questions first,
  so a page that will not help is a host never contacted. A per-domain cap keeps one prolific site from
  filling the evidence base.
- **The brief is cited or it says so.** Every claim carries a `[n]` pointing at a real URL, and
  sub-questions the sources did not answer are listed as gaps rather than filled in from the model's
  own knowledge.

#### What leaves your machine

Your question does not. Only the planner's keyword queries go out, each through the same redaction as
any other search. Turn on **Settings → Search → Approve research plans** and you get one dialog showing
every sub-question and every outgoing query before anything is sent — more informative than six
separate prompts, and the moment to catch a query carrying context it should not. The result reports
every domain contacted, the number of searches and pages, and any redactions applied.

### JavaScript-dependent pages (opt-in)

Documentation sites and single-page apps return an empty shell to a plain HTTP fetch — their content
arrives only once scripts run. Enable **Settings → Search → Read JavaScript-dependent pages** and
Sigma Oasis will re-read such a page in an offscreen browser window.

It is **off by default**, and static-first when on: the plain fetch is always tried first, and the
browser is used only when that comes back empty or the page is recognizably an app shell. A plain
fetch executes nothing and contacts exactly one host, so it stays the preferred path.

A browser normally reaches the network on its own, outside any allowlist. That is not acceptable here,
so every request the render session makes passes through a single filter that:

- **blocks every third-party request** — only the page's own origin is allowed, which makes ad,
  analytics and tracker domains structurally unreachable. This is stricter than a normal browser, not
  a relaxation;
- **blocks anything that cannot carry text** — images, media, fonts, websockets, beacons;
- **records every request, allowed or blocked**, in the same network activity log as everything else,
  under the `render` purpose. The count of blocked origins is reported back with the page.

The session itself is ephemeral and per-page: no cookies, no cache, no storage, a fresh partition each
time and destroyed afterwards. No preload script is attached, so nothing in a fetched page can reach
`window.api`. All permission requests are denied, navigation away from the target is blocked, and load
time and extracted size are capped.

**Rendering also makes prompt injection harder, not easier.** With a real DOM, `getComputedStyle`
reveals text that is invisible to a human reader — `display:none`, `opacity:0`, zero font size,
screen-reader clipping, positioned off-canvas — which is exactly where injected instructions hide,
because a person reviewing the page never sees them. That text is dropped before the model sees it and
the amount removed is reported. The static regex path cannot do this at all, since the styling may
live in an external stylesheet.

### Choosing a search provider (Settings → Search)

| Provider | Privacy profile | Setup |
| --- | --- | --- |
| **Self-hosted SearXNG** (recommended) | Best — metasearch over 70+ engines from a server **you** run; only infrastructure you control ever sees queries. | `docker run -p 8888:8080 searxng/searxng`, enable JSON output (`formats: [html, json]`), set the URL in Settings → Search. |
| **Brave Search API** | Strong — independent index, no user profiling. | Free API key from brave.com/search/api; stored via your OS keychain (Electron `safeStorage`), never in the plaintext settings file. |
| **DuckDuckGo** | Good — no key, no tracking; rate-limited. | Works out of the box (default). |

Also configurable per your taste: results per search (1–10) and **Confirm every query**, which shows
the exact sanitized query for approval before each search is sent. Use the **Test connection**
button to verify your provider setup.

---

## 🗂️ Where data is stored

All data lives in your OS application-data directory (`app.getPath('userData')`):

- **Settings** — `config.json` (managed by `electron-store`)
- **Conversations** — `conversations/<id>.json`
- **Notes** — `notes.json`

Typical locations:
- macOS: `~/Library/Application Support/Sigma Oasis`
- Windows: `%APPDATA%\Sigma Oasis`
- Linux: `~/.config/Sigma Oasis`

There is **no cloud sync and no telemetry**.

---

## 🧱 Project structure

```
sigma-oasis/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── index.ts          # App/window bootstrap
│   │   └── ipc/
│   │       ├── tools.ts      # Agentic tool implementations + schemas
│   │       ├── store.ts      # electron-store, conversations, notes, encrypted secrets
│   │       ├── net.ts        # Egress allowlist + network activity log
│   │       ├── search.ts     # Search providers + SSRF-guarded webpage fetch
│   │       ├── extract.ts    # HTML → main content, text and outbound links
│   │       ├── render.ts     # Offscreen renderer + third-party egress filter
│   │       ├── pageScript.ts # DOM extraction injected into an isolated world
│   │       ├── userAgent.ts  # The one shared, non-identifying User-Agent
│   │       ├── pdf.ts        # PDF text extraction (zlib only, no dependencies)
│   │       ├── embeddings.ts # Chunking + local embedding via LM Studio (shared)
│   │       ├── retrieval.ts  # BM25, rank fusion, MMR — pure ranking primitives
│   │       ├── researchIndex.ts # Ephemeral RAM index over fetched pages
│   │       ├── deepResearch.ts  # Plan → search → read → reflect → synthesize
│   │       ├── llm.ts        # Main-process model calls + tolerant JSON parsing
│   │       └── memory.ts     # Durable long-term memory (RAG) on disk
│   ├── preload/
│   │   ├── index.ts          # Secure context bridge (window.api)
│   │   └── index.d.ts        # Renderer-side typings
│   └── renderer/             # React + TypeScript UI
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── types.ts
│           ├── assets/index.css
│           ├── lib/          # markdown + color helpers
│           ├── stores/appStore.ts        # Zustand global state
│           ├── hooks/
│           │   ├── useLMStudio.ts         # streaming + tool loop + routing
│           │   ├── useModels.ts           # model discovery / status
│           │   └── useConversations.ts    # persistence
│           └── components/
│               ├── Sidebar.tsx
│               ├── ChatArea.tsx
│               ├── MessageBubble.tsx
│               ├── InputBar.tsx
│               ├── ModelTabs.tsx
│               ├── ToolCallBlock.tsx
│               ├── SettingsModal.tsx
│               └── CollaborativeMode.tsx
├── test/                     # node:test suite (see Tests below)
│   ├── harness.ts            # Stubs the electron/net/store seams
│   ├── renderCheck.ts        # Browser checks in a real offscreen window
│   └── fixtures/
├── scripts/test.sh
├── scripts/test-render.sh
├── electron.vite.config.ts
├── electron-builder.yml
├── tailwind.config.js
├── package.json
└── README.md
```

---

## 🧪 Tests

```bash
npm test
```

The suite covers the search, extraction, retrieval and PDF code paths — the parts that are pure
logic and easy to regress. It uses Node's built-in `node:test` runner and **adds no dependencies**;
if `node` is not on your PATH it falls back to the Node runtime already bundled inside the project's
Electron.

Tests run against the real main-process modules, with only three seams stubbed (`electron`, the
network layer, and settings), so what is verified is the code that ships rather than a
re-implementation of it. The embedding stub is deterministic and folds a few synonyms onto shared
dimensions, which is what makes it possible to assert that semantic retrieval finds a passage keyword
retrieval provably cannot.

The run finishes with a second pass in a **real offscreen Chromium window**
(`scripts/test-render.sh`), because the page-extraction script's whole job depends on
`getComputedStyle` and a real layout — mocking a DOM would only test the mock. It serves a fixture
over loopback and asserts that nine different ways of hiding text from a human reader are all stripped
before a model can see them. It skips itself, rather than failing, where no display is available.

---

## 🧑‍💻 Tech stack

- **Electron** (desktop shell) + **electron-vite** (bundler/dev server) + **electron-builder** (packaging)
- **React 18 + TypeScript** (renderer)
- **Zustand** (state), **Tailwind CSS** (styling)
- **marked** + **highlight.js** (markdown & code highlighting)
- **electron-store** (settings persistence)

---

## 🩺 Troubleshooting

- **macOS says "Sigma Oasis.app was not opened because it contains malware" / moves it to Trash** — the app is built without an Apple Developer ID signature, so Gatekeeper hard-blocks it. This is expected for unsigned builds, not an actual malware finding. Fix: after the block happens, open **System Settings → Privacy & Security**, scroll to the Security section, and click **Open Anyway** next to the blocked-app notice (then confirm with your password). If the app was moved to Trash, drag it back to `/Applications` first; the approval is tied to the binary, so it only needs doing once per build. On macOS 26+, the old `xattr -dr com.apple.quarantine` workaround no longer bypasses this block. For public distribution, sign with a Developer ID certificate and notarize (Apple Developer Program, $99/yr) — electron-builder supports both automatically once credentials are configured, and properly notarized builds don't trigger this dialog at all.
- **"LM Studio not detected"** — make sure LM Studio's local server is **started** and a model is **loaded**. Click the **Retry** button or **Settings → Connection → Test / Refresh**.
- **A model slot says "No model selected"** — open **Settings → Models** and choose a model from the dropdown for that slot.
- **Different port/URL** — update the base URL in **Settings → Connection** (e.g. `http://127.0.0.1:1234/v1`). The server must be on **this machine**: the renderer's Content-Security-Policy only permits loopback connections, so a LAN or remote LM Studio won't work for chat.
- **Tool didn't run** — confirm it's enabled in **Settings → Tools**, and that the loaded model supports tool/function calling.

---

## 📄 License

MIT
