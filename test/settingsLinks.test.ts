import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_TABS, type SettingsTabKey } from '../src/renderer/src/components/settings/tabs'
import { settingsIndex, tabOfRow } from '../src/renderer/src/lib/settingsKit'
import { settingsPath, targetTab } from '../src/renderer/src/lib/settingsLinks'
import { privacyChecks, targetForKey } from '../src/renderer/src/lib/privacyAudit'
import { UNREACHABLE_REMEDY } from '../src/renderer/src/lib/claimCheck'
import type { AppSettings } from '../src/renderer/src/types'

/**
 * v4.0 (S5): every deep link into Settings lands on a row that exists. The
 * tabs register their rows at import, so importing every tab is the index;
 * the links are read from the places that hold them.
 */

// A window stub so the tab modules (which read window.api only at call time) import under node.
;(globalThis as { window?: unknown }).window = { api: {}, speechSynthesis: undefined }

// One line per tab, so a tab added without joining this list fails the test that every rail tab has rows.
import '../src/renderer/src/components/settings/ConnectionTab'
import '../src/renderer/src/components/settings/ModelsTab'
import '../src/renderer/src/components/settings/GeneralTab'
import '../src/renderer/src/components/settings/GroundingTab'
import '../src/renderer/src/components/settings/MemoryTab'
import '../src/renderer/src/components/settings/ToolsTab'
import '../src/renderer/src/components/settings/AgentTab'
import '../src/renderer/src/components/settings/SearchTab'
import '../src/renderer/src/components/settings/VoiceTab'
import '../src/renderer/src/components/settings/LibraryTab'
import '../src/renderer/src/components/settings/SkillsTab'
import '../src/renderer/src/components/settings/McpTab'
import '../src/renderer/src/components/settings/JobsTab'
import '../src/renderer/src/components/settings/PrivacyTab'
import '../src/renderer/src/components/settings/ActivityTab'

const ids = new Set(settingsIndex().map((r) => r.id))
/** The checkout's source, from the compiled test's place under .test-build/test. */
const SOURCE_ROOT = join(__dirname, '..', '..')

describe('the settings index', () => {
  test('every tab in the rail declares at least one row', () => {
    for (const t of SETTINGS_TABS) {
      const rows = [...ids].filter((id) => tabOfRow(id) === t.key)
      assert.ok(rows.length > 0, `${t.key} has no rows`)
    }
  })

  test('every row belongs to a tab the rail has', () => {
    const keys = new Set<string>(SETTINGS_TABS.map((t) => t.key))
    for (const id of ids) assert.ok(keys.has(tabOfRow(id)), id)
  })
})

describe('deep links', () => {
  test('the shared SettingsTabKey list matches the registry', () => {
    const src = readFileSync(join(SOURCE_ROOT, 'src', 'shared', 'failure.ts'), 'utf8')
    const block = src.slice(src.indexOf('export type SettingsTabKey'), src.indexOf('export type SettingsTarget'))
    const listed = [...block.matchAll(/\| '([a-z]+)'/g)].map((m) => m[1] as SettingsTabKey)
    assert.deepEqual(listed.sort(), SETTINGS_TABS.map((t) => t.key).sort())
  })

  test('every privacy-audit target is a row that exists', () => {
    const settings = {
      baseUrl: 'http://127.0.0.1:1234/v1',
      tools: { run_terminal_command: true, write_file: true, web_search: true, fetch_webpage: true, deep_research: true },
      workingDirectory: '',
      agent: { defaultPermission: 'acceptEdits', appTools: true },
      mcp: { servers: [{ id: 'fs', name: 'fs', command: 'npx', args: [], envNames: [], enabled: true, approval: 'full', disabledTools: [] }] },
      shopping: { requireProxy: true },
      proxy: { mode: 'socks5', host: '127.0.0.1', port: 9050 },
      search: { provider: 'brave', searxngUrl: '', confirmBeforeSearch: true },
      updates: { autoCheck: true },
      audit: { enabled: true }
    } as unknown as AppSettings
    const checks = privacyChecks({
      settings,
      grants: [{ id: 'g', tool: 'run_terminal_command', summary: 'ls', createdAt: 0, uses: 1 }],
      memory: { untrustedChunks: 3 } as never,
      ledger: { entries: 2, expired: 1 },
      allowedHosts: { search: ['api.search.brave.com'] },
      secrets: { braveKey: { set: true, encrypted: false }, mcpEnv: { servers: 1, unencrypted: 0, unreadable: [] } } as never
    })
    assert.ok(checks.length >= 12, `${checks.length} checks`)
    for (const c of checks) {
      if (c.key === 'egress.allowlist') {
        assert.equal(c.target, undefined, 'derived, not set')
        continue
      }
      assert.ok(c.target, `${c.key} has no target`)
      assert.ok(ids.has(c.target!), `${c.key} → ${c.target} is not a row`)
    }
    assert.equal(targetForKey('nothing.like.this'), undefined)
  })

  test('the claim-check remedy and the composer chips land on rows', () => {
    for (const target of [UNREACHABLE_REMEDY.tab, 'tools.run_terminal_command', 'tools.write_file', 'models.pipeline', 'memory.knowledge', 'tools']) {
      assert.ok(targetTab(target), target)
      if (target.includes('.')) assert.ok(ids.has(target), target)
    }
  })

  test('a target reads as a path', () => {
    assert.equal(settingsPath('tools'), 'Settings → Tools')
    assert.equal(settingsPath('tools.web_search'), 'Settings → Tools › Web search')
    assert.equal(settingsPath('models.pipeline'), 'Settings → Roles › Pipeline order')
    assert.equal(settingsPath('nowhere.at_all'), 'Settings')
  })
})
