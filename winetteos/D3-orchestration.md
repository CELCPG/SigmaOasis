# D3 · Chief of Staff orchestration rules

- **What:** How eight agents behave as one assistant: ask classification, ownership, conflict precedence, the five-alert budget, dedupe, and the one-voice style guide.
- **Decides:** The ledger is the only channel between agents; the Chief of Staff alone decides what reaches Winette, when, and in what words.
- **Open:** `PUSH_CHANNEL`, `QUIET_HOURS` and the alert reserve rule are ASSUMPTION defaults (see D9); routing for Phases 2 and 3 depends on the build track recommendation in D9 §7.

## 1. The operating model

```
 Gmail · Calendar · Drive · (Phase 2/3 sources)
        │ read only (T1)
        ▼
 Functional agents ──write rows──▶  LEDGER  ◀──reads/writes── Chief of Staff ──▶ Winette
 (Travel, Sales, ...)              CONTEXT                    (one voice)        push · Mac
        ▲                          AUDIT                            │
        └────────── read rows ◀────────────────────────────────────┘
```

- **Blackboard, not conversation.** Agents never call each other. A functional agent writes ledger rows (the handoff contract, D1); the Chief of Staff reads them, scores them, and decides what surfaces. Every agent reads the same context store, so nothing is asked twice.
- **One exit.** Only `chief_of_staff` tasks address Winette. The single exception is `travel-watch` for travel disruptions inside 12 hours of departure (§5). Functional agents set `alert_requested`; they never push.
- **Invisible handoffs.** Agent names never appear in anything she reads. Internally, every row carries `owning_agent`, and every write carries an audit row.

## 2. Ask classification (live conversation)

Every message from Winette is classified before anything else happens. If a message contains several asks, each is classified and handled separately; the reply answers them in the order she asked.

| Class | Signal (generic examples) | Handling | Owning agent | Tier |
|---|---|---|---|---|
| **Capture** | "I told [Person] I'd send the deck Friday." "Remind me to call [Person]." | Write a ledger row with `source_type: dictation` and the conversation link. Reminders become a one-tap reminder proposal. | `chief_of_staff`; reminders and to-dos to `travel_personal` | T1 row; T2 reminder |
| **Query** | "What's open with [Account]?" "What do I owe [Person]?" | Answer from the ledger and context store only, each line with its source link. If the answer needs a source that is not connected, say which and stop. | `chief_of_staff` | T1 |
| **Draft** | "Reply to [Person], yes to Tuesday." | Create a draft in her mailbox, return the link. Never send. | Domain owner per §3; `chief_of_staff` while that agent is inactive | T2 |
| **Schedule** | "Find 30 minutes with [Person] next week." | Hold proposal with up to three options; created only on her tap. | `travel_personal` | T2 |
| **Decide or close** | "D2 yes." "U1 done." "Drop the [Topic] item." | Apply the reply verb (§8). `drop` is hers to give; agents never drop. | `chief_of_staff` | T1 ledger write on her instruction |
| **Domain question** | "Are we short on [SKU] at [Distributor]?" | Route to the domain owner (§3). If the owner is inactive or its source is NOT ACTIVATABLE, say so in one line and offer to log it. Never estimate. | Domain owner | T1 |

Rules that apply to every class:
- **Spine first.** Before asking Winette anything, check the ledger, context store and recent agent output. Ask only when the answer is not in the spine and the work is blocked without it. One question per exchange.
- **No silent scope creep.** If an ask implies an action outside the hard rules (send, pay, accept, edit a file), reply with what was prepared instead: "Drafted. Open to send."
- **Live answers obey the digest rules.** Nothing informational, source link on every factual line, inferences tagged "Inferred".

## 3. Ownership: who owns which item

### 3.1 By domain

| Domain | Owning agent | Typical `type` |
|---|---|---|
| Calendar, reminders, to-dos, travel, personal commitments | `travel_personal` | task, commitment, exception |
| Retailer and buyer commercial (Whole Foods Market), pipeline, buyer meetings, retailer reviews, distributor commercial issues (promos, listings) | `sales` | commitment, exception, decision |
| Campaigns, agency and content deadlines, launch readiness, brand approvals | `marketing` | approval, exception |
| Cash, margin, spend approvals, budget vs actual, board and Certified Origins reporting deadlines, deduction disputes | `finance` | approval, exception, decision |
| Order to delivery, distributor logistics (UNFI, KeHE fill, shorts, delivery), compliance and certification deadlines | `operations` | exception, commitment |
| Open POs, supplier commitments, lead times, MOQs, reorder points | `purchasing` | decision, exception |
| Forecast vs actual, stockout and overstock risk, promo lift, seasonality | `demand_planning` | exception, decision |
| Board, people, cross-functional, unclassified | `chief_of_staff` | any |

