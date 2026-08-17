# MCP client — scope

**Status:** proposed, not started · **Target:** v1.7 · **Estimate:** ~5 focused days, ~2,100 LOC

What ships: an MCP **client**, **stdio transport only**, **tools only**. Sigma Oasis becomes
a host that can run local MCP servers and expose their tools to models through the existing
tool loop. No new runtime dependencies.

What does not ship in v1: Streamable HTTP transport, resources, prompts, subscriptions,
tasks, MCP Apps, skills-over-MCP, OAuth. Resources → the Library and prompts → playbooks are
the two obvious v2 follow-ons.

---

## 1. Why this is tractable: one choke point

The renderer gets its tool list from exactly one place and dispatches to exactly one place:

```
window.api.listTools()  →  ipc 'tools:list'     →  TOOL_SCHEMAS.filter(enabled)
window.api.executeTool()→  ipc 'tools:execute'  →  executeTool(name, args, ctx)
```

Three call sites, all in `useLMStudio.ts` (:1047, :1196, :1341). Everything downstream is
keyed on `ToolSchema.function.name` and does not care where a schema came from:

| Layer | File | Cares about origin? |
| --- | --- | --- |
| Per-slot allowlists | `lib/toolSelection.ts` `toolsForSlot` | no |
| Embedding-rank subsetting | `lib/toolSelection.ts` `selectTurnTools` | no |
| Subset stabilization | `lib/toolSelection.ts` `stabilizeTurnTools` | no |
| Per-turn budgets | `lib/agentLoop.ts` `TOOL_TURN_BUDGETS` | no |
| Argument repair layer | `lib/nativeToolCall.ts` | no — validates against the schema it was given |
| Tool-call block | `components/ToolCallBlock.tsx` | no |
| Audit log | `main/ipc/audit.ts` | no |

**MCP tools enter at `tools:list` and leave at `tools:execute`. Nothing else in the pipeline
changes.** That is the entire reason this is a week and not a month.

---

## 2. Why hand-roll instead of using the official SDK

`@modelcontextprotocol/sdk@1.30.0` is MIT, 693 files / 4.32 MB unpacked, with 17 runtime
dependencies: `express`, `hono`, `@hono/node-server`, `cors`, `express-rate-limit`,
`raw-body`, `content-type`, `jose`, `pkce-challenge`, `eventsource`, `eventsource-parser`,
`zod`, `zod-to-json-schema`, `ajv`, `ajv-formats`, `json-schema-typed`, `cross-spawn`.

Almost all of that serves the *server* side and the HTTP transports — the two things we are
deliberately not shipping. Sigma Oasis has 8 runtime dependencies in total; adding an HTTP
server stack to the Electron main process of a privacy app to get a subprocess pipe is a bad
trade.

The stdio client is newline-delimited JSON-RPC 2.0 over a child process. Hand-rolled: ~430
lines across transport + client, zero new dependencies. Revisit only if Streamable HTTP goes
on the roadmap.

---

## 3. Protocol scope

Current spec revision: **2026-07-28**.

**Framing** (from the stdio binding): UTF-8 JSON-RPC 2.0, one message per line, messages
MUST NOT contain embedded newlines. Server stdout is messages only; stderr is free-form
logging and the client SHOULD NOT treat stderr output as an error signal. The client MUST
NOT write JSON-RPC responses to stdin. Servers MUST NOT write JSON-RPC requests to stdout.

**Two eras — this is the part that costs a day.** Revision 2026-07-28 removed the
connection-scoped `initialize` handshake; protocol version and per-request capabilities now
ride in `_meta.io.modelcontextprotocol/*` on every request. Most servers in the wild are
still initialization-based. The spec mandates a probe:

1. Send `server/discover` before anything else, with the preferred modern version in `_meta`.
2. `DiscoverResult` → modern server. Pick a mutually supported version from `supportedVersions`.
3. A recognized modern error (e.g. `UnsupportedProtocolVersionError`) → modern server, wrong
   version. Use one from its advertised `supported` list. **Do not** fall back to `initialize`.
4. Any other error, or no response within a timeout → legacy server. Fall back to
   `initialize` + `notifications/initialized`.

The fallback MUST NOT key on a specific error code — legacy servers answer unknown
pre-`initialize` methods with implementation-defined errors (`-32601`, `-32602`) or silence.

**Methods in v1:** `server/discover`, `initialize` (legacy path only), `tools/list` (with
cursor pagination), `tools/call`, `notifications/cancelled`.

