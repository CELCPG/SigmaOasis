// Settings → Activity (v4.0, S4): the three things Privacy held that are
// records rather than settings — the network log, the pages read this
// session, and the session audit log's files — each with its actions.
import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, AuditStatus, NetworkActivityEntry, ResearchIndexStats } from '../../types'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { ActionRow, Button, DangerRow, Notice, Row, Section, StatusDot, type ActionResult } from './kit'

export const ROWS = defineRows('activity', {
  network: { label: 'Network activity', help: 'Every request the app makes to the outside, newest first. Only origins are recorded — never full URLs, so your queries stay private even here. Not listed: the chat stream itself, which goes from this window to your LM Studio server on this machine and can only ever go to a loopback address.', keywords: ['requests', 'origins', 'egress', 'log'] },
  pages: { label: 'Pages read this session', help: 'When a model reads a web page, the text is held in memory and split into passages so only the relevant parts are shown to it. Never written to disk and discarded when you quit. Keeping it means re-reading a page you already fetched costs no new request.', keywords: ['research index', 'cache', 'ram'] },
  logs: { label: 'Audit logs on disk', help: 'The encrypted session transcripts, if recording is on under Privacy. Export decrypts the latest to a file you choose — plaintext, so anyone with the file can read it. Traces export the latest session as fine-tuning data, redacted.', keywords: ['export', 'purge', 'traces', 'sft'] }
})
registerRows(ROWS)