### 3.2 Classification order

1. **Counterparty org kind** from `WOS Orgs.routing_hint` (retailer → `sales`, agency → `marketing`, vendor → `purchasing`, parent → `chief_of_staff` unless the topic is reporting, then `finance`).
2. **Topic** overrides org kind when explicit: a logistics problem from a retailer goes to `operations`; a deduction dispute from a distributor goes to `finance`.
3. **Cross-functional items** (two or more domains with no clear lead) go to `chief_of_staff`, with the other agents named in `notes`.
4. **Unclassifiable** goes to `chief_of_staff`. It is never dropped for being hard to route.

### 3.3 Inactive agents

While an agent is inactive (Phase 1: everything except `chief_of_staff` and `travel_personal`), items in its domain are written with `owning_agent: chief_of_staff` and `routed_to: <inactive agent id>`. On activation, Colin runs a one-time reassignment (`owning_agent = routed_to`, `routed_to = null`) and the new agent's first run treats those rows as its backlog. No item waits on an agent that is not running.

## 4. Conflict resolution

### 4.1 Precedence ladder

1. **Hard rules** (D2, every charter) beat everything, including Winette's own instruction in chat. "Send it" is answered with "Drafted. Open to send."
2. **Chief of Staff on her attention.** What surfaces, when, in what order and at what length is decided only by `chief_of_staff`. No agent can force an alert.
3. **Finance on spend.** Finance overrides Purchasing and Marketing on any item that commits money. A spend proposal Finance has flagged surfaces with Finance's view attached, never without it.
4. **Domain owners on their numbers.** Demand Planning owns forecast numbers. Purchasing owns order proposals built on them. Operations owns feasibility of any ship or delivery promise.
5. **Travel & Personal on her calendar.** Every calendar proposal goes through `travel_personal`; other agents request holds by writing a `task` row with `routed_to: travel_personal`.

### 4.2 Specific conflicts

| Conflict | Resolution |
|---|---|
| Purchasing proposes a reorder; Demand Planning's forecast says the quantity is wrong | One decision item, not two. Both views side by side, Finance's spend view attached. Winette decides; nobody pre-decides for her. |
| Sales wants to commit a ship date to [Account]; Operations has flagged it infeasible | Sales may not log the commitment without the infeasibility flag in `notes`. If it reaches her, it reaches her as a decision with both positions. |
| Marketing launch needs spend Finance has not cleared | Surfaces as one approval with Finance's position first. |
| Two agents write the same real-world item | Dedupe key wins (§6). The domain owner per §3 keeps the row; the other appends evidence to `notes`. |
| Two hold proposals collide on her calendar | `travel_personal` resolves by the priority score of the items behind them; the loser is re-proposed with new options. |
| An agent and Winette disagree (she says done; the evidence says not done) | Her word stands. Status set per her reply; the contrary evidence goes to `notes`. |

### 4.3 Tie-break

When two items compete for the same slot (an alert, the last lines under the word cap), the higher score wins (§5.1). On a tied score: earlier due date, then higher counterparty importance tier, then older `created_at`.

## 5. The alert budget

### 5.1 Score and priority

Computed by `chief_of_staff` on every run, written to `priority`.

| Component | Points |
|---|---|
| `winette_action_needed` is true | +40 |
| Due within 24 hours or overdue | +30 |
| Otherwise due within 72 hours | +15 |
| Counterparty importance tier 1 / tier 2 | +20 / +10 |
| Type is decision or approval | +10 |
| Labels include INFERENCE | minus 20 |

Clamp 0 to 100. `p1` is 70 and above, `p2` is 40 to 69, `p3` is below 40.

### 5.2 Allocation of `ALERT_CAP` (5 per local day, all agents combined)

INFERENCE: the cap governs interrupts. The morning brief, EOD close, weekly review and trip briefs are scheduled digests and do not count against it.

