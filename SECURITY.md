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
The single outbound call to the internet is the optional `web_search` tool, which queries
DuckDuckGo's instant-answer API. There is no telemetry, no analytics, and no cloud sync.

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
