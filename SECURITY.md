# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](../../security/advisories/new) rather than opening a public issue.
Include reproduction steps and the Sigma Oasis version. Expect an initial response within a week.

## Security model

Sigma Oasis runs local models with tools that act on this machine: a chat's tools (the web, the
library, memory, a Python sandbox, and — off by default — a file writer and a terminal), MCP
servers you add, and **the agent**: a task in a folder that reads, edits, runs commands and
carries on until the task is done or it needs you (`docs/agent.md`). That capability is the point
of the app, and it is also its main risk surface. The design rules:

- **Tools execute only in the Electron main process.** The renderer can request a tool through the
  `window.api` context bridge; it never touches the filesystem or spawns processes itself.
- **The renderer is locked to its own page.** Navigation away from the app entry URL is blocked, and
  links open in the system browser. This matters because the preload (and with it `window.api`) is
  re-injected on every navigation, so a remote page loading in the app window would inherit tool access.
- **Only the microphone permission is granted**, and only to the app's own page.
- **Nothing runs a command without asking** — in a chat or an agent task, in any mode — unless you
  granted that exact command in that exact folder. The dialog names a destructive shape (a
  recursive delete, a force-push, `curl … | sh`) and, since v4.1, a command that reaches the
  network (below).
- **Model output is sanitized** with DOMPurify before rendering, under a restrictive CSP.

### A chat's own tools

- **`write_file` and `run_terminal_command` ship disabled.** Enable them under Settings → Tools.
- **`run_terminal_command` always asks** before executing, or runs under a standing grant.
- **The working directory is a boundary.** When set under Settings → Tools, the file tools refuse any
  path resolving outside it. When it is not set, every `write_file` call is confirmed individually.
  `propose_patch` shows its change as a diff and writes nothing until you apply it.

### The agent (v3.0 on)

A task runs in the main process — or in the `sigma` CLI, the same engine in a terminal. The engine
is plain Node and never imports Electron (`test/agentEngine.test.ts` fails the build if it does).

- **The folder is a boundary.** Every path resolves inside it: `..`, an absolute path elsewhere, and
  a write through a symlink that points out of it are refused. A task with no folder has no file
  tools and no commands.
- **How freely is per chat, and fixed while a task runs:**

  | Mode | Edits | Commands |
  | --- | --- | --- |
  | **Ask first** (default) | A diff with Apply and Discard; nothing is written until Apply | Each one confirmed |
  | **Accept edits** | Land without asking; checkpointed first, the diff on the record | Each one confirmed |
  | **Read-only** | Not offered | Not offered |

  A declined edit or command is final for that step; the model is told not to propose it again.
  Helpers (`task`): *explore* and *review* are read-only whatever the mode; *general* works under
  the task's mode and is not offered in *Read-only*. No helper can start another.
- **Standing grants.** *Always allow* mints a grant bound to that exact command in that exact folder
  (a chat's terminal: the command and the working directory; a file write: the resolved path; an MCP
  call: the server, the tool and the exact arguments). A call that differs by a byte asks again.
  Grants live in `grants.json` in the app's data folder, are listed with use counts and revoked under
  Settings → Tools, and are consulted only where a dialog could have been raised: with no window,
  the answer is no, grant or not. In the CLI, `a` lasts for that session only.
- **Checkpoints and Undo.** Before a task first changes a file, its contents are written to disk under
  the app's data folder (`agent-checkpoints/`) — **in plaintext**, a copy of what the file said (the
  bytes, for a document, a move or a delete). **↶ Undo changes** puts each file back, except one
  changed since the task last wrote it, which is somebody's work and is left alone and named.
  Deleting the chat deletes its checkpoints.
- **The app's own tools** (web, library, memory, Python) reach an agent only when each is enabled
  under Settings → Tools *and* *Let the agent use the app's own tools* is on; they keep their own
  rules and go out through the same audited transport as a chat's.