export function ActivityTab({ settings }: { settings: AppSettings }): JSX.Element {
  const [net, setNet] = useState<NetworkActivityEntry[]>([])
  const [pages, setPages] = useState<ResearchIndexStats | null>(null)
  const [audit, setAudit] = useState<AuditStatus | null>(null)
  const [auditNotice, setAuditNotice] = useState<ActionResult | null>(null)
  const refresh = useCallback(() => {
    void window.api.getNetworkActivity().then(setNet)
    void window.api.researchIndexStats().then(setPages)
    void window.api.auditStatus().then(setAudit)
  }, [])
  useEffect(refresh, [refresh])

  const latest = audit?.sessions[0]
  const empty = pages === null || (pages.pages === 0 && pages.searchQueries === 0 && (pages.pinnedDocs ?? 0) === 0)

  return (
    <div className="space-y-8">
      <Section
        title="Network activity"
        description={ROWS.network.help}
        right={
          <span className="inline-flex items-center gap-2">
            <Button onClick={() => void window.api.getNetworkActivity().then(setNet)}>Refresh</Button>
            <DangerRow variant="inline" label="" action="Clear" confirm="Clear the log?" onConfirm={() => window.api.clearNetworkActivity().then(() => setNet([]))} />
          </span>
        }
      >
        <Row meta={ROWS.network} bare foot={<span className="text-xs text-ink-tertiary">The chat stream goes to {settings.baseUrl}, is never proxied, and does not pass through this log. Everything that leaves the machine does.</span>}>
          {net.length === 0 ? (
            <Notice tone="muted">No network activity yet this session. With search disabled, this list should show nothing but your local LM Studio server.</Notice>
          ) : (
            <ul className="max-h-72 divide-y divide-black/10 overflow-y-auto rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
              {net.map((a, i) => (
                <li key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <StatusDot tone={a.blocked ? 'danger' : a.ok ? 'ok' : 'warn'} />
                  <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 font-mono dark:bg-white/10">{a.purpose}</span>
                  <span className="min-w-0 flex-1 truncate font-mono" title={a.origin}>
                    {a.origin}
                  </span>
                  <span className="shrink-0 text-ink-tertiary">{a.blocked ? 'blocked' : (a.status ?? a.error?.slice(0, 30) ?? '—')}</span>
                  <span className="shrink-0 text-ink-tertiary">{new Date(a.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </Row>
      </Section>

      <Section
        title="Pages read this session"
        description={ROWS.pages.help}
        right={
          <span className="inline-flex items-center gap-2">
            <Button onClick={() => void window.api.researchIndexStats().then(setPages)}>Refresh</Button>
            <DangerRow variant="inline" label="" action="Forget" confirm="Forget every page?" onConfirm={() => window.api.clearResearchIndex().then(() => window.api.researchIndexStats()).then(setPages)} />
          </span>
        }
      >
        <Row meta={ROWS.pages} bare>
          {empty ? (
            <Notice tone="muted">Nothing held in memory.</Notice>
          ) : (
            <Notice tone="muted">
              <strong className="text-ink-primary">{pages.pages}</strong> page{pages.pages === 1 ? '' : 's'} · <strong className="text-ink-primary">{pages.chunks}</strong> passages ({pages.embeddedChunks} embedded) · {Math.round(pages.chars / 1024)} KB of text ·{' '}
              <strong className="text-ink-primary">{pages.searchQueries}</strong> cached search{pages.searchQueries === 1 ? '' : 'es'}
              {(pages.pinnedDocs ?? 0) > 0 && (
                <>
                  {' '}· <strong className="text-ink-primary">{pages.pinnedDocs}</strong> attached document{pages.pinnedDocs === 1 ? '' : 's'} ({Math.round((pages.pinnedChars ?? 0) / 1024)} KB)
                </>
              )}
              . In RAM only.
            </Notice>
          )}
        </Row>
      </Section>

      <Section title="Audit logs on disk" description={ROWS.logs.help}>
        <Row meta={ROWS.logs} bare foot={auditNotice ? <Notice tone={auditNotice.tone}>{auditNotice.text}</Notice> : undefined}>
          {!audit ? (
            <p className="text-xs text-ink-tertiary">Loading…</p>
          ) : audit.sessions.length === 0 ? (
            <Notice tone="muted">No audit logs on disk.</Notice>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-ink-secondary">
                <strong className="text-ink-primary">{audit.sessions.length}</strong> session log{audit.sessions.length === 1 ? '' : 's'} · latest {latest!.entries} entries, {Math.max(1, Math.round(latest!.sizeBytes / 1024))} KB
                {latest!.sessionId === audit.currentSessionId ? ' (this session)' : ''}. The key is machine-bound, so logs do not survive an OS reinstall. Kept to the newest {audit.limits.maxSessions} launches and{' '}
                {Math.round(audit.limits.maxBytes / 1048576)} MB, oldest pruned first at each launch
                {audit.prunedThisLaunch.sessions > 0 ? ` — this launch pruned ${audit.prunedThisLaunch.sessions} (${Math.max(1, Math.round(audit.prunedThisLaunch.bytes / 1024))} KB)` : ''}.
              </p>
              <ActionRow
                action="Export latest (decrypted)"
                disabled={!audit.available}
                title="Decrypt the latest session log to a file you choose. The export is plaintext — anyone with the file can read it."
                onAction={() =>
                  void window.api.auditExport().then((r) => {
                    if (r.ok) setAuditNotice({ tone: r.chainValid ? 'ok' : 'danger', text: `Exported ${r.entries} entries to ${r.path}` + (r.chainValid ? ' — hash chain verified.' : ' — ⚠ hash chain BROKEN: the log was modified.') })
                    else if (!r.canceled) setAuditNotice({ tone: 'danger', text: `Export failed: ${r.error ?? 'unknown error'}` })
                  })
                }
              >
                <Button
                  disabled={!audit.available}
                  title="Export the latest session as OpenAI-format fine-tuning traces: positive and rejected JSONL, a manifest, and the tool schemas. Redacted; writes to a location you choose."
                  onClick={() =>
                    void window.api.tracesExport().then((r) => {
                      if (r.ok)
                        setAuditNotice({
                          tone: r.chainValid ? 'ok' : 'danger',
                          text: `Traces: ${r.counts.positive} positive, ${r.counts.rejected} rejected, ${r.counts.unlabeled} unlabeled (excluded) — schema ${r.schemaVersion ?? 'n/a'}. Wrote ${r.paths.positive} and siblings.` + (r.chainValid ? '' : ' ⚠ Hash chain BROKEN: the log was modified.')
                        })
                      else if (!r.canceled) setAuditNotice({ tone: 'danger', text: `Trace export failed: ${r.error ?? 'unknown error'}` })
                    })
                  }
                >
                  Export traces (SFT)
                </Button>
                <DangerRow
                  variant="inline"
                  label=""
                  action="Purge all"
                  confirm={`Delete all ${audit.sessions.length}?`}
                  onConfirm={() =>
                    window.api.auditPurge().then((r) => {
                      setAuditNotice({ tone: 'ok', text: `Purged ${r.removed} session log${r.removed === 1 ? '' : 's'}.` })
                      void window.api.auditStatus().then(setAudit)
                    })
                  }
                />
              </ActionRow>
            </div>
          )}
        </Row>
      </Section>
    </div>
  )
}
