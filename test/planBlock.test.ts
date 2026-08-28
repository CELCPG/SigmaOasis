import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlanBlockView } from '../src/renderer/src/components/PlanBlockView'
import {
  ABANDONED_AT_GATE,
  ABANDONED_MID_RUN,
  abandonedNote,
  abandonOrphanedPlans,
  abandonPlan,
  awaitingApproval,
  endPlan,
  OUTCOME_LABEL,
  PLAN_OUTCOMES,
  planHeaderCount,
  planHeaderStatus,
  STATUS_LABEL,
  STATUS_NOTE
} from '../src/renderer/src/lib/planState'
import type {
  ChatMessage,
  ChatPlan,
  Conversation,
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
/**
 * The shape a plan comes back from disk in when the app quit while it was
 * waiting to be approved — unapproved, nothing run, and no resolver behind it.
 * Built by hand here and produced by `abandonOrphanedPlans` further down, so
 * the block is measured against the object the load path really makes.
 */
const ABANDONED_PLAN = abandonPlan(
  plan([step(1, 'pending'), step(2, 'pending'), step(3, 'pending')], { approved: false })
)
/**
 * The other half of the same failure: the app quit with a step in flight. Left
 * alone this rendered `running` in the accent ink over a '◌' pulsing forever.
 */
const ABANDONED_MID = abandonPlan(
  plan([step(1, 'done', 'ok'), step(2, 'running'), step(3, 'pending'), step(4, 'pending')])
)
/** The same shape the sweep is asserted to produce, three steps rather than four. */
const ABANDONED_MID_PLAN = abandonPlan(
  plan([step(1, 'done', 'ok'), step(2, 'running'), step(3, 'pending')])
)

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

describe('the seven states a reader has to tell apart', () => {
  const states: ChatPlan[] = [
    plan([step(1, 'pending'), step(2, 'pending')], { approved: false }), // never approved
    plan([step(1, 'done', 'ok'), step(2, 'running')]), // running
    endPlan(plan([step(1, 'done', 'ok'), step(2, 'done', 'ok')]), 'completed'),
    CANCELLED,
    STOPPED,
    FAILED,
    ABANDONED_PLAN
  ]

  test('each renders a different header', () => {
    const headers = states.map((p) => header(render(p)))
    assert.equal(new Set(headers).size, 7)
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
    for (const outcome of ['completed', 'cancelled', 'stopped', 'failed', 'abandoned'] as const) {
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
 * (3.10–3.67:1). Hue still has to separate the five outcomes, which is what the
 * assertions below check; these only say what each hue *is*. `info` is v2.8.1's,
 * for the app's own ending — see `abandoned` in lib/planState.ts.
 */
const STATUS_INK = (() => {
  const css = readFileSync(join(REPO, 'src/renderer/src/assets/index.css'), 'utf8')
  const out: Record<string, string[]> = {}
  for (const name of ['danger', 'warn', 'ok', 'info']) {
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
  failed: FAILED,
  abandoned: ABANDONED_PLAN
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

  // "Hue still separates" the outcomes has been OUTCOME_CLASS's claim since
  // v1.12.3, and until v2.8.1 nothing here checked it: a mutation that gave
  // `abandoned` the neutral ink of `cancelled` passed this whole file. Those
  // two in particular must not share one — one is the reader's Cancel, the
  // other the app's quit — so the claim is measured, as the ink each badge
  // actually resolves to, in both themes.
  for (const dark of [false, true]) {
    test(`no two outcomes share an ink (${dark ? 'dark' : 'light'})`, () => {
      const inks = (Object.keys(ENDED) as PlanOutcome[]).map((outcome) => {
        const html = render(ENDED[outcome])
        const badge = textNodes(html).find((n) => n.text === OUTCOME_LABEL[outcome])
        assert.ok(badge, `no element renders "${OUTCOME_LABEL[outcome]}" as its own text`)
        return `${outcome}=${ink(badge!.cls, dark, background(html, dark)).map(Math.round).join(',')}`
      })
      const colours = inks.map((s) => s.slice(s.indexOf('=') + 1))
      assert.equal(new Set(colours).size, inks.length, `outcomes share an ink: ${inks.join(' | ')}`)
    })
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
  for (const status of [
    'pending',
    'running',
    'failed',
    'stopped',
    'skipped',
    'interrupted'
  ] as const) {
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
  'skipped',
  'interrupted'
]

/** The tag of the row's disclosure control, if the row rendered one. */
function stepButton(row: string): string | null {
  const at = row.indexOf('<button')
  return at === -1 ? null : row.slice(at, row.indexOf('</button>', at))
}

describe('every step status says what it is, not only what colour it is', () => {
  test('all seven statuses are named, and no two alike', () => {
    const labels = EVERY_STATUS.map((s) => STATUS_LABEL[s])
    for (const [i, label] of labels.entries()) {
      assert.ok(label && label.trim().length > 0, `${EVERY_STATUS[i]} has no label`)
    }
    assert.equal(new Set(labels).size, 7, `two statuses share a label: ${labels.join(' | ')}`)
    assert.equal(Object.keys(STATUS_LABEL).length, 7, 'a status exists with no label')
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
    ['failed', FAILED, OUTCOME_LABEL.failed],
    ['abandoned', ABANDONED_PLAN, OUTCOME_LABEL.abandoned]
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

  test('the seven states put seven different words in that one region', () => {
    const words = STATES.map(([, p]) => planHeaderStatus(p).text)
    assert.equal(new Set(words).size, 7, `states collapsed to ${words.join(' | ')}`)
  })

  test('the step count stays outside it, so a run does not narrate itself', () => {
    const html = render(STOPPED)
    const at = html.indexOf('aria-live=')
    const region = html.slice(html.lastIndexOf('<span', at), html.indexOf('</span>', at))
    // v2.4: the negative is on the word "step", not on the phrase "steps done".
    // A stopped plan's header no longer says "steps done" at all, so the older
    // assertion had become true of a region that swallowed the whole count.
    assert.ok(!/step/i.test(region), `the count is inside the live region: ${region}`)
    assert.match(header(html), /\d+ steps\b/)
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
    assert.match(headerText, /\d+ steps\b/)
    assert.match(headerText, new RegExp(OUTCOME_LABEL.stopped))
  })

  test('the decorative glyphs are not part of that name', () => {
    const html = render(STOPPED)
    assert.match(html, /aria-hidden="true">📋</, 'the clipboard is announced as "clipboard"')
  })
})

/* ---- v1.17.4: a cancelled plan was attributed to nobody ------------------- */

/**
 * A blind critic, on the cancelled badge:
 *
 * > `"cancelled — nothing ran"` attributes the decision to nobody, where the
 * > same build family manages `"stopped by you"` elsewhere.
 *
 * The first question is not what to write but whether the app may write it. It
 * may, and not merely usually: `cancelled` has exactly one writer in the whole
 * renderer, and that writer's only caller is the Cancel control inside this
 * block. Every ending the app reaches on its own is a different word —
 * `stopped` from the abort listener on the approval gate and the
 * `signal.aborted` checks around each step, `failed` from a step that threw,
 * `completed` from a plan that ran out, and (v2.8.1) `abandoned` from the load
 * sweep, for a plan whose process died under it. There is no fifth way in, so
 * there is no second case to write words for.
 *
 * That is a property of the source, not of the render, so the last test here
 * reads the source. A future path that ends a plan without the reader touching
 * it would make the badge a lie, and nothing in a rendered checklist could
 * catch that.
 */
describe('a plan that ended says whose decision it was', () => {
  test('the cancelled badge names the reader, and still says nothing ran', () => {
    assert.equal(OUTCOME_LABEL.cancelled, 'cancelled by you — nothing ran')
    // Both halves matter: who decided, and what the rows below it are. The
    // v1.12.3 finding — a reader taking "Result: ~$1,080" off a step that never
    // ran — is why the second half cannot be dropped for room.
    assert.match(planHeaderStatus(CANCELLED).text, /by you/)
    assert.match(planHeaderStatus(CANCELLED).text, /nothing ran/)
  })

  test('exactly the two outcomes the reader causes name the reader', () => {
    // Every outcome there is, read off the label table rather than typed out:
    // v2.8.1 added a fifth, and a hand-written list here would have let it
    // claim the reader without this test ever seeing it.
    const byReader = PLAN_OUTCOMES.filter((o) => /\byou\b/.test(OUTCOME_LABEL[o]))
    // The true negative: a plan that finished, a plan that failed and a plan
    // the app walked out on are not the reader's doing, and must not be laid
    // at the reader's door.
    assert.deepEqual(byReader, ['cancelled', 'stopped'])
    assert.ok(PLAN_OUTCOMES.includes('abandoned'), 'the outcome list is not the whole union')
  })

  test('the app has exactly one way to write "cancelled", and it is the reader’s button', () => {
    const src = (p: string): string => readFileSync(join(REPO, 'src', 'renderer', 'src', p), 'utf-8')

    // The executor never picks the word: it forwards the decision the gate was
    // resolved with, so it cannot name a party by inference from something
    // nearby. (Through v1.17.3 it read `signal.aborted` immediately after the
    // resolve and chose from that — a fact about the turn's abort controller
    // standing in for a fact about which control was pressed.)
    const planMode = src('hooks/planMode.ts')
    assert.ok(!/finish\(\s*'cancelled'/.test(planMode), 'planMode picks the word itself')
    assert.ok(!/resolve\(\s*'cancelled'/.test(planMode), 'planMode resolves the gate as cancelled')
    assert.match(planMode, /signal\.addEventListener\('abort', \(\) => resolve\('stopped'\)/)

    // And the single writer is the Approve/Cancel resolver.
    const hook = src('hooks/useLMStudio.ts')
    const writes = hook.split('\n').filter((l) => /'cancelled'/.test(l))
    assert.equal(writes.length, 1, `${writes.length} writers of 'cancelled' in useLMStudio.ts`)
    assert.match(writes[0]!, /resolve\(approved \? 'approved' : 'cancelled'\)/)

    // Whose only caller is the block's own Cancel button.
    const view = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'components', 'PlanBlockView.tsx'),
      'utf-8'
    )
    assert.equal(
      (view.match(/onResolve\(false\)/g) ?? []).length,
      1,
      'more than one control refuses the plan'
    )
  })
})

/* ---- v2.4: a progress fraction on a plan that will never progress --------- */

/**
 * Round 11's blind critics, on both arms: `Plan — 0/4 steps done` sat above
 * four rows every one of which read `never ran`, beside a badge reading
 * `cancelled by you — nothing ran`.
 *
 * Nothing in the fraction is false. It is a *promise*: a numerator that climbs
 * toward a denominator that gets reached, which is what a reader of a checklist
 * takes from `0/4`. Round 11 taught the badge to attribute the decision and the
 * count went on describing a run in progress — round 10's lesson (a sentence
 * broader than its measurement) with the breadth in the presentation.
 *
 * The rule is not "no fractions on dead plans": a fraction may stand as long as
 * it is closed. `4/4 steps done` leaves nothing out and says the same thing as
 * the census in fewer words, so it stays. The two true negatives below are that
 * case and the live case, and they are what stop this being bought cheaply by a
 * build that simply stopped counting.
 */
describe('a plan that is over stops reporting progress (v2.4)', () => {
  test('the recorded line: nothing ran, and the count no longer implies it might', () => {
    const FOUR = endPlan(
      plan([step(1, 'pending'), step(2, 'pending'), step(3, 'pending'), step(4, 'pending')], {
        approved: false
      }),
      'cancelled'
    )
    assert.equal(planHeaderCount(FOUR), '4 steps: 4 never ran')
    // Both halves on one screen, in the markup the reader is handed.
    const h = header(render(FOUR))
    assert.ok(!/0\/4 steps done/.test(h), `the dead plan still shows a progress fraction: "${h}"`)
    assert.match(h, new RegExp(OUTCOME_LABEL.cancelled))
  })

  test('a plan stopped part-way says what became of every one of its steps', () => {
    // STOPPED is 1 done, 1 stopped, 2 that never ran — and `1/4 steps done`
    // was the fraction inviting the reader to wait for steps 3 and 4.
    assert.equal(planHeaderCount(STOPPED), '4 steps: 1 done, 1 stopped by you, 2 never ran')
    assert.equal(planHeaderCount(FAILED), '3 steps: 1 done, 1 failed, 1 never ran')
    // v2.8.1: the plan the app walked out on is a dead checklist too, and the
    // step it was in the middle of is counted as what it is — neither a step
    // the reader stopped nor one that never ran.
    assert.equal(planHeaderCount(ABANDONED_MID), '4 steps: 1 done, 1 cut off, 2 never ran')
    assert.equal(planHeaderCount(ABANDONED_PLAN), '3 steps: 3 never ran')
  })

  test('the census accounts for every step, whatever the statuses are', () => {
    // The class, not the three instances: for any terminal plan the numbers in
    // the header sum to the number of rows below it. A tally that walked a
    // hand-written list of statuses and missed one would leave rows
    // unaccounted for, and this is the assertion that would catch it.
    for (const p of [CANCELLED, STOPPED, FAILED, ABANDONED_PLAN, ABANDONED_MID]) {
      const text = planHeaderCount(p)
      const tallied = Object.values(STATUS_LABEL).reduce((sum, label) => {
        const m = text.match(new RegExp(`\\b(\\d+) ${label.toLowerCase()}\\b`))
        return sum + (m ? Number(m[1]) : 0)
      }, 0)
      assert.equal(tallied, p.steps.length, `"${text}" accounts for ${tallied} of ${p.steps.length}`)
    }
  })

  test('a closed fraction is left alone — the true negative', () => {
    // Every step done: the fraction leaves nothing out, so it already IS the
    // census and is the shorter of the two.
    const DONE = endPlan(plan([step(1, 'done', 'ok'), step(2, 'done', 'ok')]), 'completed')
    assert.equal(planHeaderCount(DONE), '2/2 steps done')
  })

  test('a plan still in flight still counts its progress — the true negative', () => {
    // QUEUED is approved and running: 0 of 3 done, and here `0/3` is exactly
    // right, because the numerator really is expected to climb.
    assert.equal(planHeaderCount(QUEUED), '0/3 steps done')
    assert.equal(
      planHeaderCount(plan([step(1, 'pending'), step(2, 'pending')], { approved: false })),
      '0/2 steps done'
    )
  })
})

/* ---- v2.8.1: the approval that did not survive the quit -------------------- */

/**
 * The last opening in the gap v1.12 closed, on the other side of a restart.
 *
 * `planApprovals` (hooks/planMode.ts) is a module-level Map and nothing else,
 * so a plan that reached disk with its gate open came back with
 * `approved:false`, no outcome and every step 'pending' — which is exactly
 * what `awaitingApproval` is looking for. The block drew "▶ Run this plan" and
 * "Cancel" in full colour over a resolver that no longer existed;
 * `resolvePlan` found nothing in the Map and returned, so both buttons did
 * nothing and said nothing.
 *
 * Two failures at once: a control offered where the app cannot perform the
 * remedy, and a plan the app abandoned by quitting still asking the reader to
 * decide. The second is why 'abandoned' had to be its own word — 'cancelled'
 * and 'stopped' are the reader's, and spending one of them here would have
 * credited them with a decision the app took away from them.
 */
describe('a plan whose approval died with the app', () => {
  const html = render(ABANDONED_PLAN)
  assert.equal(ABANDONED_PLAN.approved, false)

  test('no control is offered that the app cannot honour', () => {
    assert.equal(enabledButtons(html), 0)
    assert.ok(!/Run this plan/.test(html), 'still renders "▶ Run this plan"')
    assert.ok(!/>Cancel</.test(html), 'still renders "Cancel"')
  })

  test('nothing reads as awaiting approval', () => {
    assert.ok(!/awaiting approval/.test(html), 'still reads "awaiting approval"')
    assert.equal(awaitingApproval(ABANDONED_PLAN), false)
  })

  test('the header names the app as what ended it', () => {
    assert.match(header(html), /the app quit/)
  })

  test('the header does not attribute the ending to the reader', () => {
    const h = header(html)
    assert.ok(!/cancelled/.test(h), 'the app’s own ending is labelled "cancelled"')
    assert.ok(!/stopped by you/.test(h), 'the app’s own ending is labelled "stopped by you"')
  })

  test('no step is left looking queued', () => {
    assert.equal((html.match(/○/g) ?? []).length, 0)
    for (const row of rows(html)) assert.match(row, /never ran/)
  })

  test('the reader is told why the buttons are gone and what to do instead', () => {
    assert.match(html, /The app quit while this plan was waiting to be approved/)
    assert.match(html, /Send the request again/)
  })

  test('the note sits where the controls were, below the steps', () => {
    assert.ok(html.indexOf(ABANDONED_AT_GATE) > html.indexOf('</ol>'), 'the note is above the checklist')
  })

  test('the note does not outrank the outcome it explains', () => {
    const note = textNodes(html).find((n) => n.text === ABANDONED_AT_GATE)
    assert.ok(note, 'no element renders the note as its own text')
    const badge = textNodes(html).find((n) => n.text === OUTCOME_LABEL.abandoned)
    assert.ok(badge, 'no element renders the outcome as its own text')
    assert.ok(weight(note!.cls) < weight(badge!.cls), 'the note is set as heavy as the outcome')
  })

  for (const dark of [false, true]) {
    test(`the note clears AA in the ${dark ? 'dark' : 'light'} theme`, () => {
      const note = textNodes(html).find((n) => n.text === ABANDONED_AT_GATE)!
      const ratio = legible(note, html, dark)
      assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`)
    })
  }

  test('the note is louder than the steps that never ran', () => {
    const note = textNodes(html).find((n) => n.text === ABANDONED_AT_GATE)!
    for (const dark of [false, true]) {
      const body = textNodes(html).filter(isBodyCopy)
      assert.ok(body.length > 0, 'no step copy in the block to compare against')
      const loudest = Math.max(...body.map((n) => legible(n, html, dark)))
      assert.ok(
        legible(note, html, dark) > loudest,
        `note ${legible(note, html, dark).toFixed(2)}:1 vs copy ${loudest.toFixed(2)}:1`
      )
    }
  })

  test('a plan that ended any other way is not given the note', () => {
    for (const outcome of ['completed', 'cancelled', 'stopped', 'failed'] as const) {
      assert.ok(
        !render(ENDED[outcome]).includes(ABANDONED_AT_GATE),
        `a ${outcome} plan explains itself as abandoned`
      )
    }
    assert.ok(!render(AWAITING).includes(ABANDONED_AT_GATE), 'a live gate explains itself as abandoned')
  })
})

/**
 * The louder half of the same failure, and the one nobody had to press.
 *
 * A plan that was *executing* when the app quit reaches disk by the same
 * routes and comes back with `approved:true`, no outcome, and a step still
 * marked 'running'. The header rendered `running` in the accent ink and the
 * row rendered '◌' with `animate-pulse` — an animation asserting that work is
 * happening right now, in a process that stopped existing, and unlike the dead
 * buttons it never even had to be interacted with to lie. Nothing resolves it,
 * because the thing that would have resolved it is what died.
 */
describe('a plan the app quit in the middle of', () => {
  const html = render(ABANDONED_MID)
  const r = rows(html)

  test('the header no longer says the plan is running', () => {
    assert.ok(!/running/.test(header(html)), 'the header still claims live work')
    assert.match(header(html), /the app quit/)
  })

  test('nothing in the block is still animated', () => {
    assert.ok(!/animate-pulse/.test(html), 'a row is still pulsing after the process died')
    assert.equal((html.match(/◌/g) ?? []).length, 0, 'the running glyph survived')
  })

  test('the step that was in flight says where it was cut off', () => {
    assert.match(r[1]!, /⊘/)
    assert.match(r[1]!, /cut off here/)
  })

  test('being cut off is not being stopped by the reader, and not failing', () => {
    assert.notEqual(marker(r[1]!), marker(rows(render(STOPPED))[1]!))
    assert.notEqual(marker(r[1]!), marker(rows(render(FAILED))[1]!))
    assert.ok(!r[1]!.includes('text-ink-danger'), 'the interrupted step renders in failure red')
    assert.ok(!r[1]!.includes('text-ink-warn'), 'the interrupted step renders in the reader’s Stop amber')
    assert.notEqual(STATUS_LABEL.interrupted, STATUS_LABEL.stopped)
    assert.ok(!/\byou\b/i.test(STATUS_LABEL.interrupted), 'the cut-off row is attributed to the reader')
    assert.ok(!/stopped here/.test(r[1]!), 'the interrupted step borrows the reader’s word')
  })

  test('it is also not a step that never ran', () => {
    assert.notEqual(marker(r[1]!), marker(r[2]!))
    assert.ok(!/never ran/.test(r[1]!), 'a step that was cut off mid-flight is told it never ran')
    assert.match(r[2]!, /never ran/)
    assert.match(r[3]!, /never ran/)
  })

  test('the step that finished keeps its result', () => {
    assert.match(r[0]!, /✓/)
    assert.ok(!/never ran/.test(r[0]!))
  })

  test('the interrupted row is not struck through like one that never ran', () => {
    // It ran. What it says about itself is a description of work that started,
    // which is a different claim from a row whose contents never happened.
    const strike = (row: string): number => (row.match(/line-through/g) ?? []).length
    assert.equal(strike(r[1]!), 0)
    assert.ok(strike(r[2]!) > 0, 'a never-run row stopped being struck')
  })

  for (const dark of [false, true]) {
    test(`the cut-off glyph clears AA in the ${dark ? 'dark' : 'light'} theme`, () => {
      const glyph = textNodes(html).find((n) => n.text === '⊘')
      assert.ok(glyph, 'no element renders the interrupted glyph as its own text')
      const ratio = legible(glyph!, html, dark)
      assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`)
    })
  }

  test('the note says the plan was running, not that it was waiting to start', () => {
    assert.ok(html.includes(ABANDONED_MID_RUN), 'the mid-run note is missing')
    assert.ok(!html.includes(ABANDONED_AT_GATE), 'a plan that ran says nothing ran')
    assert.ok(!/nothing ran/.test(ABANDONED_MID_RUN), 'the mid-run note claims nothing ran')
  })

  test('the two abandonments share a badge and are told apart below it', () => {
    // The badge names the ending and claims no extent, on purpose — so the
    // rows and the note are the only things that can carry how far it got, and
    // they have to.
    const badge = (h: string): string =>
      textNodes(h).find((n) => n.text === OUTCOME_LABEL.abandoned)!.cls
    assert.equal(badge(html), badge(render(ABANDONED_PLAN)))
    assert.match(header(html), /abandoned when the app quit/)
    assert.notEqual(abandonedNote(ABANDONED_MID), abandonedNote(ABANDONED_PLAN))
    assert.notEqual(rows(render(ABANDONED_PLAN))[1], r[1])
  })
})

describe('abandonedNote', () => {
  test('an unapproved plan is told nothing ran, because nothing did', () => {
    assert.equal(abandonedNote(ABANDONED_PLAN), ABANDONED_AT_GATE)
    assert.match(ABANDONED_AT_GATE, /waiting to be approved/)
    assert.match(ABANDONED_AT_GATE, /nothing ran/)
  })

  test('an approved plan is not', () => {
    assert.equal(abandonedNote(ABANDONED_MID), ABANDONED_MID_RUN)
    assert.match(ABANDONED_MID_RUN, /while this plan was running/)
  })

  test('approval is the discriminator even where no step got going', () => {
    // The app can quit between "approved" and the first step's own patch. The
    // rows say nothing ran; the note must not say it was still awaiting a
    // decision the reader had already given.
    const justApproved = abandonPlan(plan([step(1, 'pending'), step(2, 'pending')]))
    assert.deepEqual(justApproved.steps.map((s) => s.status), ['skipped', 'skipped'])
    assert.equal(abandonedNote(justApproved), ABANDONED_MID_RUN)
    assert.ok(!render(justApproved).includes(ABANDONED_AT_GATE))
  })

  test('both notes offer the same way forward', () => {
    for (const note of [ABANDONED_AT_GATE, ABANDONED_MID_RUN]) {
      assert.match(note, /The app quit/)
      assert.match(note, /Send the request again for a fresh plan\./)
    }
  })
})

describe('abandonPlan', () => {
  test('the step in flight is interrupted; the ones behind it never ran', () => {
    const out = abandonPlan(
      plan([step(1, 'done', 'ok'), step(2, 'running'), step(3, 'pending')])
    )
    assert.deepEqual(
      out.steps.map((s) => s.status),
      ['done', 'interrupted', 'skipped']
    )
    assert.equal(out.outcome, 'abandoned')
  })

  test('a step that already ended keeps what it said', () => {
    const out = abandonPlan(
      plan([step(1, 'failed', 'ECONNREFUSED'), step(2, 'stopped'), step(3, 'done', 'ok')])
    )
    assert.deepEqual(
      out.steps.map((s) => s.status),
      ['failed', 'stopped', 'done']
    )
  })

  test('it is endPlan plus the one status endPlan has no reason to touch', () => {
    // `endPlan` is the executor's, and the executor never hands it a running
    // step — it patches the row before it settles the plan. Only a process
    // that died mid-step can, which is why this lives here and not there.
    const settled = plan([step(1, 'done', 'ok'), step(2, 'failed', 'boom'), step(3, 'pending')])
    assert.deepEqual(abandonPlan(settled).steps, endPlan(settled, 'abandoned').steps)
    const midFlight = plan([step(1, 'running')])
    assert.equal(endPlan(midFlight, 'abandoned').steps[0]!.status, 'running')
    assert.equal(abandonPlan(midFlight).steps[0]!.status, 'interrupted')
  })
})

/* ---- the load sweep, and the two things it must not touch ------------------ */

function planMessage(id: string, p: ChatPlan): ChatMessage {
  return { id, role: 'assistant', content: '', plan: p, createdAt: 1 }
}

function convo(...messages: ChatMessage[]): Conversation {
  return {
    id: 'c1',
    title: 'Two weeks of water',
    mode: 'independent',
    messages,
    createdAt: 1,
    updatedAt: 2
  }
}

/** No executor is waiting on anything — the state after a restart. */
const NOTHING_LIVE = { has: () => false }

const ORPHAN = plan([step(1, 'pending'), step(2, 'pending'), step(3, 'pending')], {
  approved: false
})

describe('a plan read off disk with nobody behind it is settled at load', () => {
  test('the orphan is the shape the failure was found in', () => {
    assert.equal(awaitingApproval(ORPHAN), true)
    assert.match(render(ORPHAN), /Run this plan/)
    assert.equal(enabledButtons(render(ORPHAN)), 2)
  })

  const swept = abandonOrphanedPlans([convo(planMessage('m1', ORPHAN))], NOTHING_LIVE)
  const settled = swept[0]!.messages[0]!.plan!

  test('it is marked abandoned, and nothing else', () => {
    assert.equal(settled.outcome, 'abandoned')
    assert.equal(settled.approved, false)
  })

  test('every step says it never ran', () => {
    assert.deepEqual(
      settled.steps.map((s) => s.status),
      ['skipped', 'skipped', 'skipped']
    )
  })

  test('the settled plan is the one the block was measured against', () => {
    assert.deepEqual(settled, ABANDONED_PLAN)
  })

  test('the dead controls are gone from what renders', () => {
    assert.equal(enabledButtons(render(settled)), 0)
    assert.ok(!/Run this plan/.test(render(settled)))
  })

  test('a second load changes nothing further', () => {
    const again = abandonOrphanedPlans(swept, NOTHING_LIVE)
    assert.deepEqual(again[0]!.messages[0]!.plan, settled)
    assert.equal(again[0], swept[0], 'a settled plan is rewritten on every load')
  })

  test('the mid-run orphan is settled by the same sweep', () => {
    const running = plan([step(1, 'done', 'ok'), step(2, 'running'), step(3, 'pending')])
    assert.equal(running.outcome, undefined)
    assert.match(render(running), /animate-pulse/)

    const out = abandonOrphanedPlans([convo(planMessage('m1', running))], NOTHING_LIVE)
    const settledRun = out[0]!.messages[0]!.plan!
    assert.equal(settledRun.outcome, 'abandoned')
    assert.deepEqual(
      settledRun.steps.map((s) => s.status),
      ['done', 'interrupted', 'skipped']
    )
    assert.ok(!/animate-pulse/.test(render(settledRun)), 'the row is still pulsing after the sweep')
    assert.deepEqual(settledRun, ABANDONED_MID_PLAN)
  })

  test('one predicate covers both states, not two special cases', () => {
    // The gate shape and the running shape are the same claim — a plan with no
    // outcome asserts a process — and the sweep has to be written against the
    // claim. A sweep keyed on the awaiting-approval shape passes this file's
    // first half and leaves the louder half of the defect on screen.
    for (const live of [
      plan([step(1, 'pending'), step(2, 'pending')], { approved: false }),
      plan([step(1, 'running'), step(2, 'pending')]),
      plan([step(1, 'done', 'ok'), step(2, 'running')]),
      plan([step(1, 'done', 'ok'), step(2, 'pending')])
    ]) {
      const out = abandonOrphanedPlans([convo(planMessage('m1', live))], NOTHING_LIVE)
      assert.equal(out[0]!.messages[0]!.plan!.outcome, 'abandoned')
      const html = render(out[0]!.messages[0]!.plan!)
      // No control that resolves the gate. Counted by name rather than by
      // `enabledButtons`: since v1.18 a row with something to open is a real
      // button, so a step that finished before the quit still offers its
      // disclosure — which works, and is not what this is about.
      assert.ok(!/Run this plan/.test(html), 'still renders "▶ Run this plan"')
      assert.ok(!/>Cancel</.test(html), 'still renders "Cancel"')
      assert.ok(!/animate-pulse/.test(html))
      assert.ok(!/>running</.test(header(html)))
    }
  })

  test('the message keeps everything else it had', () => {
    const message = planMessage('m1', ORPHAN)
    message.content = 'Here is the plan.'
    message.modelId = 'qwen3-8b'
    const out = abandonOrphanedPlans([convo(message)], NOTHING_LIVE)[0]!.messages[0]!
    assert.equal(out.content, 'Here is the plan.')
    assert.equal(out.modelId, 'qwen3-8b')
    assert.equal(out.id, 'm1')
  })
})

/**
 * The true negatives. Each is a plan `awaitingApproval` would answer for the
 * same way the orphan does, or one the sweep has no business reading at all —
 * so a sweep that fires on any of them has replaced a false "you may still
 * decide this" with a false "the app quit on you", which is the same defect
 * pointed the other way.
 */
describe('the load sweep leaves alone what it is not for', () => {
  test('a gate that is genuinely open is untouched', () => {
    // `load()` can run mid-session — through v2.8.0 it re-ran on every
    // base-URL change, which the reader can make with the approval buttons on
    // screen. The resolver is right there.
    const live = { has: (id: string) => id === 'm1' }
    const input = [convo(planMessage('m1', ORPHAN))]
    const out = abandonOrphanedPlans(input, live)
    assert.equal(out[0], input[0], 'a live gate was rewritten')
    assert.equal(out[0]!.messages[0]!.plan!.outcome, undefined)
    assert.match(render(out[0]!.messages[0]!.plan!), /Run this plan/)
  })

  test('a step that is genuinely running is untouched', () => {
    // The other half of the same mirror. A plan mid-execution when `load()`
    // runs is being worked on by this process; settling it would stop the
    // pulse on a row where the pulse is telling the truth.
    const live = { has: (id: string) => id === 'm1' }
    const running = plan([step(1, 'done', 'ok'), step(2, 'running')])
    const input = [convo(planMessage('m1', running))]
    const out = abandonOrphanedPlans(input, live)
    assert.equal(out[0], input[0], 'a live run was rewritten')
    assert.equal(out[0]!.messages[0]!.plan!.outcome, undefined)
    assert.match(render(out[0]!.messages[0]!.plan!), /animate-pulse/)
    assert.match(header(render(out[0]!.messages[0]!.plan!)), />running</)
  })

  test('a plan that already ended keeps the ending it had', () => {
    for (const outcome of Object.keys(ENDED) as PlanOutcome[]) {
      const input = [convo(planMessage('m1', ENDED[outcome]))]
      const out = abandonOrphanedPlans(input, NOTHING_LIVE)
      assert.equal(out[0], input[0], `a ${outcome} plan was rewritten`)
      assert.equal(out[0]!.messages[0]!.plan!.outcome, outcome)
    }
  })

  test('a message carrying no plan is handed straight back', () => {
    const message: ChatMessage = { id: 'm0', role: 'user', content: 'two weeks of water', createdAt: 1 }
    const input = [convo(message)]
    const out = abandonOrphanedPlans(input, NOTHING_LIVE)
    assert.equal(out[0], input[0])
    assert.equal(out[0]!.messages[0], message)
  })

  test('a conversation with nothing to settle is the object it came in as', () => {
    const input = [convo(planMessage('m1', ENDED.completed)), convo(planMessage('m2', ENDED.failed))]
    assert.deepEqual(abandonOrphanedPlans(input, NOTHING_LIVE), input)
  })

  test('only the orphan in a mixed conversation moves', () => {
    const done = planMessage('m1', ENDED.completed)
    const orphan = planMessage('m2', ORPHAN)
    const out = abandonOrphanedPlans([convo(done, orphan)], NOTHING_LIVE)[0]!
    assert.equal(out.messages[0], done, 'a finished plan was rewritten beside an orphan')
    assert.equal(out.messages[1]!.plan!.outcome, 'abandoned')
    assert.equal(out.title, 'Two weeks of water')
  })
})

/**
 * Who is allowed to write which ending.
 *
 * The whole point of a fifth outcome is that the four that existed were spoken
 * for: `cancelled` and `stopped` are the reader's two, and the executor is the
 * only thing that can observe either. `abandoned` is the app's one, and the
 * load sweep is the only thing that can observe it. A word that starts being
 * written from both places stops meaning anything, and the failure would be
 * silent — the badge would still render, just about the wrong agent.
 */
describe('each ending has exactly one thing that can write it', () => {
  const planStateSrc = readFileSync(join(REPO, 'src/renderer/src/lib/planState.ts'), 'utf8')
  const planModeSrc = readFileSync(join(REPO, 'src/renderer/src/hooks/planMode.ts'), 'utf8')
  const loadSrc = readFileSync(join(REPO, 'src/renderer/src/hooks/useConversations.ts'), 'utf8')

  /**
   * `abandonPlan` and `abandonOrphanedPlans`, up to the label table that follows
   * them. Bounded rather than run to the end of the module, because the module
   * went on growing after them — the audit ledger lives there now — and a
   * reader's word written for the record would otherwise be charged to the
   * sweep.
   */
  const sweep = planStateSrc.slice(
    planStateSrc.indexOf('export function abandonPlan'),
    planStateSrc.indexOf('export const OUTCOME_LABEL')
  )
  assert.ok(
    planStateSrc.indexOf('export function abandonPlan') <
      planStateSrc.indexOf('export function abandonOrphanedPlans') &&
      planStateSrc.indexOf('export function abandonOrphanedPlans') <
        planStateSrc.indexOf('export const OUTCOME_LABEL'),
    'the sweep no longer sits between abandonPlan and OUTCOME_LABEL'
  )

  /**
   * Prose out. These files name every one of these words in their own
   * explanations, and a guard its own documentation trips is a guard nobody
   * keeps — the repo has learned that one twice (see the grounding banner in
   * chromeContrastCheck.ts).
   */
  const strip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

  test('the sweep is what the load path runs', () => {
    const load = loadSrc.slice(loadSrc.indexOf('const load ='), loadSrc.indexOf('const createConversation'))
    assert.ok(load.length > 0, 'useConversations no longer defines load before createConversation')
    assert.match(load, /abandonOrphanedPlans\(/)
    assert.match(load, /setConversations\(/)
    assert.ok(
      load.indexOf('abandonOrphanedPlans(') < load.indexOf('setConversations('),
      'the store is filled before the orphans are settled'
    )
  })

  test('the sweep is passed the executor’s own record of what it is behind', () => {
    assert.match(loadSrc, /import \{ livePlans \} from '\.\/planMode'/)
    assert.match(loadSrc, /abandonOrphanedPlans\([A-Za-z]+, livePlans\)/)
  })

  test('nothing but the sweep ends a plan as abandoned', () => {
    // The literal, comments stripped — not a call shape, which a reformat can
    // break while the property it was guarding still holds. `abandoned:` as a
    // Record key is bare, so the only quoted use is the one that writes it.
    const code = strip(planStateSrc)
    const writes = (code.match(/'abandoned'/g) ?? []).length
    assert.equal(writes, 1, `${writes} places in planState.ts end a plan as abandoned`)
    assert.match(strip(sweep), /'abandoned'/)
  })

  test('the executor never writes the app’s ending', () => {
    assert.ok(
      !/'abandoned'/.test(strip(planModeSrc)),
      'planMode.ts writes the outcome only load may write'
    )
  })

  test('nothing but the sweep cuts a step off', () => {
    const writes = (planStateSrc.match(/status: 'interrupted'/g) ?? []).length
    assert.equal(writes, 1, `${writes} places in planState.ts mark a step interrupted`)
    assert.match(sweep, /status: 'interrupted'/)
    assert.ok(
      !/'interrupted'/.test(strip(planModeSrc)),
      'planMode.ts writes the step status only load may write'
    )
  })

  test('the executor registers and releases what it is behind', () => {
    // A leak here is silent and one-way: the id stays "live" forever, and the
    // orphan it names is the one plan the sweep will never settle.
    const turn = planModeSrc.slice(
      planModeSrc.indexOf('export async function runPlanTurn'),
      planModeSrc.indexOf('patchPlanErrorNotice(conversationId: string')
    )
    assert.ok(turn.length > 0, 'runPlanTurn no longer precedes patchPlanErrorNotice')
    assert.match(turn, /livePlans\.add\(assistantMsg\.id\)/)
    // `\s*`, not `\n`: a Windows checkout reads this file with CRLF endings.
    assert.match(turn, /\} finally \{\s*livePlans\.delete\(assistantMsg\.id\)\s*\}/)
    assert.ok(
      turn.indexOf('livePlans.add(') < turn.indexOf('planApprovals.set('),
      'the gate opens before the executor says it is behind the plan'
    )
    assert.equal((turn.match(/livePlans\.delete\(/g) ?? []).length, 1, 'more than one release')
  })

  test('the sweep never writes the reader’s endings', () => {
    const code = strip(sweep)
    assert.ok(!/'cancelled'/.test(code), 'the load sweep writes the reader’s Cancel')
    assert.ok(!/'stopped'/.test(code), 'the load sweep writes the reader’s Stop')
  })

  test('the executor still owns both of the reader’s endings', () => {
    // Since v1.17.4 the executor does not pick either word: it forwards the
    // decision the gate was resolved with (`PlanDecision`), `'stopped'` from
    // its own abort listener and `'cancelled'` from the Cancel button's
    // resolver — see "the app has exactly one way to write" above.
    assert.match(planModeSrc, /signal\.addEventListener\('abort', \(\) => resolve\('stopped'\)/)
    assert.match(planModeSrc, /finish\(decision\)/)
    assert.match(planModeSrc, /finish\('stopped'\)/)
  })
})