- **Experiments** (Settings → Agent → Experiments) each ship off. The ones that change what the agent
  can reach or run:
  - **Hooks (A8)** — `.sigma/hooks.json` names commands to run after an edit, before a command and at
    the end. They come from the folder, so a repository you cloned can ship them. Each runs through
    `run_command`: the same dialog, the same grants, the same network notice. Read the dialog: a hook
    is a command the repository chose.
  - **Worktrees (A9)** — the app itself runs `git rev-parse` and `git worktree add`, without a dialog.
    Neither contacts a remote. Since 4.3 `worktree add` runs with `core.hooksPath` set to an empty
    directory made for the call, so the repository's own `post-checkout` hook does not run (through
    4.2 it did: code the repository ships, run without asking). git still honours the repository's
    config. Turn this on in repositories you trust.
  - **Notes (A10), recipes (C3), slash commands (C7)** — `.sigma/notes.md` and
    `.sigma/commands/*.md` are text from the folder that rides the prompt, as `SIGMA.md` does. They
    run nothing, but they are instructions: see prompt injection, below.
  - **Documents (C1)** — `.docx`, `.xlsx`, `.pptx` are read and written directly (ZIP and XML, the
    app's own code, no library); nothing in a document is executed, macros included. PDFs go through
    the app's extractor (see *Parsing untrusted input*).
  - **Chores (C2)** — move, copy, make a folder, delete: inside the folder, the destination never
    overwritten, each approved in *Ask first* and checkpointed. Delete sends to the system trash
    (the app) or to `.sigma/trash/` (the CLI); nothing is removed outright.
  - **`browse` (C4)** — the headless renderer, read-only: no form submitted, no cookie kept, no login,
    every request filtered and logged as for the JavaScript renderer below.
  - **Agent jobs (C5)** — a task on a schedule in *Read-only*: no edit, no command (declined without
    asking), no question.
  - **Inbox (C6)** — files dropped on an agent chat are *copied* into `.sigma/inbox/`.
  - **MCP tools for the agent (C8)** — servers that are on join under their own approval mode and
    per-tool switches, exactly as in a chat.

### `.sigma/` — what the app keeps in a folder

| Path | What it is | Whose |
| --- | --- | --- |
| `notes.md` | What the agent verified about the folder (A10), edited as a reviewed change | Yours to commit |
| `hooks.json` | Commands for three moments (A8) — they run, under approval | Yours; read it in a repo you did not write |
| `commands/*.md` | Slash commands (C7) | Yours |
| `inbox/` | Copies of files dropped on the chat (C6) | Your files |
| `trash/` | Files the CLI's `delete_file` moved aside (C2) | Your files |
| `worktrees/` | One git worktree per task, on a `sigma/<slug>` branch (A9) | Plumbing |

`.sigma/.gitignore` ignores `worktrees/`, `inbox/`, `trash/` and itself, and is written — or an older
one brought up to date, lines only ever added — whenever the app makes any of those folders (v4.3;
through 4.2 it ignored `worktrees/` alone, and a `git add -A` committed a dropped or a deleted file).
`notes.md`, `hooks.json` and `commands/` stay yours to commit.

## What this does not protect against

**Prompt injection is a real and unsolved risk.** A model can be steered by anything it reads: web
search results, a page `browse` loaded, an attached or read document, a file in the folder, an MCP
server's output — and, for the agent, the folder's own `SIGMA.md`, `.sigma/notes.md` and slash
commands, which ride its instructions by design. Treat a model that has read untrusted content as
capable of acting on that content's instructions. The confirmation dialogs, the folder boundary and
the permission mode are what stand between that and your files. The composer shows an amber warning
whenever a chat's write or terminal tool is armed.

**A command runs with your privileges.** There is no sandbox around `run_command`, a hook, the
chat's terminal or an MCP server: the dialog is the control. Scope the folder before arming
anything, keep *Ask first* for a folder you do not know, and read the command rather than clicking
through it.

## What is logged, and what is not

Two records, answering two questions: *what did the app send*, and *what was said*.

**The network activity log** (Settings → Activity) — what the app itself sent. In RAM only, the
newest 300 rows, gone when the app quits or when you press Clear. Origins only, never full URLs.
It holds:

- every request through `auditedFetch`, allowed or blocked: LM Studio from the main process (agent
  rounds, embeddings, the model catalog), search, pages, images, shopping, places, market data, the
  proxy test;
- every request the headless renderer's session attempts, allowed or blocked (`render`) — pages
  rendered for reading and `browse`;
- each MCP server starting, stopping or failing (`mcp`) — the process, not its traffic;
- **(v4.1)** each approved command that obviously reaches the network (`command`), with its command
  line — that it ran, not what it sent;
- **(v4.1)** the updater's checks, downloads and failures (`update`). electron-updater has its own
  HTTP stack, so these are its events rather than its requests; through v4.0 they were not listed.

It does **not** hold, because the app cannot see it:

- **the chat stream** from the window to LM Studio — loopback only, enforced by the CSP;
- **anything a command sends**: the agent's `run_command`, the hooks that run through it, a chat's
  terminal. The app detects the obvious shapes (`curl`, `wget`, `Invoke-WebRequest`, `git
  clone/fetch/pull/push`, package installs, `ssh`/`scp`/`rsync`, a literal non-loopback URL —
  `src/shared/commandDanger.ts`), says so in the dialog and logs that the command ran. A command that
  matches none of them is not marked and may still reach the network (`npm test` can). The proxy
  does not apply to commands;
- **anything an MCP server sends** — it is its own process; nor does the proxy cover it
  (`docs/mcp.md`);
- **what the repository's own git hooks do** when a worktree is made (above);
- **the `sigma` CLI**, which keeps no log at all. It talks only to LM Studio on loopback and refuses
  any other server address; its `run_command` reaches whatever the command reaches, and says so.

The Python sandbox has nothing to log: its network is blocked outright (below).

So the claim, stated exactly: **every request the app itself makes is in the log; a program it starts
for you — a command, a hook, an MCP server — has sockets of its own, and the log says that it ran, not
what it sent.**

**The session audit log** (Settings → Privacy, opt-in, off by default) — what was said. One file per
launch, each line encrypted with the OS keychain (`safeStorage`) and hash-chained to the one before,
so an edit or a deletion shows on export; if no keychain is available it does not run rather than
write plaintext. It holds what you typed (and messages typed while a turn ran), each reply, every
tool call with its arguments and result — the agent's marked `[agent]`, Code Mode's `[code mode]` —
and a plan's checklist, steps and outcome; a line is capped at 20,000 characters. It never holds
system prompts, recalled memory or compaction notes, and never anything from an ephemeral chat.
Kept to the newest 40 launches and 200 MB. The key is machine-bound, so logs do not survive an OS
reinstall; *Export latest* writes a **plaintext** copy where you choose.

**Trace export** (Settings → Activity → *Export traces*) reads that log and writes fine-tuning files
to a place you choose; it never uploads. Before a byte is written it replaces URLs, paths (any
drive, UNC, `~`, the home and working folders by exact match), names under `.sigma/inbox`, `trash`
and `worktrees`, emails, phone numbers, IP addresses and key-shaped tokens; redacts a call's
arguments value by value; and withholds what a document said (`docs/trace-export.md`).

**Also on disk, unencrypted**, in the app's data folder: conversations, agent checkpoints (file
contents, above), `grants.json`, settings. MCP environment values and the Brave key are in the OS
keychain.

