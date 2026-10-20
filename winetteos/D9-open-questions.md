# D9 · Open questions and assumptions

- **What:** Every `ASSUMPTION` and `NOT ACTIVATABLE` item in D1 to D8, grouped by who answers it, plus the build track recommendation and what this build could not complete.
- **Decides:** Nothing by itself. Each answer replaces a default the system was built against; the build track section is a recommendation with tradeoffs, not a decision.
- **Open:** All of it. Items marked **P1** block the dogfood or the Winette pilot. The **LONG-POLE** items gate Phase 3.

**How to use this:** answer an item, then update the preference or parameter it names (D1 `WOS Preferences`, or the parameter block). No prompt changes are needed unless the answer loosens a hard rule, and loosening a hard rule always means a new prompt version (D3 §11).

## 1. Parameter board

| Parameter | Built against | Status | Answers | Blocks |
|---|---|---|---|---|
| `LEDGER_STORE` / `CONTEXT_STORE` | Both specified (D1); Notion for the dogfood | ASSUMPTION | Colin | **P1** D8 setup |
| `NEVER_READ_LIST` | Not seeded; every task fails closed until set (even to `[]`) | Must be set | Colin (dogfood), Winette (pilot), Finance (bank senders) | **P1** every run |
| `OUTLOOK_MODE` | Gmail and Google Calendar are the systems of record | unknown | Winette, IT | **P1** Winette pilot |
| `PUSH_CHANNEL` (added) | Claude iOS app notifications from scheduled runs under the principal's own account | ASSUMPTION | Winette, Colin | **P1** Winette pilot |
| `MAC_SURFACE` (added) | Claude desktop app plus the ledger store's app | ASSUMPTION | Winette | Styled fidelity (D4 §1) |
| `CHAT_PLATFORM` | none; nudges are email drafts | unknown | Colin | Nothing in Phase 1 |
| `BRIEF_TIME_LOCAL` | 07:00 America/New_York; run at 06:40 | given, confirm | Winette | Nothing |
| `BRIEF_WORD_CAP` / `EOD_WORD_CAP` | 300 / 120 | given | Winette (discovery) | Nothing |
| `WEEKLY_WORD_CAP` (added) | 400 | ASSUMPTION | Winette | Nothing |
| `QUIET_HOURS` (added) | 20:00 to 07:00, in her current local zone when traveling | ASSUMPTION | Winette | Nothing |
| `AGING_THRESHOLDS` | 3 / 5, calendar days, America/New_York | given; day type ASSUMPTION | Colin | Nothing |
| `ALERT_CAP` | 5 per day; digests excluded (INFERENCE) | given | Colin | Nothing |
| `PRINCIPAL` (added preference `principal`) | Winette; dogfood Colin Long | given | Colin | D8 setup |
| `CRM`, `SALES_TRACKERS` (added), `SALES_REPORT_LINKS` (added) | unknown | NOT ACTIVATABLE | Colin | Sales |
| `MARKETING_STACK`, `CAMPAIGN_CALENDAR` (added) | unknown | NOT ACTIVATABLE | Colin | Marketing |
| `ACCOUNTING_SYSTEM`, `BUDGET_SOURCE`, `REPORTING_CALENDAR`, `DEDUCTION_SOURCE`, `FINANCE_THRESHOLDS`, `APPROVAL_MATRIX` (last five added) | unknown | NOT ACTIVATABLE, **LONG-POLE** | Finance | Finance |
| `ERP_SYSTEM`, `INVENTORY_SOURCE` | unknown | NOT ACTIVATABLE, **LONG-POLE** | Ops | Operations, Purchasing, Demand Planning |
| `PURCHASING_SOURCE` | unknown | NOT ACTIVATABLE, **LONG-POLE** | Ops | Purchasing |
| `DEMAND_DATA` | unknown (SPINS, distributor sell-through, customer forecasts, 2027 WFM forecast model named, none confirmed) | NOT ACTIVATABLE | Ops, Colin | Demand Planning |
| `ops_sla_targets` (added preference) | `{}`; no SLA breach fires until set | ASSUMPTION | Ops | Operations SLA tracker |
| `BANKING_DATA` | none, every phase | rule | n/a | n/a |
| `TRAVEL_SOURCES` | Gmail confirmations + Google Calendar; TripIt not used | default | Winette | Nothing |

All source parameters live in the `data_sources` preference (D1), seeded `"unknown"`. A functional task refuses to run while its source reads `"unknown"`.

## 2. Colin (product owner)

