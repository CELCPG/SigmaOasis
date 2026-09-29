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
    const server = { id: 'fs', name: 'Files', command: 'npx', args: ['-y', 'srv'], envNames: ['TOKEN'], enabled: true, disabledTools: [], approval: 'ask' as const }
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

  // v2.9: through v2.8 this row was a constant `ok` claiming MCP environment
  // values never reached the settings file in clear, while they sat there as a
  // field of each server's row. It is read from the main process now, and each
  // state it can be in is pinned here.
  describe('the credentials row says what the main process reports', () => {
    const secrets = (over: { braveKey?: Partial<{ set: boolean; encrypted: boolean }>; mcpEnv?: Partial<{ servers: number; unencrypted: number; unreadable: string[] }> } = {}) => ({
      braveKey: { set: false, encrypted: false, ...over.braveKey },
      mcpEnv: { servers: 0, unencrypted: 0, unreadable: [], ...over.mcpEnv }
    })

    test('not yet fetched: an info row that claims nothing about encryption', () => {
      const checks = privacyChecks({ settings: settings() })
      assert.equal(byKey(checks, 'secrets.unknown')?.state, 'info')
      assert.equal(byKey(checks, 'secrets.keychain'), undefined)
    })

    test('everything encrypted, or nothing stored: ok, and the sentence fits which', () => {
      const stored = byKey(privacyChecks({ settings: settings(), secrets: secrets({ braveKey: { set: true, encrypted: true }, mcpEnv: { servers: 2 } }) }), 'secrets.keychain')
      assert.equal(stored?.state, 'ok')
      assert.match(stored!.detail, /encrypted by the OS keychain/)
      const none = byKey(privacyChecks({ settings: settings(), secrets: secrets() }), 'secrets.keychain')
      assert.equal(none?.state, 'ok')
      assert.match(none!.detail, /^No credentials are stored/)
    })

    test('a credential the keychain could not take warns, names which, and points at its tab', () => {
      const mcp = byKey(privacyChecks({ settings: settings(), secrets: secrets({ mcpEnv: { servers: 2, unencrypted: 1 } }) }), 'secrets.unencrypted')
      assert.equal(mcp?.state, 'warn')
      assert.match(mcp!.detail, /the environment values of 1 MCP server are in config\.json in clear/)
      assert.equal(mcp!.where, 'Settings → MCP')
      const brave = byKey(privacyChecks({ settings: settings(), secrets: secrets({ braveKey: { set: true, encrypted: false } }) }), 'secrets.unencrypted')
      assert.match(brave!.detail, /so the search API key is in config\.json in clear/)
      assert.equal(brave!.where, 'Settings → Search & research')
      const both = byKey(privacyChecks({ settings: settings(), secrets: secrets({ braveKey: { set: true, encrypted: false }, mcpEnv: { servers: 3, unencrypted: 3 } }) }), 'secrets.unencrypted')
      assert.match(both!.detail, /the search API key and the environment values of 3 MCP servers are in config\.json/)
      // the private defaults must never warn, so an unencrypted credential is the only way in
      assert.equal(byKey(privacyChecks({ settings: settings(), secrets: secrets({ braveKey: { set: true, encrypted: true } }) }), 'secrets.unencrypted'), undefined)
    })
  })

  test('every row has a key, a title, a sentence and a place', () => {
    for (const c of privacyChecks({ settings: settings({ updates: { autoCheck: true }, audit: { enabled: true, autoPurgeOnQuit: false } }), audit: { available: true, sessions: [] } as never })) {
      assert.match(c.key, /^[a-z]+\.[a-z_.-]+$/)
      assert.ok(c.title.length > 4 && c.detail.length > 10 && c.where.length > 4, c.key)
    }
  })
})

describe('the agent (v3.0)', () => {
  const agent = (over: Partial<AppSettings['agent']>): AppSettings['agent'] => ({
    maxRounds: 40,
    commandTimeoutSec: 120,
    defaultPermission: 'ask',
    appTools: true,
    notify: true,
    ...over
  })

  test('asking first is the private default and adds no row', () => {
    const checks = privacyChecks({ settings: settings({ agent: agent({}) }) })
    assert.equal(byKey(checks, 'agent.accept_edits_default'), undefined)
  })

  test('agent chats that edit without asking are a widening, named', () => {
    const checks = privacyChecks({ settings: settings({ agent: agent({ defaultPermission: 'acceptEdits' }) }) })
    assert.equal(byKey(checks, 'agent.accept_edits_default')?.state, 'warn')
    assert.equal(byKey(checks, 'agent.accept_edits_default')?.where, 'Settings → Agent')
  })

  test('the web tools an agent may use are listed — only the enabled ones, only when the agent may use them', () => {
    const on = byKey(privacyChecks({ settings: settings({ agent: agent({}) }) }), 'agent.web_tools')
    assert.match(on?.detail ?? '', /^web_search, fetch_webpage —/)
    assert.equal(byKey(privacyChecks({ settings: settings({ agent: agent({ appTools: false }) }) }), 'agent.web_tools'), undefined)
  })

  test('settings from before 3.0, with no agent group, are audited without it', () => {
    assert.ok(!keys(privacyChecks({ settings: settings() })).some((k) => k.startsWith('agent.')))
  })
})
