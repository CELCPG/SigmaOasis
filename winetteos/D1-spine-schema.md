# D1 · Shared spine schema

- **What:** The ledger, context store, and audit table every WinetteOS agent reads and writes, specified for Notion and for Supabase.
- **Decides:** Field names, enums, aging math, views, write permissions, and a store recommendation (Notion for Phases 1 and 2, Supabase before Phase 3).
- **Open:** `LEDGER_STORE` choice (Colin), importance tiers for people and orgs (Colin, Winette), `NEVER_READ_LIST` contents (Colin, Winette), and whether a restricted database connection is available to the agents (IT).

## 1. Logical schema

One logical schema, two physical builds (§3 Notion, §4 Supabase). Names below are canonical; prompts, views, and tasks use them verbatim.

### 1.1 Ledger

Spec fields first, then system fields marked "added". "Req" means required at write time.

| Field | Type | Req | Purpose |
|---|---|---|---|
| `id` | uuid (Notion: Unique ID, prefix `WOS`) | yes | Stable reference used in briefs, audit, and links |
| `item` | text, one line, max 200 characters | yes | The commitment, decision, or open item, verb first |
| `type` | enum `commitment` \| `decision` \| `approval` \| `exception` \| `task` | yes | What kind of item it is |
| `owner` | text (canonical name from People) | no | Who owes the next move. Empty is allowed at capture; empty past 5 days is what the success metric counts |
| `counterparty` | text (canonical person or org name) | no | Who the item is with or for |
| `due_date` | date | no | Only when a source states it. Never inferred |
| `source_type` | enum `email` \| `meeting` \| `chat` \| `dictation` \| `system` | yes | Where the item came from |
| `source_link` | URL | yes | Link to the exact source (thread, event, note, conversation, record) |
| `status` | enum `open` \| `waiting_on_other` \| `waiting_on_winette` \| `done` \| `dropped` | yes | Lifecycle. No other values |
| `owning_agent` | enum of the eight agent IDs | yes | Agent accountable for tracking the item |
| `priority` | enum `p1` \| `p2` \| `p3` | no | Computed by `chief_of_staff` from the score (D3); empty until scored |
| `winette_action_needed` | boolean | yes | True when the principal must decide, approve, or act |
| `next_step` | text | no | The concrete next move and who makes it. Empty past 5 days counts against the metric |
| `created_at` | timestamp | yes | Set by the store at insert. Never written by an agent |
| `last_touched` | timestamp | yes | Last substantive change: status, owner, due date, next step, or new source evidence. Surfacing, reading, and nudging do not touch it |
| `notes` | text | no | Evidence links (required when status becomes `done` or `dropped`), cross-agent evidence, labels in context |
| `dedupe_key` | text | yes | Added. `{{source_type}}:{{source thread or event id}}:{{type}}:{{normalized counterparty}}`; one open row per key |
| `routed_to` | enum of agent IDs | no | Added. Set only when `owning_agent` is `chief_of_staff` and the item belongs to an inactive agent |
| `alert_requested` | boolean | yes (default false) | Added. Owning agent asks `chief_of_staff` to consider an alert |
| `last_surfaced_at` | timestamp | no | Added. Last time the item reached the principal in a brief or alert |
| `surfaced_count` | integer, default 0 | yes | Added. How many times it has surfaced |
| `nudged_at` | timestamp | no | Added. Last nudge draft created for this item |
| `escalated_at` | timestamp | no | Added. Last escalation into Decisions needed |
| `labels` | multi: `ASSUMPTION`, `INFERENCE` | no | Added. Marks items that rest on an assumption or inference |
| `artifact_link` | URL | no | Added. Prepared draft, hold proposal, PO proposal, one-pager |
| `snoozed_until` | timestamp | no | Added. Set by reply verb `snooze <when>`. The item does not surface before this time; `due_date` is unchanged |
| `body` | long text | no | Added. Prepared one-pager, content draft, or decision memo text. Notion: the ledger row's page body (no property). Supabase: `body` column |

Open statuses are `open`, `waiting_on_other`, `waiting_on_winette`. Every view and aging rule below uses that set.

### 1.2 Context store

Written once, read by all. Agents never write it directly (§6).

**People**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid | yes | |
| `name` | text, unique | yes | Canonical name. `ledger.owner` and `ledger.counterparty` use it |
| `role` | text | no | |
| `org` | text | no | Canonical org name from Orgs |
| `importance_tier` | 1 \| 2 \| 3, default 3 | yes | Set by Colin or the principal, never inferred. Unknown person = 3 |
| `preferred_channel` | enum `email` \| `phone` \| `text` \| `chat` \| `in_person` \| `via_assistant` | no | Option list added at build. ASSUMPTION: these six cover her contacts |
| `email` | text, unique | no | Used to match senders to people |
| `aliases` | text list | no | Other spellings and nicknames for matching |
| `notes` | text | no | |
| `updated_at` | timestamp | yes | Store-maintained |

**Orgs** (added; gives routing a deterministic hint)

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid | yes | |
| `name` | text, unique | yes | |
| `kind` | enum `parent` \| `self` \| `brand` \| `retailer` \| `distributor` \| `broker` \| `vendor` \| `agency` \| `board` \| `other` | yes | `board` is used by Finance as the counterparty for board reporting deadlines |
| `importance_tier` | 1 \| 2 \| 3 | no | Empty means not set; scoring treats empty as 3 |
| `routing_hint` | agent ID | no | Default owner for items with this org when the topic does not decide (D3) |
| `notes` | text | no | |
| `updated_at` | timestamp | yes | |

Seed rows (facts from the build spec only):

| name | kind | importance_tier | routing_hint |
|---|---|---|---|
| Origin Brands Inc | self | empty | empty |
| Certified Origins | parent | 1 (ASSUMPTION: until Colin or Winette sets it) | `chief_of_staff` (INFERENCE: parent-company items are cross-functional; reporting deadlines route to `finance` per D3) |
| Seggiano, Bellucci, Lunaio, Vichy Catalan, Toca Honey | brand | empty | empty |
| Whole Foods Market | retailer | 1 (ASSUMPTION) | `sales` |
| UNFI | distributor | 1 (ASSUMPTION) | empty (topic decides: commercial to `sales`, logistics to `operations`) |
| KeHE | distributor | 1 (ASSUMPTION) | empty (same rule as UNFI) |

No board org is seeded: its name is not known. Colin adds it.

