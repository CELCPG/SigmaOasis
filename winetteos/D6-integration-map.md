# D6 · Integration map

- **What:** Every system each agent touches, the connector or API, the scopes, read versus write, who approves access, and the status today.
- **Decides:** Phase 1 runs on Gmail, Google Calendar, Google Drive (read), one ledger store and one push channel; every CEO-inbox and financial-system access is a LONG-POLE approval to start now.
- **Open:** `LEDGER_STORE`, `OUTLOOK_MODE`, `PUSH_CHANNEL`, `CHAT_PLATFORM`, the Google Workspace admin's name, and every Phase 3 data source (see D9).

## 1. Legend

| Term | Meaning |
|---|---|
| **available** | Can be connected today under the account named, with no one else's approval |
| **needs approval** | The system is known; someone other than Colin must consent or allow it |
| **unknown** | The system itself, or how it is reached, is not yet confirmed. Never guessed |
| **LONG-POLE** | Access to the CEO's inbox, calendar or files, or to any financial system. Start the approval the day this map is accepted; it gates the Winette pilot or Phase 3 |
| **R** / **W** | Read / Write. "W (on tap)" means the write happens only after the principal taps that specific proposal |
| **Draft** | Write limited to creating or updating email drafts. Sending is NEVER (hard rule 1) |

Scope strings below are the minimal Google and Microsoft scopes the behavior needs. ASSUMPTION: the scopes a Claude connector actually requests are set by the connector vendor, not by us. They are verified at the OAuth consent screen and afterward in Google Admin console > Security > API controls > App access control (or the Microsoft Entra admin center for Microsoft 365). Where the connector requests more than listed here, the hard rules and the audit table carry the difference, and that gap is recorded in D7 §8.

Full Google scope prefix is `https://www.googleapis.com/auth/`. Short names are used in the tables.

## 2. Shared spine and surfaces (all agents)

| System | Connector or API | Scopes or rights | R / W | Approver | Status |
|---|---|---|---|---|---|
| Ledger store: Notion (`WOS Ledger`, `WOS Audit`, context databases) | Notion connector in the Claude project | Workspace access limited to the `WinetteOS` page tree. ASSUMPTION: the connector supports page-level selection; if it grants the whole workspace, use a dedicated Notion workspace | R/W ledger, R context, append audit | Colin (store owner); IT for where company data lives | needs approval (`LEDGER_STORE` not picked) |
| Ledger store: Supabase (schema `wos`) | Restricted Postgres role `wos_agent` via PostgREST or a narrow tool server | `wos_agent` per D1: insert and update on `wos.ledger`, insert only on `wos.audit`, select on context tables. No delete, no DDL | R/W ledger, R context, append audit | Colin; IT | needs approval (`LEDGER_STORE` not picked) |
| Push to iPhone (`PUSH_CHANNEL`) | Claude iOS app notifications from scheduled task runs | Notifications on the principal's own Claude account | W (push only) | Principal (her phone, her account); Claude Team admin for her seat | unknown (ASSUMPTION default) |
| Mac surface (`MAC_SURFACE`) | Claude desktop app, `WinetteOS` project; ledger store's own app for views | Same as Claude seat and ledger store | R | Principal; Claude Team admin | unknown (ASSUMPTION default) |
| Scheduler | Claude scheduled tasks under the principal's account (D5) | Task creation on that account | n/a | Claude Team admin; principal | unknown (ASSUMPTION: available on the plan in use) |
| Chat platform (`CHAT_PLATFORM`) | None at build. If Slack is confirmed: Slack connector, read-only on named channels, no message-write tool enabled (ASSUMPTION on available tool control) | Channel history read for named channels only | R | Slack workspace admin | unknown |

### Why the Supabase connection path matters

