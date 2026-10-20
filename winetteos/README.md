# WinetteOS

- **What:** The build artifacts for WinetteOS, an agentic chief-of-staff system for Winette, CEO of Origin Brands Inc. One voice in front, eight specialist agents behind it, one shared ledger.
- **Decides:** Phase 1 is the Chief of Staff and Travel & Personal, dogfooded on Colin's accounts first (D8). Phases 2 and 3 are fully chartered and stay inactive until their data sources are confirmed (D9 §8).
- **Open:** See D9. Items marked P1 there block the dogfood or the pilot.

| File | Deliverable |
|---|---|
| `D1-spine-schema.md` | Ledger, context store and audit table: Notion build and a Supabase migration validated on PostgreSQL 16 |
| `D2-charter-*.md` (8) | One standalone system prompt per agent |
| `D3-orchestration.md` | Routing, conflicts, the five-alert budget, dedupe, the one-voice style guide |
| `D4-brief-templates.md` | Brief, close, weekly, alert and trip formats; visual language |
| `D4-render.html` | Offline render of the iPhone and Mac surfaces (open in a browser) |
| `D5-scheduled-tasks.md` | Every scheduled task: cron, connectors, writes, full standalone prompt |
| `D6-integration-map.md` | Systems, scopes and approval status per agent |
| `D7-access-governance.md` | One-pager for the Workspace admin and system owners |
| `D8-dogfood-runbook.md` | Phase 1 week on Colin's accounts, daily checklist, exit criteria |
| `D9-open-questions.md` | Every assumption by answerer, the build track recommendation, what is not done |

Read in this order: D9 §1 for status, D3 for how it behaves, D4 for what Winette sees, then D8 to start.
