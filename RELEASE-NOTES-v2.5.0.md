# Sigma Oasis v2.5.0 — tools without limit

Sigma Oasis is an MCP client. Add a Model Context Protocol server under Settings → MCP by its
command, turn it on, and its tools join the built-in ones on the wire — under exactly the regime
the built-ins live under, and with the one thing the app cannot see said out loud. This is the
largest capability multiplier the strategy had, and it ships with the measurement the scope
demanded: whether connecting a server degrades the model's choice among the tools it already had.

## What ships

- **stdio, tools only, no new dependency.** The client is about seven hundred lines of the app's
  own TypeScript: a newline-framed transport with the specification's shutdown sequence, a
  JSON-RPC client, a manager. The official SDK carries an HTTP server stack this app has no use
  for. No HTTP transport, no remote servers, no resources or prompts — the two obvious follow-ons
  are the Library and the playbooks, and they wait for a measured reason.
- **Both protocol eras.** A modern server (revision 2026-07-28: version and client capabilities on
  every request, `resultType` on every result) and a legacy one (the `initialize` handshake) are
  told apart by the specification's probe: `server/discover` first, a result or a recognised modern
  error means modern, anything else or silence means legacy. Verified against a stub in both eras;
  the panel shows which one a server answered in.
- **Names that hold.** A tool goes on the wire as `mcp__<server>__<tool>`, sanitised to the wire
  contract and, when sanitising changed anything, carrying a 12-hex hash of the tool's identity so
  two tools can never collapse into one name. The name is a pure function of identity, never of
  connection order, so the tool list and the prompt cache are the same across launches.
- **All-or-nothing tool lists, per-outage restarts.** A server's list replaces the last one whole
  or not at all: one that would shadow a built-in, another server or itself is refused and the last
  good list stays, with the reason in the panel. A crashed server is restarted with backoff up to
  five times per outage; a connection that lives past thirty seconds resets the budget; a
  crash-looper is shown as failed with its stderr. Both lifted from the DeepSeek harness's design
  (`STRATEGY-harness-adoptions.md`, Tier 2).
- **The same regime as the built-ins.** MCP tools enter at `tools:list` after the built-ins and
  leave at `tools:execute`, so per-role allowlists, per-turn budgets (three calls per MCP tool per
  turn, disclosed in the description), identical-call reuse, the tool-call block — which shows the
  server and the tool — and the audit log apply unchanged. Every result is wrapped in an untrusted
  marker naming the server, on the pattern the public web already gets, and capped like every
  other tool's output.

## The boundary, stated

- **A server runs with your privileges.** Adding one shows the exact command, its arguments and the
  *names* of any environment variables — never values — and says so. It is saved switched off.
- **Its traffic is its own.** The egress allowlist, the activity log and the proxy setting cover the
  app's requests. A server's sockets are not the app's; the app cannot see them and does not claim
  to. The activity log records that a server started, stopped or failed, and the row says its
  traffic is not visible there. The README's egress claim now says "the app's own" traffic.
- **Nothing lets a server drive the model.** The client declares no capabilities a server could
  call on — no sampling, no elicitation, no roots. A result that asks for input is refused; a
  server request is answered with an error.

## Measured

The gate the strategy set for this release: connect servers whose tools deliberately overlap
the built-ins, and ask whether the 24 native tool-choice fixtures still pick the right tool and
still call nothing when nothing is called for. qwen3.8-9b, 8K context, temperature 0, three
passes each.

| MCP servers connected | schemas registered | on the wire per fixture | correct-tool | spurious |
| --- | --- | --- | --- | --- |
| 0 | 25 | 6.0 | 57/63 · 90% | 0/9 |
| 4 (12 tools) | 37 | 6.0 | 57/63 · 90% | 0/8 |
| 12 (36 tools) | 61 | 6.0 | 57/63 · 90% | 0/9 |

Nothing moved. The app ranks tools by embedding against the user's text and puts six on the
wire, and on these fixtures no server's tool outranked a built-in, so the model saw the same
six tools with servers connected as without. One pass in the 4-server row lost a case to an
LM Studio HTTP 500; the other two passes had it right.

**The measurement that came first was the wrong one, and it is kept.** Through v2.4 the
tool-choice eval had sent the model the whole toolbox, which the app never does. With servers
connected that overstatement stopped being harmless: 12 unranked extra tools and the 9B called
nothing on 57 of 72 runs; 36 and the request did not fit the window. The full table is in
`docs/evals.md`. The eval now applies the app's own selection per fixture, and the raw-list
numbers stand as the record of what a 9B does when handed 37 schemas: it does not pick the
wrong one, it stops picking.

## Measured, and left alone

The strategy scheduled making think-harder a per-domain default where the reasoning suite showed
review fixing more than it broke. Two facts closed it. There is no automatic default to gate:
think-harder is the 🧠 button and nothing else. And on this model there would be no domain to
give one to — across fourteen reasoning kinds the draft is right 14 of 14 and the review-and-revise
pass fixes nothing and breaks nothing, the same null the quantitative suite recorded in v1.6.
The button stays.

## Not in this release

- Streamable HTTP, resources, prompts, subscriptions, tasks and the extensions. Each is a
  transport or a feature with its own trust story; none has a measured reason yet.
- Code Mode (calling MCP tools from the Workbench's Python) is v2.7's experiment, and the honest
  prior from the orchestration evals is that a 9B may not be helped by it.

## Upgrade notes

Auto-update from v2.4.0. One new settings branch (`mcp.servers`, empty), one new Settings tab, one
new activity-log purpose (`mcp`). Nothing runs until a server is added and turned on. No change to
any built-in tool, check, record or privacy behaviour.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v2.4.0...v2.5.0