A Supabase MCP connection made with a project-owner or service credential runs SQL as a privileged role. Privileged roles bypass row-level security, can disable or delete audit rows, and can change the schema. That would turn the governance guarantees in D1 and D7 into conventions. The agent path must use the restricted `wos_agent` role, so the database itself refuses deletes, DDL and audit edits. The privileged connection is for Colin only, for migrations, and is never attached to the WinetteOS project or any scheduled task. INFERENCE: if only the privileged MCP path is available on the platform, Notion and Supabase offer similar integrity in practice, and the deciding factor becomes the iPhone reading experience (D9).

## 3. Per agent

### Chief of Staff (`chief_of_staff`) · Phase 1

| System | Connector or API | Scopes | R / W | Approver | Status |
|---|---|---|---|---|---|
| Gmail, principal inbox and Sent | Claude Gmail connector | `gmail.readonly`; `gmail.compose` for drafts | R; Draft | Dogfood: Colin. Pilot: Winette's consent plus Workspace admin if third-party app access is restricted | Dogfood: available. Winette: needs approval, **LONG-POLE** |
| Google Calendar | Claude Google Calendar connector | `calendar.readonly` | R | Same as Gmail | Dogfood: available. Winette: needs approval, **LONG-POLE** |
| Google Drive | Claude Google Drive connector | `drive.readonly` | R (docs linked from threads and invites; Sales Ops report links, never re-summarized) | Same as Gmail | Dogfood: available. Winette: needs approval, **LONG-POLE** |
| Ledger store | §2 | §2 | R/W | Colin | needs approval |
| Push channel | §2 | §2 | W (push) | Principal | unknown |
| Outlook | §5 | §5 | R | §5 | unknown |

### Travel & Personal (`travel_personal`) · Phase 1

| System | Connector or API | Scopes | R / W | Approver | Status |
|---|---|---|---|---|---|
| Gmail (confirmations from airlines, hotels, ground transport) | Claude Gmail connector | `gmail.readonly`; `gmail.compose` for travel drafts | R; Draft | As Chief of Staff | Dogfood: available. Winette: needs approval, **LONG-POLE** |
| Google Calendar | Claude Google Calendar connector | `calendar.events` (holds and reminders created only on her tap; never move, accept, decline or delete) | R; W (on tap) | As Chief of Staff | Dogfood: available. Winette: needs approval, **LONG-POLE** |
| Reminder and to-do store | Default: ledger rows of type `task` owned by the principal, plus calendar reminder events on tap | As ledger and Calendar | W (on tap) | Principal | ASSUMPTION default; unknown whether she uses Google Tasks or Apple Reminders. ASSUMPTION: Apple Reminders has no cloud connector reachable from a scheduled task |
| Ledger store | §2 | §2 | R/W | Colin | needs approval |
| TripIt or similar | Not connected | n/a | n/a | Principal | unknown; used only if confirmed (`TRAVEL_SOURCES`) |

Note on `calendar.events`: the scope permits create, move and delete. The hard rules restrict the agent to creating a proposed hold after her tap, and every such write lands in `wos.audit` as `hold_created_on_tap`. The dogfood check in D8 compares those rows against Colin's taps every day.

### Sales (`sales`) · Phase 2 · NOT ACTIVATABLE

| System | Connector or API | Scopes | R / W | Approver | Status |
|---|---|---|---|---|---|
| `CRM` | unknown | unknown (read-only requested) | R | CRM owner (unknown) | unknown |
| Sales trackers in Drive | Claude Google Drive connector | `drive.readonly`, limited to confirmed folders | R | Colin names the folders; principal's consent covers her Drive | unknown (locations unconfirmed) |
| Sales Ops reporting (Quinn, Tommaso) | Drive links | `drive.readonly` | R (link only; never replaced or recomputed) | Quinn, Tommaso, Colin | unknown (locations unconfirmed) |
| Gmail | Claude Gmail connector | `gmail.readonly`; `gmail.compose` | R; Draft | As Chief of Staff | needs approval, **LONG-POLE** (rides on the Phase 1 grant) |
| Google Calendar | Claude Google Calendar connector | `calendar.readonly` (buyer meetings) | R | As Chief of Staff | needs approval, **LONG-POLE** (rides on the Phase 1 grant) |
| Ledger store | §2 | §2 | R/W | Colin | needs approval |

