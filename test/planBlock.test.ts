import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlanBlockView } from '../src/renderer/src/components/PlanBlockView'
import {
  awaitingApproval,
  endPlan,
  OUTCOME_LABEL,
  planHeaderStatus,
  STATUS_LABEL,
  STATUS_NOTE
} from '../src/renderer/src/lib/planState'
import type {
  ChatPlan,
  PlanOutcome,
  PlanStep,
  PlanStepStatus,
  ToolCallRecord
} from '../src/renderer/src/types'

/**
 * v1.12: a plan has to have a terminal state, and the block has to show it.
 *
 * Before this, cancelling produced the message "Plan cancelled — nothing was
 * executed" above a block that still read "Plan — 0/3 steps done · awaiting
 * approval" in amber, with "▶ Run this plan" and "Cancel" live; and pressing
 * Stop mid-plan drew the interrupted step as ✗ in failure red while the steps
 * that would now never run kept the same '○' as a step still queued.
 *
 * Asserted against the real markup, because that is what the reader sees.
 */

function step(n: number, status: PlanStepStatus, output?: string): PlanStep {
  return { id: `s${n}`, title: `Step ${n}`, detail: `detail ${n}`, status, ...(output ? { output } : {}) }
}

function plan(steps: PlanStep[], rest: Partial<ChatPlan> = {}): ChatPlan {
  return { steps, approved: true, createdAt: 1, ...rest }
}

function render(p: ChatPlan, records: ToolCallRecord[] = []): string {
  // The `<!-- -->` markers separate adjacent text children in static markup and
  // do not exist in the DOM the reader gets; drop them so a span's text here is
  // the string on screen.
  return renderToStaticMarkup(
    createElement(PlanBlockView, { plan: p, streaming: false, onResolve: () => {}, records })
  ).replace(/<!-- -->/g, '')
}

/** Buttons the user can actually press — the disabled ones are step toggles. */
function enabledButtons(html: string): number {
  return html
    .split('<button')
    .slice(1)
    .filter((t) => !t.slice(0, t.indexOf('>')).includes('disabled')).length
}

/** One <li> per step, in order. */
function rows(html: string): string[] {
  return html.split('<li ').slice(1)
}

