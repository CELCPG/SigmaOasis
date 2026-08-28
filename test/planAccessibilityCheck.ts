/**
 * What a screen reader is handed for a plan block, measured on the real
 * Chromium accessibility tree.
 *
 * Round 9 contained focus in five modal surfaces and a blind critic reported
 * the same gap one level over: the plan block "carries no accessible names at
 * all — `aria-label: []`, `role: []`, `title: []` in both runs. The cancelled
 * state is conveyed entirely by glyph, strikethrough and colour class." That
 * reading came from scraping DOM attributes off a captured snapshot, which is
 * the wrong instrument twice over — it cannot see a name a browser *computes*
 * (an `<ol>` is a list with no `role=` on it), and it cannot see the names a
 * browser computes *wrongly*. Both halves mattered here.
 *
 * So this check does what a claim about a screen reader has to do: it boots the
 * shipped `out/main` on a throwaway profile seeded with five real plans, opens
 * a CDP session against the live window and reads `Accessibility.getFullAXTree`
 * — the computed tree, names and roles as the platform API exposes them, not
 * the markup they were computed from.
 *
 * What the tree said before this round, verbatim:
 *
 *     running  → button "2. Step 2 detail 2 Tools — none planned…" [disabled]
 *     pending  → button "3. Step 3 detail 3 Tools — none planned…" [disabled]
 *     done     → button "1. Step 1 detail 1 Tools — none planned… ▸"
 *     failed   → button "2. Step 2 detail 2 Tools — none planned… ▸"
 *
 * A step that had failed and a step that had succeeded produced byte-identical
 * accessible names, and so did a step still running and a step not yet started.
 * The entire difference was a bare `StaticText` glyph — `✓` against `✗`, `◌`
 * against `○` — parked outside the row, plus a colour class. Twelve of the
 * sixteen rows were `<button disabled>`: controls that were never controls,
 * announcing "dimmed, unavailable" for a checklist entry nobody was ever meant
 * to press. And every disclosure the block had fought to add — the tool
 * forecast, the unrun-forecast note, the ⚠️ undisclosed-run warning — was
 * swallowed whole into those button names and arrived as one run-on breath.
 *
 * Each assertion below carries its true negative, because most of these can be
 * bought cheaply and falsely: a build that labels every row "step" scores
 * perfectly on "every row has a name", and one that marks the whole block
 * `aria-live` scores perfectly on "the outcome is announced" while making the
 * block unusable. The negatives are what stop that.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OUTCOME_LABEL, STATUS_LABEL } from '../src/renderer/src/lib/planState'
import type { PlanOutcome, PlanStepStatus } from '../src/renderer/src/types'

/** Every terminal word the header can say, for the negatives below. */
const OUTCOME_WORDS = Object.values(OUTCOME_LABEL)

/**
 * The fixtures, and the statuses each row is seeded with — the check reads the
 * tree back against this, so a row that silently changed status would fail
 * rather than be measured against itself.
 */
interface Fixture {
  route: string
  statuses: PlanStepStatus[]
  /** Rows with something to open. Every other row must expose no control. */
  expandable: number[]
  outcome?: PlanOutcome
  approved: boolean
  /** The header's live word when there is no outcome. */
  liveWord?: string
}

const FIXTURES: Fixture[] = [
  {
    route: 'AX · cancelled',
    statuses: ['skipped', 'skipped', 'skipped'],
    expandable: [],
    outcome: 'cancelled',
    approved: false
  },
  {
    route: 'AX · stopped',
    statuses: ['done', 'stopped', 'skipped', 'skipped'],
    expandable: [0],
    outcome: 'stopped',
    approved: true
  },
  {
    route: 'AX · awaiting',
    statuses: ['pending', 'pending', 'pending'],
    expandable: [],
    approved: false,
    liveWord: 'awaiting approval'
  },
  {
    route: 'AX · running',
    statuses: ['done', 'running', 'pending'],
    expandable: [0],
    approved: true,
    liveWord: 'running'
  },
  {
    route: 'AX · failed',
    statuses: ['done', 'failed', 'skipped'],
    expandable: [0, 1],
    outcome: 'failed',
    approved: true
  }
]

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