## Network

Sigma Oasis talks to your local LM Studio server (loopback only — enforced by the renderer's CSP
for the chat stream, and since v1.4.8 by settings normalization for everything else: a base URL
that is not a loopback address is not saved, so the deliberately un-proxied LM Studio path can
never point off-machine). There is no telemetry, no analytics, and no cloud sync.

Every request the app's main process makes itself passes through an egress allowlist derived from
your settings and is recorded (origin only, never the full URL) in the activity log under
Settings → Activity. What that log cannot contain — the chat stream, and the traffic of the programs
the app starts for you — is set out above; the Activity tab says the same.

Transport is **Electron's network stack**, not Node's `fetch`. That is deliberate: undici does not
consult Electron sessions, so proxy configuration cannot reach it, and its SOCKS support needs a
dispatcher that cannot be constructed without the `undici` package. Had the proxy been bolted onto the
old stack, it would have covered only the page renderer and left `web_search` and `fetch_webpage`
going out directly: a privacy control that silently misses the paths that matter most.

The outbound paths are:

- **`web_search`**: the one provider you chose under Settings → Search (self-hosted SearXNG, the
  Brave Search API, or DuckDuckGo). Queries are sanitized before sending: emails, API-key-shaped
  tokens, JWTs, private IPs, card-shaped numbers, and local filesystem paths (including your home
  directory and configured working directory by exact match) are redacted. Enable **Confirm every
  query** to approve the exact outgoing string each time.

  Queries are also **minimized**, which is a separate control from redaction: redaction removes what
  is secret, minimization removes what is merely nobody else's business. Request framing is stripped
  ("i'm looking for X" searches for X; "best headphones for my flight to Lagos" searches for the
  headphones), and a query that is still a long, first-person, sentence-shaped paragraph is
  **refused outright** rather than sent or truncated — the model is told to send subject terms and
  calls again. A model instructed to send terms only will nonetheless sometimes send the user's
  whole message, so this is enforced in code rather than in a prompt.