### 2.1 Setup and platform

| # | Question or assumption | Built against | Where |
|---|---|---|---|
| C1 | **P1** Pick `LEDGER_STORE` for the dogfood and for production | Notion for Phases 1 and 2, Supabase before Phase 3 (recommendation) | D1, D8 |
| C2 | **P1** Set `never_read_list` for the dogfood | Unset, so every run stops | D1, D2, D5 |
| C3 | **P1** Are Claude scheduled tasks and push notifications available on the plan in use, and can a task be run on demand for the Day 0 tests? Who is the Claude Team admin for Winette's seat? | ASSUMPTION: yes | D5, D6, D8 |
| C4 | Can the Notion connector be limited to the `WinetteOS` page tree? | ASSUMPTION: yes; otherwise use a dedicated Notion workspace | D6, D7 |
| C5 | Is a restricted `wos_agent` connection to Supabase feasible (direct Postgres from a harness, or a narrow tool server), rather than a privileged MCP connection? | INFERENCE: without it Supabase loses its integrity advantage over Notion | D1, D6 |
| C6 | `wos` and `wos_test` share database roles. Before the Winette pilot, move the test schema to its own project or revoke access | Shared during dogfood | D1 |
| C7 | The Notion `nudge_candidate` formula has the principal's name and the aging thresholds typed in. Edit the TEST copy for Colin, and edit both copies if thresholds change | As built | D1 |
| C8 | `CHAT_PLATFORM`. If Slack: read-only on named channels, message-write tool off | None | D6 |
| C9 | First-run lookback when no watermark exists: 24h (Chief of Staff), 30 days of travel confirmations, 7 days (Sales, Marketing, Operations), 14 days (Finance) | ASSUMPTION | D2, D5 |
| C10 | Scan horizons: 14 days for calendar conflicts, 60 days for trips | ASSUMPTION | D2 Travel, D5 |

### 2.2 Rules and thresholds

| # | Question or assumption | Built against | Where |
|---|---|---|---|
| C11 | Aging uses calendar days | ASSUMPTION | D1, D2 |
| C12 | **Business-day definition conflicts.** Marketing and Finance exclude weekends only; Operations also excludes US federal holidays. Pick one, plus a holiday calendar | Mixed: needs one answer | D2 Marketing, Finance, Operations |
| C13 | A travel disruption within 12h of departure is exempt from the per-agent ceiling and quiet hours but not from the daily cap. Should it bypass the cap too? | Not exempt from cap; held to next digest | D2 Travel, D3 §5 |
| C14 | Alerts are evaluated every two hours on business days, so an alert can lag its trigger by up to two hours. Acceptable for Phases 1 and 2? | ASSUMPTION: yes | D3 §5.2 |
| C15 | Alert reserve: slot 5 held for score 90+ until 15:00 | ASSUMPTION | D3 §5.2 |
| C16 | Secondary metric target for the Chief of Staff: at least 90% of surfaced items not marked `notforme`. Colin clears a `notforme` suppression with a reviewed feedback row | ASSUMPTION | D2 Chief of Staff |
| C17 | Dogfood exit: precision at least 90%, recall at least 80%, on 25 samples each across the week (directional, not statistical) | ASSUMPTION | D8 |
| C18 | Dogfood extension: extend day by day; after two weeks without exit, stop, rework and restart from Day 0 | ASSUMPTION | D8 |
| C19 | Trip brief timeliness target 100%; calendar conflicts she finds first, target 0 | ASSUMPTION | D2 Travel |

### 2.3 Context store seeds

| # | Question or assumption | Built against | Where |
|---|---|---|---|
| C20 | Importance tiers. Seeded tier 1: Certified Origins, Whole Foods Market, UNFI, KeHE. Brands and Origin Brands unset. People default to tier 3. Tiers are never inferred | ASSUMPTION | D1 |
| C21 | The board's org name (an org of kind `board`, used by Finance as counterparty on reporting deadlines) | Not seeded | D1, D2 Finance |
| C22 | Routing hints: Certified Origins to `chief_of_staff` (INFERENCE), WFM to `sales`, UNFI and KeHE empty (topic decides) | As seeded | D1, D3 §3.2 |
| C23 | `preferred_channel` options: email, phone, text, chat, in_person, via_assistant | ASSUMPTION | D1 |
| C24 | Preferences are admin-only. Winette's preference changes go through the Chief of Staff, and Colin applies them. Agents never write context tables; they propose edits as ledger rows | As built | D1, D2 |

