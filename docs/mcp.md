# MCP servers (v2.5)

Sigma Oasis is a client for the Model Context Protocol: it can launch a local MCP server as a
subprocess and expose that server's tools to your models beside the built-in ones. This page is
what that means in practice, what the app enforces, and what it does not.

## What ships

- **Transport:** stdio only. The app launches the server, writes JSON-RPC to its stdin and reads
  JSON-RPC from its stdout, one message per line. No HTTP transport, no remote servers.
- **Features:** tools only. Resources, prompts, subscriptions, tasks, sampling, elicitation and
  roots are not implemented, deliberately (see *What it will not do*).
- **Both protocol eras.** A modern server (revision 2026-07-28 and later carries the protocol
  version and the client's capabilities on every request) and a legacy one (an `initialize`
  handshake, 2025-11-25 and earlier). The era is found the way the specification says: the app sends
  `server/discover`; a result or a recognised modern error means modern, anything else or silence
  means legacy and the handshake follows. The panel shows which era a server answered in.
- **Zero new dependencies.** The client is about 700 lines of the app's own TypeScript
  (`src/main/ipc/mcp/`). The official SDK carries an HTTP server stack this app has no use for.

## Adding a server

Settings → MCP → *Add a server*. You give it an id, a display name, the command, its arguments, any
environment variables, and optionally a working directory. Before anything is saved, a confirmation
shows the resolved command line and the **names** of the environment variables — values are never
shown or logged — and says that the program runs with your privileges and outside the app's egress
allowlist. The server is saved **switched off**. Turning it on is a second, explicit step, on the
same page.

Reference servers launch with `npx`, for example:

| Server | Command | Arguments |
| --- | --- | --- |
| Filesystem | `npx` | `-y @modelcontextprotocol/server-filesystem "/Users/me/Documents"` |
| Git | `npx` | `-y @modelcontextprotocol/server-git` |
| A script of your own | `node` | `/path/to/server.mjs` |

## How a server's tools reach a model

- **Wire names.** A tool `create_issue` on a server with id `github` goes on the wire as
  `mcp__github__create_issue`. Names are sanitised to the wire contract and capped at 64 characters;
  when that changed anything, a 12-hex hash of the tool's identity is appended so two distinct
  tools can never collapse into one name. The name is a pure function of the tool's identity,
  never of connection order, so the tool list is the same across launches and the prompt cache
  holds.
- **All-or-nothing tool lists.** A server's tool list replaces the previous one whole. A list that
  would shadow a built-in, collide with another server, or collide with itself is refused and the
  last good list stays registered — never a partial set. The panel says why.
- **The same regime as the built-ins.** Per-role allowlists apply (a role with an explicit
  allowlist sees only the tools named in it), per-turn budgets apply (three calls per MCP tool per
  turn, disclosed in the tool description), identical-call reuse applies, every call appears as a
  tool-call block showing the server and the tool, and every call is in the audit log.
- **Untrusted output.** Every result is wrapped in a marker naming the server before a model sees
  it, on the same pattern as text from the public web, and capped at the same length.
- **Per-tool switches.** Once a server is on, every tool is on; each can be switched off in the
  panel, which takes it off the wire and refuses calls to it.

## Failure and restart

A server that exits unexpectedly is restarted with exponential backoff, up to five times per
outage; a connection that survives past thirty seconds resets the budget. An occasionally-crashing
server recovers indefinitely; a crash-looper exhausts the cap and is shown as **failed**, with its
last stderr lines in the panel. While a server is down, its tools stay registered and calls to them
fail with a message saying so — the tool list does not shrink and grow under the model. A call that
outlives its timeout (sixty seconds) is cancelled with `notifications/cancelled`.

## What the activity log shows, and what it cannot

The network activity log is a complete account of **the app's own** requests. An MCP server is a
separate process with sockets of its own; the app has no visibility into them and no way to acquire
any short of OS-level sandboxing it does not ship. The log therefore records that a server
*started*, *stopped* or *failed*, under the `mcp` purpose, and the row says in words that the
server's own network activity is not visible there. The proxy setting does not cover a server
either. This is stated rather than papered over, and it is why a server is off until you turn it on.

## What it will not do

- **Let a server drive the model.** The client declares no capabilities a server could call on: no
  sampling, no elicitation, no roots. A result whose `resultType` is `input_required` is refused,
  not answered; a server-to-client request is answered with an error. A server must not be able to
  make your model do work you did not ask for.
- **Trust a description.** Tool descriptions are what the server says about itself, and the
  protocol's own guidance is to treat them as untrusted. They are shown in the panel unchanged and
  passed to the model with the app's own line appended: whose tool it is, and that its output is
  untrusted.
- **Pretend to see its traffic.** See above.

## Measured

The tool-choice eval (`LMSTUDIO_EVAL=1 EVAL_MCP_STUB=<n> npm run eval:tools -- <model>`) runs the
24 built-in fixtures with `n` stub MCP servers connected, three tools each with deliberately
overlapping descriptions, and reports whether their presence moved the built-in correct-tool and
spurious-call rates. Results are in `docs/evals.md` and the release notes.