**Initiatives**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | uuid | yes | |
| `name` | text, unique | yes | |
| `owner` | text | no | Canonical person name |
| `status` | enum `active` \| `paused` \| `done` | yes | |
| `agents_involved` | list of agent IDs | no | |
| `notes` | text | no | |
| `updated_at` | timestamp | yes | |

No initiatives are seeded. None are known.

**Preferences**

| Field | Type | Req | Notes |
|---|---|---|---|
| `key` | text, primary key, from the list below only | yes | |
| `value` | JSON | yes | |
| `category` | enum `brief` \| `quiet_hours` \| `travel` \| `system` | yes | |
| `set_by` | text | yes | Who set it. Build defaults say `build-spec` or `build-default ASSUMPTION` |
| `updated_at` | timestamp | yes | |

| Key | Category | Seed value | Source |
|---|---|---|---|
| `brief_time_local` | brief | `{"time":"07:00","tz":"America/New_York"}` | Spec, confirm |
| `brief_word_cap` | brief | `300` | Spec |
| `eod_word_cap` | brief | `120` | Spec |
| `weekly_word_cap` | brief | `400` | ASSUMPTION |
| `alert_cap` | system | `5` | Spec |
| `quiet_hours` | quiet_hours | `{"start":"20:00","end":"07:00","tz":"America/New_York"}` | ASSUMPTION |
| `aging_thresholds` | system | `{"nudge_owner_at_days":3,"escalate_to_winette_at_days":5}` | Spec |
| `never_read_list` | system | **Not seeded.** Every task fails closed until Colin sets it, even to `[]` | Rule |
| `active_agents` | system | `["chief_of_staff","travel_personal"]` | Spec (Phase 1) |
| `timezone_home` | travel | `"America/New_York"` | ASSUMPTION |
| `travel_preferences` | travel | `{}` (empty until the principal fills it) | Default |
| `brief_format` | brief | `{"order":["decisions_needed","due_72h","today","travel","overnight_asks"],"codes":true,"weekend":"only_if_decisions_or_travel"}` | Spec; weekend rule ASSUMPTION |
| `principal` | system | `{"name":"Winette","role":"CEO","org":"Origin Brands Inc"}` | Added key. Dogfood: `{"name":"Colin Long"}` (D8) |
| `data_sources` | system | Every key `"unknown"`: `CRM`, `ACCOUNTING_SYSTEM`, `ERP_SYSTEM`, `INVENTORY_SOURCE`, `PURCHASING_SOURCE`, `DEMAND_DATA`, `MARKETING_STACK`, `SALES_TRACKERS`, `SALES_REPORT_LINKS`, `CAMPAIGN_CALENDAR`, `BUDGET_SOURCE`, `REPORTING_CALENDAR`, `DEDUCTION_SOURCE` | Added key. A functional agent refuses to run while any source it needs is `"unknown"` |
| `ops_sla_targets` | system | `{}` (empty until Ops sets targets) | Added key |

### 1.3 Audit

Every agent write, timestamped, with before and after.

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | bigint identity (Notion: page ID) | yes | Gaps in Supabase ids come from rolled-back transactions, not deletions |
| `at` | timestamp | yes | Stamped by the store at insert. Callers cannot backdate |
| `agent` | agent ID, or `human:<role>` for direct human edits | yes | |
| `task` | text | no | Scheduled task name (D5) or `chat` |
| `run_id` | text | no | One id per task run |
| `action` | enum `create` \| `update` \| `close` \| `surface_alert` \| `surface_brief` \| `draft_created` \| `hold_proposed` \| `hold_created_on_tap` \| `reminder_created_on_tap` \| `context_update` \| `feedback` \| `rule_block` \| `run_start` \| `run_end` \| `run_failed` | yes | |
| `target_store` | enum `ledger` \| `context` \| `gmail` \| `calendar` \| `drive` \| `push` \| `none` | yes | |
| `target_id` | text | no | Ledger id, preference key, draft id, event id |
| `before` | JSON | no | Prior state (Supabase: full row; Notion: changed fields only) |
| `after` | JSON | no | New state. `surface_alert` rows carry `after.origin_agent`; `run_end` rows carry `after.watermark`; the `cos-weekly-review` `run_end` row carries `after.metric` |
| `source_link` | URL | no | |
| `tier` | `T1` \| `T2` \| `T3` | no | Trust tier of the action. Empty for human edits |
| `note` | text | no | |

Run watermark: a task reads its own latest `run_end` row and processes from `after.watermark`.

## 2. Store choice

| Dimension | Notion | Supabase |
|---|---|---|
| Principal reads it on iPhone and Mac | Native apps, saved views, zero build | Needs a front end or a mirror |
| Setup | By hand in the UI, no code | One migration plus login roles; needs SQL comfort |
| Enum discipline | Select options. INFERENCE: a write naming a new option can create it, so discipline rests on prompts | Postgres enums reject unknown values |
| Dedupe | Convention: query `dedupe_key` before insert | Unique index on `dedupe_key` among open rows |
| Aging math | Formulas with thresholds typed in as literals | Views read `aging_thresholds` from preferences |
| Audit integrity | Append-only by convention; rows are editable; page history retention depends on plan | Database triggers write every row change; audit rejects update, delete, truncate; time is database-stamped |
| Access control | Workspace and page sharing | Roles, grants, row level security |
| Fit for finance and ERP data (Phase 3) | Weak | Strong |

**Recommendation (not a decision):** Notion for Phases 1 and 2, because the principal reads it on her phone with no build and Colin can stand it up in the UI. Move to Supabase before Phase 3, when Finance and Purchasing data make a tamper-resistant audit worth the build. The logical schema is identical, so migration is an export of each Notion database to CSV and a load into the matching `wos` table by the table owner, with imported audit rows noted as imports. `CONTEXT_STORE` follows `LEDGER_STORE` (ASSUMPTION).

## 3. Notion build

Create a top-level page `WinetteOS` holding six databases: `WOS Ledger`, `WOS People`, `WOS Orgs`, `WOS Initiatives`, `WOS Preferences`, `WOS Audit`. Dogfood: an identical page `WinetteOS · TEST` with its own six databases (D8). Share each page with the WinetteOS connector only.

Select option order matters: Notion sorts a Select by option order. Create options exactly in the order listed.

### 3.1 WOS Ledger properties

