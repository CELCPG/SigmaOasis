# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](../../security/advisories/new) rather than opening a public issue.
Include reproduction steps and the Sigma Oasis version. Expect an initial response within a week.

## Security model

Sigma Oasis runs local models with **agentic tools**: file access, a shell, and a local memory store.
That capability is the point of the app, and it is also its main risk surface. The design rules:

- **Tools execute only in the Electron main process.** The renderer can request a tool through the
  `window.api` context bridge; it never touches the filesystem or spawns processes itself.
- **The renderer is locked to its own page.** Navigation away from the app entry URL is blocked, and
  links open in the system browser. This matters because the preload (and with it `window.api`) is
  re-injected on every navigation, so a remote page loading in the app window would inherit tool access.
- **Only the microphone permission is granted**, and only to the app's own page.
- **`write_file` and `run_terminal_command` ship disabled.** Enable them under Settings → Tools.
- **`run_terminal_command` always asks for confirmation** before executing.
- **The working directory is a boundary.** When set under Settings → Tools, the file tools refuse any
  path resolving outside it. When it is not set, every `write_file` call is confirmed individually.
- **Model output is sanitized** with DOMPurify before rendering, under a restrictive CSP.

## What this does not protect against

**Prompt injection is a real and unsolved risk.** A model can be steered by anything it reads: web
search results, an attached document, a file on disk. If you enable `write_file` or
`run_terminal_command`, treat a model that has read untrusted content as capable of acting on that
content's instructions. The confirmation dialogs and the working-directory boundary are what stand
between that and your filesystem. The composer shows an amber warning whenever these tools are armed.

Set a scoped working directory before enabling write access, and read the terminal confirmation
dialog rather than clicking through it.

## Network

Sigma Oasis talks to your local LM Studio server (loopback only — enforced by the renderer's CSP
for the chat stream, and since v1.4.8 by settings normalization for everything else: a base URL
that is not a loopback address is not saved, so the deliberately un-proxied LM Studio path can
never point off-machine). There is no telemetry, no analytics, and no cloud sync.

Every request the main process makes passes through an egress allowlist derived from your settings,
and is recorded (origin only, never the full URL) in the activity log under Settings → Privacy.
The one path not in that log is the chat stream itself, which the chat window sends directly to
the loopback LM Studio server; the Privacy tab says so. Everything that leaves the machine is logged.

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
  address check narrows; see "The DNS-leak / SSRF tradeoff" below.
- **`deep_research`**: several `web_search` queries plus several `fetch_webpage` reads per call, all
  subject to the limits above and to a per-call budget capping searches, pages, **distinct domains** and
  wall clock. The user's question is never sent: only the planner's keyword queries, each redacted like
  any other search. Enable "Approve research plans" to see and approve the entire plan before any query
  leaves the machine. Every domain contacted is reported back with the results.
- **The JavaScript page renderer**: opt-in and off by default (Settings → Search). See below.
- **`api.ipify.org`**: contacted only when you press "Test proxy", and allowlisted by name so it
  cannot become a general escape hatch. It is the one third party the app contacts on its own behalf.
- **Update checks**: GitHub Releases, opt-in and off by default.

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
proxy setting (or by a system-wide one).

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
