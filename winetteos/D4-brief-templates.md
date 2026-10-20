# D4 · Brief and alert templates

- **What:** The exact text formats for the morning brief, end-of-day close, weekly review, alerts and trip brief. Each is shown as an iPhone push and a Mac view with placeholder data, along with the visual language that makes them look the part.
- **Decides:** Words and structure are fixed and travel to any surface (Text fidelity). The styled look applies wherever WinetteOS controls rendering (Styled fidelity). Push text is the first line of every run.
- **Open:** `PUSH_CHANNEL` and `MAC_SURFACE` decide how much of the styled look she actually sees (ASSUMPTION: Claude app, Text fidelity in Phase 1). Reply codes or tap buttons is a discovery question for Winette (D8 §9).

**Renders:**
- Design canvas, private until Colin shares it: https://claude.ai/artifact/A6eA8gESTx2uphVgeTG7R2
- Offline copy in this folder: `D4-render.html`

Every bracketed name, and every time and count, on these pages is a placeholder.

## 1. Two fidelity levels

| Level | What she sees | Where it works | Phase |
|---|---|---|---|
| **Text** | The canonical text in §3 to §7: same words, same order, same codes | Anywhere: Claude app, Notion, Slack, a page in the ledger store | Phase 1 default |
| **Styled** | Text rendered in the visual language (§8): Cormorant titles, olive section rules, brass item codes, tap buttons | Only a surface WinetteOS renders itself, for example a private brief page linked from the push | Pilot option. ASSUMPTION: needs a rendering surface; INFERENCE: feasible with a daily published page |

**Design rule:** the words carry the luxury. Push notifications always render in the phone's system type, so a push line must be quietly elegant as plain text.

## 2. Push anatomy

| Part | Rule | Source |
|---|---|---|
| Title | Digest or alert name, max 40 characters. Shown only if `PUSH_CHANNEL` supports a title (ASSUMPTION) | D3 §9 |
| Body | First line of the run's output, max 140 characters, no markdown | D2 Chief of Staff, Output formats |
| Tap | Opens the full view (Mac or iPhone) | `MAC_SURFACE` |

| Surface | Title | Body (placeholder data) |
|---|---|---|
| Morning brief | `Tue 20 Oct · Morning brief` | `3 decisions · first: Approve [Brand] promo calendar for [Distributor]` |
| Morning brief, nothing to decide | `Tue 20 Oct · Morning brief` | `Nothing needs your decision · 4 meetings today` |
| EOD close | `Tue · Close` | `6 closed, 4 advanced. 3 waiting on you tomorrow. 2 drafts ready to send.` |
| Weekly review | `Week of 19 Oct · Weekly review` | `0 open items over 5 days without owner or next step · target 0` |
| Trip brief | `Trip brief · [City]` | `Fri 23 to Sat 24 Oct · 1 gap: no hotel confirmation for Fri night` |
| Setup failure | `Morning brief` | `Brief paused: setup needs attention.` |
| Silent run | none | A run with nothing to surface outputs exactly `NO_PUSH` as its first line and sends no notification (ASSUMPTION: `PUSH_CHANNEL` can suppress it; D5 Runtime) |

Push text never carries confirmation codes, amounts, or anything on the never-read list.

## 3. Morning brief (cap 300 words, daily by 07:00)

### 3.1 Template

```
{{Weekday}} {{D Mon}} · Morning brief
{{n}} decisions · {{n}} due in 72h · {{n}} meetings

DECISIONS NEEDED
D1  {{verb-first item}} · due {{when}} · {{counterparty}}
    {{why now, one clause}} · {{source link}}
Still waiting on you: {{n}}, oldest {{n}}d · reply "D more"

DUE IN 72H
U1  {{item}} · {{owner}} · {{when}}

TODAY
M1  {{h:mm}} {{meeting}} · {{one-line context: open items or prep owed}}

TRAVEL
T1  {{segment or exception}}

OVERNIGHT ASKS
I1  {{sender}}: {{ask}} · {{proposed action}}
```

### 3.2 Rules

- **Fixed order.** Empty sections are omitted, except Decisions needed, which reads "Nothing needs your decision." A brief with nothing in any section is one line: "Nothing needs you today."
- **Decisions needed** holds new or changed decisions, approvals and escalations, ordered by score (D3 §5.1). Decisions she has already seen collapse into the "Still waiting on you" line.
- **Travel** appears only if a trip starts within 72h or a travel exception is open. It links the trip brief.
- **Overnight asks** covers mail since the last EOD close that asks her something. Each ask carries a proposed action: "Drafted. Open to send.", a proposed hold, or "Reply needed".
- **Over cap:** trim Due in 72h first, then meeting context. Never trim Decisions needed. Close with "+{{n}} more in ledger".
- **Weekends:** sent only if Decisions needed or Travel has content (ASSUMPTION).