### 2.4 Sales, Marketing and Demand inputs

| # | Question or assumption | Built against | Where |
|---|---|---|---|
| C25 | Which CRM, if any | NOT ACTIVATABLE | D2 Sales, D6 |
| C26 | Drive links to the sales trackers (`SALES_TRACKERS`). Is Drive-tracker mode enough to activate Sales without a CRM? | ASSUMPTION: yes | D2 Sales |
| C27 | Links to Colin's reporting and to Quinn's and Tommaso's Sales Ops reporting (`SALES_REPORT_LINKS`). These are link-outs only, never re-summarized | Placeholders | D2 Sales |
| C28 | Retailer review prep flagged 30 days out; one-pager cap 250 words; one-pager by 16:00 prior business day, target 100% excluding late-booked meetings | ASSUMPTION | D2 Sales |
| C29 | `MARKETING_STACK` and `CAMPAIGN_CALENDAR` location. Is an inbox-and-Drive mode acceptable if the stack is "none to connect"? | NOT ACTIVATABLE | D2 Marketing, D6 |
| C30 | Launch risk is flagged when a milestone is past due, or when an approval is still pending within 14 days of launch | ASSUMPTION | D2 Marketing |
| C31 | Promo calendar location (Sales names it at activation); planned lift must come from a source | ASSUMPTION | D2 Demand Planning |
| C32 | Location and owner of the 2027 WFM forecast model; forecast owner by brand and account | Unknown | D2 Demand Planning, D6 |
| C33 | Stockout alert requested when the useful-action date is within 5 business days at a tier 1 account; stockout metric target 90% | ASSUMPTION | D2 Demand Planning |
| C34 | `demand-risk-scan` cadence (Mondays) depends on the data refresh cadence | ASSUMPTION | D2 Demand Planning, D5 |

## 3. Winette (discovery, D8 §9)

| # | Question or assumption | Built against | Where |
|---|---|---|---|
| W1 | **P1** `OUTLOOK_MODE`: Outlook as a client over Google mail, a separate Microsoft 365 mailbox, Office files only, or other | Gmail only | D6, D8 |
| W2 | **P1** `PUSH_CHANNEL` and `MAC_SURFACE`: where she wants to read the brief and alerts | Claude iOS and desktop apps under her own account | D4, D6 |
| W3 | **P1** Her `never_read_list`: labels, senders and folders no agent may open | Fails closed until set | D1, D2 |
| W4 | **P1** Consent to a two-week pilot on her Gmail, Calendar and Drive (read; drafts and holds on her tap) | Not started | D8 |
| W5 | Reply codes, tap buttons, or both | Both designed (D4) | D3 §8, D4 |
| W6 | Brief at 07:00; weekend brief only when decisions or travel exist | ASSUMPTION | D4 §3.2 |
| W7 | Word caps: brief 300, close 120, weekly 400, trip brief 250 | Brief and close given; others ASSUMPTION | D4 |
| W8 | Quiet hours 20:00 to 07:00, applied in her current local zone when traveling | ASSUMPTION | D2, D3 |
| W9 | Her tier 1 people (board, Certified Origins leadership, key buyers) | None seeded | D1 |
| W10 | Delegates: does anyone else (an assistant, a chief of staff) see her drafts or manage her calendar? | Nobody | D2, D8 |
| W11 | Who books her travel? Confirmations sent to an assistant's or agency's mailbox are invisible | Her own mailbox | D2 Travel |
| W12 | Where reminders live (Google Calendar private events, Google Tasks, Apple Reminders) and where she edits to-dos | Private, attendee-free Calendar entries; to-dos as a ledger view. ASSUMPTION: Apple Reminders is unreachable from a cloud task | D2 Travel, D6 |
| W13 | `travel_preferences`: ground transport, red-eyes, early holds, seat and airline programs (no account logins, ever) | None set | D2 Travel |
| W14 | Conflict thresholds: transition under 30 minutes, meeting within 90 minutes of landing, connection under 60 minutes domestic or 90 international, meetings outside 07:00 to 21:00 local | ASSUMPTION | D2 Travel |
| W15 | Trip brief by 72h before departure, refreshed the evening before | ASSUMPTION | D2 Travel, D4 §7 |
| W16 | Retention for ledger and audit rows | Kept for the life of the system until a schedule is set | D7 |
| W17 | Agencies to add to `WOS Orgs` (Marketing) | None seeded | D2 Marketing |
| W18 | Text or Styled fidelity; whether a daily brief page is wanted; theme by hour or by device setting; brand fonts if Origin Brands has them | Text in Phase 1 | D4 §1, §8 |

