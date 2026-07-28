# 🧠 FunkinAI

**A private, local-first desktop AI chat app powered by [LM Studio](https://lmstudio.ai).**

FunkinAI is a cross-platform (macOS + Windows + Linux) desktop application, inspired by the
Claude Desktop UI, that talks to models running locally in LM Studio via its OpenAI-compatible
API. It supports **up to 3 model "roles"** simultaneously, **agentic tools** (file I/O, terminal,
web search, notes), **@mention routing**, and a **collaborative pipeline** mode — all while keeping
**every byte of data on your machine**. No cloud, no telemetry.

---

## ✨ Features

- **Local & private** — connects only to your LM Studio server (`http://127.0.0.1:1234/v1` by default). The only outbound network call is the optional `web_search` tool.
- **Multi-model roles (up to 3)** — each slot has its own model, role name, system prompt, and color accent.
- **Three ways to use your models**
  - **Independent mode** — pick the active model from the top bar; each conversation keeps its thread.
  - **@mention routing** — type `@Coder write a sort function` to route a single message to a specific role.
  - **Collaborative pipeline** — your message flows through an ordered chain of models, each building on the previous one's output.
  - **Orchestrated mode** — an orchestrator model reasons about your request and **delegates to the other roles as tools** (`consult_model`), reads their answers, consults again if needed, then synthesizes the final reply. Specialists run with their own persona, tools, and memory; delegation loops are structurally impossible and consultations are capped per turn. Every delegation appears as an expandable "🤝 Consulted …" block.
- **File & image attachments** — drag & drop or use the 📎 button. Images are sent to vision-capable models (multimodal `image_url` parts); text files are inlined into context (truncated at 20 K chars). PDF support is planned.
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

Tools use LM Studio's OpenAI-compatible **tool calling**. When a model requests a tool, FunkinAI
executes it **in the Electron main process** (never the renderer) and feeds the result back to the
model. Each call appears as a collapsible **"Tool Used: …"** block showing the arguments and result.

| Tool | Description |
| --- | --- |
| `read_file` | Read the contents of a local file. |
| `write_file` | Write/overwrite a local file — **off by default**; confirms each write when no working directory is set. |
| `list_directory` | List entries in a directory. |
| `run_terminal_command` | Run a shell command — **off by default**; shows a confirmation dialog before every run. |
| `web_search` | Web search via DuckDuckGo's instant-answer API (no key). |
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

---

## 🗂️ Where data is stored

All data lives in your OS application-data directory (`app.getPath('userData')`):

- **Settings** — `config.json` (managed by `electron-store`)
- **Conversations** — `conversations/<id>.json`
- **Notes** — `notes.json`

Typical locations:
- macOS: `~/Library/Application Support/FunkinAI`
- Windows: `%APPDATA%\FunkinAI`
- Linux: `~/.config/FunkinAI`

There is **no cloud sync and no telemetry**.

---

## 🧱 Project structure

```
funkinai/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── index.ts          # App/window bootstrap
│   │   └── ipc/
│   │       ├── tools.ts      # Agentic tool implementations + schemas
│   │       └── store.ts      # electron-store, conversations, notes
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
├── electron.vite.config.ts
├── electron-builder.yml
├── tailwind.config.js
├── package.json
└── README.md
```

---

## 🧑‍💻 Tech stack

- **Electron** (desktop shell) + **electron-vite** (bundler/dev server) + **electron-builder** (packaging)
- **React 18 + TypeScript** (renderer)
- **Zustand** (state), **Tailwind CSS** (styling)
- **marked** + **highlight.js** (markdown & code highlighting)
- **electron-store** (settings persistence)

---

## 🩺 Troubleshooting

- **macOS says "FunkinAI.app was not opened because it contains malware" / moves it to Trash** — the app is built without an Apple Developer ID signature, so Gatekeeper hard-blocks it. This is expected for unsigned builds, not an actual malware finding. Fix: after the block happens, open **System Settings → Privacy & Security**, scroll to the Security section, and click **Open Anyway** next to the blocked-app notice (then confirm with your password). If the app was moved to Trash, drag it back to `/Applications` first; the approval is tied to the binary, so it only needs doing once per build. On macOS 26+, the old `xattr -dr com.apple.quarantine` workaround no longer bypasses this block. For public distribution, sign with a Developer ID certificate and notarize (Apple Developer Program, $99/yr) — electron-builder supports both automatically once credentials are configured, and properly notarized builds don't trigger this dialog at all.
- **"LM Studio not detected"** — make sure LM Studio's local server is **started** and a model is **loaded**. Click the **Retry** button or **Settings → Connection → Test / Refresh**.
- **A model slot says "No model selected"** — open **Settings → Models** and choose a model from the dropdown for that slot.
- **Different port/URL** — update the base URL in **Settings → Connection** (e.g. `http://127.0.0.1:1234/v1`). The server must be on **this machine**: the renderer's Content-Security-Policy only permits loopback connections, so a LAN or remote LM Studio won't work for chat.
- **Tool didn't run** — confirm it's enabled in **Settings → Tools**, and that the loaded model supports tool/function calling.

---

## 📄 License

MIT