interface AxNode {
  nodeId: string
  parentId?: string
  childIds?: string[]
  ignored?: boolean
  /** The DOM node this was computed from — the check's anchor. */
  backendDOMNodeId?: number
  role?: { value?: string }
  name?: { value?: string }
  properties?: { name: string; value?: { value?: unknown } }[]
}

interface RowReading {
  /** The status column: its computed role and name. */
  marker: { role: string; name: string } | null
  /** The row's own control, if it has one. */
  control: { role: string; name: string; expanded: string | null; disabled: boolean } | null
  /** Text the row exposes outside any control — its prose. */
  prose: string[]
}

interface BlockReading {
  route: string
  found: boolean
  /** The block's own accessible name, from `group`. */
  groupRole: string
  groupName: string
  lists: number
  listItems: number
  rows: RowReading[]
  /** Every live region inside the block: role, politeness, atomicity, text. */
  live: { role: string; live: string; atomic: string; text: string }[]
  /** Controls anywhere in the block that announce themselves as disabled. */
  disabledControls: string[]
  /** Every control in the block, rows and approval footer alike. */
  controls: string[]
}

function seedProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'sigma-plan-ax-'))
  writeFileSync(
    join(profile, 'config.json'),
    JSON.stringify(
      {
        settings: {
          // A port nothing is listening on: the app must come up offline.
          baseUrl: 'http://127.0.0.1:65533/v1',
          onboardingCompleted: true,
          theme: 'light',
          updates: { autoCheck: false },
          audit: { enabled: false, autoPurgeOnQuit: false },
          memory: { autoContext: false, topK: 3, embeddingModel: '' },
          claimCheck: { enabled: false, maxClaims: 5 },
          secondOpinion: { enabled: false, criticSlotId: null },
          grounding: {
            autoCorrect: false,
            playbooks: false,
            selfReview: false,
            workbenchChecks: false,
            ledger: false
          },
          projects: []
        }
      },
      null,
      2
    )
  )

  const dir = join(profile, 'conversations')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()

  /** One step, with the extras that make a row expandable or divergent. */
  const st = (
    n: number,
    status: PlanStepStatus,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    id: `s${n}`,
    title: `Step ${n}`,
    detail: `detail ${n}`,
    status,
    ...extra
  })

  const write = (
    id: string,
    title: string,
    steps: Record<string, unknown>[],
    rest: Record<string, unknown>,
    toolCalls: Record<string, unknown>[] = []
  ): void => {
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        title,
        mode: 'independent',
        activeModelSlotId: 'model-1',
        messages: [
          { id: 'u0', role: 'user', content: 'do the thing', createdAt: now - 1000 },
          {
            id: 'a0',
            role: 'assistant',
            modelId: 'bench-model',
            roleName: 'Assistant',
            color: 'blue',
            toolCalls,
            content: 'here is the plan',
            plan: { steps, createdAt: 1, ...rest },
            createdAt: now - 900
          }
        ],
        createdAt: now - 2000,
        updatedAt: now - 900
      })
    )
  }

  write(
    'ax-cancelled',
    'AX · cancelled',
    [st(1, 'skipped'), st(2, 'skipped'), st(3, 'skipped')],
    { approved: false, outcome: 'cancelled' }
  )
  write(
    'ax-stopped',
    'AX · stopped',
    [st(1, 'done', { output: 'ok' }), st(2, 'stopped'), st(3, 'skipped'), st(4, 'skipped')],
    { approved: true, outcome: 'stopped' }
  )
  write(
    'ax-awaiting',
    'AX · awaiting',
    [st(1, 'pending', { tools: ['web_search'] }), st(2, 'pending'), st(3, 'pending')],
    { approved: false }
  )
  write(
    'ax-running',
    'AX · running',
    [st(1, 'done', { output: 'ok' }), st(2, 'running'), st(3, 'pending')],
    { approved: true }
  )
  // Step 1 forecasts web_search and runs calculator: both directions of the
  // reconciliation are on the row, so the negatives below can check that a
  // control's name does not swallow them.
  write(
    'ax-failed',
    'AX · failed',
    [
      st(1, 'done', { output: 'ok', tools: ['web_search'] }),
      st(2, 'failed', { output: 'ECONNREFUSED' }),
      st(3, 'skipped')
    ],
    { approved: true, outcome: 'failed' },
    [
      {
        id: 't0',
        name: 'calculator',
        args: { expr: '1+1' },
        status: 'done',
        result: '2',
        planStepId: 's1'
      }
    ]
  )

  return profile
}

