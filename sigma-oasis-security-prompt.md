# Sigma Oasis — Security, Privacy & Private Web Search Improvement Prompt

> A detailed brief describing the Sigma Oasis application, its privacy mission, and a concrete
> roadmap for hardening it into the most secure and private way for people to use AI — where the
> user is never the product, no data is ever sold, and everything stays on the user's machine.

---

## 1. What Sigma Oasis Is

**Sigma Oasis** is a cross-platform desktop AI chat application (macOS, Windows, Linux) built on
**Electron + React + TypeScript**. It is inspired by the Claude Desktop UI, but with a radically
different data philosophy:

> **Your safe oasis of data protection.** Every byte of data stays on your machine.
> No cloud. No telemetry. No analytics. No account. No data sale — ever.

### Core architecture

- **Local inference only.** Sigma Oasis talks exclusively to a locally running
  [LM Studio](https://lmstudio.ai) server (`http://127.0.0.1:1234/v1` by default) via its
  OpenAI-compatible API. Models (Llama, Qwen, Mistral, etc. GGUFs) run entirely on the user's
  hardware. Prompts, attachments, and responses never transit a third-party server.
- **Multi-model roles (up to 3 slots).** Each slot has its own model, role name, system prompt,
  and color accent. Four usage modes:
  - **Independent** — one active model per conversation.
  - **@mention routing** — `@Coder refactor this function` routes a message to a specific role.
  - **Collaborative pipeline** — a message flows through an ordered chain of models, each building
    on the previous output.
  - **Orchestrated** — an orchestrator model delegates to specialist roles as tools
    (`consult_model`), reads their answers, and synthesizes a final reply. Delegation loops are
    structurally impossible and consultations are capped per turn.
- **Agentic tools** (executed in the Electron **main process**, never the renderer):
  `read_file`, `write_file` (off by default), `list_directory`, `run_terminal_command` (off by
  default, always confirmed), `web_search`, `get_current_datetime`, and a local notes store
  (`create_note` / `list_notes` / `read_note`).
- **Long-term local memory (RAG).** A vector store embedded through LM Studio's `/v1/embeddings`.
  Memories are auto-recalled into conversations; models can save/search/forget; notes are
  auto-indexed; documents can be added under Settings → Memory. Vectors are tied to the embedding
  model that produced them; switching models flags sources needing re-indexing.
- **Fully local voice.** Replies read aloud with on-device OS voices; push-to-talk transcription
  via locally installed **whisper.cpp**. No audio leaves the machine.
- **Local persistence.** Settings via `electron-store`; conversations, notes, and memory as JSON
  in the OS app-data directory (e.g. `~/Library/Application Support/Sigma Oasis` on macOS).
  **No cloud sync, no telemetry.**

### Existing security posture (already good)

- `write_file` and `run_terminal_command` ship **disabled**; terminal commands always show a
  confirmation dialog.
- A configurable **working directory** acts as a filesystem boundary: `read_file`, `write_file`,
  and `list_directory` refuse paths outside it.
- The renderer's **Content-Security-Policy permits loopback connections only**, so chat cannot be
  redirected to a remote LM Studio.
- Tool results are rendered in collapsible "Tool Used: …" blocks for transparency.
- DOMPurify is a dependency for sanitizing rendered markdown.

---

## 2. The Mission: Users Are Not the Product

Design and build Sigma Oasis so it can make — and keep — these promises verifiably:

1. **No data sale, ever.** There is no server-side component that could collect or sell data.
   There is no business model based on user data.
2. **Local-first by default, verifiable.** A user (or auditor) can confirm that the only network
   egress is (a) the loopback LM Studio connection and (b) explicitly user-enabled, privacy-
   preserving search endpoints.
3. **Radical transparency.** Every network request, file access, and tool execution is visible,
   logged locally, and explainable to a non-expert user.
4. **Informed consent for every risk.** Anything that mutates the filesystem, runs commands, or
   reaches the network is opt-in, clearly labeled, and individually confirmable.

---

## 3. Recommended Security & Privacy Improvements

### 3.1 Network egress control and auditing

- **Network activity monitor.** Add a Settings → Privacy panel that lists every outbound
  connection the app has made (host, timestamp, which tool initiated it). Since the design goal
  is "loopback + search only," this list should be short and auditable — make that a feature.
- **Egress allowlist enforcement.** In the main process, route all `fetch`/`net` calls through a
  single wrapper that enforces a hardcoded allowlist: `127.0.0.1` / `localhost` (LM Studio), plus
  the configured search provider domains. Any other destination is blocked and logged. This makes
  "no telemetry" structurally true, not just a policy.
- **No auto-updater phone-home surprises.** `electron-updater` is a dependency. Make update
  checks **opt-in**, disable them by default, document exactly what metadata update checks send,
  and let users set a custom update feed or disable updates entirely.
- **No crash reporters, no analytics SDKs.** Audit `node_modules` for packages that make network
  calls on their own; pin and review dependencies; add an `npm audit` / dependency-review step to
  CI.

### 3.2 Local data protection at rest

- **Encrypted-at-rest storage.** Offer an optional passphrase that encrypts `conversations/`,
  `notes.json`, and the memory vector store using the OS keychain (Electron `safeStorage`) or a
  user-supplied key (Argon2-derived). Today all of this is plaintext JSON on disk.
- **Sensitive-data hygiene.** Never persist API keys or secrets in `config.json` in plaintext;
  use `safeStorage`. Warn if the user pastes something that looks like a credential into a chat.
- **Secure deletion.** When a user deletes a conversation or memory, overwrite/remove the file
  fully (no soft-deletes lingering on disk).

### 3.3 Agentic tool hardening

- **Prompt-injection defenses.** A model can be influenced by anything it reads (search results,
  attached files). Add a **content trust boundary**: text returned from `web_search`, fetched
  pages, and attachments is wrapped in delimiters and accompanied by a system-level instruction
  that this content is *untrusted data, never instructions*. Surface a visible "untrusted content"
  badge on tool results.
- **Two-person rule for destructive tools.** `write_file` currently confirms per-write only when
  no working directory is set. Extend per-action confirmation to *any* write outside the working
  directory, and add a diff preview (old vs. new content) in the confirmation dialog.
- **Terminal command guardrails.** Maintain a blocklist of clearly destructive patterns
  (`rm -rf /`, fork bombs, `dd`, disk formatting, piping remote scripts to a shell). Even with
  user confirmation, flag these with an explicit danger warning. Show the full expanded command,
  not a truncated one.
- **Tool permission scoping per role.** Let the user grant tools per model slot (e.g. the Coder
  role gets file tools; the Researcher role gets only web search), reducing the blast radius of a
  misbehaving or manipulated model.

### 3.4 Supply chain & platform

- **Code signing and notarization** for macOS/Windows releases (removes Gatekeeper blocks and
  proves binary provenance). Publish **SHA-256 checksums** and reproducible build instructions.
- **Lockfile integrity + SBOM.** Commit `package-lock.json` (done), generate an SBOM for each
  release, and run dependency vulnerability scanning in CI.
- **Sandbox the renderer fully.** Verify `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, and that the preload exposes only a minimal, typed `window.api` surface.
- **Audit the IPC boundary.** Every `ipcMain.handle` channel should validate its arguments against
  a schema (e.g. zod) — never trust renderer input.

### 3.5 Privacy UX promises

- **First-run privacy pledge screen.** Plain-language statement: what leaves the machine
  (nothing, except optional search queries), where data lives, and how to delete it.
- **One-click "leave no trace."** A button that wipes all conversations, notes, memory, and
  settings, with clear confirmation.
- **Offline mode indicator.** A visible badge when the app is operating with zero non-loopback
  network activity — turning privacy into something the user can *see*.

---

## 4. Building Improved, Privacy-Preserving Web Search into Sigma

The current `web_search` tool calls DuckDuckGo's **instant-answer API**, which is keyless but
weak: it mostly returns Wikipedia-style abstracts and often returns nothing useful. Goal: a
**real search experience** that preserves the "you are not the product" guarantee.

### 4.1 Design principles

1. **No tracking, no profiling.** The search provider must not log queries tied to identity, and
   Sigma must not send identifying headers, cookies, or stable client fingerprints.
2. **Query minimization.** The model should send *only* the search query — never conversation
   history, memory contents, or file contents — unless the user explicitly approves.
3. **User-visible and controllable.** Every search appears as a tool block; the user can disable
   search entirely, pick the provider, and see exactly what query was sent.
4. **Local-first fallback.** Offer a fully self-hosted option so search can work with zero trust
   in any third party.

### 4.2 Provider options (in order of privacy strength)

| Option | How it works | Privacy profile | Notes |
|---|---|---|---|
| **Self-hosted SearXNG** | User runs SearXNG locally (Docker or bare metal); Sigma queries `http://127.0.0.1:8888/search?format=json` | **Best** — metasearch over 70+ engines, queries leave the machine only from the SearXNG instance, no keys, no tracking | Make this the recommended option; add a setup wizard |
| **Brave Search API** | Commercial API, free tier, no user profiling | Strong — no ads/tracking business model; requires an API key | Store key via `safeStorage`; document exactly what is sent |
| **DuckDuckGo HTML endpoint** | Scrape `html.duckduckgo.com/html/` results instead of the instant-answer API | Good — no key, no tracking, but rate-limited and brittle | Big quality upgrade over the current instant-answer API; implement careful parsing + backoff |
| **Kagi / Mojeek / Startpage** | Paid or niche privacy engines | Good–strong | Optional provider plugins |

Implement a **provider abstraction**: a `SearchProvider` interface with `search(query, opts) →
results[]`, so providers are pluggable and the user selects one in Settings → Search.

### 4.3 Concrete implementation plan

1. **Replace the instant-answer call** (`src/main/ipc/tools.ts`, `web_search` case) with the
   provider layer above. Return structured results: `title`, `url`, `snippet`, `source`,
   `publishedDate` (when available).
2. **Add a `fetch_webpage` tool** so the model can retrieve and read a specific result:
   - Fetch in the main process; strip scripts/ads; convert to clean markdown/text (e.g. Mozilla
     Readability + a turndown-style converter).
   - Enforce the egress allowlist, HTTPS-only, response size cap (e.g. 2 MB), timeout, and
     redirect limits. **Block private/loopback IP ranges** to prevent SSRF against the user's
     LAN or the LM Studio server itself.
   - Mark all fetched content as **untrusted** (see 3.3) and truncate to a configurable token
     budget before feeding it to the model.
3. **Query hygiene layer.** Before any search executes, pass the proposed query through a
   local check: strip anything resembling names, emails, paths, or secrets unless the user
   confirms. Optionally show the exact outgoing query in the confirmation UI.
4. **Result citation UI.** Render search results as clickable source cards under the model's
   reply, so answers grounded in search are verifiable — trust through transparency.
5. **Optional local result cache** (encrypted at rest like other data, with a TTL and a
   clear-cache button) to reduce repeat queries and work offline.
6. **Rate limiting & backoff** per provider so Sigma is a good API citizen and doesn't leak
   behavioral patterns through burst traffic.
7. **Settings → Search panel**: provider picker, API key entry (stored with `safeStorage`),
   self-hosted SearXNG URL + connection test, per-search confirmation toggle, and a "search is
   the only thing that leaves this machine" explainer.

### 4.4 What "success" looks like

- A user can ask "what changed in the latest Node LTS?" and get an answer synthesized from 5
  real, cited sources — with the model running locally, the query going only to the provider the
  user chose, and a visible record of exactly what was sent and received.
- With self-hosted SearXNG, the *only* entity that ever sees the query is infrastructure the
  user controls.
- With search disabled, the app makes **zero** non-loopback connections, and the user can verify
  that from the Privacy panel.

---

## 5. Guiding principles for any AI assistant working on this codebase

- **Never** add telemetry, analytics, crash reporting, or any background network call without
  explicit user request.
- **Never** weaken a default: tools that mutate the machine stay off-by-default; confirmation
  dialogs stay; the working-directory boundary stays.
- **Prefer structural guarantees** (allowlists, sandboxes, encryption) over policy promises.
- **Keep everything explainable**: a non-expert user should be able to answer "what leaves my
  computer?" in one sentence — *"Only the search queries I explicitly allow, to the provider I
  chose. Everything else stays on my machine."*
- Preserve the existing MIT license, the Electron main/renderer/preload separation, and the
  TypeScript + Zustand + Tailwind stack.
