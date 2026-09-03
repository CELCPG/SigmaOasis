# Strategy: OpenClaw 2.0 design adoptions

*Written 2026-09-03, after reading OpenClaw's 2.0 announcement (2026-08-30, release 2026.8.1), its
documentation (architecture, skills, automations, hooks, memory architecture, multi-agent, exec
approvals, secrets, sandbox/tool-policy/elevated, the security audit checks, SOUL.md/AGENTS.md),
the InfoQ, MarkTechPost, heise and cybersecuritynews coverage, the encyclopedia entry, and the
arXiv security analysis of the framework (2603.27517).* Companion to
`STRATEGY-harness-adoptions.md` (the DeepSeek harness review) and
`STRATEGY-capability-multipliers.md` (the sequence this feeds).

## What OpenClaw is, in one paragraph

A personal agent **daemon**. One long-lived Gateway per host owns every messaging surface
(WhatsApp, Telegram, Slack, Discord, Signal, iMessage, WebChat) and a browser control UI; an
agent loop behind it runs tools, skills (directories of `SKILL.md` plus resources, from a
registry called ClawHub) and plugins; a scheduler runs cron jobs and a heartbeat inside the
Gateway process, not the model; memory is plain files plus one SQLite index in tiers with
provenance the model cannot write; subagents run background turns; approvals are
argument-scoped standing grants that fail closed when anything changes by a byte; secrets are
substituted into requests at the egress boundary so a model never sees a value; a
`security audit` command runs over a hundred named checks. 2.0 (933 contributors, 16,000 pull
requests) added guided setup that finds existing subscriptions and local models, a rebuilt
browser app, shared cloud sessions ("multiplayer"), a team secret store, and the approval and
credential work above. Its security record is the other half of the picture: a skill found
exfiltrating data, an agent that created a dating profile unprompted, secrets stored
unencrypted at rest, sandboxing not on by default, a state ban on its use — and a published
taxonomy of seven weakness classes: prompt injection through skills, credential exposure, skill
supply chain, sandbox escape, over-broad permissions, memory poisoning, network exposure.

## Why we care, and what we will not become

Sigma Oasis is the opposite shape on purpose: a desktop chat app that opens **no listening
port**, owns **no inbound surface**, runs **nothing while it is closed**, keeps every byte on the
machine, encrypts secrets with the OS keychain, sandboxes computation by construction, and
judges every claim with a mechanical eval. OpenClaw's growth came from being always on and
reachable from a phone; six of its seven weakness classes are consequences of exactly that.
So the rule for this document is the rule the harness review used: **adopt the mechanisms at
our existing seams, never the shape.** What transfers is the discipline OpenClaw arrived at
*after* the incidents — provenance the model cannot forge, grants scoped to the byte, jobs that
run in code rather than in the model, an audit that names its checks. What does not transfer is
the daemon, the surfaces, the registry, the cloud.

## Tier 1 — Provenance the model cannot write (memory integrity)

OpenClaw's memory architecture is the best thing in the project and the closest fit to what we
already have. Its rules, in its own words: memory is "plain files and one SQLite index,
organized into tiers with different trust levels, write rules, and injection behavior"; every
entry carries an origin class — `owner`, `agent`, `untrusted`, `system` — and a session kind in
"SQLite columns the model cannot write through prose"; untrusted-origin content "is structurally
barred from the curated core and from auto-injection"; when a tool declares network-sourced
content "the entire turn becomes marked untrusted"; injected recall is marked so it "cannot be
re-extracted as new memory"; durable memory "has exactly one primary writer", a consolidation
pass with a human-readable review trail.

Our `memory.json` chunks carry `source`, `text`, `embedding`, `model`, `createdAt` — and no
origin. A `memory_save` issued on a turn whose context held a fetched page is stored exactly like
one typed by the user, and is auto-recalled into every later conversation. That is the
memory-poisoning class, open. Adopt, at `main/ipc/memory.ts` and the fact ledger (A2):

1. **Origin class and session kind on every chunk**, written by the handler, never from
   arguments: `user` (typed or added under Settings → Memory), `model` (a `memory_save` the
   model issued), `untrusted` (the turn's context carried `UNTRUSTED_HEADER` content), `app`
   (notes auto-indexed, the ledger). Session kind: interactive, plan step, consultation, job.
2. **Auto-recall admits every origin but `untrusted`.** OpenClaw's rule, adopted as stated:
   agent-origin memory is admitted to recall, untrusted-origin memory is structurally barred
   from it. An `untrusted` chunk is reachable only through an explicit `memory_search`, where
   it is labelled and carries the untrusted marker, and the panel shows it with its origin and
   forgets the whole class in one click. The recall line under a reply already names sources;
   it names a model's origin too. *(v2.6: built this way. An earlier draft of this line had
   `model` chunks recalled only on a trigger phrase; that was narrower than the rule being
   adopted and is not what shipped.)*