/** One property off an AX node, as a string, or null when it is not set. */
function prop(node: AxNode, name: string): string | null {
  const hit = (node.properties ?? []).find((p) => p.name === name)
  if (!hit) return null
  return String(hit.value?.value ?? '')
}

function readBlock(nodes: AxNode[], route: string, anchor: number): BlockReading {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const roleOf = (n: AxNode): string => String(n.role?.value ?? '')
  const nameOf = (n: AxNode): string => String(n.name?.value ?? '')

  const empty: BlockReading = {
    route,
    found: false,
    groupRole: '',
    groupName: '',
    lists: 0,
    listItems: 0,
    rows: [],
    live: [],
    disabledControls: [],
    controls: []
  }

  // The block is located by its DOM identity, never by the role or the name
  // this check is here to measure.
  //
  // The first draft of this file found it as `role=group` with a name starting
  // "Plan — ", which is elegant and wrong: run against the pre-fix build it
  // reported nine failures instead of the hundred and forty-five that were
  // really there, because the block was not a named group *yet* and every
  // per-row assertion sat behind `if (!found) continue`. One broken property
  // masking every other measurement is this project's oldest recurring defect,
  // arriving here in the check meant to close it. A locator must not be one of
  // the things being located.
  const group = nodes.find((n) => n.backendDOMNodeId === anchor)
  if (!group) return empty

  const children = (n: AxNode): AxNode[] =>
    (n.childIds ?? []).map((id) => byId.get(id)).filter((c): c is AxNode => Boolean(c))

  const descendants = (n: AxNode): AxNode[] => {
    const out: AxNode[] = []
    const walk = (x: AxNode): void => {
      for (const c of children(x)) {
        out.push(c)
        walk(c)
      }
    }
    walk(n)
    return out
  }

  const all = descendants(group)
  const lists = all.filter((n) => roleOf(n) === 'list')
  const items = all.filter((n) => roleOf(n) === 'listitem')

  const live = all
    .filter((n) => prop(n, 'live') !== null && prop(n, 'live') !== '')
    .map((n) => ({
      role: roleOf(n),
      live: prop(n, 'live') ?? '',
      atomic: prop(n, 'atomic') ?? '',
      // A live region announces its own text, so that is what is recorded.
      text: descendants(n)
        .filter((d) => roleOf(d) === 'StaticText')
        .map(nameOf)
        .join('')
        .trim()
    }))

  const buttons = all.filter((n) => roleOf(n) === 'button')
  const disabledControls = buttons
    .filter((n) => prop(n, 'disabled') === 'true')
    .map((n) => nameOf(n) || '(unnamed)')
  // Every control, not only the ones on rows: the approval footer is part of
  // the block a reader meets, and it named itself "▶ Run this plan" until the
  // same rule the step rows got was applied to it too.
  const controls = buttons.map((n) => nameOf(n) || '(unnamed)')

  const rows: RowReading[] = items.map((item) => {
    const inside = descendants(item)
    const marker = inside.find((n) => roleOf(n) === 'image') ?? null
    const control = inside.find((n) => roleOf(n) === 'button') ?? null
    // Prose is the text the row exposes on its own account — everything not
    // folded into a control's or an icon's name. That is exactly the quantity
    // that was zero before this round.
    const swallowed = new Set<string>()
    for (const c of inside) {
      if (roleOf(c) === 'button' || roleOf(c) === 'image') {
        for (const d of descendants(c)) swallowed.add(d.nodeId)
      }
    }
    const prose = inside
      .filter((n) => roleOf(n) === 'StaticText' && !swallowed.has(n.nodeId))
      .map(nameOf)
      .filter((t) => t.trim().length > 0)

    return {
      marker: marker ? { role: roleOf(marker), name: nameOf(marker) } : null,
      control: control
        ? {
            role: roleOf(control),
            name: nameOf(control),
            expanded: prop(control, 'expanded'),
            disabled: prop(control, 'disabled') === 'true'
          }
        : null,
      prose
    }
  })

  return {
    route,
    found: true,
    groupRole: roleOf(group),
    groupName: nameOf(group),
    lists: lists.length,
    listItems: items.length,
    rows,
    live,
    disabledControls,
    controls
  }
}

