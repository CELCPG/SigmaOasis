// Settings → Privacy (v4.0, S4): the promise, the audit as a scorecard whose
// rows say where their switch is, updates, the proxy with labelled fields,
// shopping, and the session audit log's switches. What the app has done —
// the network log, the pages read, the log files — is the Activity tab.
import { useEffect, useState } from 'react'
import type { AppSettings, AuditStatus, Grant, McpServerStatus, MemoryStats, SecretsStatus } from '../../types'
import { privacyChecks, type PrivacyCheck } from '../../lib/privacyAudit'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { ActionRow, Card, Field, Notice, Row, Section, Segmented, Slider, StatusDot, Stepper, Switch, type ActionResult } from './kit'
import { SettingsLink } from './SettingsLink'

export const ROWS = defineRows('privacy', {
  audit: { label: 'Privacy audit', help: 'Every setting that changes what leaves this machine or what a model may do, as it stands now. Nothing here contacts anything; each row says where its switch is.', keywords: ['audit', 'widened', 'defaults'] },
  autoCheck: { label: 'Check for updates automatically', help: 'Contacts GitHub Releases periodically. Off by default — Check now under Appearance & chat always works.', keywords: ['updates', 'github'] },
  proxyMode: { label: 'Proxy', help: 'Route search, page reads and rendering through a proxy you run. The only control here that hides who is asking rather than what is asked — your provider still sees the query, but no longer your IP address. LM Studio is never proxied.', keywords: ['tor', 'vpn', 'socks5', 'http proxy'] },
  proxyHost: { label: 'Proxy host', help: 'Tor’s daemon listens on 127.0.0.1; the Tor Browser bundle too.', keywords: ['host'] },
  proxyPort: { label: 'Proxy port', help: 'Tor’s daemon: 9050. The Tor Browser bundle: 9150.', keywords: ['port', '9050', '9150'] },
  proxyTest: { label: 'Test the proxy', help: 'The one time the app contacts a third party on its own behalf: it asks api.ipify.org which IP address sites see, because a misconfigured proxy otherwise fails silently by simply not being used.', keywords: ['ipify', 'test'] },
  requireProxy: { label: 'Require a proxy for shopping fetches', help: 'Refuses rather than going out direct. Big retailers block Tor exits, so this trades success rate for not handing them your IP — deliberately, and in that order.', keywords: ['shopping', 'tor'] },
  excludeTierX: { label: 'Exclude affiliate listicles and content farms', help: '“Top 10 best…” pages are written to rank, not to inform. The domain list is in src/main/ipc/sourceTiers.ts — a ranking you can read.', keywords: ['shopping', 'listicles'] },
  maxSellers: { label: 'Sellers checked per comparison', help: 'Each seller is one page fetch. The budget is checked before each fetch and the stop is stated in the result.', keywords: ['shopping', 'sellers'] },
  auditEnabled: { label: 'Record a session audit log', help: 'An append-only transcript of what was actually said: your inputs, the model’s answers, each tool call — no system prompts or hidden layers. Every line is encrypted with your OS keychain and hash-chained, so an edited or deleted line is detectable on export. Ephemeral chats are never logged. The log starts when you turn it on.', keywords: ['audit log', 'transcript', 'encrypted'] },
  autoPurgeOnQuit: { label: 'Purge the log when the app quits', help: 'Verification for the current session only; nothing accumulates.', keywords: ['purge', 'quit'] }
})
registerRows(ROWS)

const AUDIT_TONE: Record<PrivacyCheck['state'], 'ok' | 'warn' | 'info'> = { ok: 'ok', warn: 'warn', info: 'info' }

/**
 * v2.6: the privacy audit. Every setting that widens what leaves the machine
 * or what a model may do, as a named row with a sentence and the place its
 * switch is. Computed from the live settings plus the status it fetches here;
 * nothing on this list changes a setting.
 */