| Property | Notion type | Options or rule |
|---|---|---|
| `item` | Title | One line, verb first |
| `id` | Unique ID | Prefix `WOS` |
| `type` | Select | commitment, decision, approval, exception, task |
| `owner` | Rich text | Canonical name from WOS People |
| `counterparty` | Rich text | Canonical person or org name |
| `due_date` | Date | Date only, no time |
| `source_type` | Select | email, meeting, chat, dictation, system |
| `source_link` | URL | Required by prompt rule |
| `status` | Select | open, waiting_on_other, waiting_on_winette, done, dropped. Use Select, not Notion's Status type, so no extra groups or default options appear |
| `owning_agent` | Select | chief_of_staff, travel_personal, sales, marketing, finance, operations, purchasing, demand_planning |
| `priority` | Select | p1, p2, p3 |
| `winette_action_needed` | Checkbox | |
| `next_step` | Rich text | |
| `created_at` | Created time | Store-set, not editable |
| `last_touched` | Date (include time) | **Never Last edited time.** Last edited time changes when an agent stamps `last_surfaced_at` or `nudged_at`, which would reset staleness and hide aging items |
| `notes` | Rich text | |
| `dedupe_key` | Rich text | Added |
| `routed_to` | Select | Same eight options as `owning_agent`. Added |
| `alert_requested` | Checkbox | Added |
| `last_surfaced_at` | Date (include time) | Added |
| `surfaced_count` | Number | Added. Integer, default 0 by prompt |
| `nudged_at` | Date (include time) | Added |
| `escalated_at` | Date (include time) | Added |
| `labels` | Multi-select | ASSUMPTION, INFERENCE. Added |
| `artifact_link` | URL | Added |
| `snoozed_until` | Date (include time) | Added |
| `body` | Page body | Added. No property: the prepared text lives in the row's page content |
| `age_days` | Formula | See §3.3 |
| `stale_days` | Formula | See §3.3 |
| `due_in_days` | Formula | See §3.3 |
| `is_open` | Formula | See §3.3 |
| `is_snoozed` | Formula | See §3.3 |
| `nudge_candidate` | Formula | See §3.3 |
| `escalation_candidate` | Formula | See §3.3 |
| `metric_flag` | Formula | See §3.3 |

### 3.2 Context and audit databases

**WOS People:** `name` Title · `role` Rich text · `org` Rich text · `importance_tier` Select (1, 2, 3) · `preferred_channel` Select (email, phone, text, chat, in_person, via_assistant) · `email` Email · `aliases` Rich text (comma separated) · `notes` Rich text · `updated_at` Last edited time.

**WOS Orgs:** `name` Title · `kind` Select (parent, self, brand, retailer, distributor, broker, vendor, agency, board, other) · `importance_tier` Select (1, 2, 3) · `routing_hint` Select (the eight agent IDs) · `notes` Rich text · `updated_at` Last edited time. Seed the rows in §1.2.

**WOS Initiatives:** `name` Title · `owner` Rich text · `status` Select (active, paused, done) · `agents_involved` Multi-select (the eight agent IDs) · `notes` Rich text · `updated_at` Last edited time.

**WOS Preferences:** `key` Title · `value` Rich text (JSON) · `category` Select (brief, quiet_hours, travel, system) · `set_by` Rich text · `updated_at` Last edited time. Seed the rows in §1.2 except `never_read_list`.

**WOS Audit:** `entry` Title (`{{action}} · {{target_id}}`) · `at` Created time · `agent` Select (eight agent IDs, plus `human`) · `task` Rich text · `run_id` Rich text · `action` Select (the 15 audit actions in §1.3, in that order) · `target_store` Select (ledger, context, gmail, calendar, drive, push, none) · `target_id` Rich text · `before` Rich text (JSON, changed fields only) · `after` Rich text (JSON, changed fields only) · `source_link` URL · `tier` Select (T1, T2, T3) · `note` Rich text.

Audit integrity limits in Notion, stated plainly:
- Append-only is a convention enforced by prompts. Any member or integration with edit access to `WOS Audit` can edit or delete a row.
- `at` uses Created time, so the timestamp itself cannot be edited through the UI or API.
- Recovery of an edited row depends on Notion page history, whose retention depends on the workspace plan (ASSUMPTION: verify the plan before Phase 2).
- Notion's API limits a single rich text value (ASSUMPTION: 2,000 characters per text object), which is why `before` and `after` hold changed fields only.
- In Notion, agents write every audit row themselves, including row changes. Supabase writes row-change audit rows by trigger (§4).

### 3.3 Formulas (Notion formula 2.0)

Thresholds are typed in as literals because a Notion formula cannot read WOS Preferences. If `AGING_THRESHOLDS` changes, edit `nudge_candidate`, `escalation_candidate`, and `metric_flag`. Days are calendar days in the workspace time zone (ASSUMPTION: calendar days, America/New_York).

`age_days`
```
dateBetween(today(), parseDate(formatDate(prop("created_at"), "YYYY-MM-DD")), "days")
```

`stale_days`
```
if(empty(prop("last_touched")), prop("age_days"),
   dateBetween(today(), parseDate(formatDate(prop("last_touched"), "YYYY-MM-DD")), "days"))
```

`due_in_days` (9999 means no due date; negative means overdue)
```
if(empty(prop("due_date")), 9999,
   dateBetween(parseDate(formatDate(prop("due_date"), "YYYY-MM-DD")), today(), "days"))
```

`is_open`
```
prop("status") == "open" or prop("status") == "waiting_on_other" or prop("status") == "waiting_on_winette"
```

`is_snoozed`
```
!empty(prop("snoozed_until")) and dateBetween(prop("snoozed_until"), now(), "minutes") > 0
```

`nudge_candidate` (replace `"Winette"` with `"Colin Long"` in the TEST copy)
```
lets(
  ownerSet, !empty(prop("owner")) and prop("owner") != "Winette",
  fresh, empty(prop("nudged_at")) or dateBetween(prop("last_touched"), prop("nudged_at"), "minutes") > 0,
  (prop("status") == "open" or prop("status") == "waiting_on_other")
    and prop("stale_days") >= 3 and ownerSet and fresh
)
```

`escalation_candidate`
```
lets(
  gap, empty(prop("owner")) or empty(prop("next_step")),
  fresh, empty(prop("escalated_at")) or dateBetween(prop("last_touched"), prop("escalated_at"), "minutes") > 0,
  prop("is_open") and (prop("stale_days") >= 5 or (prop("age_days") >= 5 and gap)) and fresh
)
```

