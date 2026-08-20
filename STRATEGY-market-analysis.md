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
2. **A `market_data` tool** (the real feature). Daily OHLCV for tickers from a keyless public
   endpoint (Stooq-style CSV), fetched by the app through the existing allowlist + network log,
   cached in RAM like fetched pages, and handed to the sandbox at `/work/<ticker>.csv`. No API
   keys by default; a configurable provider for people who have one (FRED for macro series).
   Every chart footer names the provider and the as-of date — a chart with an unstated date is a
   fabrication with axes.
3. **Futures, honestly labelled.** Without a paid feed there are no clean continuous contracts.
   Phase one covers what keyless public data can: index and commodity ETF proxies, with the proxy
   relationship stated in the reply rather than papered over. Real futures chains wait for a
   user-keyed provider.

## Phases

- **Phase 1 (shipped, v1.11.2):** playbook charting nudge; hardcoded-numbers guard; routing that
  actually reaches the Researcher and Finance slots.
- **Phase 2:** `market_data` tool + indicator recipes in the finance playbook (SMA/EMA crossover,
  RSI, drawdown, beta vs. a benchmark — computed in the sandbox, charted, never recalled).
  Measured like everything else: an eval where every stated indicator value must reproduce from
  the fetched series.
- **Phase 3:** education — a curated "Investing foundations" library pack (the pack mechanism
  exists), so definitions and rules come from citable passages instead of model memory; plus a
  scenario workbench: contribution plans, ladders, allocation comparisons as parameterized
  computations with charts.
- **Non-goals, permanent:** price predictions, buy/sell recommendations, and any figure the turn's
  tools did not produce. The app's job is to compute, chart, cite, and say what it could not get.