// ---------------------------------------------------------------------------
// The judgement
// ---------------------------------------------------------------------------

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function judge(readings: BlockReading[]): void {
  console.log('\nthe block, as the accessibility tree reports it')
  for (const r of readings) {
    console.log(`\n  ${r.route}`)
    console.log(`    ${r.groupRole || '(no group)'} name=${JSON.stringify(r.groupName)}`)
    for (const l of r.live) {
      console.log(`    live: ${l.role} [${l.live} atomic=${l.atomic}] ${JSON.stringify(l.text)}`)
    }
    r.rows.forEach((row, i) => {
      const m = row.marker ? `${row.marker.role} ${JSON.stringify(row.marker.name)}` : 'NO MARKER'
      const c = row.control
        ? `${row.control.role} ${JSON.stringify(row.control.name)} expanded=${String(row.control.expanded)}`
        : 'no control'
      console.log(`    row ${i + 1}: ${m} · ${c}`)
    })
    console.log(`    controls in the block: ${JSON.stringify(r.controls)}`)
  }

  console.log('\nthe block names itself, and the count never travels without its outcome')
  for (const r of readings) {
    const f = FIXTURES.find((x) => x.route === r.route)!
    check(`${r.route}: the block resolves into the tree`, r.found, 'the anchor reached no AX node')
    if (!r.found) continue
    check(
      `${r.route}: the block announces itself as a group`,
      r.groupRole === 'group',
      `role=${JSON.stringify(r.groupRole)}`
    )
    // v2.4: the count is a progress fraction only while that fraction is
    // closed — see `planHeaderCount`. A plan that ended with steps it never ran
    // names what became of each of them instead, so this asks for whichever
    // form the fixture's own statuses call for, and the census branch carries
    // the negative round 11 needed: no open fraction over a dead checklist.
    if (!f.outcome || f.statuses.every((s) => s === 'done')) {
      check(
        `${r.route}: the name carries the step count`,
        new RegExp(`\\d+/${f.statuses.length} steps done`).test(r.groupName),
        JSON.stringify(r.groupName)
      )
    } else {
      const tallied = Object.values(STATUS_LABEL).reduce((sum, label) => {
        const m = r.groupName.match(new RegExp(`\\b(\\d+) ${label.toLowerCase()}\\b`))
        return sum + (m ? Number(m[1]) : 0)
      }, 0)
      check(
        `${r.route}: the name accounts for every step it lists`,
        tallied === f.statuses.length,
        `${tallied} of ${f.statuses.length} accounted for in ${JSON.stringify(r.groupName)}`
      )
      check(
        `${r.route}: a plan that will not progress is named with no progress fraction`,
        !/\d+\/\d+ steps done/.test(r.groupName),
        JSON.stringify(r.groupName)
      )
    }
    if (f.outcome) {
      check(
        `${r.route}: the name carries how the plan ended`,
        r.groupName.includes(OUTCOME_LABEL[f.outcome]),
        JSON.stringify(r.groupName)
      )
    } else {
      // The negative: a plan still in flight must not be named as an ended one.
      // A build that always appended "finished" would pass every line above.
      check(
        `${r.route}: an unfinished plan claims no terminal outcome`,
        OUTCOME_WORDS.every((w) => !r.groupName.includes(w)),
        JSON.stringify(r.groupName)
      )
    }
  }

  console.log('\nthe steps are a list, and every row says what state it is in')
  for (const r of readings) {
    const f = FIXTURES.find((x) => x.route === r.route)!
    if (!r.found) continue
    check(`${r.route}: exactly one list`, r.lists === 1, `${r.lists} lists`)
    check(
      `${r.route}: one list item per step`,
      r.listItems === f.statuses.length,
      `${r.listItems} items for ${f.statuses.length} steps`
    )
    r.rows.forEach((row, i) => {
      const status = f.statuses[i]!
      const where = `${r.route}/row ${i + 1} (${status})`
      check(`${where}: the status marker has a role and a name`, Boolean(row.marker?.name), 'none')
      check(
        `${where}: the marker says the state in words`,
        row.marker?.name === STATUS_LABEL[status],
        `${JSON.stringify(row.marker?.name)} for a ${status} step`
      )
    })
  }

  console.log('\nthe states a reader could not tell apart before')
  // The specific collisions the tree recorded. Named individually because they
  // are the failures this round exists to close, and a general "all names
  // differ" line would let one of them come back inside a passing aggregate.
  const markerFor = (route: string, status: PlanStepStatus): string | undefined => {
    const r = readings.find((x) => x.route === route)
    const f = FIXTURES.find((x) => x.route === route)
    if (!r || !f) return undefined
    const i = f.statuses.indexOf(status)
    return i === -1 ? undefined : r.rows[i]?.marker?.name
  }
  const running = markerFor('AX · running', 'running')
  const queued = markerFor('AX · running', 'pending')
  const done = markerFor('AX · failed', 'done')
  const failed = markerFor('AX · failed', 'failed')
  check(
    'a running step and a queued step are different to a reader',
    Boolean(running) && running !== queued,
    `running ${JSON.stringify(running)} vs queued ${JSON.stringify(queued)}`
  )
  check(
    'a step that failed and a step that succeeded are different to a reader',
    Boolean(done) && done !== failed,
    `done ${JSON.stringify(done)} vs failed ${JSON.stringify(failed)}`
  )
  // And the class, not the two instances: all six statuses, pairwise distinct.
  const seen = new Map<string, PlanStepStatus[]>()
  for (const r of readings) {
    const f = FIXTURES.find((x) => x.route === r.route)!
    r.rows.forEach((row, i) => {
      const name = row.marker?.name ?? ''
      const list = seen.get(name) ?? []
      if (!list.includes(f.statuses[i]!)) list.push(f.statuses[i]!)
      seen.set(name, list)
    })
  }
  const collisions = [...seen.entries()].filter(([, s]) => s.length > 1)
  check(
    'no two step statuses share one accessible name',
    collisions.length === 0,
    collisions.map(([n, s]) => `${JSON.stringify(n)} = ${s.join('/')}`).join(', ')
  )
  const statusesSeen = new Set(FIXTURES.flatMap((f) => f.statuses))
  check(
    'the fixtures cover every status there is',
    statusesSeen.size === Object.keys(STATUS_LABEL).length,
    `${statusesSeen.size} of ${Object.keys(STATUS_LABEL).length}: ${[...statusesSeen].join(' ')}`
  )

  console.log('\na row is a control only when there is something to open')
  for (const r of readings) {
    const f = FIXTURES.find((x) => x.route === r.route)!
    if (!r.found) continue
    check(
      `${r.route}: no row announces itself as a disabled control`,
      r.disabledControls.length === 0,
      `${r.disabledControls.length}: ${JSON.stringify(r.disabledControls.slice(0, 3))}`
    )
    // Every control in the block, not only the ones on rows. The approval
    // footer is part of the block a reader meets, and it named itself
    // "▶ Run this plan" — the same defect as the wrench, one element over,
    // and exactly the kind a check scoped to the rows would never see.
    check(
      `${r.route}: no control anywhere in the block is named with a glyph`,
      r.controls.every((n) => !/[▸▾🔧▶📋]/.test(n)),
      JSON.stringify(r.controls.filter((n) => /[▸▾🔧▶📋]/.test(n)))
    )
    // The awaiting plan is the only one that may offer a control that runs it —
    // the negative that keeps the line above from passing on an empty list.
    check(
      `${r.route}: the run control is offered only while the plan can be approved`,
      r.controls.includes('Run this plan') === (!f.approved && !f.outcome),
      JSON.stringify(r.controls)
    )
    r.rows.forEach((row, i) => {
      const where = `${r.route}/row ${i + 1}`
      if (f.expandable.includes(i)) {
        check(`${where}: opens, so it is a button`, row.control?.role === 'button', 'no button')
        check(
          `${where}: the button says whether it is open`,
          row.control?.expanded === 'false' || row.control?.expanded === 'true',
          `expanded=${String(row.control?.expanded)}`
        )
      } else {
        // The negative that stops the fix being "make everything a button".
        check(`${where}: nothing to open, so no control at all`, row.control === null, 'a control')
      }
    })
  }

  console.log("\nthe row's prose is prose, not a control's name")
  for (const r of readings) {
    if (!r.found) continue
    r.rows.forEach((row, i) => {
      const where = `${r.route}/row ${i + 1}`
      const name = row.control?.name ?? ''
      // Before this round every one of these was inside the button's name.
      if (row.control) {
        check(
          `${where}: the control is named for the step, not for the row`,
          !/detail \d/.test(name) && !name.includes('Tools —'),
          JSON.stringify(name)
        )
        check(
          `${where}: no decorative glyph in the control's name`,
          !/[▸▾🔧]/.test(name),
          JSON.stringify(name)
        )
      }
      const prose = row.prose.join(' ')
      check(`${where}: the detail line is readable as text`, prose.includes(`detail ${i + 1}`), JSON.stringify(row.prose))
      check(`${where}: the tool forecast is readable as text`, prose.includes('Tools —'), JSON.stringify(row.prose))
    })
  }

  console.log('\nboth halves of the forecast reconciliation reach the reader as text')
  {
    const r = readings.find((x) => x.route === 'AX · failed')
    const row = r?.rows[0]
    const prose = (row?.prose ?? []).join(' ')
    check(
      'the unrun forecast is its own line',
      /Forecast web_search, which this step never ran\./.test(prose),
      JSON.stringify(row?.prose)
    )
    check(
      'the undisclosed run is its own line',
      /Ran calculator, which this step did not disclose\./.test(prose),
      JSON.stringify(row?.prose)
    )
    // The negative: a row whose forecast held says neither.
    const clean = readings.find((x) => x.route === 'AX · stopped')
    const cleanProse = (clean?.rows ?? []).flatMap((x) => x.prose).join(' ')
    check(
      'a plan with no divergence says neither, so the lines above mean something',
      !/never ran\.|did not disclose/.test(cleanProse),
      JSON.stringify(cleanProse.slice(0, 120))
    )
  }

  console.log('\none live region, carrying the state — not the block, and not the rows')
  for (const r of readings) {
    const f = FIXTURES.find((x) => x.route === r.route)!
    if (!r.found) continue
    // The negative that matters most: making the whole block live would
    // announce every step, every count and every streamed tool result over the
    // reader, and would satisfy any check that only asked "is it announced".
    check(
      `${r.route}: exactly one live region in the block`,
      r.live.length === 1,
      `${r.live.length} live regions: ${JSON.stringify(r.live.map((l) => l.text))}`
    )
    const region = r.live[0]
    if (!region) continue
    check(`${r.route}: it is polite, not assertive`, region.live === 'polite', region.live)
    check(
      `${r.route}: it reads as one sentence rather than a diff`,
      region.atomic === 'true',
      `atomic=${region.atomic}`
    )
    const expected = f.outcome ? OUTCOME_LABEL[f.outcome] : f.liveWord!
    check(
      `${r.route}: it says ${JSON.stringify(expected)}`,
      region.text === expected,
      JSON.stringify(region.text)
    )
    // And it must not be the whole header: a live region wrapping the count
    // would re-announce on every step of a running plan. v2.4: on the word
    // "step", not on "steps done" — an ended plan's count no longer contains
    // that phrase, so the older negative had stopped being able to fail.
    check(
      `${r.route}: the step count is outside the live region`,
      !/step/i.test(region.text),
      JSON.stringify(region.text)
    )
  }
}