`metric_flag`
```
prop("is_open") and prop("age_days") > 5 and (empty(prop("owner")) or empty(prop("next_step")))
```

### 3.4 Views on WOS Ledger

| View | Layout | Filter | Sort | Show |
|---|---|---|---|---|
| Needs Winette | Table | `is_open` is checked AND `is_snoozed` is unchecked AND (`winette_action_needed` is checked OR `status` is waiting_on_winette) | `due_date` ascending, then `priority` ascending | item, priority, due_date, counterparty, next_step, source_link, artifact_link |
| Due 72h | Table | `is_open` is checked AND `is_snoozed` is unchecked AND `due_in_days` ≤ 3 | `due_date` ascending, then `priority` ascending | item, owner, due_date, due_in_days, status, source_link |
| Aging > 5d | Table | `is_open` is checked AND `age_days` > 5 | `age_days` descending | item, owner, next_step, age_days, stale_days, owning_agent |
| By agent | Board, grouped by `owning_agent`, empty groups shown | `is_open` is checked | `due_date` ascending | item, priority, due_date, owner |
| Nudge queue | Table | `nudge_candidate` is checked | `stale_days` descending | item, owner, counterparty, status, stale_days, nudged_at |
| Escalation queue | Table | `escalation_candidate` is checked | `age_days` descending | item, owner, next_step, age_days, stale_days, escalated_at |
| Weekly metric | Table, grouped by `type` | `metric_flag` is checked | `age_days` descending | item, owner, next_step, age_days. Footer calculation on `item`: Count all |

The Weekly metric view's count is the primary success metric (target 0); the `commitment` group's count is reported alongside. Trend comes from the `after.metric` value that `cos-weekly-review` writes into its `run_end` audit row.

## 4. Supabase build

### 4.1 What the migration does

- Creates schema `wos`, enum types for every enum above, six tables, and indexes, including a unique `dedupe_key` among open rows.
- Stamps `ledger.created_at` and `audit.at` in the database; clamps `last_touched` so it cannot sit in the future. Agents cannot game the aging metric by backdating.
- Writes an audit row for every insert, update, and delete on ledger, people, orgs, initiatives, and preferences, through a trigger that fires for every caller role. Ledger inserts log `create`, transitions into `done` or `dropped` log `close`, other changes log `update`; context changes log `context_update`.
- Makes `audit` append-only: update, delete, and truncate are revoked from every WinetteOS role and blocked by trigger even for the table owner.
- Enforces in the database: one-line `item`, non-empty `source_link`, `dedupe_key` prefix matching `source_type`, `routed_to` only on `chief_of_staff` rows, evidence in `notes` before `done` or `dropped`.
- Creates roles `wos_agent`, `wos_reader`, `wos_admin`, grants, and row level security. Agents can update only rows that are still open; closed rows are frozen.
- Creates read-only views with `security_invoker = true`, so the caller's own grants and policies apply.
- Seeds orgs (facts only) and preferences (defaults). `never_read_list` is deliberately not seeded.

Verified at build on PostgreSQL 16: the migration ran end to end into `wos` and, with the two-line edit in §4.3, into `wos_test` in the same database; the constraints, RLS, audit trigger, append-only guard, snooze filter, and every view returned the expected results against test rows.

### 4.2 Migration `001_wos_spine.sql`

