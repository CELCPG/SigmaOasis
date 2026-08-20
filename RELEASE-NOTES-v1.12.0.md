# Sigma Oasis v1.12.0 — market analysis, honestly

This release started with three exported finance chats read end to end. They showed a model
answering market questions from memory, presenting its own invented constants as computed, a
router that never once reached the specialist roles, and a New Project button that did nothing.
Everything below traces back to one of those findings. Pinned by 1,500 node checks.

## Market data, charts included (opt-in)

A new **`market_data`** tool fetches daily OHLCV history for stocks, ETFs, indices, **futures**
(`ES=F`, `GC=F`) and crypto pairs, computes the summary stats **in the app** — period return,
range high/low, max drawdown, annualized realized volatility, every number derived from the
fetched bars — and stages the full series at `/work/<SYMBOL>.csv`, where `run_python` computes
indicators (SMA/EMA, RSI, beta vs. an index) and charts them with matplotlib straight into the
chat. Ask for six months of NVDA with a 20-day moving average and you get a real chart drawn by
your own local model from real data.

The provider was chosen by probing, not preference. The plan said a keyless CSV host; testing
found a JavaScript proof-of-work wall in front of it, and defeating bot-detection is something
this app does not do. Yahoo's public chart endpoint answers plain requests, serves futures and
indices natively, and errors cleanly on junk symbols. It is unofficial and may change — when it
does, the tool degrades to a clear error, never to a guessed number.

Privacy, stated plainly: each lookup sends the ticker to one pinned host
(`query1.finance.yahoo.com`) on its own egress purpose, every request appears in the network
activity log, and the toggle **ships off** — a ticker lookup discloses what you are researching,
and the Settings description says so.

**Measured** (docs/evals.md): two synthetic tickers, expected values recomputed independently
from the same series. With the tool: **6/6 figures reproduce, 2/2 chart requests produced a real
PNG**. Without it: 0/6 — and the model stated confident prices for tickers it cannot know on
**3 of 6** questions. That fabrication rate is why the tool exists.

## The app stops certifying invented numbers

- **The sandbox banner endorsed fabrication.** A model asked for volatile stocks wrote
  `nvda_range = (10, 20)`, printed it, and the app appended "Numbers above were computed, not
  recalled." A run whose every printed number is a literal in its own code now gets a caution
  naming what happened instead — and the grounding checker arms against such runs while refusing
  them as support, so the constants come back flagged, not certified.
- **Tools that disagree now say so.** Two numeric tools stating different values for the same
  labelled figure in one turn ("period return: 14.61%" from market_data, "-8.99%" from the
  model's own python — measured live) produce a ⚖️ check line naming both sides. Disclosed,
  never adjudicated.
- **Correct answers stop being flagged.** Figures standing verbatim in search results or fetched
  pages were being reported as unsupported; presence in source-tool output now counts (presence
  only — a page full of numbers cannot certify arbitrary arithmetic).

## Routing that actually reaches your specialists

Only the Data Analyst template ever carried a routing `specialty` — research, coding and finance
turns structurally could not route, which is why every reply in the reviewed sessions came from
the general slot. The templates now declare their specialties and existing installs are
backfilled by role name. The classifier also gained an explicit research signal ("research …",
"deep dive", "what's the latest", "current status of" — the user naming the *method* beats topic
vocabulary) and a finance vocabulary that knows investing, stocks, 401(k)s and futures, not just
mortgages. Verified live: "research the current state of the housing market" → Researcher,
"$400 to invest every two weeks" → Finance Coach, each with a visible 🔀 routing note.

## Investing foundations — a reference pack the SEC wrote

A curated pack from **Investor.gov** (public domain): stocks, bonds, mutual funds and index
funds; risk, diversification, asset allocation, rebalancing, dollar-cost averaging, expense
ratios, Treasuries; and the shapes investment fraud takes. Fetched from the source by the pack
builder — **never written by a model**, because a reference pack authored from model memory
would be the exact failure this app exists to prevent. One-click install under Settings →
Library. Money questions can now actually reach the library: the finance domain previously knew
taxes and mortgages but no investing vocabulary, so "what are safe investments right now"
consulted nothing at all.

Alongside it, a **money-scenario playbook**: state the parameters and check them against the
question ($400 every two weeks is 26 periods a year, not 24 — verbatim the arithmetic that went
wrong in a reviewed session), compute with tools, compare scenarios that differ in one
parameter, chart the comparison, and say what would flip the conclusion.

## Also

- **The New Project buttons work.** They called `window.prompt()`, which Electron rejects with a
  thrown "prompt() is and will not be supported" — so they died silently. They now create the
  project and open its editor with the name selected.
- **The streaming reasoning splitter is provably lossless**: a boundary-exhaustive property test
  parses nine transcript shapes at every chunk-cut position. The sweep found and fixed one real
  boundary bug (a newline leaking into reasoning when a cut landed inside a Gemma channel tag).
- The pack builder no longer fails legitimately short pages: stability across polls is the
  render signal now, not an arbitrary character floor — nine Investor.gov pages had been dying
  after 45 seconds despite rendering instantly and completely.
- A phantom `![chart](/work/chart.png)` in a reply can no longer render as a broken image; real
  charts arrive through the tool-result gallery.
- The market eval's first pass failed a correct answer (drawdown stated as −34.77% against an
  expected +34.77); drawdowns are scored sign-agnostically now. An eval that fails right answers
  teaches people to dismiss it.

## Caveats, which are real

- Market answer-quality numbers are one model class (qwen3.8-9b) and one embedding model; the
  fixture series stand in for the provider up to the parser.
- The `market_data` endpoint is unofficial; treat outages as expected weather.
- Historical prices are not forecasts, and the tool output says so on every reply.

## Upgrade notes

Auto-update from v1.11.x. `market_data` ships **off** — enable it under Settings → Tools; the
investing pack installs from Settings → Library. Template roles that kept their original names
(Researcher, Coder, Finance Coach, Data Analyst) gain routing specialties automatically; renamed
roles are untouched. No other settings changed meaning.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.11.1...v1.12.0