- **`image_search`**: the same provider as `web_search`, with the same sanitization — plus one fetch
  per result to whichever host that result's image sits on (at most 6 per search, two at a time). Those
  fetches use the same SSRF guard as `fetch_webpage`: HTTPS only, private/loopback addresses refused, the
  check re-run on every redirect hop, and a size cap. The content type must be a raster image
  (`jpeg`, `png`, `gif`, `webp`, `avif`); **SVG is refused outright** because it can carry script. Bytes
  are downscaled to 320px and inlined as a `data:` URL, so the chat window — whose CSP permits
  `img-src 'self' data:` and nothing else — never makes a request of its own, and no image host is
  contacted again when an old conversation is reopened. Requests carry no cookies, no referrer and no
  browser fingerprint, and appear in the activity log under the `image` purpose so they are
  distinguishable from pages you asked to read. What this does **not** do is hide you from the image
  host: without a proxy it still sees your IP address, which is why the confirmation dialog states it
  before the search runs.

  **Which hosts those are depends on your provider.** DuckDuckGo's image results are served by Bing,
  and its thumbnails resolve to Microsoft's CDN: a live check against the shipped code returned six
  results whose thumbnails all sat on `tse1`/`tse2`/`tse4.mm.bing.net` rather than on the retailers'
  own domains. That is fewer parties than contacting six separate shops, but it means one company
  sees the whole gallery. Other providers hand back different hosts — some their own cache, some the
  origin site — and this is not a difference the app can normalize away. The activity log under
  Settings → Privacy is the authority: it lists every host contacted, per search, with a timestamp.
- **`shop_compare` / `price_watch`**: retailer and manufacturer product pages, under the same SSRF
  guard, logged under the `shop` purpose. `requireProxy` refuses the fetch outright when no proxy is
  active rather than silently going out direct. The app never authenticates, never adds to a cart and
  never transacts.
- **`fetch_webpage`**: arbitrary HTTPS URLs, at a model's direction. This is the one path not bound
  by the allowlist, so it is guarded separately: HTTPS only, private/loopback/link-local addresses
  refused, redirects followed manually with the check re-run on every hop, and hard size and time caps.
  HTML, plain text and PDF are accepted; every other content type is refused. When a proxy is active the
  address check narrows; see "The DNS-leak / SSRF tradeoff" below. One exception exists for the evals
  and is closed unless the process environment opens it: `SIGMA_RESEARCH_FIXTURE_ORIGIN` admits one
  exact loopback origin a suite serves pages from, and `SIGMA_RESEARCH_FIXTURE_ALIAS` (v4.3), only
  beside it, one exact HTTPS origin that stands for it — requests to the alias are sent to the loopback
  origin and the page renderer refuses it, so nothing addressed to it leaves the machine
  (`src/main/ipc/fixtureSeam.ts`). The app never sets either.