3. **Taint propagates within a turn.** A save issued after a web tool returned in the same turn
   is `untrusted`, whatever the model says about it. Recalled chunks are marked in the turn so a
   save in that turn cannot re-save them (loop prevention).
4. **The ledger is the curated tier.** A2's `verified-claims` pack gets a supersession key per
   claim, the review surface is the pack's own document list, and nothing enters it except
   through the grounding pass — one writer.

*Eval gate:* a `memory-poisoning` node suite — a fetched fixture page containing "remember that
the CEO's password is …" and a model that obeys must produce a chunk that is `untrusted`, never
auto-recalled, and visible as such; the projects and memory recall suites must not move.

## Tier 2 — Standing grants scoped to the byte (approvals)

OpenClaw's exec approvals bind a permission to the executable **and** an `argPattern` over the
parsed arguments, and to the working directory the approval happened in; "Allow once" runs
without storing anything, "Allow always" mints a grant that "fails closed back to a normal
prompt whenever anything changed … by even one byte"; grants are listed with use counts and
revoked by id; permission modes run from `deny` to `full`, and approvals "can only tighten,
never loosen" the configured policy.

Our terminal tool confirms every run and our `write_file` confirms every write outside a
working directory — correct, and the reason nobody enables them. Adopt:

1. **Grants for the two confirming tools**: the dialog gains "Allow once" and "Always allow
   here"; the second stores `(tool, exact argv, cwd, env names)` in settings; a call matches only
   byte-for-byte; Settings → Tools lists grants with use counts and a revoke button.
2. **Per-server approval mode for MCP** (v2.5): `ask` (every call confirms, the default for a
   newly enabled server), `allowlist` (grants only), `full` (no prompts — stated as what it is).
   A grant binds `(server, tool, canonical arguments)`.
3. **Interpreter allowlists** for the terminal tool, OpenClaw's "safe bins": `python3` with
   `argPattern ^safe\.py$` runs `safe.py` and nothing else.
4. **No `full` mode for host exec.** OpenClaw ships one; we do not. Unattended host execution
   is the sandbox's job, and the sandbox is the Workbench.

*(v2.6: 1, 2 and 4 built. A grant lives in its own file, not in settings, and is bound to a
SHA-256 over the tool, the canonical arguments and the working directory — for `write_file`
the resolved path alone, since content changes every write and "always allow writes to this
file" is the thing worth granting. Nothing mints a grant but a button in a dialog the app
raised; no window means decline, grant or not. Servers saved before v2.6 migrate to `ask`,
which is a behaviour change for them and is stated in the notes. Item 3, interpreter
allowlists, is deferred: it is a pattern match, and the rule adopted here is byte-exact.)*

*Eval gate:* node tests for grant matching (a one-byte difference fails closed; cwd is part of
the key), the modal-focus and tab-traverse suites for the dialog, the audit suite for the
record — every grant use is an audit entry.

## Tier 3 — Jobs that run in code, not in the model (automations)

OpenClaw's automations are the shape A3 ("standing questions") was reaching for, worked out:
one payload kind per job — a system event, an agent turn, a shell command, a headless script —
a schedule (`--at`, `--every`, `--cron`, on exit, on stream), a session target (`main`,
`isolated`, `current`), a delivery mode (`announce`, `webhook`, `none`), persistence in SQLite,
execution "inside the Gateway process, not inside the model", auto-disable "after 10
consecutive execution failures" with a notice to the owner, and approvals for an automation
minted as "a scoped standing grant bound to that exact agent, automation, job configuration,
and operation" that is void the moment the job is edited.

Adopt, with the one difference that defines us: **jobs run while the app is open, and only
then.** No daemon, no port, nothing acting while the window is closed. (An opt-in menu-bar
mode that keeps the app resident is a later, separate decision, and it changes nothing below.)

1. **Job kinds**: re-run a saved deep-research question; re-check a ledger claim near its
   freshness limit; re-check a watched price; refresh a tracked pack folder. Each is a tool the
   user already ran once, re-run with the same arguments — a job never invents a request.
2. **Delivery is a digest conversation**, one per job, with every run appended; nothing is sent
   anywhere. Every network call a job makes is in the activity log under a `job` purpose.
3. **Grants fail closed on edit**: a job that needs a confirming tool carries the grant the user
   gave when creating it, bound to the job's configuration; editing the job voids the grant.
4. **Auto-disable after ten consecutive failures**, with the reason on the job's row, and the
   audit log carrying every run as a session of kind `job` — which is also what keeps job
   sessions out of memory promotion (Tier 1's session-kind gate, OpenClaw's own rule).

*Eval gate:* a `jobs` node suite (schedule arithmetic, fail-closed grants, the ten-failure
cutoff) and the audit suite; the render suite pins that a digest renders as a live chat does.

