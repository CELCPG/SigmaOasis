# Sigma Oasis v1.12.1 — the multi-model question, answered with numbers

v1.12 fixed routing so turns could reach specialist roles. This release asks the harder question
that promise implies: does multi-model orchestration actually make answers better? Three new
measurement regimes, 48 scored cases, a second model family, and two new lines in the UI that
state what was found. Pinned by 1,509 node checks.

## Orchestrated mode, measured — and it tells you itself

An orchestrator that delegates to specialists as tools is the app's most powerful-feeling mode,
and it had never been measured. Now it has, three ways (same weights under every persona — the
configuration a single-model user actually gets):

- **Orchestrator holding its own tools:** it never delegated once in 21 cases — it just computed,
  correctly (21/21 vs 20/21 independent). Orchestration was a free no-op.
- **Orchestrator with no tools** (delegation load-bearing): the relay is faithful — 15/15 correct
  on delegated cases, the right specialist picked every time — at **2.3× the latency** for equal
  overall correctness.
- **Synthesis tasks built for a delegation win** (a CSV computation *and* a policy rule living
  only in a reference pack, capabilities split so no single consult can answer): every case
  crossed at least two roles in sensible order and every figure was exact — at **3.0× the
  latency** of one agent holding all the tools, which scored 6/6.

Across all 48 cases, delegation never once produced an answer the plain agent got wrong. The
verdict: a working routing mechanism, not an intelligence amplifier. **The app now says so where
it matters:** with every enabled role on the same model, Orchestrated mode's panel states that
delegation adds structure and latency, not intelligence — and the note vanishes when roles run
genuinely different models, because that configuration is unmeasured and the app claims nothing
it has not measured, in either direction.

## The panel says what routing can reach

The v1.12 routing fixes only route to specialist roles that exist. With one enabled generalist —
the setup in the sessions that started all this — routing silently does nothing, and silence
reads as breakage. The Strategy section now states what the router can reach: no specialists →
the full explanation and where to fix it; partial coverage → which turn kinds route and which
stay put; full coverage → no note at all.

## Second family: recall generalizes, market depends on the model

The "measured on one model class" caveat is paid down:

- **Project recall on mistral-7b:** 7/8 vs bare 1/8, gate fired 8/8 and stayed quiet 5/5 — the
  qwen numbers to the case. The recall effect is a property of the retrieval, not the model.
- **Market data on mistral-7b: 0/6, zero tool calls in 8 turns.** The model never invoked a tool,
  answered from memory, and *claimed tool use it never made* — "I've used web_search … the latest
  closing price for TRND is $157.49", with web_search not on the wire and the figure invented.
  The market feature is gated on tool-calling competence: 6/6 with real charts on a tool-native
  family, nothing on a family that will not call tools. Choose your market-analysis model
  accordingly; the honesty badges catch the fabrication, but they cannot make the feature work.

## Also

- The "$400 every two weeks" arithmetic that went wrong in a reviewed session is now a permanent
  eval fixture — expected value computed independently, tolerance accepting both defensible
  compounding conventions and rejecting both measured wrong answers — and it passes.
- Three new opt-in suites ship with the repo: `orchestrate`, `synthesis` (with its invented-policy
  fixture pack, so retrieval is load-bearing by construction), and the lean-orchestrator variant.
  Full method and numbers in `docs/evals.md`.

## Upgrade notes

Auto-update from v1.12.0. No settings changed and nothing moved; the two new panel notes appear
only in the configurations they describe, and disappear when the configuration is one where the
feature can do its job.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.12.0...v1.12.1