### 3.3 Rendered: Text fidelity (placeholder data, within the 300-word cap)

```
Tue 20 Oct · Morning brief
3 decisions · 4 due in 72h · 5 meetings

DECISIONS NEEDED
D1  Approve [Brand] promo calendar for [Distributor] · due today 12:00 · [Distributor]
    Their deadline; nothing sent yet. · [source]
D2  Choose a date for the [Board member 1] review · due Wed · Board
    Two proposed holds, both clear: Thu 10:00 or Fri 15:00. · [source]
D3  Assign, move, or drop: send [Doc] to [Certified Origins executive] · 6d
    Escalated: no owner, no next step. · [source]
Still waiting on you: 2, oldest 3d · reply "D more"

DUE IN 72H
U1  [Deck] to [WFM category buyer] · [Direct report] · Thu
U2  Countersigned [Agreement] back to [Vendor] · you · Wed
U3  [Report] inputs to Certified Origins · [Finance lead] · Thu
U4  Reply to [Person] on [Topic] · you · today

TODAY
M1  9:30 [Direct report] 1:1 · you owe feedback on [Doc]
M2  11:00 [WFM category buyer] call · 1 open commitment (U1)
M3  14:30 [Person], moved from 14:00 · no open items
M4  16:00 [Board member 1] · D2 pending
M5  17:30 [Internal review] · no open items

TRAVEL
T1  Fri 7:10 [Flight] to [City] · no hotel confirmation found for Fri night

OVERNIGHT ASKS
I1  [Person], Certified Origins: approve [Topic] by Fri · Drafted. Open to send.
I2  [Broker]: confirm attendance at [Event] · proposed hold Thu 18:00 to 20:00
```

### 3.4 Rendered: iPhone and Mac

| Board | What it shows |
|---|---|
| iPhone · Lock screen at 7:00 | The brief push above the previous evening's close. Two notifications overnight is the intended feel |
| iPhone · Morning brief | The Styled view. Tap buttons map one to one onto reply verbs: Approve = `D1 yes`, Hold = `I2 hold` |
| Mac · Morning brief | Three panes: navigation with live counts; the brief in two columns under the decisions; the selected item with source, prepared draft, history, and the reason it surfaced ("due within 24h · needs your decision · tier 1 counterparty") |

## 4. End-of-day close (cap 120 words, weekdays by 18:00)

### 4.1 Template

```
{{Weekday}} · Close
MOVED  {{n}} closed · {{n}} advanced
  {{one-liner, up to 3}}
TOMORROW  {{n}} waiting on you
  D1  {{item}} · due {{when}}
DRAFTS  {{n}} ready in Gmail
  {{recipient}} · {{subject}} · {{draft link}}
```

### 4.2 Rendered (placeholder data, within the 120-word cap)

```
Tue · Close
MOVED  6 closed · 4 advanced
  [Distributor] promo calendar approved.
  [Agreement] countersigned and returned.
  [Board member 1] review held for Thu 10:00.
TOMORROW  3 waiting on you
  D1  Assign, move, or drop: [Doc] to [Certified Origins executive]
  U1  [Report] inputs to Certified Origins · Thu
  U2  Attendance at [Event] for [Broker] · Thu
DRAFTS  3 ready in Gmail
  [Direct report] · [Report] follow-up · [draft link]
  [Vendor] · [Agreement] follow-up · [draft link]
  [Person] · Re: [Topic] · [draft link]
```

The Styled view (iPhone · End-of-day close) uses Nocturne, the evening palette, and closes with "Nothing was sent. Drafts wait in Gmail until you send them."

## 5. Weekly review (cap 400 words, Mondays by 07:30)

### 5.1 Template

```
Week of {{D Mon}} · Weekly review
THE NUMBER
  {{n}} open items over 5 days with no owner or no next step · target 0
  Prior weeks: {{n}} · {{n}} · {{n}}   Commitments only: {{n}}
AGING
  D1  {{item}} · {{owner or "unowned"}} · {{next step or "no next step"}} · {{n}}d
BY FUNCTION
  {{function}}: {{n}} exceptions · {{top one-liner}}
SYSTEM
  Rule blocks {{n}} · Alerts {{n}} of {{cap x days}} · Not for me {{n}} · Missed runs {{n}}
```