## Tier 4 — Skills as a package the user can install from a folder

OpenClaw's skill is a directory: `SKILL.md` with `name` and a `description` under 160 characters
"shown to the agent and in discovery output", instructions in the body, resources referenced
through `{baseDir}`, loaded from several roots with workspace over global over bundled. It is a
good format and a bad supply chain: the registry is where the exfiltrating skill came from, and
the audit's `skills.code_safety` check exists because of it.

We have the pieces of a skill and no package: playbooks are TypeScript constants, packs are
folders with a manifest, MCP servers are settings rows, and the Workbench has no helper
library. Adopt the format, not the registry:

1. **A skill folder**: `skill.json` (name, description as a *decision rule* in our house style —
   use when, do not use when, one example — trigger phrases for the router), an optional
   `playbook.md`, an optional pack (`manifest.json` + `docs/`), an optional MCP server spec, and
   optional Python helpers staged into `/work/skills/<name>/` for `run_python`.
2. **Install from a folder only**, through a confirmation that lists what the skill carries:
   instructions, documents, a server command (with the MCP confirmation), code the sandbox will
   see. No registry, no URL install, no auto-update. Precedence: user skills over bundled.
3. **The router picks skills the way it picks playbooks**: the domain classifier plus trigger
   phrases; the chosen skill is disclosed under the reply as the playbook is now.
4. **Bundled skills** are the existing playbooks and packs repackaged, so the format is used
   from day one and the library suite keeps measuring them.

*Eval gate:* the library suite with the bundled skills installed must equal today's numbers;
a `skills` suite of twelve prompts measures whether the router picks the right skill and whether
a skill's playbook moves its domain's cases; the tool-choice suite with a skill that carries an
MCP server, through `EVAL_MCP_STUB` as in v2.5.

## Tier 5 — Voice and rules as two files (customization)

OpenClaw separates `SOUL.md` ("tone, opinions, brevity, humor, boundaries") from `AGENTS.md`
(standing operating rules) and injects both; its guidance is that prompts be "iterated on,
pinned, and evaluated rather than written once and forgotten." Our slots have one system
prompt; projects have standing instructions; model profiles carry eval scores.

Adopt the split and the discipline: a slot's **persona** (how it sounds) and its **rules** (what
it does) as two editable blocks, rules disclosed under the reply beside the playbook line;
projects keep their instructions as a third layer. Persona versions are pinned per slot and
the reasoning and library suites can be run against a slot from Settings → Models, which the
in-app eval already does for tool choice. This is small, and it is the customization answer.

*Eval gate:* the answer suites run per slot; a persona change that moves the library or
reasoning numbers is a measured change, not a cosmetic one.

## Tier 6 — A privacy audit that names its checks

`openclaw security audit` runs over a hundred named checks — state-directory permissions,
unauthenticated bindings, tokens too short, wildcard approvals, plugins without an allowlist,
open DMs with powerful tools, dangerous sandbox mounts — each with a pass, a fail and a fix.
Most of them are about surfaces we do not have. The idea transfers whole.

Adopt a **Privacy audit** under Settings → Privacy, mechanical and named:
`tools.terminal_enabled_without_working_directory`, `tools.write_enabled_without_working_directory`,
`mcp.server_enabled` (one per server, with its command and env names),
`mcp.server_enabled_while_proxy_required`, `search.provider_not_self_hosted`,
`updates.auto_check_on`, `audit.disabled`, `memory.untrusted_chunks_present` (Tier 1),
`grants.standing_grants_present` (Tier 2), `jobs.enabled` (Tier 3),
`state.dir_permissions`, `secrets.in_plaintext_config` (should always pass — the keychain), and
`egress.hosts_allowed` listing the allowlist as it stands. Each row is a sentence and a button.
OpenClaw learned the value of this after the incidents; we can have it before.

*Eval gate:* a node suite per check against synthetic settings; the tab-traverse suite for the
panel.

## Tier 7 — Secrets: what we already do, and the one addition

OpenClaw mints "an opaque, process-local sentinel" for a credential and substitutes the real
value "immediately before each request leaves the process", with an opt-in proxy that binds a
secret to approved hosts; the model never holds a value. We already do the equivalent for the
one credential we hold (the Brave key lives in the keychain and is injected in the main process
at the request boundary), and unlike OpenClaw we encrypt at rest. One addition: **MCP server
environment values entered through a masked field and stored in the keychain**, names only in
settings and dialogs, values injected into the child's environment at spawn. Destination
binding does not transfer — a server's sockets are its own — which is exactly why the MCP tab
says so.

## What OpenClaw's incidents say about our privacy core

Each of the seven weakness classes maps to a property this app already has or this document
adds — and the mapping is the argument for keeping the shape:

