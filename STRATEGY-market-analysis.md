# Strategy: market analysis, charting, and financial education

Requested 2026-08-19, alongside three exported finance sessions that show where today's app
stands: the models answer market questions from memory, the volatility "numbers" they cite are
their own constants, and nothing ever gets drawn. This is the plan for doing it honestly.

## What already exists (and was underused)

- **Charting is plumbed end to end.** `run_python` has matplotlib; a PNG saved under `/work` is
  shown to the user in the reply's gallery, and the tool description says so. In the reviewed
  sessions the model never once used it. The finance playbook now instructs it to chart scenario
  comparisons and growth curves, and to plot only values computed this turn.
- **The compute side is real.** numpy + pandas in the sandbox is enough for returns, drawdowns,
  moving averages, RSI/ATR, correlation and beta — *given data*.
- **Honesty rails are in place** and are prerequisites, not afterthoughts: the hardcoded-numbers
  guard (v1.11.2) stops the sandbox from certifying invented figures, and the grounding ladder
  flags numbers no tool produced. Any market feature builds on top of these.

## The gap is data, and data is a privacy decision

Every serious analysis feature needs price series, and this is a local-first app with an audited
egress allowlist. In order of preference:

1. **User-supplied CSVs** (works today). Broker and portfolio exports drop into a chat, the Data
   Analyst profiles them, `run_python` computes and charts. Zero new egress. The education packs
   should teach the export path per major broker.
2. **A `market_data` tool** (shipped, v1.12). Daily OHLCV from Yahoo Finance's public chart
   endpoint (`query1.finance.yahoo.com`), one pinned host on its own egress purpose, every request
   in the activity log, toggle ships OFF. Provider chosen by probing, not preference: the original
   plan was Stooq's keyless CSV, and testing found a JavaScript proof-of-work wall in front of it —
   solving that is bot-detection circumvention, which this app does not do. Yahoo answers plain
   requests, serves futures and indices natively, and errors cleanly on junk symbols; it is
   unofficial and may change, and the tool degrades to a clear error when it does. The app computes
   the summary stats itself (period return, high/low, max drawdown, realized volatility) and stages
   the full series at `/work/<SYMBOL>.csv` for run_python; the as-of date rides every output.
3. **Futures** turn out to be native, not proxied: `ES=F`, `GC=F` and friends come from the same
   endpoint as equities (verified live). Continuous-contract caveats still apply and belong in the
   education pack, not in silence.

## Phases

- **Phase 1 (shipped, v1.11.2):** playbook charting nudge; hardcoded-numbers guard; routing that
  actually reaches the Researcher and Finance slots.
- **Phase 2 (shipped, v1.12):** the `market_data` tool, wired into the honesty rails — a fetched
  series counts as a consulted source, its computed stats support the reply's figures, a
  `yfinance` import error points at the tool, and a phantom `![chart](/work/…)` image reference
  can no longer render as a broken icon. Its first live run caught all four of those gaps.
  The indicator eval exists (`EVAL_SUITES=market`): fixture series in the provider's payload
  shape, expected values recomputed independently in TypeScript, a tool arm vs a no-tools arm
  whose honest answer is refusal. Results in docs/evals.md. Still owed: indicator recipes in the
  playbook beyond the chart nudge.
- **Phase 3 (shipped, v1.12):** education. A curated **"Investing foundations"** pack — 14
  documents, ~43k characters, fetched from Investor.gov (SEC, public domain) by the existing
  build script: what stocks, bonds, mutual funds and index funds are; risk, diversification,
  asset allocation, rebalancing, dollar-cost averaging, expense ratios, Treasuries; and the
  shapes investment fraud takes. Authored by the SEC, not by a model — a reference pack written
  from model memory would be the exact failure this app exists to prevent.

  Two things had to change for the pack to be *reachable*. The finance reference domain knew
  mortgages and taxes but no investing vocabulary, so "what are safe investments right now"
  never triggered a library lookup at all; it does now. And a **money-scenario playbook** —
  state the parameters and check them against the question (an "$400 every two weeks" plan is 26
  periods a year, not 24, and not $800 a month), compute with tools, compare two scenarios
  differing in ONE parameter, chart it, say what would flip the conclusion — which is the
  scenario workbench, expressed as a method rather than a new tool, because run_python already
  computes and charts.

  Nine candidate glossary pages were dropped rather than shipped as ~270-character stubs; the
  companion IRS pack carries retirement-account limits. Retirement-account *concepts* (401(k),
  Roth) remain a gap on the SEC side — noted, not papered over.
- **Non-goals, permanent:** price predictions, buy/sell recommendations, and any figure the turn's
  tools did not produce. The app's job is to compute, chart, cite, and say what it could not get.