### Marketing (`marketing`) · Phase 2 · NOT ACTIVATABLE

| System | Connector or API | Scopes | R / W | Approver | Status |
|---|---|---|---|---|---|
| `MARKETING_STACK` (email, social, paid, agency tools) | unknown | unknown (read-only requested) | R | Marketing owner (unknown) | unknown |
| Campaign calendar and approvals | Location unconfirmed; Drive if there | `drive.readonly` | R | Marketing owner | unknown |
| Gmail | Claude Gmail connector | `gmail.readonly`; `gmail.compose` | R; Draft | As Chief of Staff | needs approval, **LONG-POLE** |
| Ledger store | §2 | §2 | R/W | Colin | needs approval |

### Finance (`finance`) · Phase 3 · NOT ACTIVATABLE

| System | Connector or API | Scopes | R / W | Approver | Status |
|---|---|---|---|---|---|
| `ACCOUNTING_SYSTEM` | unknown | Read-only reporting access requested; no posting, no approval, no payment rights | R | Finance system owner (unknown) | unknown, **LONG-POLE** |
| Budget, board and Certified Origins reporting files | Drive, locations unconfirmed | `drive.readonly` | R | Finance system owner | unknown, **LONG-POLE** |
| Gmail | Claude Gmail connector | `gmail.readonly`; `gmail.compose` | R; Draft | As Chief of Staff | needs approval, **LONG-POLE** |
| Banking | Not connected | none | none | n/a | none, every phase (`BANKING_DATA`) |
| Ledger store | §2 | §2 | R/W | Colin | needs approval |

### Operations (`operations`) · Phase 3 · NOT ACTIVATABLE

| System | Connector or API | Scopes | R / W | Approver | Status |
|---|---|---|---|---|---|
| `ERP_SYSTEM` | unknown | Read-only order, shipment and inventory views requested | R | ERP owner (unknown) | unknown, **LONG-POLE** (holds financial data, INFERENCE) |
| `INVENTORY_SOURCE` | unknown | Read-only | R | Ops owner (unknown) | unknown |
| Distributor data (UNFI, KeHE: fill, shorts, delivery) | unknown method (portal export, EDI, email reports) | Read-only | R | Ops owner; distributor terms of use | unknown |
| Compliance and certification records | unknown location | Read-only | R | Ops owner | unknown |
| Gmail | Claude Gmail connector | `gmail.readonly`; `gmail.compose` | R; Draft | As Chief of Staff | needs approval, **LONG-POLE** |
| Ledger store | §2 | §2 | R/W | Colin | needs approval |

### Purchasing (`purchasing`) · Phase 3 · NOT ACTIVATABLE

| System | Connector or API | Scopes | R / W | Approver | Status |
|---|---|---|---|---|---|
| `PURCHASING_SOURCE` (PO system, vendor list, lead times, MOQs) | unknown | Read-only; no PO create, edit or submit rights | R | Purchasing or Finance owner (unknown) | unknown, **LONG-POLE** |
| `INVENTORY_SOURCE` | unknown | Read-only | R | Ops owner | unknown |
| Demand Planning output | Ledger rows owned by `demand_planning` | via ledger store | R | n/a | blocked on Demand Planning activation |
| Gmail | Claude Gmail connector | `gmail.readonly`; `gmail.compose` (supplier follow-up drafts) | R; Draft | As Chief of Staff | needs approval, **LONG-POLE** |
| Ledger store | §2 | §2 | R/W | Colin | needs approval |

### Demand Planning (`demand_planning`) · Phase 3 · NOT ACTIVATABLE