1. **Eligibility.** A row is eligible when it is `p1`, has not been surfaced in its current state, and either has `alert_requested: true` or has just crossed a threshold (due within 24 hours with no `next_step`, or a new exception).
2. **Quiet hours.** No alerts 20:00 to 07:00 America/New_York (ASSUMPTION). Exception: travel disruption within 12 hours of departure.
3. **Slots 1 to 4** are pooled and go to eligible rows by score.
4. **Slot 5 is the reserve.** Before 15:00 local it is released only for a score of 90 or more. From 15:00 it joins the pool.
5. **Per-agent ceiling.** No originating agent gets more than 2 alerts per day. Travel disruptions within 12 hours of departure are exempt from the ceiling, never from the cap.
6. **Overflow.** Anything eligible but held goes into the next digest tagged "Held", ahead of new items in its section.
7. **Counting.** The cap is the count of `surface_alert` audit rows for the local date. Never estimated, never reset mid-day.

ASSUMPTION: alerts are evaluated at each `ledger-capture` run (every two hours on business days) and at `travel-watch`, so an alert can lag its trigger by up to two hours. Faster evaluation needs the orchestrated harness discussed in D9 §7.

### 5.3 Worked example (placeholder data)

| Time | Candidate | Score | Outcome |
|---|---|---|---|
| 08:05 | Travel: [Flight] to [City] cancelled, departs in 9h | 85 | Alert A1 (travel, exempt from ceiling) |
| 10:05 | Decision for [Board member 1], due today | 90 | Alert A2 |
| 12:05 | Commitment to [WFM category buyer], due tomorrow, no next step | 75 | Alert A3 |
| 12:05 | Exception from [Distributor] thread, due today | 80 | Alert A4 (pool now full) |
| 14:05 | Approval for [Person], due today | 80 | Held: only the reserve remains and 80 is below 90 before 15:00 |
| 16:05 | Same approval, still open | 80 | Reserve has joined the pool: Alert A5 |
| 18:05 | New decision, score 85 | 85 | Held: cap reached. The EOD close already ran at 17:40, so it leads tomorrow's brief, tagged "Held" |

## 6. Dedupe: she never sees the same thing twice

### 6.1 One row per real-world item

- **Key:** `{{source_type}}:{{source thread or event id}}:{{type}}:{{normalized counterparty}}`.
- Before any insert, the writing agent looks up the key among open rows. A match means update, never insert. A second agent with the same item appends its evidence to `notes` and leaves ownership alone.
- Two threads about the same commitment (a reply chain forked, a forwarded copy) are merged by `chief_of_staff` when the item text, counterparty and due date all match; the merged row keeps both source links in `notes`. A near match with any difference stays as two rows. No guessing.

### 6.2 One surfacing per state

- A surfacing writes an audit row (`surface_alert` or `surface_brief`) whose `after` holds a state fingerprint: status, due date, owner, next step, and the latest evidence link.
- An item surfaces again only if the fingerprint changed or it crossed a threshold (due within 24 hours, escalation at 5 days). When it resurfaces, the line leads with what changed: "Moved to Thu.", "Now overdue.", "[Person] replied."
- **Across surfaces:** an item alerted today does not reappear in tonight's EOD close or tomorrow's brief unless its state changed.
- **Carryover decisions** collapse into one line in the morning brief: "Still waiting on you: 3, oldest 4d · reply "D more"". She sees her queue size every day and each item in full only once per state.

## 7. Asking Winette

- No agent asks her for anything the ledger, context store, calendar or a connected source already answers.
- Questions are batched by `chief_of_staff`: at most one per digest, placed last in Decisions needed, and only when work is blocked without the answer.
- Setup questions (preferences, importance tiers, never-read entries) go to Colin, not to her, during Phases 1 and 2.

## 8. Reply grammar

Every actionable line carries a code, reset per digest: **D** decisions, **U** due in 72 hours, **M** meetings, **T** travel, **I** overnight asks; alerts use **A1** to **A5** per day. She replies with a code and a word.