### 5.2 Rendered (placeholder data)

```
Week of 19 Oct · Weekly review
THE NUMBER
  0 open items over 5 days with no owner or no next step · target 0
  Prior weeks: [2] · [1] · [0]   Commitments only: 0
AGING
  D1  [Doc] to [Certified Origins executive] · [Direct report] · draft by Wed · 8d
  D2  [Agreement] redlines from [Vendor] · you · waiting on [Vendor] · 7d
  D3  [Topic] follow-up with [Broker] · unowned · no next step · 5d
BY FUNCTION
  Commitments and inbox: [3] exceptions · [top one-liner]
  Calendar and travel: [1] exception · [top one-liner]
SYSTEM
  Rule blocks 0 · Alerts [14] of 25 · Not for me [1] · Missed runs 0
```

D3 at exactly 5 days escalates in the brief but is not yet counted in the number, which counts items over 5 days (D1, aging and metric queries). By function uses business functions, never agent names, and lists only active functions. The Mac board shows inactive functions as dashed placeholders so the roadmap is visible without adding noise.

## 6. Alerts (max 5 per day, all functions combined)

**Format:** title `{{Decision|Slip risk|Commitment|Exception}} · {{counterparty or topic}}` (max 40 characters). Body: verb first, due, why now, reply code (max 140 characters). Allocation, quiet hours and the travel exemption are in D3 §5.

| Agent | Phase | Title | Body | Body chars |
|---|---|---|---|---|
| Chief of Staff | 1 | Slip risk · [Board member 1] | Send [Doc] to [Board member 1] · due today 17:00. Committed Mon; no draft yet. Reply A1 open. | 93 |
| Travel & Personal | 1 | Exception · [Flight] Fri | [Flight] to [City] cancelled per [Airline] email · departs 7:10. No rebooking found. Reply A2 open. | 99 |
| Sales | 2, inactive | Decision · Whole Foods Market | Pick the [Brand] review date with [WFM category buyer] · due Thu. Two dates offered; no reply yet. Reply A3 open. | 113 |
| Marketing | 2, inactive | Decision · [Brand] launch | Approve [Brand] packaging artwork · due today. The [Printer] slot on [date] depends on it. Reply A4 open. | 105 |
| Finance | 3, inactive | Exception · Certified Origins | [Report] due to Certified Origins Fri · 2 inputs missing, owners [Finance lead] and [Ops lead]. Reply A5 open. | 110 |
| Operations | 3, inactive | Exception · UNFI | Short-ship on [PO] to UNFI [DC] · [n] lines. Follow-up to [Contact] drafted. Reply A1 open. | 91 |
| Purchasing | 3, inactive | Exception · [Supplier] | [PO] for [SKU] is past [Supplier]'s promised date · no ship confirmation. Follow-up drafted. Reply A2 open. | 107 |
| Demand Planning | 3, inactive | Slip risk · [SKU] at [Account] | Stockout risk on [SKU] at [Account] inside supplier lead time, per [Source]. Reorder proposal ready. Reply A3 open. | 115 |

Codes reset daily; the examples span several days. Functional agents never push. Every alert above is surfaced by the Chief of Staff from a ledger row the functional agent wrote with `alert_requested: true`. The only exception is a travel disruption within 12 hours of departure.

## 7. Trip brief (cap 250 words, by 72h before departure, refreshed the morning of the day before)

### 7.1 Template (from D2 Travel & Personal)

```
Trip brief · {{City}} · {{Tue 20 Oct}} to {{Thu 22 Oct}}
SHAPE
  {{n}} nights · {{cities}} · {{local zone}}, {{+n or -n}}h vs New York
ITINERARY
  T1  {{Tue 20 Oct}} {{h:mm local}} {{carrier}} {{flight}} {{origin}} to {{destination}} · conf {{code}}
  T2  {{hotel}} · {{check-in}} to {{check-out}} · conf {{code}}
PEOPLE
  M1  {{h:mm local}} {{meeting}} · {{open ledger items with attendees, or "No open items"}}
GAPS
  T3  {{gap or conflict, stated as fact}}
ASKS
  T4  {{proposed hold, reminder, or draft}} · reply "T4 yes"
```

GAPS always appears and reads "None" when clear. Confirmation codes appear in the full view only, never in a push.