## 4. Finance

| # | Question or assumption | Built against | Where |
|---|---|---|---|
| F1 | **LONG-POLE** `ACCOUNTING_SYSTEM`, its access method, and who approves and owns a read-only credential | NOT ACTIVATABLE | D2 Finance, D6, D7 |
| F2 | **P1** Bank and payment-processor sender domains for the never-read list. None are invented | Not set | D2 Finance, D7 |
| F3 | `BUDGET_SOURCE`: where budget vs actual lives | ASSUMPTION: a budget file in Drive or the accounting system | D2 Finance |
| F4 | `REPORTING_CALENDAR`: board and Certified Origins reporting deadlines. Can a deadline-only mode of `finance-reporting-deadlines` run from it before the accounting connector exists? | ASSUMPTION: yes, Finance confirms | D2 Finance, D5 |
| F5 | `DEDUCTION_SOURCE`: where UNFI and KeHE deduction details and dispute windows come from | Unknown; no portal names guessed | D2 Finance |
| F6 | `FINANCE_THRESHOLDS`: margin, cash and variance thresholds | Unset, so no threshold exceptions are raised | D2 Finance |
| F7 | `APPROVAL_MATRIX` and the CEO spend approval threshold, which drives `winette_action_needed` on reorder proposals | Unset; spend conflicts only against stated budget or cash facts | D2 Finance, Purchasing |
| F8 | While Finance is inactive, spend decisions carry "Finance view pending" | As built | D2 Purchasing |

## 5. Operations

| # | Question or assumption | Built against | Where |
|---|---|---|---|
| O1 | **LONG-POLE** `ERP_SYSTEM` and `INVENTORY_SOURCE`, their owners and access path. INFERENCE: the ERP holds financial data, so Finance co-approves | NOT ACTIVATABLE | D2 Ops, Purchasing, Demand, D6, D7 |
| O2 | How UNFI and KeHE fill, shorts and delivery data arrives (portal export, EDI, email reports) | ASSUMPTION: exports land in a Drive folder Ops names | D2 Ops, D6 |
| O3 | Where the compliance and certification register lives | ASSUMPTION: a Drive document or sheet Ops names | D2 Ops |
| O4 | `ops_sla_targets` values; transit lane table for feasibility checks | Placeholders; no breach fires | D2 Ops |
| O5 | Compliance window: row opens 60 days before a deadline; alert requested at 14 days with no next step | ASSUMPTION | D2 Ops |
| O6 | Owners by role in `WOS People`: Ops lead, customer service lead, buyer of record, forecast owner | Placeholders; unowned rows escalate | D2 Ops, Purchasing, Demand |
| O7 | **LONG-POLE** `PURCHASING_SOURCE`: PO system, vendor list, lead times, MOQs, unit costs | NOT ACTIVATABLE | D2 Purchasing, D6 |
| O8 | Late-PO pre-flag 3 business days before the promised date; reorder review period; the Purchasing vs Demand variance threshold that triggers one shared decision | ASSUMPTION and placeholders | D2 Purchasing |
| O9 | Location of supplier agreements and price lists | ASSUMPTION: a Drive folder Ops or Finance names | D2 Purchasing |
| O10 | `DEMAND_DATA`: for each of SPINS, distributor sell-through, customer forecasts and the 2027 WFM forecast model, the access method, location, format and refresh cadence | NOT ACTIVATABLE | D2 Demand, D6 |
| O11 | Demand thresholds: `forecast_variance` above 20% absolute over 4 complete weeks (ASSUMPTION); review period, overstock weeks, shelf-life window, lift, seasonality and forecast-change thresholds; the stockout definition | Placeholders | D2 Demand |

## 6. IT (Google Workspace admin, Claude Team admin, Microsoft 365 admin if any)