- **`deep_research`**: several `web_search` queries plus several `fetch_webpage` reads per call, all
  subject to the limits above and to a per-call budget capping searches, pages, **distinct domains** and
  wall clock. The user's question is never sent: only the planner's keyword queries, each redacted like
  any other search. Enable "Approve research plans" to see and approve the entire plan before any query
  leaves the machine. Every domain contacted is reported back with the results.
- **The JavaScript page renderer**: opt-in and off by default (Settings → Search). See below.
- **`api.ipify.org`**: contacted only when you press "Test proxy", and allowlisted by name so it
  cannot become a general escape hatch. It is the one third party the app contacts on its own behalf.
- **Update checks**: GitHub Releases, opt-in and off by default ("Check now" always works). They go
  through electron-updater's own transport, not `auditedFetch`; since v4.1 each check, download and
  failure is a row in the activity log under `update`.

Outside the app's own transport, by construction, and so not in the list above: what a command, a
hook or an MCP server sends (see *What is logged, and what is not*).

Requests carry a common browser User-Agent rather than an app-specific one, so an install does not
identify itself (or its version) to the hosts it contacts.

Page text read via `fetch_webpage` is chunked and embedded **in RAM only** for relevance ranking, and
recent search responses are cached the same way. Embedding happens against your local LM Studio
server; both caches are size-capped, expire, are never written to disk, and never enter long-term
memory unless you explicitly save something. Settings → Privacy reports their size and clears them on
demand.

### Proxying (Tor / VPN)

Off by default. When configured, search, page reads and rendering are all routed through the proxy;
**LM Studio is pinned to a direct connection explicitly**, so model traffic can never be captured by a
proxy setting (or by a system-wide one). A command, a hook or an MCP server is not proxied: it is a
program with its own sockets, and goes out however the system sends it.

SOCKS5 is preferred over an HTTP proxy because Chromium resolves hostnames *at the proxy*, so the local
resolver never learns which sites are being read.

A misconfigured proxy is treated as a hard failure rather than a silent fallback: an empty host, a host
containing a scheme or path, or an out-of-range port all fall back to a direct connection **with a
stated reason**, and "Test proxy" reports the address sites actually see. The failure mode a privacy
control must never have is quietly not applying while the user believes it is.

#### The DNS-leak / SSRF tradeoff

`fetch_webpage` normally resolves a hostname locally and inspects every answer before connecting, the
strongest form of the SSRF guard. But resolving locally *tells the local resolver which host is about to
be visited*, which is exactly what a proxy exists to prevent.

So when a proxy is active, the local lookup is skipped and the guard narrows to what can be judged
without resolving: literal private, loopback and link-local IP addresses, and loopback hostnames, are
still refused. Resolution moves to the proxy, which is where it belongs. Tor refuses private address
ranges itself, and the request never touches the local network stack.

This is a real, deliberate reduction in SSRF strength while proxied. It is taken because the
alternative silently defeats the user's stated intent, and it is stated here rather than left as a
surprise.

### The JavaScript page renderer

Off by default. When enabled, a page that returns no readable text to a plain fetch is re-read in an
offscreen Chromium window, which **runs that page's scripts**: the one place in the app where code
from the public web executes. It is worth being precise about what contains it.

A browser normally reaches the network on its own, entirely outside `auditedFetch`. That would make the
activity log an incomplete account of what left the machine, so instead every request the render
session attempts passes through a single `webRequest.onBeforeRequest` filter, which allows only the
target page's own origin and only resource types that can carry text, and reports every request
(allowed or blocked) into the same activity log under the `render` purpose. Third-party requests are
refused outright, so ad, analytics and tracker domains are unreachable by construction rather than by
blocklist.

Around that: a fresh ephemeral session per page (no cookies, cache or storage, cleared and destroyed
afterwards); **no preload script**, so `window.api` and every agentic tool behind it are unreachable
from the document; `nodeIntegration` off and `contextIsolation` and `sandbox` on; all permission
requests denied; `window.open` denied; navigation and cross-origin redirects blocked; and caps on load
time and extracted size. Extraction runs in an isolated world, so our own code is not exposed to the
page's JavaScript context.