**Shutdown:** close stdin → wait → SIGTERM → SIGKILL. On unexpected exit, restart; the
protocol is stateless so in-flight requests are simply lost and retryable.

---

## 4. Five things that block it today

**1. `ToolToggles` is a closed interface.** `store.ts:78–106` enumerates every tool name, and
`tools.ts:28` does `getSettings().tools[name]`. Dynamic names have no key.
→ A separate `mcp` settings branch holds per-server and per-tool enablement. `tools:execute`
checks it when the name is not a static toggle key.

**2. `TOOL_HANDLERS` is compile-time closed.** `Record<keyof ToolToggles, ToolHandler>`
(`registry.ts:19`) makes "toggle without handler" a build error. That is a deliberate,
valuable property — **do not loosen it.**
→ Add an MCP fallback in `executeTool` *before* the `Unknown tool` return. The static table
keeps its exact type.

**3. `test/toolRegistry.test.ts` asserts `handlerNames === schemaNames` exactly.** Keeping
static and dynamic tools in separate lists keeps that test both passing and meaningful.
→ Add one assertion: no MCP tool name may collide with a built-in.

**4. Name collisions and wire-safe names.** A filesystem server exposing `read_file` must not
shadow the built-in. Tool names on the wire must match `^[a-zA-Z0-9_-]{1,64}$`, so dots are
out.
→ Namespace as `<server>_<tool>`, sanitized, truncated to 64, deduped with a numeric suffix.
A `Map<wireName, {serverId, originalName}>` holds the reverse mapping for dispatch. The
tool-call block shows the server as a badge and the original tool name as the label.

**5. `TURN_TOOL_CAP = 6`.** One filesystem server adds ~12 tools; three servers can triple the
toolbox. The ranker exists for exactly this, but there is a real quality risk:
`toolSchemas.ts` descriptions are *decision rules* ("Use when… Do not use when… Example:")
tuned against the eval harness. MCP descriptions are nameplates ("Read a file"). They will
rank badly *and* crowd out built-ins that were tuned to win.
→ Two mitigations: (a) reserve slots — cap MCP tools per turn separately, so built-ins keep a
floor; (b) let the user override a tool's description in Settings. **Measure it**: run the
tool-choice eval with 0 / 12 / 36 MCP tools loaded and report the delta on built-in
selection accuracy. We have the harness; nobody else shipping MCP publishes this number.

---

## 5. The egress problem

This is the one item that needs a decision rather than an implementation.

The README claims: *"All of it is enforced by a built-in egress allowlist, visible in a
network activity log with a purpose on every row."*

An MCP server is a separate OS process. Its sockets are not ours. `net.ts`'s `allowedHosts()`
does not apply, the activity log cannot see the traffic, and the Tor/VPN proxy setting does
not cover it. A GitHub MCP server talks to github.com and Sigma Oasis has no visibility into
it and **no way to acquire any** short of OS-level sandboxing we are not going to ship
cross-platform.

Three options:

**A. Disclose; do not pretend.** Ship it, state the boundary in the UI and README, add an
activity-log row kind `mcp`: *"server `github` started — its own network activity is not
visible here."* Precedent exists: the image-search dialog already says "those hosts still see
your IP unless a proxy is on."

**B. Refuse to run MCP servers while "require proxy" is on.** Coherent, blunt, and kills the
feature for precisely the users most likely to want a local-only server.

**C. Per-server local-only / networked declaration at install.** Labels tools accordingly but
cannot enforce the claim — which is the kind of thing this README refuses to do everywhere
else.

**Recommendation: A**, plus MCP off by default, per-server install confirmation showing the
resolved argv, and the README claim amended to scope it explicitly to *the app's own* egress.
The blast-radius limiter is that nothing runs until you turn it on, one server at a time,
with the command in front of you.

---

## 6. Trust model

An MCP server is arbitrary local code running with the user's privileges. Adding one is
`run_terminal_command` without the confirmation dialog. So:

- **Install confirmation** shows the resolved command, args, and env var *names* (not values),
  and states plainly that the server runs with your privileges and outside the egress allowlist.
- **Servers are off on add.** Explicit enable, per server.
- **Per-tool enable within a server.** Default: all on once the server is on — per-tool is the
  escape hatch, not a setup chore.
- **Results carry an untrusted marker** naming the server, on the `UNTRUSTED_HEADER` pattern.
  MCP's own spec says tool descriptions and annotations "should be considered untrusted."
