# Sigma Oasis v1.4.8

The bounded one. v1.4.7 made the app fast; this release closes the two places where the app's privacy story and its behaviour disagreed, tests the one boundary that had none, stops throwing away most of a long attachment, and clears the structural ground the next feature — the offline reference library — will be built on. Pinned by 1,124 node checks (23 new) plus 26 new sanitizer checks in a real window.

## The privacy story and the code now agree

- **The LM Studio base URL must be a loopback address, and now that is enforced.** LM Studio traffic carries your conversations in plaintext, so it deliberately bypasses the proxy and is described everywhere as "loopback". But nothing stopped a mistyped or hand-edited base URL from pointing elsewhere — and while the chat window's own security policy made *chat* fail against a remote address, embeddings, planning and research prompts went out on that un-proxied path regardless. Silent and unprotected: the worst of both. A base URL that is not loopback is no longer saved; the Connection tab says so as you type. If remote LM Studio is ever supported it will be an explicit opt-in that also routes through the egress path, not a value that happens to parse.
- **The activity log says what it does not contain.** The chat stream itself goes straight from the chat window to your loopback server and never appeared in the network activity list — while the list read as "every request the app makes". It now says plainly that the chat stream (loopback, never proxied) is the one path not listed, and that everything leaving the machine is. `SECURITY.md` says the same. Moving the stream through the main process to make the log literally complete was considered and rejected: the largest refactor for the smallest gap.
- **Settings reads and writes give the same guarantee.** Reads shallow-merged defaults while writes deep-normalized, so a stale install could see half-filled nested settings until its first save; and a save spread unknown keys from the chat window into `config.json` verbatim. Both now go through one normalizer that builds its result key by key from the defaults — a key added to settings without a rule is a compile error, and an unknown key is dropped.

## The markdown sanitizer is tested — and was tightened by the test

- **`renderMarkdown` is where model output becomes DOM**, which makes it the app's cross-site-scripting surface, and it had no test. It could not have had a normal one: DOMPurify is a no-op without a DOM, so a Node test of it passes while sanitizing nothing. It now runs in a real offscreen Chromium window (`scripts/test-render.sh`), with the shipped pipeline bundled byte-for-byte — 26 checks that scripts, event handlers, `javascript:` links, iframes and objects are removed, that code fences are escaped rather than executed, and that what should render (emphasis, tables, highlighted code with its Copy button, `data:` images) still does.
- **Writing the pins found two things the defaults let through into a chat bubble:** form controls — a model, or a web page a tool quoted, could render a convincing "enter your password" box — and inline `style` attributes, enough for a fixed overlay covering the real interface. Both are now forbidden. The Copy button on code blocks stays; it is the app's own.

## A long attachment is read, not cut

- **A text or PDF attachment over 20,000 characters used to keep its first 20,000 and silently lose the rest** — a 60-page PDF answered from its table of contents. Now such a document keeps its opening inline (so the model knows what it is reading) and its whole text goes into the same hybrid keyword + semantic index that fetched web pages use, held in RAM only. Every question retrieves the passages most relevant to *that* question and hands them to the model as app-supplied notes, next to memory recall; the reply shows exactly which passages were retrieved, under "From the attached document(s)".
- **The model is told what it has and has not been given.** An indexed attachment is labelled with its true length, that only the opening is inline, and where the rest comes from — with the standing instruction never to guess at parts of the document it was not shown. A small model that reads "truncated" alone tends either to apologize for missing content it was in fact given, or to invent it.
- **Nothing is written to disk.** The index dies with the process. After a restart the document is re-read from its original path — your own file, on your own machine — the first time you ask about it again; if the file has moved, the model gets the opening plus a note saying the rest is unavailable, which is strictly more than it had before. Attached documents outlive the 30-minute web-page cache and cannot be evicted by it; the Privacy tab counts them.
- **Why this now:** it is the smallest possible exercise of the durable retrieval the offline reference library (next release) needs, and it fixes the most common way a long document was silently misread.

## Structure, so the next feature is one module and one line

- **The tool switch is a dispatch table.** The 470-line `switch` that ran every tool is now one module per domain (files, web, research, calculators, notes, memory, shopping) assembled into a registry typed against the tool toggles — a toggle without a handler is a compile error, and a test pins that schemas, toggles and handlers name the same 21 tools. Adding a tool is one module plus one registry line, which is what the reference library's `reference_lookup` and a future MCP bridge both plug into. Behaviour unchanged.
- **The chat hook is split by concern.** `useLMStudio.ts` had grown to 2,400 lines holding the transport, the turn helpers, the verification passes and plan mode alongside the agent loop. Those are now separate modules with the hook as glue — moved verbatim, comments intact, no behaviour change; the tests that exercise the moved logic still pass against the moved code.
- **One loopback predicate** where there were three copies (settings, egress allowlist, SSRF guard) — a tightening can no longer miss one.
- **CI runs on Linux too**, under a virtual display so the real-window checks run there as well. Nothing in the suite is macOS-only any more, and now that is checked rather than believed.

## Upgrade notes

- **Nothing to configure.** No new settings, no migration. If your base URL was not a loopback address it will revert to the default on first launch and the Connection tab will explain why.
- **A saved base URL pointing at another machine will stop working.** That configuration never worked for chat and leaked everything else; see above.
- **macOS:** signed and notarized. Both Apple Silicon and Intel DMGs are attached. Also via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.4.7, this release appears as an update automatically.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.4.7...v1.4.8
