# Strategy: DeepSeek Harness design adoptions

*Written 2026-08-23, after a full review of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), DeepSeek AI's open-source agent harness (developer preview, master branch as of this date).*

## What dsh is, in one paragraph

A Cordis-based "everything is a plugin" monorepo (~50 packages). Every capability sits behind a service seam (`ctx.llm`, `ctx.tools`, `ctx.fs`, `ctx.sandbox`, `ctx.subagents`, `ctx.compaction`, `ctx.spillStore`, …) with swappable providers. The session is an append-only event log — "model-visible means logged," enforced by runtime invariants — from which LLM history, UI, replay, forking, and compaction are all derived. Tool execution runs through a staged pipeline (reorderable pre-execute policy → monotonic guards → around-dispatch wrappers → post-execute). Docs are build artifacts: generated catalogs with `--check` CI twins, per-package "Model Experience / Token effect / KV Cache effect" sections, ~740 gate-verified design notes.

## Why we care, and why we don't copy it

Sigma Oasis is deliberately the opposite shape: local-first, dependency-light, one provider (LM Studio), no plugin system, and mechanical evals as the arbiter of every claim. We adopt dsh's *ideas at our existing seams* — the `AgentLoopDeps` injection points, `tools:list`/`tools:execute`, the `turnContext[]` assembly — never its framework. One point of confidence going the other way: dsh has essentially no in-repo eval harness (its BENCHMARK.md is three lines pointing at a Python SDK); our eval culture is ahead, so every adoption below names its eval gate.

## Tier 1 — Internal architecture (fixes known pain, unblocks everything later)

1. **Context-provider registry** (dsh: prompt sections / context-injection plugins).
   Replace the nine hardcoded pre-flight blocks in `runTurn` (`src/renderer/src/hooks/useLMStudio.ts`) with an ordered registry in `src/renderer/src/lib/contextProviders/`: each provider has a cheap `enabled()` gate, an isolated `gather()` (failure degrades to absence, never breaks the turn), and shared tool-record/audit bookkeeping written once. Fixed registry order preserves the response cache and eval comparability. This is the seam MCP-derived context and any tenth source will plug into.
2. **Single-declaration tool registry** (dsh: `defineTool`).
   Collapse the seven name-keyed tables that currently drift — `toolSchemas.ts`, `toolHandlers/registry.ts`, the two duplicate `ToolToggles` declarations, `TOOL_LABELS`, `TOOL_TURN_BUDGETS`, `ALWAYS_ON_TOOLS`, `SOURCE_TOOLS` — into one `ToolMeta` table in `src/shared/tools/` from which everything derives. Budgets stay disclosed in tool descriptions (`withBudgetNotes()`), now derived instead of parallel-maintained.
3. **Unified execution bookkeeping** (dsh: one pipeline for every dispatch).
   App-initiated pre-flight tool calls share a `TurnToolLedger` with the agent loop, so budgets and repeat-detection apply uniformly and the per-slot allowlist becomes structural (`ProviderIO.runTool` refuses non-allowlisted names) instead of a per-block convention.
4. **Shared streaming core** (dsh: `StreamChunk` protocol + single `BlockAssembler`).
   One SSE parser + chunk/block assembler in `src/shared/`, used by both `src/main/ipc/llm.ts` and `src/renderer/src/hooks/chatTransport.ts`, ending the two independently implemented clients with divergent timeout/reasoning handling. Contract details worth keeping from dsh: usage before finish, nothing after finish; tool-call arguments stay raw JSON strings end-to-end; a max-tokens finish drops possibly-truncated tool calls.

*Eval gate:* these are behavior-neutral refactors (except the ledger unification, which is isolated and measured). Full `node:test`, then `eval:tools` and `eval:answers` (all suites, `EVAL_PASSES=3`) against the committed `.eval-results` baselines — any suite movement is a defect.

## Tier 2 — MCP support (existing plan, hardened)

Execute `docs/mcp-client-scope.md` (already scoped to `tools:list` / `tools:execute`), lifting three dsh mechanisms verbatim:

- **Deterministic naming**: `mcp__<server>__<tool>` normalized to the 64-char function-name contract; when normalization or truncation changes the name, append a 12-hex hash of `(server, rawName)` so distinct tools never collapse. Names are pure functions of identity, never of connection order.
- **Per-outage reconnection budgets**: exponential backoff with `maxAttempts` per outage; a connection surviving past `maxDelayMs` resets the budget — an occasionally-crashing server recovers indefinitely, a crash-looper exhausts the cap. During an outage the last good tool generation stays registered and fails calls cleanly.
- **All-or-nothing generation swaps**: a re-sync that would collide or partially fail rolls back whole, never leaving a partial tool set.

MCP tools enter as a second source merged over the static `ToolMeta` table and remain subject to per-slot allowlists (the security boundary) — default-off per server.

## Tier 3 — Code Mode in the Workbench (eval-measurable feature)

dsh's Code Mode replaces per-call tool invocation with a typed, deterministically generated SDK the model calls from code. We already have the hard part — a Pyodide sandbox (`src/main/ipc/workbench.ts`):

- Generate a typed Python SDK (`tools.<name>(args)`, `TypedDict`s) from the `ToolMeta` table: lexicographic order, byte-identical for an unchanged tool set (KV-cache friendly).
- Every SDK call re-enters the real `tools:execute` path carrying the parent call id — budgets, audit, and allowlists apply; programs see only `{toolName, message}` on failure.
- Ship as a per-slot mode (`native | code | both`), and **let a new eval suite decide** whether code-mode orchestration helps small local models. Given what the orchestration evals taught us, the honest prior is that it may not — the suite is the arbiter.

## Tier 4 — UX features

- **Spill for oversized tool results** (dsh: spill + output-retention): above a byte threshold, replace inline output with head/tail preview + opaque locator + retrieval hint; a `read_spill` tool fetches ranges. Files under `userData/spill/<conversationId>/`, exclusive-create. **Ephemeral chats never spill to disk** — full content stays in memory.
- **Mid-turn steering** (dsh: inbox `followup`/`steer`/`inject` verbs): let the user type while a turn runs; delivery at the next agent-loop iteration boundary (messages consumed between tool rounds); `inject` (deliver without waking) reserved for app-added context. Persisted as ordinary conversation messages with a delivery marker.
- **Replayable tool cards** (dsh: pure `presentCall`/`presentResult` + persisted `presentationMeta`): tool-record presentation must be a pure function of args + result so trace export and conversation reload render identically; result-time display facts persist on the record; old/malformed records soft-validate to a generic fallback — display never crashes a replay.

## Adopted as process (cheap, immediate)

- **Generated-catalog drift gate**: once the single-declaration registry exists, generate `docs/tool-catalog.md` from it with a `--check` twin in CI.
- **"Model Experience" notes**: for each tool/provider, a short doc block stating what the model sees, the token effect, and the KV-cache effect. We already reason this way in comments (`src/main/ipc/llm.ts:60-130`); make it a convention.
- **Postmortems** for measured regressions: `docs/postmortem/NNNN-*.md`, following dsh's numbered format.

## Explicitly rejected

- **Cordis / plugin framework, profiles, bundles, patches** — wholesale runtime composition contradicts the small-dependency, single-app ethos. The registries above capture the useful seams without the framework.
- **Typert RPC layer** — Electron's typed preload bridge already serves this role.
- **Append-only session event log as source of truth** — a full "model-visible means logged" rewrite is out of proportion for a chat app with working conversation JSON plus a hash-chained audit log. We adopt its two portable disciplines piecemeal: compaction as a bracketed, crash-detectable operation, and presentation purity for replay (Tier 4).
- **Multi-provider LLM adapter seam** — single-provider is a product decision; the shared streaming core gets the code benefit without the abstraction.
- **External subagent providers (Codex/Claude Code), E2B remote sandboxing** — conflict with local-first positioning.

## Ordering rationale

Tier 1 first because items 2→1→3 are a dependency chain (the tool table gives providers their budget/allowlist vocabulary; the provider registry gives the ledger a single choke point), and because MCP (Tier 2) and Code Mode (Tier 3) both generate from the `ToolMeta` table. Tier 4 items are independent and can interleave.