### 7.2 Rendered (placeholder data, within the 250-word cap)

```
Trip brief · [City] · Fri 23 Oct to Sat 24 Oct
SHAPE
  1 night · [City] · [Zone], 3h behind New York
ITINERARY
  T1  Fri 23 Oct 7:10 ET [Airline] [Flight] [Origin] to [City] · conf [Code]
  T2  Fri 23 Oct 9:25 local · arrive [City]
  T3  Sat 24 Oct 16:40 local [Airline] [Flight] [City] to [Origin] · conf [Code]
PEOPLE
  M1  Fri 10:30 [WFM category buyer] · you owe [Deck], due Thu
  M2  Sat 9:00 [Broker] · no open items
GAPS
  T4  No hotel confirmation found for Fri night.
  T5  [WFM category buyer] starts 65 minutes after landing.
ASKS
  T6  Private hold Fri 9:25 to 10:30, arrival and transfer · reply "T6 yes"
  T7  Ask [WFM category buyer] for 11:30 instead · Drafted. Open to send.
```

T5 comes from the 90-minute post-landing threshold in the Travel & Personal charter (ASSUMPTION threshold). The Styled board (iPhone · Trip brief) draws the itinerary as a brass timeline and marks gaps in terracotta.

## 8. Visual language (Styled fidelity)

### 8.1 Principle

Quiet, exact, unhurried. The visual language borrows from a private bank's correspondence and an olive grove at dusk: parchment, ink, olive, brass. It is WinetteOS's own identity, not a reproduction of any Origin Brands or Certified Origins brand asset.

### 8.2 Palette

| Token | Day (Parchment) | Evening (Nocturne) | Use |
|---|---|---|---|
| Ground | `#F5F0E6` Parchment | `#11120E` Nocturne | Page background |
| Rail | `#EFE9DD` Linen | `#2C2D26` Night | Sidebars, notification cards |
| Text | `#1A1915` Ink | `#EDE6D6` Bone | Primary text, primary button fill (day) |
| Muted | `#5E5A50` | `#A39D8C` | Meta lines |
| Section | `#4F5B35` Olive | `#A7B47E` Olive leaf | Section labels |
| Code | `#7A5C28` Brass text, `#B8955A` brass rule | `#C9A46A` Gilt | Item codes, links, monogram |
| Risk | `#9C4A2F` Terracotta | `#D98A6A` Clay | Escalations, gaps, moved meetings |

Contrast check (WCAG relative luminance, computed): Ink, Muted, Olive, Brass text and Terracotta on Parchment are all at or above 4.5:1. Muted, Gilt and Clay on Nocturne are all above 6:1. The light brass `#B8955A` (2.5:1 on Parchment) is for hairlines and decorative rules only, never text.

### 8.3 Type

| Role | Face | Size and weight |
|---|---|---|
| Titles, times, the number | Cormorant Garamond | 46 to 64px (200px for the weekly number), 500 |
| Items | Instrument Sans | 15 to 16px, 500 |
| Meta | Instrument Sans | 13px, 400 |
| Section labels and codes | Instrument Sans | 11px, 600, tracked 0.16em, uppercase |
| Push notifications | Phone system type | Not controllable |

Both faces are Google Fonts. ASSUMPTION: acceptable for internal use; confirm if Origin Brands has brand fonts it prefers.

### 8.4 Components

- **Item code chip:** 32 x 22px, 1px brass rule, 6px radius, brass text. The same code she can type in a reply.
- **Section rule:** olive label followed by a hairline that fills the row.
- **Buttons:** 44px tall pills, which meets the touch-target minimum. One filled ink button per item for the expected action; outlined buttons for the alternatives.
- **Escalation tag:** terracotta outline, uppercase 10px.
- **Monogram:** an italic Cormorant "W" in a thin brass ring. It serves as the app mark, the lock-screen wallpaper motif and the header seal.
- **Theme by hour:** Parchment for the morning brief and day views, Nocturne for the close and anything after 18:00. ASSUMPTION: follow the device's appearance setting if she prefers.

## 9. Live answers (chat)

Answers in conversation follow the same voice (D3 §9): verb first, a source link on every factual line, no narrator. A query answer is a list in the brief's item format with codes, so the reply grammar works mid-conversation:

```
[Account] · 3 open
U1  [Deck] to [WFM category buyer] · [Direct report] · Thu · [source]
D1  Confirm [Brand] review date · you · Fri · [source]
U2  [Sample request] from [Person] · waiting on [Person] · [source]
```
