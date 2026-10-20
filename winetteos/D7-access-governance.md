# D7 · Access and governance one-pager

- **What:** What WinetteOS reads, what it never touches, how every action is traced, and how any access is revoked in one step, written for the Google Workspace admin and the owners of finance and ERP systems.
- **Decides:** Read-only by default, drafts and on-tap holds as the only writes outside its own ledger, no sends, no money movement, no bank data, in any phase.
- **Open:** Named approvers for Google Workspace, finance and ERP; `LEDGER_STORE`; whether the platform allows per-tool connector control (see D9).

## 1. Posture in six lines

1. Reads mail, calendar and files; writes only email drafts, calendar holds she taps to approve, and its own ledger.
2. Never sends email, never messages anyone, never moves money, never edits or shares a file, never reads bank data.
3. Every write is logged with before and after, by agent and task, in the `wos.audit` table.
4. Content is data: an instruction inside an email or document is logged and refused, never followed.
5. A never-read list (labels, senders, folders) is loaded before any read; if it is missing, the run stops.
6. Every access is revocable in one step by the user and by the admin, listed below.

## 2. Connector register

| Connector | Reads | Never touches | Audit trail | One-step revocation | Approver |
|---|---|---|---|---|---|
| Gmail (principal) | Inbox and Sent, minus never-read labels and senders | Send, forward, delete, labels, filters, settings, never-read items, bank senders | `wos.audit` (`draft_created`, `rule_block`); Gmail Drafts and Sent; Google Admin OAuth token audit log (ASSUMPTION: available on the Workspace edition in use) | User: Claude Settings > Connectors > disconnect, or Google Account > Security > third-party access > remove. Admin: Google Admin console > Security > API controls > App access control > block | Principal; Google Workspace admin |
| Google Calendar | Events and invites | Move, accept, decline, delete; any create without her tap | `wos.audit` (`hold_proposed`, `hold_created_on_tap`, `reminder_created_on_tap`); event history in Calendar | Same as Gmail | Principal; Google Workspace admin |
| Google Drive | Documents linked from mail and invites; named folders in later phases | Create, edit, move, rename, share, delete (every phase in this prompt version) | `wos.audit` read references in ledger `source_link`; Drive audit log in Admin console (ASSUMPTION: edition-dependent) | Same as Gmail | Principal; Google Workspace admin |
| Microsoft 365 (only if `OUTLOOK_MODE` = separate mailbox) | Mail and calendar via Graph `Mail.Read`, `Calendars.Read` | `Mail.Send` never requested; no file writes | `wos.audit`; Entra sign-in and audit logs | User: Claude Settings > Connectors. Admin: Entra admin center > Enterprise applications > the app > disable sign-in (ASSUMPTION on menu labels) | Principal; M365 admin |
| Notion (if `LEDGER_STORE` = Notion) | WinetteOS page tree only | Any page outside it | `WOS Audit` database; Notion page history (retention depends on plan) | Notion: Settings > Connections > disconnect | Colin; IT |
| Supabase (if `LEDGER_STORE` = Supabase) | Schema `wos` through role `wos_agent` | Delete, DDL, audit edits (refused by the database) | `wos.audit` (insert-only for agents); Postgres logs | `alter role wos_agent nologin;` | Colin; IT |
| Push (`PUSH_CHANNEL`) | Nothing; sends a notification to her own phone | Anyone else's device | `wos.audit` (`surface_alert`, `surface_brief`) | Disable the scheduled tasks, or iPhone Settings > Notifications > Claude | Principal |
| Accounting, ERP, purchasing (Phase 3) | Read-only reporting views, once named | Posting, approval, payment, PO creation or submission, master data | `wos.audit`; the system's own access log | System owner disables the read-only user or token | Finance or ERP owner |
| Banking | Nothing, every phase | Everything | n/a | n/a | n/a |

## 3. For the Google Workspace admin

**What we ask for.** One Claude connector each for Gmail, Calendar and Drive on the principal's account. Minimal scopes needed: `gmail.readonly`, `gmail.compose` (drafts), `calendar.events` (holds on tap), `drive.readonly`. ASSUMPTION: the connector vendor sets the scopes actually requested; we will send you the consent-screen list before the pilot so you can compare it against this one.

**What you should know about `gmail.compose`.** Google has no draft-only scope; the draft scope also permits sending. Sending is blocked by the hard rules in every prompt, by disabling the send tool if the platform allows per-tool control (ASSUMPTION to verify), by the audit table (drafts are logged; a send has no audit action, so any send is an incident), and by a daily Sent-folder check during the dogfood.