| System | Connector or API | Scopes | R / W | Approver | Status |
|---|---|---|---|---|---|
| SPINS | unknown access method | Read-only | R | Data owner (unknown); SPINS license terms | unknown |
| Distributor sell-through (UNFI, KeHE) | unknown method | Read-only | R | Ops or Sales owner | unknown |
| Customer forecasts | unknown location | Read-only | R | Sales owner | unknown |
| 2027 WFM forecast model | unknown location and format. ASSUMPTION: if it is an Excel file in Drive, the Drive connector can read `.xlsx` (verify) | `drive.readonly` | R | Model owner (unknown) | unknown |
| `INVENTORY_SOURCE` | unknown | Read-only | R | Ops owner | unknown |
| Sales output | Ledger rows owned by `sales` | via ledger store | R | n/a | blocked on Sales activation |
| Ledger store | §2 | §2 | R/W | Colin | needs approval |

## 4. The draft scope can send

`gmail.compose` is the narrowest Google scope that creates drafts, and it also permits sending. Google has no draft-only scope. "Never send" is therefore enforced in four layers, none of which is a flag:

1. Hard rule 1 in every charter and task prompt (D2, D5).
2. Tool control: disable or withhold the Gmail send tool in the connector. ASSUMPTION: the Claude platform offers per-tool enable or disable on connectors for the plan in use; verify before the dogfood. If it does not, layers 1, 3 and 4 carry the rule and D7 §8 records the residual risk.
3. Audit: every draft write is a `draft_created` row in `wos.audit`; there is no audit action for send, so any send is by definition unaudited and an S1 in D8.
4. Daily Sent-folder check by the reviewer (D8 checklist), comparing Sent against what the principal sent herself.

The same pattern applies to `calendar.events` (scope permits move and delete; rule permits create-on-tap only) and to any connector that turns out broader than its row above.

## 5. `OUTLOOK_MODE` options

| Mode | What it means | Extra connector | Scopes | Approver | Effect on build |
|---|---|---|---|---|---|
| A. Outlook as a client | Outlook on Mac or iPhone reads the Google Workspace mailbox | None | n/a | n/a | No change. Gmail is the source of truth |
| B. Separate Microsoft 365 mailbox | Some or all of her mail or calendar lives in Exchange Online | Microsoft 365 connector (Graph API) | Delegated `Mail.Read`, `Calendars.Read`; `Mail.ReadWrite` only if drafts are wanted there; `Calendars.ReadWrite` only for holds on tap. `Mail.Send` is never requested | Microsoft 365 admin; principal | Capture and brief read both mailboxes; dedupe key includes the mailbox. Graph separates `Mail.Send` from draft rights, so send can be withheld at the scope level here |
| C. Office files only | Excel, Word stored in Drive or OneDrive, no Outlook mail | Drive (if in Drive) or OneDrive (`Files.Read`) | `drive.readonly` or `Files.Read` | Workspace or M365 admin | Read-only file access, same rules |
| Unknown (today) | Not answered | None | n/a | n/a | Build against Gmail only. ASSUMPTION |

## 6. Long-pole approvals (start now)

| # | Access | Why it is long | Approver | Gates |
|---|---|---|---|---|
| 1 | Winette's Gmail (read, draft) | CEO inbox; consent plus possible admin allow-listing | Winette; Google Workspace admin | Winette pilot |
| 2 | Winette's Google Calendar (read, holds on tap) | CEO calendar | Winette; Google Workspace admin | Winette pilot |
| 3 | Winette's Google Drive (read) | CEO files, board and parent-company material | Winette; Google Workspace admin | Winette pilot |
| 4 | Microsoft 365 mailbox, if `OUTLOOK_MODE` = B | Second tenant, second admin | M365 admin; Winette | Winette pilot |
| 5 | `ACCOUNTING_SYSTEM` read-only | Financial system | Finance system owner | Finance activation |
| 6 | `ERP_SYSTEM` read-only | Holds financial and order data (INFERENCE) | ERP owner | Operations activation |
| 7 | `PURCHASING_SOURCE` read-only | PO and vendor terms | Purchasing or Finance owner | Purchasing activation |
| 8 | Banking | Not requested in any phase | n/a | never |

INFERENCE: the Google Workspace tenant may be owned by Origin Brands or by Certified Origins; whichever it is decides who signs rows 1 to 3 (D9, IT).
