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
    assert.ok(!r[1]!.includes('text-red-500'), 'the stopped step renders in failure red')
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
    assert.match(r[1]!, /text-red-500/)
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