/** The status column of a step row: its class and its glyph, together. */
function marker(row: string): string {
  const m = row.match(/text-center ([^"]+)">([^<]*)</)
  assert.ok(m, 'no status marker in row')
  return `${m![1]}|${m![2]}`
}

const header = (html: string): string => html.slice(0, html.indexOf('<ol'))

const CANCELLED = endPlan(
  plan([step(1, 'pending'), step(2, 'pending'), step(3, 'pending')], { approved: false }),
  'cancelled'
)
const STOPPED = endPlan(
  plan([step(1, 'done', 'ok'), step(2, 'stopped'), step(3, 'pending'), step(4, 'pending')]),
  'stopped'
)
const FAILED = endPlan(
  plan([step(1, 'done', 'ok'), step(2, 'failed', 'ECONNREFUSED'), step(3, 'pending')]),
  'failed'
)
const QUEUED = plan([step(1, 'running'), step(2, 'pending'), step(3, 'pending')])

describe('a cancelled plan is over', () => {
  const html = render(CANCELLED)

  test('no enabled control still offers to run it', () => {
    assert.equal(enabledButtons(html), 0)
    assert.ok(!/Run this plan/.test(html), 'still renders "▶ Run this plan"')
  })

  test('nothing reads as awaiting approval', () => {
    assert.ok(!/awaiting approval/.test(html), 'still reads "awaiting approval"')
    assert.equal(awaitingApproval(CANCELLED), false)
  })

  test('the header says it was cancelled', () => {
    assert.match(header(html), /cancelled/)
  })

  test('no step is left looking queued', () => {
    assert.equal((html.match(/○/g) ?? []).length, 0)
    for (const row of rows(html)) assert.match(row, /never ran/)
  })
})

describe('a plan the user stopped part-way', () => {
  const html = render(STOPPED)
  const r = rows(html)

  test('the interrupted step is not presented as a failure', () => {
    assert.ok(!r[1]!.includes('✗'), 'the stopped step renders the failure glyph')
    assert.ok(!r[1]!.includes('text-ink-danger'), 'the stopped step renders in failure red')
    assert.match(r[1]!, /stopped here/)
  })

  test('steps that will never run are distinguishable from queued ones', () => {
    const queued = marker(rows(render(QUEUED))[1]!)
    assert.notEqual(marker(r[2]!), queued)
    assert.notEqual(marker(r[3]!), queued)
    assert.equal((html.match(/○/g) ?? []).length, 0)
  })

  test('the header says the plan is over, not how many steps are done', () => {
    assert.match(header(html), /stopped by you/)
  })

  test('a step that did run keeps its own result', () => {
    assert.match(r[0]!, /✓/)
  })
})

describe('a plan that failed on its own still reads as a failure', () => {
  const html = render(FAILED)
  const r = rows(html)

  test('the failed step keeps the failure glyph and colour', () => {
    assert.match(r[1]!, /✗/)
    assert.match(r[1]!, /text-ink-danger/)
  })

  test('a failure and a user stop are not the same marker', () => {
    assert.notEqual(marker(r[1]!), marker(rows(render(STOPPED))[1]!))
  })

  test('the header says failed', () => {
    assert.match(header(html), /failed/)
  })
})

describe('the six states a reader has to tell apart', () => {
  const states: ChatPlan[] = [
    plan([step(1, 'pending'), step(2, 'pending')], { approved: false }), // never approved
    plan([step(1, 'done', 'ok'), step(2, 'running')]), // running
    endPlan(plan([step(1, 'done', 'ok'), step(2, 'done', 'ok')]), 'completed'),
    CANCELLED,
    STOPPED,
    FAILED
  ]

  test('each renders a different header', () => {
    const headers = states.map((p) => header(render(p)))
    assert.equal(new Set(headers).size, 6)
  })

  test('only the one that can still be approved offers the buttons', () => {
    const withButtons = states.filter((p) => /Run this plan/.test(render(p)))
    assert.equal(withButtons.length, 1)
    assert.equal(withButtons[0]!.approved, false)
    assert.equal(withButtons[0]!.outcome, undefined)
  })
})

describe('endPlan', () => {
  test('only the steps that never ran become skipped', () => {
    const ended = endPlan(
      plan([step(1, 'done', 'ok'), step(2, 'failed', 'boom'), step(3, 'pending')]),
      'failed'
    )
    assert.deepEqual(
      ended.steps.map((s) => s.status),
      ['done', 'failed', 'skipped']
    )
    assert.equal(ended.outcome, 'failed')
  })

  test('an ended plan never awaits approval again', () => {
    const pendingUnapproved = plan([step(1, 'pending')], { approved: false })
    assert.equal(awaitingApproval(pendingUnapproved), true)
    for (const outcome of ['completed', 'cancelled', 'stopped', 'failed'] as const) {
      assert.equal(awaitingApproval(endPlan(pendingUnapproved, outcome)), false)
    }
  })
})

/* ---- v1.12.3: what the block says, and how loudly ------------------------- */

/**
 * Three failures a blind critic found in real recorded runs, each measured
 * here against the rendered markup rather than described.
 *
 * 1. Approval was asked for blind: at the moment the user authorised
 *    execution the block held three titles and their prose — no tool name, no
 *    badge — and the tool calls appeared only once they had run.
 * 2. The terminal state was drawn in the weakest ink in the block:
 *    "cancelled — nothing ran" in text-neutral-400, the same grey as the step
 *    body copy, on a block that otherwise read as finished.
 * 3. A step that never ran kept its contents fully legible: five rows labelled
 *    "never ran" carrying "Result: ~$1,080" at the weight of a step that did.
 *
 * Ink is compared by measurement, not by eye: WCAG 2.1 relative luminance
 * against the block's own composited background, in both themes.
 */

const REPO = join(__dirname, '..', '..')

/** Tailwind v3 defaults, for every ink the plan block sets. */
const PALETTE: Record<string, string> = {
  'neutral-200': '#e5e5e5',
  'neutral-300': '#d4d4d4',
  'neutral-400': '#a3a3a3',
  'neutral-500': '#737373',
  'neutral-600': '#525252',
  'neutral-700': '#404040',
  'green-300': '#86efac',
  'green-400': '#4ade80',
  'green-600': '#16a34a',
  'green-800': '#166534',
  'green-900': '#14532d',
  'red-300': '#fca5a5',
  'red-400': '#f87171',
  'red-500': '#ef4444',
  'red-700': '#b91c1c',
  'red-900': '#7f1d1d',
  'amber-300': '#fcd34d',
  'amber-500': '#f59e0b',
  'amber-600': '#d97706',
  'amber-800': '#92400e',
  'amber-900': '#78350f'
}

/** --accent-ink is a CSS variable; take both themes from the stylesheet itself. */
const ACCENT_INK = (() => {
  const css = readFileSync(join(REPO, 'src/renderer/src/assets/index.css'), 'utf8')
  const found = css.match(/--accent-ink:\s*(#[0-9a-fA-F]{6})/g) ?? []
  assert.equal(found.length, 2, 'index.css no longer defines --accent-ink once per theme')
  return found.map((m) => m.slice(m.indexOf('#')))
})()

/**
 * The ink tokens, both themes, from the stylesheet. These are rgba over
 * whatever is behind them, so unlike a Tailwind hex they cannot be measured
 * without knowing the surface — which is the point of them, and why the
 * measurement has to composite rather than look up.
 */
const INK_TOKENS = (() => {
  const css = readFileSync(join(REPO, 'src/renderer/src/assets/index.css'), 'utf8')
  const out: Record<string, Array<[number, number, number, number]>> = {}
  for (const tier of ['primary', 'secondary', 'tertiary', 'muted']) {
    const found = css.match(new RegExp(`--text-${tier}:\\s*rgba\\(([^)]+)\\)`, 'g')) ?? []
    assert.equal(found.length, 2, `index.css no longer defines --text-${tier} once per theme`)
    out[tier] = found.map((m) => {
      const parts = m.slice(m.indexOf('(') + 1, m.lastIndexOf(')')).split(',').map(Number)
      return [parts[0]!, parts[1]!, parts[2]!, parts[3]!] as [number, number, number, number]
    })
  }
  return out
})()

/**
 * The status inks — the same idea as the tiers above and read the same way, but
 * opaque rather than rgba, so they resolve without a surface.
 *
 * They exist because a raw palette step cannot be theme-aware: the plan block's
 * outcomes and step statuses were `text-red-500` / `text-amber-600` / their
 * `dark:` twins, and the light half of every one of those pairs was under AA
 * (3.10–3.67:1). Hue still has to separate the four outcomes, which is what the
 * assertions below check; these only say what each hue *is*.
 */
const STATUS_INK = (() => {
  const css = readFileSync(join(REPO, 'src/renderer/src/assets/index.css'), 'utf8')
  const out: Record<string, string[]> = {}
  for (const name of ['danger', 'warn', 'ok']) {
    const found = css.match(new RegExp(`--text-${name}:\\s*(#[0-9a-fA-F]{6})`, 'g')) ?? []
    assert.equal(found.length, 2, `index.css no longer defines --text-${name} once per theme`)
    out[name] = found.map((m) => m.slice(m.indexOf('#')))
  }
  return out
})()

/** The canvas the block sits on, read from the app's own Tailwind config. */
const CANVAS = (() => {
  const cfg = readFileSync(join(REPO, 'tailwind.config.js'), 'utf8')
  const m = cfg.match(/base:\s*\{\s*light:\s*'(#[0-9a-fA-F]{6})',\s*dark:\s*'(#[0-9a-fA-F]{6})'/)
  assert.ok(m, 'tailwind.config.js no longer states the canvas colours')
  return { light: m![1]!, dark: m![2]! }
})()

type RGB = [number, number, number]

function hex(value: string): RGB {
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as RGB
}

function luminance([r, g, b]: RGB): number {
  const lin = (c: number): number => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(fg: RGB, bg: RGB): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** The block's background: its own tint class composited over the canvas. */
function background(html: string, dark: boolean): RGB {
  const open = html.indexOf('class="') + 7
  const root = html.slice(open, html.indexOf('"', open))
  const m = dark
    ? root.match(/dark:bg-white\/\[([\d.]+)\]/)
    : root.match(/(?:^|\s)bg-black\/\[([\d.]+)\]/)
  assert.ok(m, `the plan block no longer states its ${dark ? 'dark' : 'light'} background`)
  const alpha = Number(m![1])
  const tint = dark ? 255 : 0
  return hex(dark ? CANVAS.dark : CANVAS.light).map((c) => c * (1 - alpha) + tint * alpha) as RGB
}

/** The colour an element's classes resolve to in one theme. */
function ink(cls: string, dark: boolean, bg: RGB): RGB {
  const pick = (prefix: string): string[] =>
    cls
      .split(/\s+/)
      .filter((t) => t.startsWith(prefix))
      .map((t) => t.slice(prefix.length))
      .filter((t) => t === 'accent-ink' || /^ink-[a-z]+$/.test(t) || /^[a-z]+-\d{3}$/.test(t))
  // A dark: override wins where there is one. Where there is none, a raw
  // Tailwind class renders the same in both themes — but an ink TOKEN does not,
  // because the variable behind it is redefined per theme. That is the whole
  // reason the tokens exist, so resolving one always uses the theme in hand.
  const overrides = dark ? pick('dark:text-') : []
  const base = pick('text-')
  const name = overrides[overrides.length - 1] ?? base[base.length - 1]
  assert.ok(name, `no ink in "${cls}"`)
  if (name === 'accent-ink') return hex(ACCENT_INK[dark ? 1 : 0]!)
  if (name.startsWith('ink-')) {
    const tier = name.slice(4)
    // The status inks are opaque, so they need no surface; the neutral tiers
    // carry their own alpha and are composited over the block's background.
    const status = STATUS_INK[tier]
    if (status) return hex(status[dark ? 1 : 0]!)
    const token = INK_TOKENS[tier]
    assert.ok(token, `unmeasured ink token "${name}" — index.css defines no --text-${tier}`)
    const [r, g, b, a] = token![dark ? 1 : 0]!
    return [r, g, b].map((c, i) => c * a + bg[i]! * (1 - a)) as RGB
  }
  const value = PALETTE[name]
  assert.ok(value, `unmeasured ink "${name}" — add it to PALETTE`)
  return hex(value!)
}

/** How heavy the type is: a class the block sets, or Tailwind's 400 default. */
function weight(cls: string): number {
  if (/\bfont-bold\b/.test(cls)) return 700
  if (/\bfont-semibold\b/.test(cls)) return 600
  if (/\bfont-medium\b/.test(cls)) return 500
  return 400
}

interface Node {
  cls: string
  text: string
}

/** Every element that carries text of its own, with the classes it sets. */
function textNodes(html: string): Node[] {
  const out: Node[] = []
  const re = /class="([^"]*)"[^>]*>([^<]+)</g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const text = m[2]!.trim()
    if (text) out.push({ cls: m[1]!, text })
  }
  return out
}

/**
 * A step's own copy — the lines it sets on their own row: its detail and its
 * tool disclosure. Identified by the layout class rather than by their text, so
 * a line added to a step is measured rather than quietly exempt.
 */
const isBodyCopy = (n: Node): boolean => /(?:^|\s)block(?:\s|$)/.test(n.cls)

const legible = (n: Node, html: string, dark: boolean): number =>
  contrast(ink(n.cls, dark, background(html, dark)), background(html, dark))

// ---- PT1: approval is asked for with the tools on the table ------------------

const AWAITING = plan(
  [
    { id: 'a1', title: 'Work out the water', detail: '1 gal × 3 × 14 days.', status: 'pending', tools: [] },
    {
      id: 'a2',
      title: 'Check the reference library',
      detail: 'Look for an emergency supply list.',
      status: 'pending',
      tools: ['library_search', 'web_search']
    },
    {
      id: 'a3',
      title: 'Compile the checklist',
      detail: 'One list, by category.',
      status: 'pending',
      tools: ['library_search']
    }
  ],
  { approved: false }
)

describe('a plan is approved on what it will do', () => {
  const html = render(AWAITING)

  test('every step discloses its tools before anything runs', () => {
    const disclosed = rows(html).filter((r) => /Tools —/.test(r))
    assert.equal(disclosed.length, AWAITING.steps.length)
  })

  test('the tool names are in the DOM at the moment approval is asked for', () => {
    const r = rows(html)
    assert.match(r[1]!, /library_search/)
    assert.match(r[1]!, /web_search/)
    assert.match(r[2]!, /library_search/)
    // Retrospective disclosure is the failure: the names must precede the
    // control that authorises the run, not follow it.
    assert.ok(
      html.lastIndexOf('Tools —') < html.indexOf('Run this plan'),
      'the tool disclosure is rendered after the Run button'
    )
  })

  test('a step that plans no tool says so rather than saying nothing', () => {
    assert.match(rows(html)[0]!, /Tools — none planned/)
  })
})

// ---- PT2: the outcome is the loudest thing in the block ----------------------

const ENDED: Record<PlanOutcome, ChatPlan> = {
  completed: endPlan(plan([step(1, 'done', 'ok'), step(2, 'done', 'ok')]), 'completed'),
  cancelled: CANCELLED,
  stopped: STOPPED,
  failed: FAILED
}

describe('a terminal outcome is the most legible thing in the block', () => {
  for (const outcome of Object.keys(ENDED) as PlanOutcome[]) {
    const html = render(ENDED[outcome])
    const nodes = textNodes(html)
    const label = OUTCOME_LABEL[outcome]
    const badge = nodes.find((n) => n.text === label)

    test(`${outcome}: the outcome outweighs every other word in the block`, () => {
      assert.ok(badge, `no element renders "${label}" as its own text`)
      const heavier = nodes.filter((n) => n !== badge && weight(n.cls) >= weight(badge!.cls))
      assert.equal(heavier.length, 0, `set no heavier than ${heavier.map((n) => n.text).join(' | ')}`)
    })

    for (const dark of [false, true]) {
      const theme = dark ? 'dark' : 'light'

      test(`${outcome}: the outcome clears AA in the ${theme} theme`, () => {
        const ratio = legible(badge!, html, dark)
        assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`)
      })

      test(`${outcome}: the outcome is not the grey of the step copy (${theme})`, () => {
        const body = nodes.filter(isBodyCopy)
        assert.ok(body.length > 0, 'no step copy in the block to compare against')
        const loudest = Math.max(...body.map((n) => legible(n, html, dark)))
        const ratio = legible(badge!, html, dark)
        assert.ok(ratio > loudest, `outcome ${ratio.toFixed(2)}:1 vs copy ${loudest.toFixed(2)}:1`)
        for (const n of body) assert.notEqual(n.cls, badge!.cls)
      })
    }
  }
})

// ---- PT3: a step that never ran presents nothing as a finding ----------------

const ABANDONED = endPlan(
  plan([
    { id: 'b1', title: 'Total water volume', detail: '4 × 8 × 14 = 448 gallons.', status: 'stopped' },
    {
      id: 'b2',
      title: 'Cost refilled containers',
      detail: 'Result: ~$244 for delivery plus containers.',
      status: 'pending',
      tools: ['finance_calculator']
    },
    { id: 'b3', title: 'Cost bottled cases', detail: 'Result: ~$1,080 for 90 cases.', status: 'pending' }
  ]),
  'stopped'
)

describe('a step that never ran does not present its contents as findings', () => {
  const html = render(ABANDONED)
  const abandoned = rows(html).filter((r) => /never ran/.test(r))
  const ran = rows(html).filter((r) => /stopped here/.test(r))

  test('the fixture is the shape the failure was found in', () => {
    assert.equal(abandoned.length, 2)
    assert.equal(ran.length, 1)
    // Two lines of copy per row — the detail and the tool disclosure — is what
    // the dimness below is measured over.
    for (const row of [...abandoned, ...ran])
      assert.equal(textNodes(`<li ${row}`).filter(isBodyCopy).length, 2)
  })

  test('every figure inside a never-ran row is struck through', () => {
    let figures = 0
    for (const row of abandoned) {
      for (const node of textNodes(`<li ${row}`)) {
        if (!/\$[\d,]/.test(node.text)) continue
        figures += 1
        assert.match(node.cls, /line-through/, `"${node.text}" is legible as a result`)
      }
    }
    assert.ok(figures >= 2, `expected the abandoned rows to carry figures, found ${figures}`)
  })

  test('the whole row is struck, not only its title', () => {
    for (const row of abandoned)
      for (const node of textNodes(`<li ${row}`)) {
        // The verdict on the row is not part of the row's content, and the
        // status glyph carries no words.
        if (node.text === STATUS_NOTE.skipped || !/[a-z]/i.test(node.text)) continue
        assert.match(node.cls, /line-through/, `"${node.text}" keeps a step's full weight`)
      }
  })

  for (const dark of [false, true]) {
    test(`never-ran copy is dimmer than the copy of a step that ran (${dark ? 'dark' : 'light'})`, () => {
      const copy = (rowsOf: string[]): number =>
        Math.max(
          ...rowsOf.flatMap((r) =>
            textNodes(`<li ${r}`)
              .filter(isBodyCopy)
              .map((n) => legible(n, html, dark))
          )
        )
      assert.ok(
        copy(abandoned) < copy(ran),
        `never ran ${copy(abandoned).toFixed(2)}:1 vs ran ${copy(ran).toFixed(2)}:1`
      )
    })
  }
})

// ---- the round-1 guarantee, kept: a step's executed calls stay visible -------

describe('a step that did run still shows the calls it made', () => {
  const record = (id: string, name: string, planStepId: string): ToolCallRecord => ({
    id,
    name,
    args: { query: 'tide tables' },
    status: 'done',
    result: 'ok',
    planStepId
  })

  test('the count is on the row before anything is expanded', () => {
    const ran = plan([
      { id: 'c1', title: 'Search', detail: 'Find it.', status: 'done', output: 'ok', tools: ['web_search'] },
      { id: 'c2', title: 'Write it up', detail: 'Summarise.', status: 'pending', tools: [] }
    ])
    const html = render(ran, [record('r1', 'web_search', 'c1'), record('r2', 'web_search', 'c1')])
    assert.match(rows(html)[0]!, /2 tool calls/)
    assert.ok(!/\d+ tool calls?/.test(rows(html)[1]!), 'a step with no calls claims some')
  })
})

// ---- PT1, round 4: the forecast, reconciled against what the step ran --------

/**
 * Measured, judge-r3/PT1/run-1. Step 3 was authorised as
 * "Tools — may use: memory_search" and then called `reference_lookup`
 * ({"query":"emergency food storage non-perishable shelf life household
 * preparedness guidelines FEMA Red Cross","max_passages":6}) against the user's
 * own installed library — a tool that appears nowhere in the block the user
 * approved. Afterwards the row read "🔧 2 tool calls" and nothing else: a count
 * is not a name, and the count agreed with itself.
 *
 * The forecast is deliberately not an allowlist — a small model that names no
 * tool would then be handed none, and the plan is worse for it. So the loop
 * closes the other way round. The step already shows the calls it made; the
 * block now compares them with what it said it would reach for and says when
 * they differ. Same species and same words as `undisclosedToolRuns` in
 * lib/toolGrounding.ts: a call that the account of the work leaves out.
 */

const call = (
  id: string,
  name: string,
  planStepId: string,
  status: ToolCallRecord['status'] = 'done'
): ToolCallRecord => ({ id, name, args: { query: 'q' }, status, result: 'ok', planStepId })

const RECONCILED = endPlan(
  plan([
    {
      id: 'g1',
      title: 'Calculate the two-week date range',
      detail: 'Start and end dates for the emergency period.',
      status: 'done',
      tools: ['date_calculator']
    },
    {
      id: 'g2',
      title: 'Calculate total water needed',
      detail: '3 people × 1 gallon/day × 14 days = 42 gallons.',
      status: 'done',
      tools: []
    },
    {
      id: 'g3',
      title: 'Search reference library for emergency storage',
      detail: 'Look for notes on supplies and food storage.',
      status: 'done',
      tools: ['memory_search']
    }
  ]),
  'completed'
)

/** The run's own calls: four on step 1 (two of them errors), two on step 3. */
const RECONCILED_CALLS: ToolCallRecord[] = [
  call('k1', 'date_calculator', 'g1', 'error'),
  call('k2', 'date_calculator', 'g1'),
  call('k3', 'date_calculator', 'g1', 'error'),
  call('k4', 'date_calculator', 'g1'),
  call('k5', 'memory_search', 'g3'),
  call('k6', 'reference_lookup', 'g3')
]

/** The row's verdict on its own forecast, in the block's own words. */
const MISMATCH = /did not disclose/

/**
 * A negative control proves nothing while the check is dead — every row is
 * unmarked when nothing marks anything. So each one first asserts that the
 * block does mark the row that really did mismatch.
 */
function assertLive(html: string): void {
  assert.match(
    html,
    MISMATCH,
    'no row marks an undisclosed run at all, so an unmarked row proves nothing'
  )
}

describe('a step is held to the tools it forecast', () => {
  const html = render(RECONCILED, RECONCILED_CALLS)
  const r = rows(html)

  test('the fixture is the shape the failure was found in', () => {
    assert.match(r[0]!, /4 tool calls/)
    assert.match(r[2]!, /2 tool calls/)
    assert.match(r[2]!, /Tools — may use: memory_search/)
  })

  test('a step that ran a tool it never forecast names it on the row', () => {
    assert.match(r[2]!, /reference_lookup/)
    assert.match(r[2]!, MISMATCH)
  })

  test('the mark names the tool that went undisclosed, and only that one', () => {
    const note = textNodes(`<li ${r[2]!}`).find((n) => MISMATCH.test(n.text))
    assert.ok(note, 'the row carries no undisclosed-run verdict of its own')
    assert.match(note!.text, /reference_lookup/)
    assert.ok(
      !/memory_search/.test(note!.text),
      `a tool the step did forecast is named as undisclosed: "${note!.text}"`
    )
  })

  test('a step whose calls match its forecast is not marked', () => {
    assertLive(html)
    assert.ok(
      !MISMATCH.test(r[0]!),
      'a step that forecast date_calculator and ran it four times is marked'
    )
  })

  test('a step that forecast nothing and ran nothing is not marked', () => {
    assertLive(html)
    assert.match(r[1]!, /Tools — none planned/)
    assert.ok(!MISMATCH.test(r[1]!), 'a reasoning-only step that ran nothing is marked')
  })

  test('an errored call still counts as having run undisclosed', () => {
    const errored = render(
      plan([
        {
          id: 'e1',
          title: 'Check the library',
          detail: 'Look it up.',
          status: 'done',
          tools: ['memory_search']
        }
      ]),
      [call('k8', 'reference_lookup', 'e1', 'error')]
    )
    assert.match(errored, MISMATCH)
    assert.match(errored, /reference_lookup/)
  })

  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light'

    test(`the mark is legible enough to be read (${theme})`, () => {
      const note = textNodes(html).find((n) => MISMATCH.test(n.text))
      assert.ok(note, 'the block carries no undisclosed-run verdict')
      const ratio = legible(note!, html, dark)
      assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`)
    })

    test(`the mark never outshouts how the plan ended (${theme})`, () => {
      const note = textNodes(html).find((n) => MISMATCH.test(n.text))
      const badge = textNodes(html).find((n) => n.text === OUTCOME_LABEL.completed)
      assert.ok(note && badge, 'the fixture lost its verdict or its outcome')
      assert.ok(
        legible(badge!, html, dark) > legible(note!, html, dark),
        `outcome ${legible(badge!, html, dark).toFixed(2)}:1 vs mark ${legible(note!, html, dark).toFixed(2)}:1`
      )
      assert.ok(weight(note!.cls) < weight(badge!.cls), 'the mark is set as heavy as the outcome')
    })
  }

  test('the mark outlives the setting that hides tool-call details', () => {
    const hidden = renderToStaticMarkup(
      createElement(PlanBlockView, {
        plan: RECONCILED,
        streaming: false,
        onResolve: () => {},
        records: RECONCILED_CALLS,
        hideToolCalls: true
      })
    ).replace(/<!-- -->/g, '')
    assert.ok(!/\d+ tool calls?/.test(hidden), 'the fixture no longer hides the call blocks')
    assert.match(hidden, MISMATCH)
    assert.match(hidden, /reference_lookup/)
  })
})

describe('a step that forecast no tool at all is held to that too', () => {
  const REASONING_ONLY = plan([
    {
      id: 'h1',
      title: 'Compile the checklist',
      detail: 'One list, by category.',
      status: 'done',
      tools: []
    }
  ])
  const html = render(REASONING_ONLY, [call('k9', 'reference_lookup', 'h1')])
  const row = rows(html)[0]!

  test('"this step reasons only" is a forecast like any other', () => {
    assert.match(row, /Tools — none planned/)
    assert.match(row, MISMATCH)
    assert.match(row, /reference_lookup/)
  })

  // Strengthened in round 7. The wording above is what a step that merely
  // *added* a tool to its list gets; a step that was approved as touching
  // nothing and then ran two is a different failure and must not read the same.
  test('a step that promised nothing says so, rather than reading like an addition', () => {
    assert.match(row, /planned no tools at all/)
    assert.ok(
      !/planned no tools at all/.test(rows(render(RECONCILED, RECONCILED_CALLS))[2]!),
      'a step that added a tool to a real forecast is accused of having forecast none'
    )
  })
})

// ---- round 7: the other direction of the same difference ---------------------

/**
 * Measured, judge-r6/PT1, and verified against the raw audit log rather than
 * taken on a critic's word. The plan on screen at the approval moment forecast
 * `Tools — may use: list_notes` on one step and `read_note` on another;
 * `trace/audit.jsonl` for that run contains `memory_search` ×1 and
 * `reference_lookup` ×3, and nothing else. Neither forecast tool ever ran.
 *
 * Nothing said so. Both forecast lines stayed on screen unannotated, the header
 * read `Plan — 4/4 steps done` beside `finished`, and the two steps that did
 * reach for tools were precisely the ones that had said "none planned; this
 * step reasons only". A reader who approved on the strength of "may use:
 * list_notes" had no way to learn the forecast was worthless.
 *
 * v1.17 reconciled executed ∖ forecast and stopped there — round 5's species
 * again, a check reading a quantity adjacent to the one it means: one direction
 * of a set difference standing in for the difference. Both directions are now
 * reported, and they are deliberately not reported alike (see below).
 */
const FORECAST_UNRUN = endPlan(
  plan([
    {
      id: 'f1',
      title: 'List the stored notes',
      detail: 'Enumerate what the notebook holds.',
      status: 'done',
      output: 'Nothing to enumerate.',
      tools: ['list_notes']
    },
    {
      id: 'f2',
      title: 'Read the matching note',
      detail: 'Pull the one about the household.',
      status: 'done',
      output: 'No matching note.',
      tools: ['read_note']
    },
    {
      id: 'f3',
      title: 'Recall what was established',
      detail: 'Household size and constraints.',
      status: 'done',
      output: '3 people.',
      tools: []
    },
    {
      id: 'f4',
      title: 'Assemble the answer',
      detail: 'One list, by category.',
      status: 'done',
      output: 'Done.',
      tools: []
    }
  ]),
  'completed'
)

/** The run's own calls, exactly as the audit log recorded them. */
const FORECAST_UNRUN_CALLS: ToolCallRecord[] = [
  call('m1', 'memory_search', 'f3'),
  call('m2', 'reference_lookup', 'f4'),
  call('m3', 'reference_lookup', 'f4'),
  call('m4', 'reference_lookup', 'f4')
]

/** The row's verdict on a forecast that did not happen. */
const UNRUN = /which this step never ran/

describe('a forecast that did not happen is reconciled too', () => {
  const html = render(FORECAST_UNRUN, FORECAST_UNRUN_CALLS)
  const r = rows(html)

  test('the fixture is the shape the failure was found in', () => {
    assert.match(r[0]!, /Tools — may use: list_notes/)
    assert.match(r[1]!, /Tools — may use: read_note/)
    assert.match(r[2]!, /Tools — none planned/)
    assert.match(r[3]!, /Tools — none planned/)
    // The steps that forecast a tool ran none, and the ones that forecast
    // none ran four between them. That inversion is the whole case.
    for (const row of [r[0]!, r[1]!]) assert.ok(!/\d+ tool calls?/.test(row))
    assert.match(r[2]!, /1 tool call\b/)
    assert.match(r[3]!, /3 tool calls/)
  })

  test('a forecast tool that never ran is named on the row', () => {
    assert.match(r[0]!, UNRUN)
    assert.match(r[0]!, /Forecast list_notes/)
    assert.match(r[1]!, /Forecast read_note/)
  })

  test('the note names the tool that did not run, and only that one', () => {
    const note = textNodes(`<li ${r[0]!}`).find((n) => UNRUN.test(n.text))
    assert.ok(note, 'the row carries no verdict on its own unrun forecast')
    assert.match(note!.text, /list_notes/)
    assert.ok(!/read_note/.test(note!.text), `another step's forecast leaked in: "${note!.text}"`)
  })

  test('the header no longer reads as a clean 4/4', () => {
    const h = header(html)
    assert.match(h, /4\/4 steps done/)
    assert.match(h, /4 of 4 steps diverged from their forecast/)
  })

  /**
   * PT2's rule, extended to a fixture PT2 never covered. How the plan ended
   * stays the heaviest thing in the block; a clause appended to the header must
   * not become a second stamp competing with it. Weight, not contrast — the
   * header count has out-contrasted the outcome badge since v1.12.3, and the
   * qualification is deliberately pinned to the count rather than below it.
   */
  test('the outcome is still the heaviest thing in the block', () => {
    const nodes = textNodes(html)
    const badge = nodes.find((n) => n.text === OUTCOME_LABEL.completed)
    const note = nodes.find((n) => /diverged from their forecast/.test(n.text))
    assert.ok(badge && note, 'the fixture lost its outcome or its header note')
    const heavier = nodes.filter((n) => n !== badge && weight(n.cls) >= weight(badge!.cls))
    assert.equal(heavier.length, 0, `set no heavier than ${heavier.map((n) => n.text).join(' | ')}`)
  })

  test('the header note carries the same weight as the count it qualifies', () => {
    const nodes = textNodes(html)
    const count = nodes.find((n) => /4\/4 steps done/.test(n.text))
    const note = nodes.find((n) => /diverged from their forecast/.test(n.text))
    assert.ok(count && note, 'the fixture lost its count or its header note')
    assert.equal(weight(note!.cls), weight(count!.cls))
    for (const dark of [false, true]) {
      assert.equal(
        legible(note!, html, dark).toFixed(2),
        legible(count!, html, dark).toFixed(2),
        `${dark ? 'dark' : 'light'}: the qualification is dimmer than the claim it qualifies`
      )
    }
  })

  test('an unrun forecast is stated, not warned about', () => {
    const note = textNodes(html).find((n) => UNRUN.test(n.text))
    const warning = textNodes(html).find((n) => MISMATCH.test(n.text))
    assert.ok(note && warning, 'the fixture carries only one of the two verdicts')
    assert.ok(!/⚠/.test(note!.text), `the quiet reconciliation shouts: "${note!.text}"`)
    assert.match(warning!.text, /⚠️/)
    for (const dark of [false, true]) {
      const quiet = legible(note!, html, dark)
      const loud = legible(warning!, html, dark)
      const theme = dark ? 'dark' : 'light'
      // Legible, or the reader cannot learn their approval was uninformed …
      assert.ok(quiet >= 4.5, `${theme}: the note misses AA at ${quiet.toFixed(2)}:1`)
      // … and quieter than a tool that ran unannounced, or the two failures
      // arrive at one volume and the reader learns to discount both.
      assert.ok(quiet < loud, `${theme}: note ${quiet.toFixed(2)}:1 vs warning ${loud.toFixed(2)}:1`)
    }
  })

  test('the reconciliation outlives the setting that hides tool-call details', () => {
    const hidden = renderToStaticMarkup(
      createElement(PlanBlockView, {
        plan: FORECAST_UNRUN,
        streaming: false,
        onResolve: () => {},
        records: FORECAST_UNRUN_CALLS,
        hideToolCalls: true
      })
    ).replace(/<!-- -->/g, '')
    assert.ok(!/\d+ tool calls?/.test(hidden), 'the fixture no longer hides the call blocks')
    assert.match(hidden, UNRUN)
    assert.match(hidden, /4 of 4 steps diverged/)
  })
})

/**
 * The true negative that has to sit beside every true positive here: a plan
 * whose forecast was accurate must produce no noise at all. Same tools, same
 * statuses, same shape — only the calls are the ones the steps said they would
 * make.
 */
describe('a plan whose forecast was accurate says nothing about it', () => {
  const ACCURATE = endPlan(
    plan([
      {
        id: 'p1',
        title: 'List the stored notes',
        detail: 'Enumerate what the notebook holds.',
        status: 'done',
        output: 'Two notes.',
        tools: ['list_notes']
      },
      {
        id: 'p2',
        title: 'Read the matching note',
        detail: 'Pull the one about the household.',
        status: 'done',
        output: '3 people.',
        tools: ['read_note']
      },
      {
        id: 'p3',
        title: 'Assemble the answer',
        detail: 'One list, by category.',
        status: 'done',
        output: 'Done.',
        tools: []
      }
    ]),
    'completed'
  )
  const html = render(ACCURATE, [
    call('n1', 'list_notes', 'p1'),
    call('n2', 'read_note', 'p2'),
    call('n3', 'read_note', 'p2')
  ])

  test('the fixture really did run the tools it forecast', () => {
    const r = rows(html)
    assert.match(r[0]!, /1 tool call\b/)
    assert.match(r[1]!, /2 tool calls/)
    assert.ok(!/\d+ tool calls?/.test(r[2]!), 'the reasoning-only step ran something')
  })

  test('neither direction of the reconciliation says a word', () => {
    assert.ok(!UNRUN.test(html), 'an accurate forecast is faulted for an unrun tool')
    assert.ok(!MISMATCH.test(html), 'an accurate forecast is faulted for an undisclosed run')
  })

  test('the header is the plain count, with nothing appended to it', () => {
    const h = header(html)
    assert.match(h, /3\/3 steps done/)
    assert.ok(!/diverged/.test(h), `the header hedges an accurate plan: "${h}"`)
  })
})

/**
 * The class, not the two instances. Round 5 recorded that a check written
 * against the forms it has already seen gets defeated by one it has not, and
 * round 6 sharpened it: any check reading a quantity *adjacent to* the one it
 * means fails the same way. The quantity meant here is the symmetric difference
 * of forecast and executed, so that is what is asserted — every member of it
 * reaches the row, whichever side it came from.
 */
describe('the reconciliation is the whole difference, not one side of it', () => {
  const cases: { forecast: string[]; ran: string[] }[] = [
    { forecast: [], ran: [] },
    { forecast: ['list_notes'], ran: [] },
    { forecast: [], ran: ['reference_lookup'] },
    { forecast: ['memory_search'], ran: ['memory_search', 'reference_lookup'] },
    { forecast: ['list_notes', 'read_note'], ran: ['memory_search'] },
    { forecast: ['list_notes', 'read_note'], ran: ['read_note'] },
    { forecast: ['web_search'], ran: ['web_search'] }
  ]

  for (const { forecast, ran } of cases) {
    const label = `forecast [${forecast.join(' ')}] ran [${ran.join(' ')}]`

    test(`both sides reach the row: ${label}`, () => {
      const p = plan([
        { id: 'x1', title: 'Step', detail: 'Do it.', status: 'done', output: 'ok', tools: forecast }
      ])
      const html = render(
        p,
        ran.map((name, i) => call(`x${i}`, name, 'x1'))
      )
      const row = rows(html)[0]!
      // Only what the row says as a *verdict* counts. Reading the whole row
      // would let the forecast preview vouch for its own unrun name, which is
      // the reassurance this round exists to remove.
      const verdicts = textNodes(`<li ${row}`)
        .filter((n) => UNRUN.test(n.text) || MISMATCH.test(n.text))
        .map((n) => n.text)
        .join(' ')
      const expected = [
        ...ran.filter((n) => !forecast.includes(n)),
        ...forecast.filter((n) => !ran.includes(n))
      ]
      for (const name of expected) {
        assert.match(
          verdicts,
          new RegExp(`\\b${name}\\b`),
          `${name} is in the difference and no verdict names it: "${verdicts}"`
        )
      }
      // And nothing is invented: a tool on both sides earns no verdict at all.
      for (const name of [...forecast, ...ran].filter((n) => !expected.includes(n))) {
        assert.ok(
          !new RegExp(`\\b${name}\\b`).test(verdicts),
          `${name} was forecast and ran, and is faulted anyway: "${verdicts}"`
        )
      }
      if (expected.length === 0) {
        assert.equal(verdicts, '', `a matching forecast is faulted: ${label}`)
        assert.ok(!/diverged/.test(header(html)), `a matching forecast reaches the header: ${label}`)
      } else {
        assert.match(header(html), /1 of 1 step diverged from its forecast/)
      }
    })
  }
})

/**
 * The other half of "written against the class": *did not* is not *could not
 * have*. Only a step that reached the end of its own sub-turn can be said to
 * have finished without touching what it forecast. A step that failed, was
 * stopped, or was abandoned when the plan ended never got that far — and its
 * row already says so, in a struck-through line that must not acquire a second
 * one repeating it.
 */
describe('a step that never reached its forecast is not faulted for it', () => {
  for (const status of ['pending', 'running', 'failed', 'stopped', 'skipped'] as const) {
    test(`a ${status} step is not told it skipped its forecast`, () => {
      const html = render(
        plan([
          { id: 'y1', title: 'Look it up', detail: 'Check the library.', status, tools: ['read_note'] }
        ])
      )
      assert.match(html, /Tools — may use: read_note/)
      assert.ok(!UNRUN.test(html), `a ${status} step is faulted for a forecast it never reached`)
      assert.ok(!/diverged/.test(header(html)), `a ${status} step reaches the header`)
    })
  }

  test('the same step, once done, is', () => {
    const html = render(
      plan([
        {
          id: 'y1',
          title: 'Look it up',
          detail: 'Check the library.',
          status: 'done',
          output: 'ok',
          tools: ['read_note']
        }
      ])
    )
    assert.match(html, UNRUN)
    assert.match(html, /Forecast read_note/)
  })
})

// ---- v1.18: what the block says to a reader who cannot see it ---------------

/**
 * The authority on every claim in this section is `test/planAccessibilityCheck
 * .ts`, which reads the computed accessibility tree out of a real Chromium
 * window over CDP. A name is *computed*, and markup is not what a reader is
 * handed: the defect this round closed was invisible in the markup and plain in
 * the tree — a `<button>` wrapping four lines of prose is named with all four,
 * and `<ol>` is a list with no `role=` anywhere on it.
 *
 * What is pinned here instead is the smaller set of facts the markup alone
 * decides, so they fail in the fast suite rather than only under Electron: that
 * a row with nothing to open is not dressed as a control, that a state word
 * exists at all and differs for every status, and that the header carries
 * exactly one live region rather than none or one per line.
 */

const EVERY_STATUS: PlanStepStatus[] = [
  'pending',
  'running',
  'done',
  'failed',
  'stopped',
  'skipped'
]

/** The tag of the row's disclosure control, if the row rendered one. */
function stepButton(row: string): string | null {
  const at = row.indexOf('<button')
  return at === -1 ? null : row.slice(at, row.indexOf('</button>', at))
}

describe('every step status says what it is, not only what colour it is', () => {
  test('all six statuses are named, and no two alike', () => {
    const labels = EVERY_STATUS.map((s) => STATUS_LABEL[s])
    for (const [i, label] of labels.entries()) {
      assert.ok(label && label.trim().length > 0, `${EVERY_STATUS[i]} has no label`)
    }
    assert.equal(new Set(labels).size, 6, `two statuses share a label: ${labels.join(' | ')}`)
    assert.equal(Object.keys(STATUS_LABEL).length, 6, 'a status exists with no label')
  })

  for (const status of EVERY_STATUS) {
    test(`a ${status} step carries its state on the glyph`, () => {
      const html = render(plan([step(1, status)]))
      assert.match(
        html,
        new RegExp(`role="img" aria-label="${STATUS_LABEL[status]}"`),
        `the ${status} glyph is a bare symbol`
      )
    })
  }

  // The negative: the label is per status, not one word stamped on every row.
  test('two different statuses in one plan do not share a label', () => {
    const html = render(plan([step(1, 'done', 'ok'), step(2, 'failed', 'boom'), step(3, 'pending')]))
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])
    assert.equal(new Set(labels).size, labels.length, `repeated label in ${labels.join(' | ')}`)
  })
})

describe('a row is a control only when there is something to open', () => {
  test('a step with output renders a button that says whether it is open', () => {
    const row = rows(render(plan([step(1, 'done', 'the result')])))[0]!
    const button = stepButton(row)
    assert.ok(button, 'an expandable step renders no control')
    assert.match(button!, /aria-expanded="false"/)
  })

  test('a step with nothing to open renders no control at all', () => {
    const row = rows(render(plan([step(1, 'pending')])))[0]!
    assert.equal(stepButton(row), null, 'a step with nothing to open is dressed as a button')
  })

  test('a cancelled plan offers a reader no controls whatsoever', () => {
    const html = render(CANCELLED)
    assert.ok(!html.includes('<button'), 'a dead plan still renders buttons')
    assert.ok(!html.includes('disabled'), 'a dead plan still renders a disabled control')
  })

  test("the row's prose is outside the control, not swallowed into its name", () => {
    const row = rows(render(plan([step(1, 'done', 'the result')])))[0]!
    const button = stepButton(row)!
    assert.ok(!button.includes('detail 1'), 'the detail line is inside the button')
    assert.ok(!button.includes('Tools —'), 'the tool forecast is inside the button')
    // …and the row still carries both, so the two assertions above are not
    // passing because the lines were dropped.
    assert.match(row, /detail 1/)
    assert.match(row, /Tools —/)
  })
})

describe('the block has one live region, and it carries the state', () => {
  const STATES: [string, ChatPlan, string][] = [
    ['never approved', plan([step(1, 'pending')], { approved: false }), 'awaiting approval'],
    ['running', plan([step(1, 'running')]), 'running'],
    ['finished', endPlan(plan([step(1, 'done', 'ok')]), 'completed'), OUTCOME_LABEL.completed],
    ['cancelled', CANCELLED, OUTCOME_LABEL.cancelled],
    ['stopped', STOPPED, OUTCOME_LABEL.stopped],
    ['failed', FAILED, OUTCOME_LABEL.failed]
  ]

  for (const [name, p, expected] of STATES) {
    test(`${name}: exactly one live region, saying "${expected}"`, () => {
      const html = render(p)
      const live = [...html.matchAll(/aria-live="[^"]*"/g)]
      // One, never none — a region that only comes into existence when the
      // plan ends announces nothing, which is what three conditional spans
      // did — and never more than one, because a block that is live all over
      // talks over the reader for the whole run.
      assert.equal(live.length, 1, `${live.length} live regions`)
      assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/)
      assert.equal(planHeaderStatus(p).text, expected)
    })
  }

  test('the six states put six different words in that one region', () => {
    const words = STATES.map(([, p]) => planHeaderStatus(p).text)
    assert.equal(new Set(words).size, 6, `states collapsed to ${words.join(' | ')}`)
  })

  test('the step count stays outside it, so a run does not narrate itself', () => {
    const html = render(STOPPED)
    const at = html.indexOf('aria-live=')
    const region = html.slice(html.lastIndexOf('<span', at), html.indexOf('</span>', at))
    assert.ok(!/steps done/.test(region), `the count is inside the live region: ${region}`)
    assert.match(header(html), /steps done/)
  })
})

describe('the block names itself out of the header a reader can see', () => {
  test('the group is labelled by its own header, not by a hidden string', () => {
    const html = render(STOPPED)
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)
    assert.ok(labelledBy, 'the block exposes no name at all')
    assert.match(html, /role="group"/)
    assert.ok(
      html.includes(`id="${labelledBy![1]}"`),
      `aria-labelledby="${labelledBy![1]}" points at no element in the block`
    )
    // The named element is the header, so the outcome cannot be announced
    // without the count it qualifies, or the count without the outcome.
    const headerText = header(html)
    assert.ok(headerText.includes(`id="${labelledBy![1]}"`), 'the name points below the header')
    assert.match(headerText, /steps done/)
    assert.match(headerText, new RegExp(OUTCOME_LABEL.stopped))
  })

  test('the decorative glyphs are not part of that name', () => {
    const html = render(STOPPED)
    assert.match(html, /aria-hidden="true">📋</, 'the clipboard is announced as "clipboard"')
  })
})