```sql
-- WinetteOS spine, migration 001. Target: Supabase Postgres 15+ (plain Postgres 15+ also works).
-- The schema name appears ONLY on the next two statements. For the dogfood copy, change both to wos_test.
begin;
create schema if not exists wos;
set local search_path to wos, public;

-- 1. Roles (idempotent). Login users are created separately and granted membership (see D1 §4.4).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'wos_agent')  then create role wos_agent  nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'wos_reader') then create role wos_reader nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'wos_admin')  then create role wos_admin  nologin; end if;
end $$;

-- 2. Enum types. These are the only legal values.
create type item_type         as enum ('commitment','decision','approval','exception','task');
create type item_status       as enum ('open','waiting_on_other','waiting_on_winette','done','dropped');
create type source_kind       as enum ('email','meeting','chat','dictation','system');
create type agent_id          as enum ('chief_of_staff','travel_personal','sales','marketing','finance','operations','purchasing','demand_planning');
create type priority_level    as enum ('p1','p2','p3');
create type label_tag         as enum ('ASSUMPTION','INFERENCE');
create type org_kind          as enum ('parent','self','brand','retailer','distributor','broker','vendor','agency','board','other');
create type initiative_status as enum ('active','paused','done');
create type pref_category     as enum ('brief','quiet_hours','travel','system');
create type channel_kind      as enum ('email','phone','text','chat','in_person','via_assistant');
create type audit_action      as enum ('create','update','close','surface_alert','surface_brief','draft_created','hold_proposed','hold_created_on_tap','reminder_created_on_tap','context_update','feedback','rule_block','run_start','run_end','run_failed');
create type target_store      as enum ('ledger','context','gmail','calendar','drive','push','none');
create type tier_level        as enum ('T1','T2','T3');

-- 3. Helpers.
create function local_today() returns date
language sql stable as $$ select (now() at time zone 'America/New_York')::date $$;

create function touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- Agents call this at the top of every write transaction so audit rows carry agent, task and run.
create function set_actor(p_agent text, p_task text, p_run_id text) returns void
language plpgsql as $$
begin
  perform set_config('wos.agent',  p_agent,  true);
  perform set_config('wos.task',   p_task,   true);
  perform set_config('wos.run_id', p_run_id, true);
end $$;

-- 4. Ledger.
create table ledger (
  id                    uuid primary key default gen_random_uuid(),
  item                  text not null,
  type                  item_type not null,
  owner                 text,
  counterparty          text,
  due_date              date,
  source_type           source_kind not null,
  source_link           text not null,
  status                item_status not null default 'open',
  owning_agent          agent_id not null,
  priority              priority_level,
  winette_action_needed boolean not null default false,
  next_step             text,
  created_at            timestamptz not null default now(),
  last_touched          timestamptz not null default now(),
  notes                 text,
  -- added system fields
  dedupe_key            text not null,
  routed_to             agent_id,
  alert_requested       boolean not null default false,
  last_surfaced_at      timestamptz,
  surfaced_count        integer not null default 0,
  nudged_at             timestamptz,
  escalated_at          timestamptz,
  labels                label_tag[] not null default '{}',
  artifact_link         text,
  snoozed_until         timestamptz,
  body                  text,
  constraint item_one_line      check (length(btrim(item)) between 1 and 200 and position(E'\n' in item) = 0),
  constraint source_link_present check (length(btrim(source_link)) > 0 and source_link !~ '\s'),
  constraint dedupe_key_shape   check (split_part(dedupe_key, ':', 1) = source_type::text and dedupe_key ~ '^[a-z]+:.+:(commitment|decision|approval|exception|task):.*$'),
  constraint routed_only_via_cos check (routed_to is null or (owning_agent = 'chief_of_staff' and routed_to <> 'chief_of_staff')),
  constraint closed_needs_evidence check (status not in ('done','dropped') or length(btrim(coalesce(notes, ''))) > 0),
  constraint surfaced_count_nonneg check (surfaced_count >= 0),
  constraint touched_after_created check (last_touched >= created_at - interval '1 minute')
);
create unique index ledger_dedupe_open_uq on ledger (dedupe_key)
  where status in ('open','waiting_on_other','waiting_on_winette');
create index ledger_status_idx       on ledger (status);
create index ledger_agent_status_idx on ledger (owning_agent, status);
create index ledger_due_idx          on ledger (due_date) where status in ('open','waiting_on_other','waiting_on_winette');
create index ledger_touched_idx      on ledger (last_touched);

-- The database owns created_at; last_touched can never sit in the future. Agents cannot game the aging metric.
create function ledger_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at   := now();
    new.last_touched := now();
  else
    new.created_at   := old.created_at;
    new.last_touched := least(new.last_touched, now());
  end if;
  return new;
end $$;
create trigger ledger_guard before insert or update on ledger for each row execute function ledger_guard();

-- 5. Context store.
create table people (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  role              text,
  org               text,
  importance_tier   smallint not null default 3 check (importance_tier in (1,2,3)),
  preferred_channel channel_kind,
  email             text unique,
  aliases           text[] not null default '{}',
  notes             text,
  updated_at        timestamptz not null default now()
);

create table orgs (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  kind            org_kind not null,
  importance_tier smallint check (importance_tier in (1,2,3)),
  routing_hint    agent_id,
  notes           text,
  updated_at      timestamptz not null default now()
);

create table initiatives (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  owner           text,
  status          initiative_status not null default 'active',
  agents_involved agent_id[] not null default '{}',
  notes           text,
  updated_at      timestamptz not null default now()
);

create table preferences (
  key        text primary key,
  value      jsonb not null,
  category   pref_category not null,
  set_by     text not null,
  updated_at timestamptz not null default now(),
  constraint known_key check (key in ('brief_time_local','brief_word_cap','eod_word_cap','weekly_word_cap','alert_cap',
    'quiet_hours','aging_thresholds','never_read_list','active_agents','timezone_home','travel_preferences','brief_format','principal','data_sources','ops_sla_targets'))
);

create trigger people_touch      before update on people      for each row execute function touch_updated_at();
create trigger orgs_touch        before update on orgs        for each row execute function touch_updated_at();
create trigger initiatives_touch before update on initiatives for each row execute function touch_updated_at();
create trigger preferences_touch before update on preferences for each row execute function touch_updated_at();

-- 6. Audit (append-only).
create table audit (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default clock_timestamp(),
  agent        text not null,
  task         text,
  run_id       text,
  action       audit_action not null,
  target_store target_store not null,
  target_id    text,
  before       jsonb,
  after        jsonb,
  source_link  text,
  tier         tier_level,
  note         text,
  constraint agent_known check (agent in ('chief_of_staff','travel_personal','sales','marketing','finance','operations','purchasing','demand_planning') or agent like 'human:%')
);
create index audit_task_action_at_idx on audit (task, action, at desc);
create index audit_action_at_idx      on audit (action, at);
create index audit_target_idx         on audit (target_store, target_id);

-- The database stamps the time; callers cannot backdate.
create function audit_stamp() returns trigger
language plpgsql as $$ begin new.at := clock_timestamp(); return new; end $$;
create trigger audit_stamp before insert on audit for each row execute function audit_stamp();

-- No role, including the owner, can rewrite history through normal SQL.
create function audit_block_mutation() returns trigger
language plpgsql as $$ begin raise exception 'wos.audit is append-only (% blocked)', tg_op; end $$;
create trigger audit_no_update   before update or delete on audit for each row       execute function audit_block_mutation();
create trigger audit_no_truncate before truncate         on audit for each statement execute function audit_block_mutation();

-- Row-change audit for ledger and context tables. Fires for every caller role.
create function audit_row_change() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare
  v_agent  text  := nullif(current_setting('wos.agent',  true), '');
  v_task   text  := nullif(current_setting('wos.task',   true), '');
  v_run    text  := nullif(current_setting('wos.run_id', true), '');
  v_before jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_after  jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_store  text  := case when tg_table_name = 'ledger' then 'ledger' else 'context' end;
  v_action text;
  v_tier   text;
  v_note   text  := lower(tg_op) || ' on ' || tg_table_name;
begin
  if tg_op = 'UPDATE' and v_before = v_after then
    return null;
  end if;
  if v_store = 'ledger' then
    v_action := case
      when tg_op = 'INSERT' then 'create'
      when tg_op = 'UPDATE' and (v_after->>'status') in ('done','dropped')
                            and (v_before->>'status') not in ('done','dropped') then 'close'
      else 'update' end;
    v_tier := case when v_agent is not null then 'T1' end;
  else
    v_action := 'context_update';
    v_tier := case when v_agent is not null then 'T2' end;
  end if;
  execute format(
    'insert into %1$I.audit (agent, task, run_id, action, target_store, target_id, before, after, source_link, tier, note)
     values ($1, $2, $3, $4::%1$I.audit_action, $5::%1$I.target_store, $6, $7, $8, $9, $10::%1$I.tier_level, $11)',
    tg_table_schema)
  using coalesce(v_agent, 'human:' || session_user), v_task, v_run, v_action, v_store,
        coalesce(v_after->>'id', v_before->>'id', v_after->>'key', v_before->>'key'),
        v_before, v_after, coalesce(v_after->>'source_link', v_before->>'source_link'), v_tier, v_note;
  return null;
end $$;

create trigger ledger_audit      after insert or update or delete on ledger      for each row execute function audit_row_change();
create trigger people_audit      after insert or update or delete on people      for each row execute function audit_row_change();
create trigger orgs_audit        after insert or update or delete on orgs        for each row execute function audit_row_change();
create trigger initiatives_audit after insert or update or delete on initiatives for each row execute function audit_row_change();
create trigger preferences_audit after insert or update or delete on preferences for each row execute function audit_row_change();

-- 7. Row level security.
alter table ledger      enable row level security;
alter table people      enable row level security;
alter table orgs        enable row level security;
alter table initiatives enable row level security;
alter table preferences enable row level security;
alter table audit       enable row level security;

-- Ledger: agents read all, insert open rows, update only rows that are still open. Closed rows are frozen.
create policy ledger_admin_all     on ledger for all    to wos_admin  using (true) with check (true);
create policy ledger_reader_select on ledger for select to wos_reader using (true);
create policy ledger_agent_select  on ledger for select to wos_agent  using (true);
create policy ledger_agent_insert  on ledger for insert to wos_agent
  with check (status in ('open','waiting_on_other','waiting_on_winette'));
create policy ledger_agent_update  on ledger for update to wos_agent
  using (status in ('open','waiting_on_other','waiting_on_winette')) with check (true);

-- Context: agents and readers select only. Agents propose context changes as ledger items (T2); wos_admin applies them.
create policy people_admin_all       on people      for all    to wos_admin               using (true) with check (true);
create policy people_read            on people      for select to wos_agent, wos_reader   using (true);
create policy orgs_admin_all         on orgs        for all    to wos_admin               using (true) with check (true);
create policy orgs_read              on orgs        for select to wos_agent, wos_reader   using (true);
create policy initiatives_admin_all  on initiatives for all    to wos_admin               using (true) with check (true);
create policy initiatives_read       on initiatives for select to wos_agent, wos_reader   using (true);
create policy preferences_admin_all  on preferences for all    to wos_admin               using (true) with check (true);
create policy preferences_read       on preferences for select to wos_agent, wos_reader   using (true);

-- Audit: everyone with a role reads; agents insert only non-row actions (row changes are written by the trigger).
create policy audit_read          on audit for select to wos_admin, wos_agent, wos_reader using (true);
create policy audit_agent_insert  on audit for insert to wos_agent
  with check (agent not like 'human:%' and action not in ('create','update','close','context_update'));
create policy audit_admin_insert  on audit for insert to wos_admin
  with check (action in ('feedback','rule_block','run_failed'));

-- 8. Grants. Table names are unqualified on purpose; the search_path above decides the schema.
do $$
begin
  execute format('grant usage on schema %I to wos_agent, wos_reader, wos_admin', current_schema());
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on schema %I from anon, authenticated', current_schema());
  end if;
end $$;

grant select on ledger, people, orgs, initiatives, preferences, audit to wos_agent, wos_reader, wos_admin;
grant insert, update on ledger to wos_agent;
grant insert on audit to wos_agent, wos_admin;
grant insert, update, delete on ledger, people, orgs, initiatives, preferences to wos_admin;
revoke update, delete, truncate on audit from public, wos_agent, wos_reader, wos_admin;
revoke delete on ledger, people, orgs, initiatives, preferences from wos_agent, wos_reader;
revoke insert, update on people, orgs, initiatives, preferences from wos_agent, wos_reader;
revoke create on schema public from wos_agent, wos_reader;
revoke execute on function set_actor(text, text, text) from public;
grant execute on function set_actor(text, text, text) to wos_agent, wos_admin;

-- 9. Read-only views (security_invoker: the caller's grants and RLS apply).
create view v_ledger_aging with (security_invoker = true) as
with t as (
  select local_today() as today,
         coalesce((select (value->>'nudge_owner_at_days')::int        from preferences where key = 'aging_thresholds'), 3) as nudge_days,
         coalesce((select (value->>'escalate_to_winette_at_days')::int from preferences where key = 'aging_thresholds'), 5) as escalate_days,
         (select value->>'name' from preferences where key = 'principal') as principal
)
select l.*,
       t.today - (l.created_at   at time zone 'America/New_York')::date as age_days,
       t.today - (l.last_touched at time zone 'America/New_York')::date as stale_days,
       l.due_date - t.today                                              as due_in_days,
       l.status in ('open','waiting_on_other','waiting_on_winette')      as is_open,
       t.nudge_days, t.escalate_days, t.principal
from ledger l cross join t;

create view v_needs_winette with (security_invoker = true) as
select id, item, type, priority, due_date, due_in_days, counterparty, owner, status, owning_agent, routed_to,
       next_step, source_link, artifact_link, labels, last_surfaced_at, age_days
from v_ledger_aging
where is_open and (winette_action_needed or status = 'waiting_on_winette')
  and (snoozed_until is null or snoozed_until <= now())
order by due_date nulls last, priority nulls last, created_at;

create view v_due_72h with (security_invoker = true) as
select id, item, type, owner, counterparty, due_date, due_in_days, status, owning_agent, priority,
       winette_action_needed, next_step, source_link
from v_ledger_aging
where is_open and due_in_days <= 3
  and (snoozed_until is null or snoozed_until <= now())
order by due_date, priority nulls last;

create view v_aging_over_5d with (security_invoker = true) as
select id, item, type, owner, counterparty, next_step, status, owning_agent, routed_to, age_days, stale_days,
       (coalesce(btrim(owner), '') = '' or coalesce(btrim(next_step), '') = '') as missing_owner_or_next_step,
       source_link
from v_ledger_aging
where is_open and age_days > escalate_days
order by age_days desc;

create view v_by_agent with (security_invoker = true) as
select owning_agent,
       count(*) filter (where status = 'open')                                    as open,
       count(*) filter (where status = 'waiting_on_other')                        as waiting_on_other,
       count(*) filter (where status = 'waiting_on_winette')                      as waiting_on_winette,
       count(*) filter (where is_open and due_in_days < 0)                        as overdue,
       count(*) filter (where is_open and due_in_days between 0 and 3)            as due_72h,
       count(*) filter (where is_open and (winette_action_needed or status = 'waiting_on_winette')) as needs_winette,
       count(*) filter (where is_open and routed_to is not null)                  as held_for_inactive_agent,
       max(age_days) filter (where is_open)                                       as oldest_open_age_days
from v_ledger_aging
group by owning_agent
order by owning_agent;

create view v_nudge_candidates with (security_invoker = true) as
select id, item, owner, counterparty, status, stale_days, nudged_at, last_touched, source_link,
       case when status = 'waiting_on_other' then counterparty else owner end as nudge_to
from v_ledger_aging
where status in ('open','waiting_on_other')
  and stale_days >= nudge_days
  and coalesce(btrim(owner), '') <> ''
  and owner is distinct from principal
  and (nudged_at is null or nudged_at < last_touched)
order by stale_days desc;

create view v_escalation_candidates with (security_invoker = true) as
select id, item, owner, next_step, status, owning_agent, age_days, stale_days, escalated_at, source_link,
       case when stale_days >= escalate_days then 'stale' else 'unowned_or_no_next_step' end as reason
from v_ledger_aging
where is_open
  and (stale_days >= escalate_days
       or (age_days >= escalate_days and (coalesce(btrim(owner), '') = '' or coalesce(btrim(next_step), '') = '')))
  and (escalated_at is null or escalated_at < last_touched)
order by age_days desc;

create view v_metric_weekly with (security_invoker = true) as
select now() as measured_at,
       count(*) filter (where is_open and age_days > 5
                          and (coalesce(btrim(owner), '') = '' or coalesce(btrim(next_step), '') = '')) as metric_all_types,
       count(*) filter (where is_open and age_days > 5 and type = 'commitment'
                          and (coalesce(btrim(owner), '') = '' or coalesce(btrim(next_step), '') = '')) as metric_commitments,
       count(*) filter (where is_open)                                                                  as open_total,
       0                                                                                                as target
from v_ledger_aging;

create view v_alerts_today with (security_invoker = true) as
with a as (
  select coalesce(after->>'origin_agent', agent) as origin
  from audit
  where action = 'surface_alert'
    and (at at time zone 'America/New_York')::date = local_today()
), cap as (
  select coalesce((select (value #>> '{}')::int from preferences where key = 'alert_cap'), 5) as alert_cap
)
select local_today()                                        as local_date,
       (select count(*) from a)::int                        as alerts_sent,
       cap.alert_cap,
       greatest(cap.alert_cap - (select count(*) from a)::int, 0) as remaining,
       coalesce((select jsonb_object_agg(origin, n) from (select origin, count(*) as n from a group by origin) s), '{}'::jsonb) as by_origin_agent
from cap;

grant select on v_ledger_aging, v_needs_winette, v_due_72h, v_aging_over_5d, v_by_agent,
                v_nudge_candidates, v_escalation_candidates, v_metric_weekly, v_alerts_today
  to wos_agent, wos_reader, wos_admin;

-- 10. Seeds: facts from the build spec only. never_read_list is NOT seeded: every task fails closed until it is set.
insert into orgs (name, kind, importance_tier, routing_hint, notes) values
  ('Origin Brands Inc',  'self',        null, null,             'Commercial arm of Certified Origins.'),
  ('Certified Origins',  'parent',      1,    'chief_of_staff', 'ASSUMPTION: tier 1 until set. Reporting deadlines route to finance (D3).'),
  ('Seggiano',           'brand',       null, null,             null),
  ('Bellucci',           'brand',       null, null,             null),
  ('Lunaio',             'brand',       null, null,             null),
  ('Vichy Catalan',      'brand',       null, null,             null),
  ('Toca Honey',         'brand',       null, null,             null),
  ('Whole Foods Market', 'retailer',    1,    'sales',          'Primary retail account. ASSUMPTION: tier 1 until set.'),
  ('UNFI',               'distributor', 1,    null,             'ASSUMPTION: tier 1 until set. Topic decides owner: commercial to sales, logistics to operations (D3).'),
  ('KeHE',               'distributor', 1,    null,             'ASSUMPTION: tier 1 until set. Topic decides owner: commercial to sales, logistics to operations (D3).');

insert into preferences (key, value, category, set_by) values
  ('brief_time_local',   '{"time":"07:00","tz":"America/New_York"}',                                  'brief',       'build-spec (confirm)'),
  ('brief_word_cap',     '300',                                                                         'brief',       'build-spec'),
  ('eod_word_cap',       '120',                                                                         'brief',       'build-spec'),
  ('weekly_word_cap',    '400',                                                                         'brief',       'build-default ASSUMPTION'),
  ('alert_cap',          '5',                                                                           'system',      'build-spec'),
  ('quiet_hours',        '{"start":"20:00","end":"07:00","tz":"America/New_York"}',                   'quiet_hours', 'build-default ASSUMPTION'),
  ('aging_thresholds',   '{"nudge_owner_at_days":3,"escalate_to_winette_at_days":5}',                 'system',      'build-spec'),
  ('active_agents',      '["chief_of_staff","travel_personal"]',                                      'system',      'build-spec'),
  ('timezone_home',      '"America/New_York"',                                                        'travel',      'build-default ASSUMPTION'),
  ('travel_preferences', '{}',                                                                          'travel',      'build-default (empty until the principal fills it)'),
  ('brief_format',       '{"order":["decisions_needed","due_72h","today","travel","overnight_asks"],"codes":true,"weekend":"only_if_decisions_or_travel"}', 'brief', 'build-spec; weekend rule ASSUMPTION'),
  ('principal',          '{"name":"Winette","role":"CEO","org":"Origin Brands Inc"}',                 'system',      'build-spec'),
  ('data_sources',       '{"CRM":"unknown","ACCOUNTING_SYSTEM":"unknown","ERP_SYSTEM":"unknown","INVENTORY_SOURCE":"unknown","PURCHASING_SOURCE":"unknown","DEMAND_DATA":"unknown","MARKETING_STACK":"unknown","SALES_TRACKERS":"unknown","SALES_REPORT_LINKS":"unknown","CAMPAIGN_CALENDAR":"unknown","BUDGET_SOURCE":"unknown","REPORTING_CALENDAR":"unknown","DEDUCTION_SOURCE":"unknown"}', 'system', 'build-default (every source unknown until confirmed)'),
  ('ops_sla_targets',    '{}',                                                                          'system',      'build-default (empty until Ops sets targets)');

commit;
```

