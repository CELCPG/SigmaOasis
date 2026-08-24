import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlanBlockView } from '../src/renderer/src/components/PlanBlockView'
import { awaitingApproval, endPlan } from '../src/renderer/src/lib/planState'
import type { ChatPlan, PlanStep, PlanStepStatus } from '../src/renderer/src/types'

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

function render(p: ChatPlan): string {
  return renderToStaticMarkup(
    createElement(PlanBlockView, { plan: p, streaming: false, onResolve: () => {} })
  )
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
