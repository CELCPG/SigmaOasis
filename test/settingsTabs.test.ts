import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_GROUPS, SETTINGS_TABS, filterTabs, settingsTab } from '../src/renderer/src/components/settings/tabs'

/** v4.0 (S1): the rail's registry — one table the rail, the header, the search and the deep links share. */

describe('the settings tab registry', () => {
  test('every tab has a label, a description, a group in the group order and an icon', () => {
    for (const t of SETTINGS_TABS) {
      assert.ok(t.label.length > 0, t.key)
      assert.ok(t.description.length > 20, `${t.key}: a description is a sentence`)
      assert.ok(SETTINGS_GROUPS.includes(t.group), `${t.key}: ${t.group}`)
      assert.ok(t.icon.length > 0, t.key)
    }
  })

  test('keys are unique and stable for deep links', () => {
    const keys = SETTINGS_TABS.map((t) => t.key)
    assert.equal(new Set(keys).size, keys.length)
    assert.equal(settingsTab('models').label, 'Roles')
    assert.equal(settingsTab('connection').label, 'LM Studio')
  })

  test('groups appear in the rail in the registry order, each contiguous', () => {
    const seen: string[] = []
    for (const t of SETTINGS_TABS) {
      if (seen[seen.length - 1] !== t.group) {
        assert.ok(!seen.includes(t.group), `${t.group} appears twice, split`)
        seen.push(t.group)
      }
    }
    assert.deepEqual(seen, SETTINGS_GROUPS)
  })

  test('the search narrows by label, description and keywords; empty shows all', () => {
    assert.equal(filterTabs('').length, SETTINGS_TABS.length)
    assert.deepEqual(filterTabs('brave').map((t) => t.key), ['search'])
    // A word start, not a substring: "tor" is Tor under Privacy, not calculators under Tools.
    assert.deepEqual(filterTabs('TOR').map((t) => t.key), ['privacy'])
    assert.ok(filterTabs('model').map((t) => t.key).includes('models'))
    assert.deepEqual(filterTabs('nothing here matches'), [])
  })
})