| # | Question or assumption | Built against | Where |
|---|---|---|---|
| I1 | **P1** Who is the Google Workspace admin, and is the tenant owned by Origin Brands or Certified Origins? INFERENCE: the owner signs off on CEO inbox, calendar and Drive access | Unknown | D6, D7 |
| I2 | **P1, LONG-POLE** Admin approval for connector access to Winette's Gmail, Calendar and Drive (plus her consent). The dogfood uses Colin's accounts only | Not requested | D6, D7 |
| I3 | **P1** Does the platform allow per-tool connector control (turn off Gmail send, Drive write and share, Calendar move and delete)? If not, the residual risk is recorded in D7 §8 | ASSUMPTION: yes | D6, D7, D8 |
| I4 | Scopes the Gmail, Calendar and Drive connectors actually request, checked at the consent screen and in the Admin console | Minimal set assumed: `gmail.readonly`, `gmail.compose`, `calendar.readonly`, `calendar.events`, `drive.readonly`. `gmail.compose` technically permits send | D6, D7 |
| I5 | Workspace edition: are OAuth token and Drive audit logs available in the Admin console? | ASSUMPTION: edition-dependent | D7 |
| I6 | If `OUTLOOK_MODE` is a separate Microsoft 365 mailbox: Graph scopes `Mail.Read`, `Calendars.Read`, approval by the M365 admin, and the Entra revocation path | ASSUMPTION on menu labels | D6, D7 |
| I7 | Can the Drive connector read `.xlsx` and `.docx` stored in Drive? Sales Ops reports and the WFM forecast model may be Excel | ASSUMPTION: yes | D2, D6 |
| I8 | Follow-up drafts sit in the principal's Gmail. Drafting into an Ops lead's or buyer's mailbox needs its own approved connector | Principal's mailbox only | D2 Ops, Purchasing |
| I9 | Notion: page history retention and workspace audit log by plan. Rich text limit of 2,000 characters per text object, so audit rows hold changed fields only. Unknown select options can be auto-created, so enum discipline rests on prompts | ASSUMPTION; verify before Phase 2 | D1 |
| I10 | A privileged Supabase connector (project-owner rights) bypasses grants and row-level security and could disable triggers | Restricted `wos_agent` connection recommended | D1, D6 |
| I11 | Phase 3 `source_link` values deep-link to source records; where a system has no deep links, the link points to the export file and row | ASSUMPTION | D2 Phase 3 charters |

## 7. Build track recommendation

**Question (build prompt §6):** does an eight-agent roster with cross-agent routing need an orchestrated harness, and what changes if so?

**Recommendation:** stay on the agreed track (Claude Team Project, connectors, external ledger) for Phase 1 and very likely Phase 2. Before the first Phase 3 agent touches accounting, ERP or purchasing data, move orchestration to a company-hosted Agent SDK harness. Keep the D1 ledger as the contract and keep Winette's surface unchanged. Revisit at the Phase 2 gate with dogfood and pilot evidence. This is a recommendation, not a decision.

### 7.1 Why the line falls at Phase 3

- **Hard rules as code, not prompts.** In a Project, "never send" holds through the prompt, per-tool connector control (if it exists, I3) and audit. In a harness, the send tool does not exist, calendar writes need a signed tap token, and a pre-tool hook denies anything outside the agent's allowlist. The build prompt asks for hard rules, not flags; for money-adjacent systems only code fully meets that.
- **Real routing.** Phase 1 "routing" is one model applying two charters (D3 §11). Eight charters with conflict rules, and a dispatcher that classifies her ask and calls the owning agent with only that agent's tools, is orchestration work.
- **Latency.** Alerts lag up to two hours on a two-hour capture cadence (D3 §5.2, C14). A harness can evaluate on change.
- **Audit integrity.** The harness can hold the restricted `wos_agent` credential (I10), so database grants and triggers bind every write.
- **System-owner approvals.** Finance and Ops will approve a scoped, company-owned service credential faster than a personal connector in someone's chat app. INFERENCE from typical finance-system governance.

### 7.2 Tracks compared

| | A. Claude Team Project + connectors (agreed) | A+. Project + Skills per agent | B. Agent SDK harness, company-hosted | C. Claude Code cloud routines | D. Colin's OpenClaw stack |
|---|---|---|---|---|---|
| Hard-rule enforcement | Prompt, tool settings if available, audit | Same as A | Code: tool allowlists, hooks, tap tokens | Hooks and tool permissions per routine | Code, as Colin builds it |
| Cross-agent routing | One model, charters as knowledge | Skills loaded per ask; still one model and one tool set | Dispatcher plus subagents with separate tools | Per-routine; weak as her chat surface | As built |
| Alert latency | Up to 2h | Up to 2h | On change | Per schedule | As built |
| Her surface | Claude iOS and desktop | Same | Claude app via connector, or a WinetteOS surface (Styled fidelity becomes easy) | Not a chat surface | Colin's surface |
| Setup time | Days | Days | Weeks | Days | Fastest for Colin |
| Who maintains | Colin | Colin | An owner with engineering time; on-call for failures | Colin | Colin alone |
| Data custody | Anthropic connectors under her account | Same | Company cloud, company credentials | Anthropic cloud sessions | Wherever Colin runs it. INFERENCE: CEO data on infrastructure one person controls is a governance and key-person risk |
| Best fit | Phase 1 and 2 | Phase 2 if charters strain one prompt | Phase 3 | Scheduled jobs only | Prototyping, not production |

