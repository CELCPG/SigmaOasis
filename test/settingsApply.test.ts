import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * v4.0 (S3): apply as you go, against the real store. A change applies to
 * the store and the disk in one call, names its row in a toast, and Undo puts
 * exactly that value back — also on disk.
 */

const writes: unknown[] = []
;(globalThis as { window?: unknown }).window = {
  api: {
    setSettings: async (s: unknown) => {
      writes.push(s)
      return true
    }
  }
}

// After the window stub: the hook reads window.api at call time, the store at import time.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useAppStore } = require('../src/renderer/src/stores/appStore') as typeof import('../src/renderer/src/stores/appStore')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applySettings } = require('../src/renderer/src/hooks/settingsApply') as typeof import('../src/renderer/src/hooks/settingsApply')
import type { AppSettings } from '../src/renderer/src/types'

const base = { theme: 'light', fontSize: 15, plan: { confirmPlan: false, maxSteps: 5 } } as unknown as AppSettings

describe('applySettings', () => {
  beforeEach(() => {
    writes.length = 0
    useAppStore.setState({ settings: base, settingsToasts: [] })
  })

  test('applies to the store and the disk, and names the row', () => {
    applySettings({ id: 'general.theme', label: 'Theme' }, { theme: 'dark' })
    assert.equal(useAppStore.getState().settings?.theme, 'dark')
    assert.equal(writes.length, 1)
    assert.equal((writes[0] as AppSettings).theme, 'dark')
    const toast = useAppStore.getState().settingsToasts.at(-1)
    assert.equal(toast?.label, 'Theme')
    assert.equal(toast?.value, 'dark')
  })

  test('Undo restores the previous value, on disk too', () => {
    applySettings({ id: 'general.fontSize', label: 'Font size' }, { fontSize: 18 }, '18px')
    const toast = useAppStore.getState().settingsToasts.at(-1)!
    assert.equal(toast.value, '18px')
    toast.undo()
    assert.equal(useAppStore.getState().settings?.fontSize, 15)
    assert.equal(writes.length, 2)
    assert.equal((writes[1] as AppSettings).fontSize, 15)
  })

  test('a nested change is described by its leaf', () => {
    applySettings(null, { plan: { confirmPlan: true, maxSteps: 5 } })
    const toast = useAppStore.getState().settingsToasts.at(-1)
    assert.equal(toast?.label, 'plan.confirmPlan')
    assert.equal(toast?.value, 'On')
  })

  test('a change that changes nothing writes nothing and says nothing', () => {
    applySettings({ id: 'general.theme', label: 'Theme' }, { theme: 'light' })
    assert.equal(writes.length, 0)
    assert.equal(useAppStore.getState().settingsToasts.length, 0)
  })
})