### 4.3 The test schema (`wos_test`)

The schema name appears only in the two statements at the top: `create schema if not exists wos;` and `set local search_path to wos, public;`. Every other object is created unqualified and lands in whatever schema the search path names. The audit trigger writes to `tg_table_schema`, and grants read `current_schema()`. To build the dogfood copy, change `wos` to `wos_test` in those two statements and run the file again. Roles are shared across both schemas.

### 4.4 Login roles and connection

Create login users outside the migration so no secret lands in a file:

```sql
create role wos_agent_svc   login password '{{from secret store}}' in role wos_agent;
create role wos_reader_svc  login password '{{from secret store}}' in role wos_reader;
create role wos_admin_colin login password '{{from secret store}}' in role wos_admin;
```

Agents open every write with the actor call, in one transaction, so the audit trigger records agent, task, and run:

```sql
begin;
select wos.set_actor('chief_of_staff', 'ledger-capture', '{{run_id}}');
insert into wos.ledger (item, type, owner, counterparty, due_date, source_type, source_link,
                        owning_agent, winette_action_needed, next_step, dedupe_key, notes)
values ({{...}})
on conflict (dedupe_key) where status in ('open','waiting_on_other','waiting_on_winette')
do update set notes = concat_ws(E'\n', wos.ledger.notes, excluded.notes), last_touched = now();
commit;
```