- **Nothing lets a server drive the model.** v1 negotiates no client capabilities: no
  elicitation, and `InputRequiredResult` replies are rejected rather than answered. A server
  must not be able to make Sigma Oasis's model do work the user did not ask for.
- **Output capped** at `MAX_OUTPUT_CHARS` (8000), same as every other tool.
- **Per-call timeout** with `notifications/cancelled` on expiry.

---

## 7. Files

**New**

| File | Purpose | ~LOC |
| --- | --- | --- |
| `src/main/ipc/mcp/transport.ts` | spawn, line framing, write queue, stderr ring buffer, exit/restart | 180 |
| `src/main/ipc/mcp/client.ts` | JSON-RPC correlation, era probe, both handshakes, `tools/list` pagination, `tools/call`, cancellation, timeouts | 250 |
| `src/main/ipc/mcp/manager.ts` | server registry, lifecycle, status, tool cache, re-list, name mapping | 220 |
| `src/main/ipc/mcp/naming.ts` | sanitize / namespace / dedupe / collide-check against `TOOL_SCHEMAS` | 60 |
| `src/main/ipc/mcp.ts` | IPC: `mcp:list` `add` `remove` `start` `stop` `reload` `logs` `setEnabled` | 120 |
| `src/renderer/src/components/settings/McpTab.tsx` | server list, status, tool list, stderr viewer, add form | 400 |
| `test/fixtures/mcp/stub-server.mjs` | stub server, modern + `--legacy` mode | 80 |
| `test/mcpTransport.test.ts`, `test/mcpClient.test.ts`, `test/mcpNaming.test.ts` | | 400 |
| `docs/mcp.md` | user-facing | — |

**Modified**

| File | Change | ~LOC |
| --- | --- | --- |
| `src/main/ipc/tools.ts` | merge MCP schemas into `tools:list`; MCP dispatch in `tools:execute` | 30 |
| `src/main/ipc/toolHandlers/registry.ts` | MCP fallback before `Unknown tool` | 8 |
| `src/main/ipc/store.ts` | `McpSettings` + migration | 40 |
| `src/main/ipc/net.ts` | `mcp` activity-log kind | 15 |
| `src/preload/index.ts`, `src/renderer/src/types.ts` | API surface + types | 50 |
| `src/renderer/src/lib/agentLoop.ts` | default per-turn budget for MCP tools | 10 |
| `src/renderer/src/lib/toolSelection.ts` | reserved slots for built-ins | 30 |
| `test/toolRegistry.test.ts` | collision assertion | 15 |
| `README.md` | MCP section; amend the egress claim | — |

---

## 8. Phases

| # | Phase | Done when | Est. |
| --- | --- | --- | --- |
| 1 | Transport + client, headless | Stub server (both eras) lists and calls tools from a unit test; kill -9 restarts; timeout cancels | 1.5 d |
| 2 | Manager + settings + IPC | An enabled server's tools appear in `tools:list` and dispatch through `tools:execute`; off by default | 1 d |
| 3 | Trust surface | Install confirmation, untrusted marker, activity-log row, per-tool enable | 0.5 d |
| 4 | Settings UI | Add/remove/start/stop/reload, status dot, tool list, stderr viewer | 1 d |
| 5 | Selection quality | Reserved slots + budgets; tool-choice eval delta at 0/12/36 MCP tools reported | 0.5 d |
| 6 | Docs | README section, `docs/mcp.md`, amended egress claim | 0.5 d |

Phases 1–2 carry the risk (era probing against real-world servers). 3–6 are known work.

**Validation targets for phase 1–2:** the reference filesystem, git, and sqlite servers, plus
one legacy-era server, all launched via `npx`.

---

## 9. Open decisions

1. **Egress posture** — A, B, or C from §5. *Recommend A.*
2. **Namespacing visible to the model** — `github_create_issue` as-is, or user-editable
   descriptions layered on top? Affects §4.5's eval result.
3. **Its own Settings tab, or a section under Tools?** `SettingsModal.tsx` is already 123 KB,
   so it lives in `settings/McpTab.tsx` either way.
4. **Autostart enabled servers on launch, or lazy on first use?** *Lean autostart* — lazy
   means the tool list grows mid-conversation, which moves the system block and defeats
   `stabilizeTurnTools`, discarding the prompt cache on the turn a server first wakes.
5. **Flagged preview in 1.7, or headline feature?**
