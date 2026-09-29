import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DANGER_ARM_MS,
  clampStep,
  dangerClick,
  defineRows,
  describeValue,
  firstChange,
  parseTyped,
  pushToast,
  registerRows,
  searchRows,
  segmentedKey,
  settingsIndex,
  tabOfRow,
  type ChangeToast
} from '../src/renderer/src/lib/settingsKit'

/**
 * v4.0 (S2): the pure parts of the Settings control kit. The components only
 * draw these; what a stepper clamps to, when a danger button acts, where an
 * arrow key lands and what the search finds are decided here.
 */

describe('clampStep', () => {
  test('clamps to the floor and the ceiling', () => {
    assert.equal(clampStep(0, 40, 5, 200), 5)
    assert.equal(clampStep(9000, 120, 10, 600), 600)
    assert.equal(clampStep(42, 40, 5, 200), 42)
  })

  test('snaps to the step from the floor', () => {
    assert.equal(clampStep(13, 12, 12, 20, 1), 13)
    assert.equal(clampStep(0.74, 0.7, 0, 2, 0.1), 0.7)
    assert.equal(clampStep(1.06, 1, 0.5, 2, 0.1), 1.1)
  })

  test('an empty or unreadable field keeps the value it had', () => {
    assert.equal(clampStep(parseTyped(''), 40, 5, 200), 40)
    assert.equal(clampStep(parseTyped('   '), 40, 5, 200), 40)
    assert.equal(clampStep(parseTyped('abc'), 40, 5, 200), 40)
    assert.equal(clampStep(parseTyped('12'), 40, 5, 200), 12)
  })
})

describe('dangerClick', () => {
  test('one click never acts', () => {
    const r = dangerClick({ armed: false }, 1000)
    assert.equal(r.act, false)
    assert.deepEqual(r.state, { armed: true, since: 1000 })
  })

  test('a second click within the window acts and disarms', () => {
    const r = dangerClick({ armed: true, since: 1000 }, 1000 + DANGER_ARM_MS)
    assert.equal(r.act, true)
    assert.deepEqual(r.state, { armed: false })
  })

  test('a second click after the window arms again instead of acting', () => {
    const r = dangerClick({ armed: true, since: 1000 }, 1000 + DANGER_ARM_MS + 1)
    assert.equal(r.act, false)
    assert.deepEqual(r.state, { armed: true, since: 1000 + DANGER_ARM_MS + 1 })
  })
})

describe('segmentedKey', () => {
  test('arrows move and wrap, Home and End jump', () => {
    assert.equal(segmentedKey('ArrowRight', 0, 3), 1)
    assert.equal(segmentedKey('ArrowRight', 2, 3), 0)
    assert.equal(segmentedKey('ArrowLeft', 0, 3), 2)
    assert.equal(segmentedKey('ArrowDown', 1, 3), 2)
    assert.equal(segmentedKey('ArrowUp', 1, 3), 0)
    assert.equal(segmentedKey('Home', 2, 3), 0)
    assert.equal(segmentedKey('End', 0, 3), 2)
  })

  test('a key the control does not own is left to the page', () => {
    assert.equal(segmentedKey('Tab', 0, 3), null)
    assert.equal(segmentedKey('Enter', 0, 3), null)
    assert.equal(segmentedKey('ArrowRight', 0, 0), null)
  })
})

describe('the settings index', () => {
  const rows = defineRows('appearance', {
    theme: { label: 'Theme', help: 'Light, dark, or follow the system.', keywords: ['dark mode', 'night'] },
    fontSize: { label: 'Font size', help: 'The chat’s base size.' }
  })

  test('ids are tab-qualified and stable', () => {
    assert.equal(rows.theme.id, 'appearance.theme')
    assert.equal(rows.fontSize.id, 'appearance.fontSize')
    assert.equal(tabOfRow('appearance.theme'), 'appearance')
    assert.equal(tabOfRow('lonely'), 'lonely')
  })

  test('registering twice lists once', () => {
    registerRows(rows)
    registerRows(rows)
    const listed = settingsIndex().filter((r) => r.id.startsWith('appearance.'))
    assert.equal(listed.length, 2)
  })

  test('search matches every word across label, help and keywords, case-insensitively', () => {
    const all = [rows.theme, rows.fontSize]
    assert.deepEqual(searchRows(all, 'dark').map((r) => r.id), ['appearance.theme'])
    assert.deepEqual(searchRows(all, 'NIGHT').map((r) => r.id), ['appearance.theme'])
    assert.deepEqual(searchRows(all, 'size chat').map((r) => r.id), ['appearance.fontSize'])
    assert.deepEqual(searchRows(all, 'size night'), [])
  })

  test('an empty query matches nothing: the filter is not a listing', () => {
    assert.deepEqual(searchRows([rows.theme], ''), [])
    assert.deepEqual(searchRows([rows.theme], '   '), [])
  })
})

describe('firstChange', () => {
  test('finds the first differing leaf through nested partials', () => {
    assert.deepEqual(firstChange({ theme: 'light', plan: { confirmPlan: false, maxSteps: 5 } }, { theme: 'light', plan: { confirmPlan: true, maxSteps: 5 } }), {
      path: 'plan.confirmPlan',
      value: true
    })
    assert.deepEqual(firstChange({ fontSize: 14 }, { fontSize: 16 }), { path: 'fontSize', value: 16 })
    assert.equal(firstChange({ a: 1 }, { a: 1 }), null)
  })

  test('an array changes as a whole', () => {
    const r = firstChange({ models: [{ id: 'a', enabled: true }] }, { models: [{ id: 'a', enabled: false }] })
    assert.equal(r?.path, 'models')
    assert.ok(Array.isArray(r?.value))
  })
})

describe('pushToast', () => {
  const t = (id: number): ChangeToast => ({ id, label: `t${id}`, value: 'x', undo: () => undefined })
  test('keeps the newest three', () => {
    const list = pushToast(pushToast(pushToast(pushToast([], t(1)), t(2)), t(3)), t(4))
    assert.deepEqual(list.map((x) => x.id), [2, 3, 4])
  })
})

describe('describeValue', () => {
  test('says a value the way a toast should', () => {
    assert.equal(describeValue(true), 'On')
    assert.equal(describeValue(false), 'Off')
    assert.equal(describeValue(15, 'px'), '15 px')
    assert.equal(describeValue(''), 'empty')
    assert.equal(describeValue('dark'), 'dark')
    assert.equal(describeValue('x'.repeat(60)), `${'x'.repeat(37)}…`)
  })
})