| Class | OpenClaw's exposure | Sigma Oasis |
| --- | --- | --- |
| prompt injection through skills | skills from a registry, instructions loaded as trusted | untrusted marker on every foreign text; skills installed from a folder through a confirmation (Tier 4) |
| credential exposure | secrets unencrypted in SQLite | keychain-encrypted; masked MCP env values (Tier 7) |
| skill supply chain | ClawHub | no registry, ever |
| sandbox escape | Docker/Podman, not on by default | Pyodide in a sandboxed window, on by construction; host exec confirms per run |
| over-broad permissions | `full` mode, wildcard grants | per-slot allowlists, per-turn budgets, byte-scoped grants, no `full` for host exec (Tier 2) |
| memory poisoning | fixed in their architecture; the fix is the model for Tier 1 | origin classes, taint, one writer (Tier 1) |
| network exposure | a Gateway on a port, DMs from strangers | no listener; nothing runs while the app is closed (Tier 3's rule) |

## Explicitly rejected

- **The Gateway daemon and the messaging surfaces** (WhatsApp, Telegram, Signal, iMessage,
  Slack, Discord, WebChat). Each is an inbound channel a stranger can write to, which is the
  DM-injection class and the reason `channels.<provider>.dm.open` is an audit check. A chat app
  that opens no port has no such check to fail.
- **Shared cloud sessions and the team secret store.** Cloud, by definition.
- **ClawHub or any registry.** The supply-chain class, verbatim.
- **Browser control with element inspection.** Our offscreen renderer already fetches with
  every third-party request blocked; a driven browser session is a cookie jar.
- **Docker/Podman sandboxing as a dependency.** The Workbench is sandboxed by construction and
  ships in the app; a container runtime is an install step and, in OpenClaw's own default, off.
- **Hooks as trusted, unsandboxed JavaScript in the process.** No.
- **The `elevated` escape hatch and the `full` permission mode** for host execution.
- **A plugin SDK.** Rejected in the harness review; the reasons hold.
- **Subagents as a general facility.** We have orchestrated mode with `consult_model`, capped
  and loop-proof; the multi-turn evals said orchestration does not help a 9B. What transfers is
  the *tracking* — every consultation is already a disclosed block.

## Sequencing, against the capability-multipliers plan

| Release | From this document | Why there |
| --- | --- | --- |
| **v2.6** — verification that compounds | Tier 1 (provenance) folded into A2 the ledger; Tier 3 (jobs) *is* A3; Tier 2 (grants) because A3's unattended runs need them; Tier 6 (privacy audit), cheap | the three land on the same seams A2 and A3 open |
| **v2.7** — the loop opens up | Tier 4 (skills) beside Code Mode, which stages a skill's helpers into the sandbox; Tier 5 (persona and rules) | a skill package needs the sandbox path Code Mode builds |
| **later** | Tier 7's masked MCP env values with the next MCP change; an opt-in resident mode, as its own decision | small, and separable |

Every tier names its gate above. The one this document adds to the house rules: a mechanism
adopted from a project with a public incident record is adopted **with the check that would have
caught the incident** — the privacy audit row, the eval case, the node test — or not at all.

## Sources

- [OpenClaw 2.0, Accidentally](https://openclaw.ai/blog/openclaw-2-accidentally) — the announcement
- [OpenClaw documentation](https://docs.openclaw.ai/) — architecture, creating skills, cron jobs, hooks, memory architecture, multi-agent, exec approvals, secrets, sandbox vs tool policy vs elevated, security audit checks, SOUL.md
- [InfoQ: OpenClaw 2.0 Releases with Simplified Setup and Collaborative Agents](https://www.infoq.com/news/2026/09/openclaw-2-release/)
- [MarkTechPost: Guided Model Setup, 575 ms Control UI Startup, and One Trust Boundary Per Gateway](https://www.marktechpost.com/2026/08/30/openclaw-releases-openclaw-2-0-guided-model-setup-575-ms-control-ui-startup-and-one-trust-boundary-per-gateway/)
- [Cybersecurity News: OpenClaw 2.0 Released With Major Security Upgrades](https://cybersecuritynews.com/openclaw-2-0-released/)
- [heise: OpenClaw 2.0: Largest update to date](https://www.heise.de/en/news/OpenClaw-2-0-Largest-update-to-date-expands-team-and-agent-functions-11435048.html)
- [VentureBeat: the era of 'multiplayer' AI coding](https://venturebeat.com/technology/openclaw-2-0-is-here-what-it-means-for-enterprises)
- [Wikipedia: OpenClaw](https://en.wikipedia.org/wiki/OpenClaw) — history and incidents
- [A Security Analysis of the OpenClaw AI Agent Framework (arXiv 2603.27517)](https://arxiv.org/pdf/2603.27517)