function PrivacyAudit({ settings, auditInfo }: { settings: AppSettings; auditInfo: AuditStatus | null }): JSX.Element {
  const [live, setLive] = useState<{
    mcp: McpServerStatus[] | null
    grants: Grant[] | null
    memory: MemoryStats | null
    ledger: { entries: number; expired: number } | null
    allowedHosts: Record<string, string[]> | null
    secrets: SecretsStatus | null
  }>({ mcp: null, grants: null, memory: null, ledger: null, allowedHosts: null, secrets: null })
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.mcpStatus().catch(() => null),
      window.api.grantsList().catch(() => null),
      window.api.memoryStats().catch(() => null),
      window.api.ledgerStats().catch(() => null),
      window.api.allowedHostsByPurpose().catch(() => null),
      window.api.secretsStatus().catch(() => null)
    ]).then(([mcp, grants, memory, ledger, allowedHosts, secrets]) => {
      if (!cancelled) setLive({ mcp, grants, memory, ledger, allowedHosts, secrets })
    })
    return () => {
      cancelled = true
    }
  }, [settings])
  const checks = privacyChecks({ settings, audit: auditInfo, ...live })
  const warns = checks.filter((c) => c.state === 'warn').length
  return (
    <Card data-testid="privacy-audit" title="Privacy audit" status={warns === 0 ? 'nothing widened beyond the defaults' : `${warns} setting${warns === 1 ? '' : 's'} widened beyond the defaults`}>
      <ul className="divide-y divide-black/10 dark:divide-white/10">
        {checks.map((c) => (
          <li key={c.key} className="flex items-start gap-3 py-2 text-xs">
            <StatusDot tone={AUDIT_TONE[c.state]} />
            <span className="min-w-0 flex-1 -mt-0.5">
              <span className="block text-sm text-ink-primary">{c.title}</span>
              <span className="block text-ink-secondary">{c.detail}</span>
              <span className="block text-ink-tertiary">{c.target ? <SettingsLink to={c.target}>{c.where}</SettingsLink> : c.where}</span>
            </span>
            <code className="shrink-0 text-[10px] text-ink-tertiary">{c.key}</code>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export interface PrivacyTabProps {
  settings: AppSettings
  apply: ApplySettings
  defaults: AppSettings | null
}

export function PrivacyTab({ settings, apply, defaults }: PrivacyTabProps): JSX.Element {
  const [auditInfo, setAuditInfo] = useState<AuditStatus | null>(null)
  const [proxyTest, setProxyTest] = useState<ActionResult | null>(null)
  const [testing, setTesting] = useState(false)
  useEffect(() => {
    void window.api.auditStatus().then(setAuditInfo)
  }, [])
  const proxy = settings.proxy
  const setProxy = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['proxy']>, shown?: string): void => apply(meta, { proxy: { ...proxy, ...patch } }, shown)
  const shopping = settings.shopping
  const setShopping = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['shopping']>): void => apply(meta, { shopping: { ...shopping, ...patch } })
  const audit = settings.audit
  const setAudit = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['audit']>): void => apply(meta, { audit: { ...audit, ...patch } })

  return (
    <div className="space-y-8">
      <Section title="The promise" description="What this app will and will not contact.">
        <p className="text-sm leading-relaxed text-ink-secondary">
          Sigma Oasis runs your models locally and stores everything on this machine. The only outbound connections it can make are: your local LM
          Studio server, the search provider you chose (only when search tools run), and GitHub — only if you enable update checks below. Anything else
          is blocked by the egress allowlist before it is sent.
        </p>
        <Row meta={ROWS.audit} bare>
          <PrivacyAudit settings={settings} auditInfo={auditInfo} />
        </Row>
        <Row meta={ROWS.autoCheck}>
          <Switch checked={settings.updates.autoCheck} onChange={(autoCheck) => apply(ROWS.autoCheck, { updates: { autoCheck } })} />
        </Row>
      </Section>

      <Section title="Proxy" description={ROWS.proxyMode.help} onReset={defaults ? () => apply({ id: 'privacy.proxyReset', label: 'Proxy' }, { proxy: defaults.proxy }, 'defaults') : undefined}>
        <Row meta={ROWS.proxyMode} layout="stack">
          <Segmented
            variant="cards"
            value={proxy.mode}
            onChange={(mode) => setProxy(ROWS.proxyMode, { mode }, mode)}
            options={[
              { value: 'none', label: 'No proxy', hint: 'Direct connections.' },
              { value: 'socks5', label: 'SOCKS5', hint: 'Recommended: Tor, most VPNs. Hostnames resolve at the proxy, so your local resolver never learns which sites you read.' },
              { value: 'http', label: 'HTTP proxy', hint: 'A plain HTTP proxy.' }
            ]}
          />
        </Row>
        {proxy.mode !== 'none' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Row meta={ROWS.proxyHost} layout="stack">
              <Field value={proxy.host} mono placeholder="127.0.0.1" onCommit={(host) => setProxy(ROWS.proxyHost, { host })} />
            </Row>
            <Row meta={ROWS.proxyPort}>
              <Stepper value={proxy.port} min={1} max={65535} onChange={(port) => setProxy(ROWS.proxyPort, { port })} />
            </Row>
          </div>
        )}
        <Row meta={ROWS.proxyTest} layout="stack">
          <ActionRow
            action="Test proxy"
            busy={testing ? 'Testing…' : null}
            result={proxyTest}
            onAction={() => {
              setTesting(true)
              setProxyTest(null)
              void window.api
                .testProxy()
                .then((r) => setProxyTest({ tone: r.ok ? 'ok' : 'danger', text: r.detail }))
                .finally(() => setTesting(false))
            }}
          />
        </Row>
      </Section>

      <Section
        title="Shopping"
        description="Shopping tools contact retailers, who log the visit. Sigma Oasis never logs in, never fills a cart and never checks out — you finish the purchase in your own browser. The watchlist stays on this machine."
        onReset={defaults ? () => apply({ id: 'privacy.shoppingReset', label: 'Shopping' }, { shopping: defaults.shopping }, 'defaults') : undefined}
      >
        <Row meta={ROWS.requireProxy}>
          <Switch checked={shopping.requireProxy} onChange={(requireProxy) => setShopping(ROWS.requireProxy, { requireProxy })} />
        </Row>
        <Row meta={ROWS.excludeTierX}>
          <Switch checked={shopping.excludeTierX} onChange={(excludeTierX) => setShopping(ROWS.excludeTierX, { excludeTierX })} />
        </Row>
        <Row meta={ROWS.maxSellers}>
          <Slider value={shopping.maxSellers} min={1} max={5} onCommit={(maxSellers) => setShopping(ROWS.maxSellers, { maxSellers })} />
        </Row>
      </Section>

      <Section title="Session audit log" description="A record of what was said, encrypted on this machine. Its files are under Activity.">
        {auditInfo && !auditInfo.available && <Notice tone="warn">Unavailable: your OS keychain is not accessible, and this log is never written unencrypted.</Notice>}
        <Row meta={ROWS.auditEnabled}>
          <Switch checked={audit.enabled} disabled={auditInfo !== null && !auditInfo.available} onChange={(enabled) => setAudit(ROWS.auditEnabled, { enabled })} />
        </Row>
        {audit.enabled && (
          <Row meta={ROWS.autoPurgeOnQuit}>
            <Switch checked={audit.autoPurgeOnQuit} onChange={(autoPurgeOnQuit) => setAudit(ROWS.autoPurgeOnQuit, { autoPurgeOnQuit })} />
          </Row>
        )}
      </Section>
    </div>
  )
}