The `on conflict` clause is the dedupe rule: a second agent proposing the same key appends its evidence to `notes` instead of creating a row.

**Connector warning.** ASSUMPTION: an off-the-shelf connector such as a Supabase MCP server acting with project-owner rights connects as a privileged role. Grants and RLS do not apply to it, and an owner can disable triggers or drop tables. The audit triggers still fire on every write it makes, so mistakes are caught, but a privileged connector is not tamper-resistant. Recommendation: agents connect as `wos_agent_svc` through a direct Postgres connection (orchestrated harness, D9) or a small custom MCP server that holds only that credential. If the Data API is used instead, do not expose `wos` to `anon` or `authenticated`; the migration revokes both when they exist.

## 5. Aging queries

All derive from `AGING_THRESHOLDS` (`nudge_owner_at_days: 3`, `escalate_to_winette_at_days: 5`). Calendar days, America/New_York (ASSUMPTION).

| Rule | Definition | Supabase | Notion |
|---|---|---|---|
| Nudge candidate | Status `open` or `waiting_on_other`; `stale_days >= 3`; owner set and not the principal; never nudged or nudged before the last substantive change | `select * from wos.v_nudge_candidates;` (`nudge_to` = counterparty when `waiting_on_other`, else owner) | Nudge queue view |
| Escalation candidate | Open status; `stale_days >= 5`, or `age_days >= 5` with owner or next step empty; never escalated or escalated before the last substantive change | `select * from wos.v_escalation_candidates;` (`reason` = `stale` or `unowned_or_no_next_step`) | Escalation queue view |
| Primary metric | Open status; `age_days > 5`; owner or next step empty. Target 0 | `select metric_all_types, metric_commitments, open_total from wos.v_metric_weekly;` | Weekly metric view, Count all |

