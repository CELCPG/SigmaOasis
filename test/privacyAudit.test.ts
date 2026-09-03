import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { privacyChecks } from '../src/renderer/src/lib/privacyAudit'
import type { AppSettings } from '../src/renderer/src/types'

/**
 * v2.6: the privacy audit is a pure function of the settings and the live
 * status the panel already fetches. Each row has a stable key, so the tests
 * name the rows they expect and nothing else.
 */

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    baseUrl: 'http://localhost:1234',
    workingDirectory: '',
    tools: { run_terminal_command: false, write_file: false, web_search: true, fetch_webpage: true, image_search: false, deep_research: false } as AppSettings['tools'],
    search: { provider: 'duckduckgo', searxngUrl: '', maxResults: 5, confirmBeforeSearch: false, useHeadlessRenderer: false },
    updates: { autoCheck: false },
    proxy: { mode: 'none', host: '', port: 9050 },
    audit: { enabled: false, autoPurgeOnQuit: false },
    shopping: { requireProxy: true, excludeTierX: true, maxSellers: 3 },
    mcp: { servers: [] },
    ...over
  } as unknown as AppSettings
}

const keys = (checks: ReturnType<typeof privacyChecks>): string[] => checks.map((c) => c.key)
const byKey = (checks: ReturnType<typeof privacyChecks>, key: string) => checks.find((c) => c.key === key)

describe('privacy audit', () => {
  test('the private defaults read as ok and info, never warn', () => {
    const checks = privacyChecks({ settings: settings() })
    assert.ok(!checks.some((c) => c.state === 'warn'), keys(checks).join(','))
    assert.equal(byKey(checks, 'lmstudio.loopback')?.state, 'ok')
    assert.equal(byKey(checks, 'updates.manual')?.state, 'ok')
    assert.equal(byKey(checks, 'audit.off')?.state, 'info')
    assert.equal(byKey(checks, 'tools.egress')?.state, 'info')
    assert.match(byKey(checks, 'tools.egress')!.detail, /web_search, fetch_webpage|fetch_webpage, web_search/)
  })

  test('a remote model server, the terminal tool and an unscoped write tool warn and say where', () => {
    const checks = privacyChecks({
      settings: settings({ baseUrl: 'http://10.0.0.5:1234', tools: { ...settings().tools, run_terminal_command: true, write_file: true } })
    })
    assert.equal(byKey(checks, 'lmstudio.remote')?.state, 'warn')
    assert.equal(byKey(checks, 'tools.terminal_enabled')?.state, 'warn')
    assert.equal(byKey(checks, 'tools.write_unscoped')?.state, 'warn')
    assert.equal(byKey(checks, 'tools.write_unscoped')?.where, 'Settings → Tools')
    const scoped = privacyChecks({ settings: settings({ workingDirectory: '/Users/me/proj', tools: { ...settings().tools, write_file: true } }) })
    assert.equal(byKey(scoped, 'tools.write_scoped')?.state, 'info')
    assert.match(byKey(scoped, 'tools.write_scoped')!.detail, /\/Users\/me\/proj/)
  })

  test('each enabled MCP server is a row; full approval warns; proxy is named as not covering it', () => {
    const server = { id: 'fs', name: 'Files', command: 'npx', args: ['-y', 'srv'], env: { TOKEN: 'x' }, enabled: true, disabledTools: [], approval: 'ask' as const }
    const ask = privacyChecks({ settings: settings({ mcp: { servers: [server, { ...server, id: 'off', enabled: false }] } }), mcp: [{ id: 'fs', state: 'running' } as never] })
    const row = byKey(ask, 'mcp.enabled.fs')
    assert.equal(row?.state, 'info')
    assert.match(row!.detail, /Environment: TOKEN/)
    assert.match(row!.detail, /Each call is confirmed/)
    assert.match(row!.detail, /Currently running/)
    assert.equal(byKey(ask, 'mcp.enabled.off'), undefined)
    const full = privacyChecks({ settings: settings({ mcp: { servers: [{ ...server, approval: 'full' }] }, proxy: { mode: 'socks5', host: '127.0.0.1', port: 9050 } }) })
    assert.equal(byKey(full, 'mcp.enabled.fs')?.state, 'warn')
    assert.equal(byKey(full, 'mcp.outside_proxy')?.state, 'warn')
  })

  test('grants, untrusted memory and ledger entries appear only when present', () => {
    const none = privacyChecks({ settings: settings(), grants: [], memory: { untrustedChunks: 0 } as never, ledger: { entries: 0, expired: 0 } })
    assert.ok(!keys(none).some((k) => k.startsWith('grants.') || k.startsWith('memory.') || k.startsWith('ledger.')))
    const some = privacyChecks({
      settings: settings(),
      grants: [{ id: 'g', tool: 'run_terminal_command', summary: 'npm test', createdAt: 1, uses: 2 }],
      memory: { untrustedChunks: 3 } as never,
      ledger: { entries: 12, expired: 2 }
    })
    assert.equal(byKey(some, 'grants.standing')?.state, 'warn')
    assert.match(byKey(some, 'memory.untrusted_present')!.title, /^3 memory chunks/)
    assert.match(byKey(some, 'ledger.entries')!.title, /12 verified claims kept, 2 past freshness/)
  })

  test('the allowlist row lists only purposes with hosts', () => {
    const checks = privacyChecks({ settings: settings(), allowedHosts: { lmstudio: ['localhost'], mcp: [], update: ['github.com'] } })
    const row = byKey(checks, 'egress.allowlist')!
    assert.equal(row.detail, 'lmstudio: localhost · update: github.com')
  })

  test('every row has a key, a title, a sentence and a place', () => {
    for (const c of privacyChecks({ settings: settings({ updates: { autoCheck: true }, audit: { enabled: true, autoPurgeOnQuit: false } }), audit: { available: true, sessions: [] } as never })) {
      assert.match(c.key, /^[a-z]+\.[a-z_.-]+$/)
      assert.ok(c.title.length > 4 && c.detail.length > 10 && c.where.length > 4, c.key)
    }
  })
})