// ---------------------------------------------------------------------------
// Boot the shipped build and take the reading
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const profile = seedProfile()
  app.setPath('userData', profile)

  // The app shows its window on `ready-to-show`; a test suite must not throw
  // one on the user's screen. An offscreen window still lays out, and the
  // accessibility tree is computed from that layout.
  let win: BrowserWindow | null = null
  app.on('browser-window-created', (_e, created) => {
    win = created
    created.show = (): void => {}
    created.showInactive = (): void => {}
  })

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(join(__dirname, '..', '..', 'out', 'main', 'index.js'))

  await app.whenReady()
  const deadline = Date.now() + 20_000
  while (!win && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  if (!win) throw new Error('the app created no window')
  const wc = (win as BrowserWindow).webContents
  await new Promise<void>((r) => {
    if (!wc.isLoading()) return r()
    wc.once('did-finish-load', () => r())
  })
  // The renderer boots asynchronously: settings, then conversations.
  await new Promise((r) => setTimeout(r, 2500))

  // The computed tree, over CDP. Nothing below reads a DOM attribute: the
  // whole point is to be told what the platform would tell a screen reader.
  wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Accessibility.enable')
  await wc.debugger.sendCommand('DOM.enable')

  const readings: BlockReading[] = []
  for (const fixture of FIXTURES) {
    const opened = await wc.executeJavaScript(`(() => {
      var rows = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]'))
      var hit = rows.filter(function (b) {
        return (b.innerText || '').indexOf(${JSON.stringify(fixture.route)}) !== -1
      })[0]
      if (hit) hit.click()
      return !!hit
    })()`)
    if (!opened) throw new Error(`the driver could not open ${fixture.route}`)
    await new Promise((r) => setTimeout(r, 700))

    // Mark the block in the DOM so the tree can be entered by identity rather
    // than by any property under test. The attribute is set by the driver and
    // never ships; the app has no test hook in it.
    const tagged = await wc.executeJavaScript(`(() => {
      var prior = document.querySelector('[data-plan-ax]')
      if (prior) prior.removeAttribute('data-plan-ax')
      var all = Array.prototype.slice.call(document.querySelectorAll('div'))
      var hit = all.filter(function (d) {
        return d.querySelector('ol') && (d.textContent || '').indexOf('Plan — ') !== -1
      })
      // querySelectorAll is in document order, so every ancestor of the block
      // matches before the block does: the innermost match is the block.
      var block = hit[hit.length - 1]
      if (block) block.setAttribute('data-plan-ax', '1')
      return !!block
    })()`)
    if (!tagged) throw new Error(`no plan block on ${fixture.route}`)

    const { root } = (await wc.debugger.sendCommand('DOM.getDocument', { depth: -1 })) as {
      root: { nodeId: number }
    }
    const { nodeId } = (await wc.debugger.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-plan-ax]'
    })) as { nodeId: number }
    if (!nodeId) throw new Error(`could not resolve the plan block on ${fixture.route}`)
    const { node } = (await wc.debugger.sendCommand('DOM.describeNode', { nodeId })) as {
      node: { backendNodeId: number }
    }

    const { nodes } = (await wc.debugger.sendCommand('Accessibility.getFullAXTree')) as {
      nodes: AxNode[]
    }
    readings.push(readBlock(nodes, fixture.route, node.backendNodeId))
  }

  judge(readings)

  console.log(`\n${'='.repeat(58)}`)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* a leftover temp profile is not worth failing a run over */
  }
  if (failures.length === 0) {
    console.log(`ALL ${passed} PLAN-ACCESSIBILITY CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

main().catch((err) => {
  console.error('PLAN-ACCESSIBILITY CHECK ERROR:', err)
  app.exit(1)
})