Items the principal owns are never nudged by draft. They escalate into Decisions needed (D3).

Metric trend (last four weekly reviews):

```sql
select (at at time zone 'America/New_York')::date as week_of,
       (after->'metric'->>'metric_all_types')::int as metric_all_types,
       (after->'metric'->>'metric_commitments')::int as metric_commitments
from wos.audit
where task = 'cos-weekly-review' and action = 'run_end'
order by at desc
limit 4;
```

Task watermark:

```sql
select after->>'watermark' as watermark
from wos.audit
where task = '{{task_name}}' and action = 'run_end'
order by at desc
limit 1;
```

Alert cap check before any alert:

```sql
select alerts_sent, alert_cap, remaining, by_origin_agent from wos.v_alerts_today;
```

## 6. Spine contract

| Object or field | Agents (`wos_agent`) | Colin (`wos_admin`) | Principal |
|---|---|---|---|
| Ledger: create row | Yes, open status only, with `source_link` and `dedupe_key` | Yes | Through dictation; `chief_of_staff` writes it |
| Ledger: `status` to `done` | Only with evidence (link) in `notes` | Yes | Reply verb `done` |
| Ledger: `status` to `dropped` | Never on its own judgment. Only to apply the principal's or owner's `drop` reply, cited in `notes` | Yes | Reply verb `drop` |
| Ledger: `priority`, `last_surfaced_at`, `surfaced_count`, `escalated_at`, `snoozed_until` | `chief_of_staff` only | Yes | Reply verb `snooze` sets `snoozed_until` through `chief_of_staff` |
| Ledger: `nudged_at` | `chief_of_staff` (`aging-nudges`) only | Yes | |
| Ledger: `owning_agent`, `routed_to` | Functional agents set themselves on create in their domain; `chief_of_staff` routes and reassigns. One exception: a cross-agent request (hold request, feasibility check, spend view) is a `task` row the requester creates with `owning_agent` set to the agent that must act and `requested_by: <agent>` in `notes`; if that agent is inactive, `owning_agent` is `chief_of_staff` and `routed_to` is the target | Yes | Reply verb `assign` changes `owner` |
| Ledger: `created_at` | Never (store-set) | Never | Never |
| Ledger: `last_touched` | On a substantive change only | Yes | |
| Ledger: rows another agent owns | Append evidence to `notes` only (the dedupe upsert) | Yes | |
| Ledger: delete | Never | Yes, logged | No |
| People, Orgs, Initiatives | Read only. Propose a change as a ledger item (T2); Colin applies it after his or the principal's confirm | Read and write | Confirms proposals |
| Preferences | Read only | Only writer | Tells `chief_of_staff`; Colin applies |
| Audit | Append rows for non-row actions (`surface_alert`, `surface_brief`, `draft_created`, `hold_proposed`, `hold_created_on_tap`, `reminder_created_on_tap`, `feedback`, `rule_block`, `run_start`, `run_end`, `run_failed`). Row changes are trigger-written in Supabase and agent-written in Notion | Append `feedback`, `rule_block`, `run_failed` only | Never |
| DDL (schema, tables, views) | Never | Through migrations only | Never |

Supabase grants that implement the agent column exactly: `wos_agent` has insert and update on `wos.ledger`, insert only on `wos.audit`, select on every context table and view, no delete anywhere, no create on any schema. Verified with `has_table_privilege` and `has_schema_privilege` at build.

Fail-closed rule: if `never_read_list` is missing from Preferences, or a functional agent's entry in `data_sources` is `"unknown"`, the task writes `run_failed` and stops.