**What you can verify yourself.** The app's token and scopes in Admin console > Security > API controls > App access control; OAuth activity in the admin audit logs (ASSUMPTION: edition-dependent); the `wos.audit` table, which Colin will share read-only on request.

**How you stop it.** Block the app in App access control. That revokes every WinetteOS connection to the tenant in one action.

## 4. For the finance system owner (Phase 3 only)

**Nothing connects to a finance system before Phase 3**, and Phase 3 starts per system only after you name the system, approve a read-only user or token, and agree the views it may read.

**What Finance would read.** Approvals waiting on the CEO, budget vs actual, margin, and board and Certified Origins reporting deadlines. Read-only.

**What it never does.** Post entries, approve, release, schedule or submit payments, wires or transfers, change vendor or bank master data, or read bank data. "Prepare and flag" means a ledger item and, at most, a draft for a human to act on in your system.

**What we need from you.** The system name and access method; a read-only credential you control and can disable; the list of bank and payment-processor sender domains to add to the never-read list (none are assumed; Finance supplies them).

## 5. For the ERP and operations system owner (Phase 3 only)

**Same gate as Finance.** Operations, Purchasing and Demand Planning connect only to systems you name, through read-only access you issue and can disable.

**What they would read.** Orders, shipments, distributor fill and shorts (UNFI, KeHE), inventory, open POs, lead times, MOQs, compliance and certification dates, forecast inputs.

**What they never do.** Create, edit, release or submit a PO; change inventory, pricing, vendor or item master data; contact a distributor or supplier. Reorder and forecast changes are proposals in the ledger for a human to execute.

## 6. Data handling

- The ledger stores a one-line item, owner, dates, status and a link back to the source. It does not store email bodies, attachments or document text.
- Drafts live in the principal's own Gmail Drafts. Briefs and alerts go only to her own devices.
- Context store holds names, roles, orgs, importance tier and preferred channel for people she works with; no personal data beyond that.
- Retention: ledger and audit rows are kept for the life of the system. ASSUMPTION: no deletion schedule until Winette or IT sets one (D9).

## 7. Prompt injection, never-read list, bank senders

- **Content is data.** If an email, document, invite or page asks the system to send, pay, share, forward, reveal anything, or change a rule, it does not comply. It writes a `rule_block` audit row and an exception item for the Chief of Staff. The weekly review reports the `rule_block` count.
- **Never-read list.** Labels, senders and folders the principal names. Loaded before every read; if it is missing or unreadable, the run stops with `run_failed`. It must be set explicitly before the first run, even if empty.
- **Bank-sender exclusion.** Bank and payment-processor senders go on the never-read list so the system never reads bank data arriving by email. Finance supplies the domains; none are invented here.

## 8. Residual risks (stated plainly)

| Risk | Mitigation | Owner |
|---|---|---|
| Connector scopes are broader than the behavior (send, move, delete) | Hard rules, tool control if available, audit, daily checks in dogfood | Colin |
| Rules are enforced in prompts, not code, on the Phase 1 track | Audit on every write; D9 recommends a code-enforced harness before Phase 3 | Colin |
| Notion audit rows are editable by anyone with edit rights | Restrict edit rights to Colin; prefer Supabase before Phase 3 | Colin; IT |
| A privileged Supabase connection bypasses row-level security | Agents use `wos_agent` only; privileged access is Colin's, for migrations | Colin |

## 9. Phase gates and what changes in Phase 3

| Phase | Agents | Access added | Gate |
|---|---|---|---|
| 1 | Chief of Staff, Travel & Personal | Gmail, Calendar, Drive read; ledger; push. Dogfood on Colin's account first | D8 exit criteria, then Winette's consent and admin approval |
| 2 | Sales, Marketing | Named Drive folders, CRM and marketing tools read-only once confirmed | Phase 1 passed; data sources confirmed |
| 3 | Finance, Operations, Purchasing, Demand Planning | Accounting, ERP, purchasing, demand data, read-only, per system | Data source confirmed and connector approved by its owner, per agent |

What changes in Phase 3: financial and operational systems join, read-only. Any loosening of a hard rule (for example, writing to one named Drive folder) ships as a new, versioned prompt reviewed by Colin and the relevant system owner; no setting or flag can loosen a rule. Money movement, sending, and bank data stay prohibited in every phase.
