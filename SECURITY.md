# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](../../security/advisories/new) rather than opening a public issue.
Include reproduction steps and the Sigma Oasis version. Expect an initial response within a week.

## Security model

Sigma Oasis runs local models with **agentic tools** — file access, a shell, and a local memory store.
That capability is the point of the app, and it is also its main risk surface. The design rules:

- **Tools execute only in the Electron main process.** The renderer can request a tool through the
  `window.api` context bridge; it never touches the filesystem or spawns processes itself.
- **The renderer is locked to its own page.** Navigation away from the app entry URL is blocked, and
  links open in the system browser. This matters because the preload — and with it `window.api` — is
  re-injected on every navigation, so a remote page loading in the app window would inherit tool access.
- **Only the microphone permission is granted**, and only to the app's own page.
- **`write_file` and `run_terminal_command` ship disabled.** Enable them under Settings → Tools.
- **`run_terminal_command` always asks for confirmation** before executing.
- **The working directory is a boundary.** When set under Settings → Tools, the file tools refuse any
  path resolving outside it. When it is not set, every `write_file` call is confirmed individually.
- **Model output is sanitized** with DOMPurify before rendering, under a restrictive CSP.

## What this does not protect against

**Prompt injection is a real and unsolved risk.** A model can be steered by anything it reads — web
search results, an attached document, a file on disk. If you enable `write_file` or
`run_terminal_command`, treat a model that has read untrusted content as capable of acting on that
content's instructions. The confirmation dialogs and the working-directory boundary are what stand
between that and your filesystem. The composer shows an amber warning whenever these tools are armed.

Set a scoped working directory before enabling write access, and read the terminal confirmation
dialog rather than clicking through it.

## Network

Sigma Oasis talks to your local LM Studio server (loopback only — enforced by the renderer's CSP).
There is no telemetry, no analytics, and no cloud sync.

Every request the main process makes passes through an egress allowlist derived from your settings,
and is recorded (origin only, never the full URL) in the activity log under Settings → Privacy.
The outbound paths are:

- **`web_search`** — the one provider you chose under Settings → Search (self-hosted SearXNG, the
  Brave Search API, or DuckDuckGo). Queries are sanitized before sending: emails, API-key-shaped
  tokens, JWTs, private IPs, card-shaped numbers, and local filesystem paths — including your home
  directory and configured working directory by exact match — are redacted. Enable **Confirm every
  query** to approve the exact outgoing string each time.
- **`fetch_webpage`** — arbitrary HTTPS URLs, at a model's direction. This is the one path not bound
  by the allowlist, so it is guarded separately: HTTPS only, DNS-resolved private/loopback/link-local
  addresses refused, redirects followed manually with the check re-run on every hop, and hard size
  and time caps. HTML, plain text and PDF are accepted; every other content type is refused.
- **Update checks** — GitHub Releases, opt-in and off by default.

Requests carry a common browser User-Agent rather than an app-specific one, so an install does not
identify itself (or its version) to the hosts it contacts.

Page text read via `fetch_webpage` is chunked and embedded **in RAM only** for relevance ranking, and
recent search responses are cached the same way. Embedding happens against your local LM Studio
server; both caches are size-capped, expire, are never written to disk, and never enter long-term
memory unless you explicitly save something. Settings → Privacy reports their size and clears them on
demand.

### Parsing untrusted input

Two parsers read data from the public web, and both are deliberately dependency-free: the HTML
extractor and the PDF text extractor. The PDF path decompresses and parses attacker-controlled binary
input, which is worth naming explicitly:

- It is pure TypeScript over Node's built-in `zlib` — no native PDF library, no font rasterization, no
  JavaScript execution, and nothing in a PDF is evaluated. A malicious PDF has no code path to run on.
- Object count, decompressed size, and output length are all capped, and every parse step is wrapped
  so malformed structure fails the fetch rather than throwing out of it. The realistic residual risk
  is CPU/memory waste on a hostile file, bounded by those caps.
- Extraction output is checked for being plausible natural language before it is returned. If it is
  not, the fetch fails with an explanation. This is a correctness guard, not a security one, but it
  matters for the same reason: a model cannot distinguish confidently-wrong text from real content.

Text from either parser is still untrusted external content and is passed to models behind the same
`⚠️ UNTRUSTED EXTERNAL CONTENT` marker as everything else from the web. Prompt injection remains the
unsolved risk described above — extraction quality does not change that.

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