Two honest caveats:

- **DNS rebinding.** The static path resolves a host and refuses private addresses *before*
  connecting. Chromium resolves DNS internally, so the renderer cannot pin resolution the same way.
  Same-origin-only filtering and the cookieless ephemeral session reduce the payoff to near zero, but
  it is not the identical guarantee. `assertPublicHost` still runs on the URL before rendering.
- **Script execution is inherent.** Enabling this means accepting that a fetched page's JavaScript
  runs, sandboxed, on your machine. That is why it ships off and why the static fetch is always tried
  first.

On the other hand, rendering **improves** prompt-injection resistance. With a real DOM,
`getComputedStyle` identifies text hidden from human readers (`display:none`, `opacity:0`, zero font
size, screen-reader clipping, off-canvas positioning), which is exactly where injected instructions
hide. That text is removed before a model sees it, and the amount removed is reported. The static path
cannot detect any of it, because the styling may come from an external stylesheet.

### Parsing untrusted input

Two parsers read data from the public web, and both are deliberately dependency-free: the HTML
extractor and the PDF text extractor. The PDF path decompresses and parses attacker-controlled binary
input, which is worth naming explicitly:

- It is pure TypeScript over Node's built-in `zlib`: no native PDF library, no font rasterization, no
  JavaScript execution, and nothing in a PDF is evaluated. A malicious PDF has no code path to run on.
- Object count, decompressed size, and output length are all capped, and every parse step is wrapped
  so malformed structure fails the fetch rather than throwing out of it. The realistic residual risk
  is CPU/memory waste on a hostile file, bounded by those caps.
- Extraction output is checked for being plausible natural language before it is returned. If it is
  not, the fetch fails with an explanation. This is a correctness guard, not a security one, but it
  matters for the same reason: a model cannot distinguish confidently-wrong text from real content.

Text from either parser is still untrusted external content and is passed to models behind the same
`⚠️ UNTRUSTED EXTERNAL CONTENT` marker as everything else from the web. Prompt injection remains the
unsolved risk described above; extraction quality does not change that.

## The Python sandbox (Workbench)

`run_python`, `run_code` and `analyze_file` run Pyodide (CPython compiled to WebAssembly) in a hidden
Electron window with `sandbox: true`, context isolation and no Node integration, on a session of its
own that refuses every request not on the app's `sigma-workbench://` scheme, under a CSP of
`connect-src 'self'`. It has no network — not even loopback — and no disk: inputs are copied into a
virtual `/work`, and what the code writes there comes back bounded. A job over its time budget has
its window destroyed. Code Mode's calls to the app's tools leave the sandbox as messages the
renderer decides under the same allowlists, budgets and audit as any tool call; the sandbox's own
network stays blocked. `test/workbenchCheck.ts` proves each of these in Electron proper
(`docs/workbench.md`).

## MCP servers

An MCP server is a local program the app launches over stdio — no HTTP transport, no remote servers
— and it runs with your privileges, outside the egress allowlist, the proxy and the activity log.
So a server is saved **switched off**, and turning it on is a second step. Its environment values
are kept in the OS keychain, never in the settings file. Each server has an approval mode (`ask`,
the default; `allowlist`; `full`), each tool its own switch, and every result reaches a model behind
an untrusted-content marker naming the server. The client declares no capability a server could use
to drive the model (no sampling, elicitation or roots). Since v4.0 (C8, an experiment) the same
servers, under the same modes, can be the agent's tools. Details: `docs/mcp.md`.

## Distribution

Release builds are signed with a Developer ID certificate and notarized by Apple. Verify a
download before running it:

```bash
spctl --assess --verbose /Applications/Sigma Oasis.app
codesign --verify --deep --strict --verbose=2 /Applications/Sigma Oasis.app
```

Builds you make yourself without signing credentials are unsigned; Gatekeeper will block them
until you approve the app via System Settings → Privacy & Security → Open Anyway. See the
README's troubleshooting section.