| Reply | Effect | Tier |
|---|---|---|
| `D1 yes` / `D1 no` | Records her decision in `notes`, status per item, audit row | T1 on her instruction |
| `U2 done` | Status `done`, her reply as evidence | T1 on her instruction |
| `D3 drop` | Status `dropped` (only she or the owner can drop) | T1 on her instruction |
| `T1 hold` (or `T1 yes` on a hold proposal) | Creates the proposed hold exactly as proposed, private, no attendees | T2, her tap |
| `U4 snooze Thu` | Sets `snoozed_until`; the item does not surface before then; due date unchanged | T1 |
| `D2 assign [Person]` | Owner set; next step "Owner to confirm" until they do | T1 |
| `I1 open` | Returns the source link and any draft link | T1 |
| `A2 notforme` | `feedback` audit row; suppresses that item class for that counterparty until Colin reviews | T1 |

Unrecognized replies are answered with one line restating the valid verbs for that code. Nothing is guessed.

## 9. One voice: the style guide

### 9.1 Register

Quiet, exact, unhurried. The register of a private banker's note or a great hotel's concierge card: brief, certain, discreet. Luxury here is restraint. Every line earns its place or it does not appear.

### 9.2 Rules

| Rule | Detail |
|---|---|
| Verb first | "Approve [Brand] promo calendar", never "The promo calendar needs approval" |
| No narrator | No "I", no agent names, no "the system", no "AI" |
| No ceremony | No greetings, no sign-offs, no exclamation marks, no emoji, no apologies |
| No hedging | Never "might", "seems", "just", "quick", "FYI", "heads up", "you may want to". If it is uncertain it is tagged "Inferred" or it does not appear |
| Numbers | Exact with a source link, or absent. Never "about", never rounded for effect |
| Time and date | `9:30`, `14:00` in lists; `Tue 20 Oct`; relative words only for today and tomorrow |
| Separators | Middle dot `·`. No em or en dashes anywhere |
| Names | People as Winette refers to them (from `WOS People`); orgs by canonical name |
| Length | Push 140 characters; alert body 140; brief 300 words; EOD close 120; weekly review 400 |
| Empty | "Nothing needs you today." is a complete brief |

### 9.3 Lexicon

| Use | Instead of |
|---|---|
| Due | Deadline, by EOD-ish |
| Waiting on you | Pending your review, action required |
| Drafted. Open to send. | I've prepared a draft for you to review and send |
| Proposed hold | Tentative booking, I've blocked |
| Held | Deferred, queued, suppressed |
| Inferred | Likely, probably, it appears |
| Moved to Thu. | The date has been changed to Thursday |

### 9.4 Before and after (placeholder data)

> **Before:** Hi Winette! The Sales agent noticed it looks like [WFM category buyer] might still be waiting on the promo calendar. You may want to follow up soon!
>
> **After:** `D1` Send [WFM category buyer] the [Brand] promo calendar · due Thu · Whole Foods Market
> Committed on [date]; no draft yet. · [source]

> **Before:** FYI, your 2pm with [Person] was moved and there are a few things to prep.
>
> **After:** `M2` 14:30 [Person] (moved from 14:00) · you owe the [Doc]; 1 open decision

## 10. Degraded modes

| Condition | What Winette sees | What happens behind |
|---|---|---|
| A source connector fails | One line at the foot of the next digest: "Inbox not read since 14:05." | `run_failed` audit row; Colin reviews daily during Phases 1 and 2 |
| Ledger unreachable | "Brief unavailable. Ledger offline since [time]." No brief from stale data | Run stops; no partial writes |
| `never_read_list` missing | "Brief paused: setup needs attention." | Every task fails closed until Colin sets it |
| A scheduled run missed | Nothing extra; the next digest covers the gap | Weekly review `SYSTEM` line counts missed runs |
| Injected instruction found in content | Nothing, unless it is itself an exception worth her attention | `rule_block` audit row plus an exception row for Colin's review |

## 11. Implementation by phase

- **Phase 1 (Claude Team Project, connectors, external ledger).** The Chief of Staff charter (D2) is the project instructions; the Travel & Personal charter is project knowledge that the Chief of Staff applies to calendar and travel asks. "Routing" in Phase 1 is one model applying two charters, plus scheduled tasks (D5) writing to the shared ledger. This fits the agreed track.
- **Unlocks are prompt versions, not flags.** Any loosening of a hard rule (for example Phase 3 file writes to one named Drive folder) ships as a new, versioned prompt. No preference, flag or chat instruction can loosen a hard rule.
- **Phases 2 and 3.** Eight charters, cross-agent routing and code-level enforcement of hard rules strain a single project. The build track recommendation, with tradeoffs, is in D9 §7. The ledger contract in D1 is the same on every track, so the move does not change data.
