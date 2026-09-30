# Orchestrated mode

Part of the [evals index](../evals.md).

## Orchestrated mode, measured (v1.12.1, qwen3.8-9b, temperature 0)

The promise is "the power of multiple models": an orchestrator that reasons about the request and
delegates to specialists as tools. Whether that beats simply answering had never been measured.
Two regimes over the 21 quant fixtures (objective ground truth; arithmetic, finance and CSV work),
same weights under every persona — this machine's honest reality, and what a single-model user
actually gets from orchestrated mode. Specialists are the app's own template personas; the roster
includes a tool-less Researcher so a wrong pick is possible.

**Regime 1 — the orchestrator holds the tools itself** (its slot's allowlist includes the
Workbench, as a default setup would):

| arm | correct | consults | tool calls/case | s/case |
| --- | --- | --- | --- | --- |
| independent | 20/21 | — | 1.1 | 22 |
| orchestrated | 21/21 | **0** on 21 cases | 1.1 | 21 |

The orchestrator **never delegated once**. Given the option and the tools, it computes — which on
these tasks is optimal, and means orchestration is a free no-op here, not an amplifier. The
one-case difference is single-run noise, not a signal.

**Regime 2 — the orchestrator holds NO tools** (roster only; the per-slot-allowlist configuration
where delegation is load-bearing):

| arm | correct | consults | s/case |
| --- | --- | --- | --- |
| independent | 20/21 | — | 24 |
| orchestrated (lean) | 20/21 | 15/21 cases, all → Data Analyst | **55** |

On the 15 delegated cases: independent 14/15, orchestrated **15/15** — the relay is lossless; a
specialist's computed answer survives the round trip intact, and the orchestrator always picked
the right specialist (never the tool-less Researcher). The costs are equally plain: **2.3× the
latency** for equal overall correctness, and the one overall miss came from a case the lean
orchestrator answered *from memory instead of consulting* — it went tool-free on 6 of 21 cases
and got away with it on 5.

### What this means

Orchestrated mode is a working **routing mechanism**, not an intelligence amplifier — at least on
same-weights hardware and tool-solvable tasks. Delegation is faithfully executed when the
orchestrator lacks tools, skipped when it has them, and costs 2.3× when used. The practical
advice that falls out: give the orchestrator slot the tools it needs and delegation stays a
no-cost option; reserve real delegation for slots that genuinely differ (different models, or
deliberately different allowlists). The failure mode to watch is a tool-less orchestrator
answering from memory rather than consulting — the exact class the "answered from model memory"
badge exists for.

**Regime 3 — synthesis across specialists** (`EVAL_SUITES=synthesis`), the configuration most
likely to show a delegation win, built so a win is *possible*: six cases each requiring a number
computed from an attached CSV **and** a policy rule that exists only in a fixture reference pack
whose figures are invented — retrieval is load-bearing in both arms, weights cannot shortcut it.
The independent arm holds all three capabilities (Workbench + reference_lookup); the orchestrated
arm splits them across specialists (Data Analyst: Workbench; Researcher: library; Finance Coach:
calculator) under a tool-less orchestrator, so no single consult can answer.

| arm | correct | cross-role consults | s/case |
| --- | --- | --- | --- |
| independent (all tools, one agent) | **6/6** | — | 59 |
| orchestrated (split capabilities) | 6/6 figures, 5/6 strict | 2+ distinct roles on **6/6** | **177** |

The mechanism performs exactly as designed: every case delegated across at least two roles, in
sensible orders (compute → fetch policy → apply, or policy first), and every final figure was
exact — commission tiers, threshold branches, the budget cap, all of it. The one strict-scoring
miss is an **uncited rate, not a wrong number**: the rebate answer was perfect ($841.67, only the
qualifying region, correct threshold) but the final reply never restated the 8.5% the Researcher
had fetched. And the cost is **3.0×** the latency of one agent holding all the tools.

### The verdict across all three regimes

Delegation is a working mechanism and a losing configuration. With tools in hand the orchestrator
rightly never uses it; forced by allowlists it relays faithfully at 2.3×; on tasks built for
synthesis it crosses roles correctly at 3.0× — and at no point, in 48 measured cases, did it
produce a single answer the plain agent got wrong. On same-weights hardware, "the power of
multiple models" is realized by giving ONE well-tooled slot the job, and per-slot allowlists
should be treated as a security boundary, not a performance strategy. The configuration still
unmeasured is genuinely different weights per slot, which needs more memory than this machine.