### 7.3 What changes if the harness is adopted

| Deliverable | Change |
|---|---|
| D1 | None to the contract. Agents connect as `wos_agent`; Supabase becomes the clear choice |
| D2 | Charters become subagent system prompts, each paired with a tool allowlist. Hard-rule text stays as defense in depth |
| D3 | Routing, scoring, dedupe and the alert budget move from prompt to code with the same rules; alerts evaluate on change |
| D4 | Unchanged formats. Styled fidelity becomes practical |
| D5 | Scheduled tasks become harness jobs with the same names, crons and prompts |
| D6, D7 | Per-user connectors give way to company-owned credentials per system. Revocation becomes credential rotation plus disabling the job. CEO mailbox access needs IT's review of the harness's credential custody. INFERENCE: prefer per-user OAuth held by the harness over domain-wide delegation |
| D8 | A one-week shadow run of the harness against the live ledger before cutover, with the same exit criteria |

## 8. NOT ACTIVATABLE register

| Agent | Phase | Missing | Activates when | Tasks held inactive |
|---|---|---|---|---|
| Sales | 2 | `CRM` (or `SALES_TRACKERS` in Drive-tracker mode), `SALES_REPORT_LINKS` | Phase 1 exit (D8) and Colin confirms sources in `data_sources` | `sales-exceptions`, `sales-meeting-prep` |
| Marketing | 2 | `MARKETING_STACK`, `CAMPAIGN_CALENDAR` | Phase 1 exit and Colin confirms sources | `marketing-approvals` |
| Finance | 3 | `ACCOUNTING_SYSTEM` (LONG-POLE), `BUDGET_SOURCE`, `REPORTING_CALENDAR`, `DEDUCTION_SOURCE`, `FINANCE_THRESHOLDS`, `APPROVAL_MATRIX` | Finance confirms source and approves connector access | `finance-exceptions`, `finance-reporting-deadlines` |
| Operations | 3 | `ERP_SYSTEM`, `INVENTORY_SOURCE` (LONG-POLE), distributor data path, compliance register, `ops_sla_targets` | Ops confirms sources and approves access | `ops-exceptions` |
| Purchasing | 3 | `PURCHASING_SOURCE`, `INVENTORY_SOURCE` (LONG-POLE) | Ops confirms sources and approves access; Demand Planning active | `purchasing-po-watch` |
| Demand Planning | 3 | `DEMAND_DATA`, `INVENTORY_SOURCE` | Ops and Colin confirm each source and its refresh cadence | `demand-risk-scan` |

On activation, Colin runs the one-time reassignment in D3 §3.3. The new agent's first run treats rows with `routed_to` set to its ID as its backlog.

## 9. What this build could not complete, and why

1. **Nothing was connected or run against live accounts.** No connector was attached to Colin's or Winette's Gmail, Calendar, Drive, Notion or Supabase. Doing so needs their consent and, for Winette, IT approval (I1, I2). D8 is the procedure.
2. **Scheduled tasks are defined, not created.** D5 holds every name, cron and prompt. Creating them needs Colin's account, the connectors, and `never_read_list` set (C2, C3).
3. **Notion build not validated live.** The Supabase migration ran end to end on a local PostgreSQL 16 (both `wos` and `wos_test`, agent-role rejections, audit trigger, views). The Notion formulas and views are specified but untested in a workspace, and Supabase-only roles (`anon`, `authenticated`) were not exercised.
4. **Push rendering not verified on a device.** The canvas and `D4-render.html` are mockups. How much of the push format survives depends on `PUSH_CHANNEL` (W2).
5. **Platform behaviors are unverified and labeled.** Per-tool connector control, the exact connector scopes, Workspace audit log availability and Notion plan limits are all labeled ASSUMPTION (I3 to I5, I9).
6. **Phase 2 and 3 agents are charter-complete but NOT ACTIVATABLE.** No data source is confirmed (§8). No vendor names were guessed.
7. **Styled fidelity has no rendering surface yet.** It is designed (D4 §8), but Phase 1 ships Text fidelity (W18).
