// Extracted from SettingsModal.tsx (v2.4): the "privacy" tab, as it was. Pure prop-drilling —
// every piece of state and every handler still lives in the modal and arrives here as a prop,
// so nothing about ordering, effects or behaviour changed; the modal just stopped being 2,500 lines.

import React from 'react'
import type { AppSettings, AuditStatus, NetworkActivityEntry, ResearchIndexStats } from '../../types'

export interface PrivacyTabProps {
  auditInfo: AuditStatus | null
  auditNotice: string | null
  draft: AppSettings
  netActivity: NetworkActivityEntry[]
  proxyTest: { ok: boolean; detail: string; } | null
  proxyTesting: boolean
  researchStats: ResearchIndexStats | null
  setAuditInfo: React.Dispatch<React.SetStateAction<AuditStatus | null>>
  setAuditNotice: React.Dispatch<React.SetStateAction<string | null>>
  setNetActivity: React.Dispatch<React.SetStateAction<NetworkActivityEntry[]>>
  setProxyTest: React.Dispatch<React.SetStateAction<{ ok: boolean; detail: string; } | null>>
  setProxyTesting: React.Dispatch<React.SetStateAction<boolean>>
  setResearchStats: React.Dispatch<React.SetStateAction<ResearchIndexStats | null>>
  update: (partial: Partial<AppSettings>) => void
}

export function PrivacyTab(props: PrivacyTabProps): JSX.Element {
  const { auditInfo, auditNotice, draft, netActivity, proxyTest, proxyTesting, researchStats, setAuditInfo, setAuditNotice, setNetActivity, setProxyTest, setProxyTesting, setResearchStats, update } = props
  return (
    <div className="space-y-5">
                    <div>
                      <div className="text-sm font-medium">The privacy promise</div>
                      <p className="mt-1 text-sm text-ink-secondary">
                        Sigma Oasis runs your models locally and stores everything on this machine.
                        The only outbound connections it can make are: your local LM Studio server, the
                        search provider you chose (only when search tools run), and GitHub — only if
                        you enable update checks below. Anything else is blocked by the egress
                        allowlist before it is sent.
                      </p>
                    </div>

                    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.updates.autoCheck}
                        onChange={(e) => update({ updates: { autoCheck: e.target.checked } })}
                        className="mt-0.5 h-4 w-4 accent-accent"
                      />
                      <span>
                        Automatically check for updates
                        <span className="block text-xs text-ink-secondary">
                          Contacts GitHub Releases periodically. Off by default — the manual
                          &quot;Check now&quot; button (General tab) always works.
                        </span>
                      </span>
                    </label>


                    <div className="border-t border-black/10 dark:border-white/10 pt-4">
                      <div className="text-sm font-medium">Proxy (Tor / VPN)</div>
                      <p className="mt-1 text-xs text-ink-secondary">
                        Route search, page reads and rendering through a proxy you run. This is the only
                        control here that hides <em>who is asking</em> rather than what is asked — your
                        provider still sees the query, but no longer your IP address. Your LM Studio
                        server is never proxied.
                      </p>

                      <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                        <select
                          value={draft.proxy.mode}
                          onChange={(e) =>
                            update({
                              proxy: {
                                ...draft.proxy,
                                mode: e.target.value as AppSettings['proxy']['mode']
                              }
                            })
                          }
                          className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm"
                        >
                          <option value="none">No proxy (direct connection)</option>
                          <option value="socks5">SOCKS5 — recommended (Tor, most VPNs)</option>
                          <option value="http">HTTP proxy</option>
                        </select>
                        <button
                          type="button"
                          disabled={proxyTesting}
                          onClick={async () => {
                            setProxyTesting(true)
                            setProxyTest(null)
                            // Test the saved settings, so what is verified is what is in force.
                            await window.api.setSettings(draft)
                            setProxyTest(await window.api.testProxy())
                            setProxyTesting(false)
                          }}
                          className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50"
                        >
                          {proxyTesting ? 'Testing…' : 'Test proxy'}
                        </button>
                      </div>

                      {draft.proxy.mode !== 'none' && (
                        <div className="mt-2 grid grid-cols-[2fr_1fr] gap-2">
                          <input
                            value={draft.proxy.host}
                            onChange={(e) => update({ proxy: { ...draft.proxy, host: e.target.value } })}
                            placeholder="127.0.0.1"
                            spellCheck={false}
                            className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm font-mono"
                          />
                          <input
                            type="number"
                            value={draft.proxy.port}
                            onChange={(e) =>
                              update({ proxy: { ...draft.proxy, port: Number(e.target.value) } })
                            }
                            min={1}
                            max={65535}
                            className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm font-mono"
                          />
                        </div>
                      )}

                      {draft.proxy.mode === 'socks5' && (
                        <p className="mt-2 text-xs text-ink-secondary">
                          With SOCKS5, hostnames are resolved <strong>at the proxy</strong>, so your local
                          resolver never learns which sites you read. Tor&apos;s daemon listens on port
                          9050; the Tor Browser bundle uses 9150.
                        </p>
                      )}
                      {proxyTest && (
                        <p
                          className={`mt-2 text-xs ${
                            proxyTest.ok ? 'text-ink-ok' : 'text-ink-danger'
                          }`}
                        >
                          {proxyTest.detail}
                        </p>
                      )}
                      <p className="mt-2 text-xs text-ink-secondary">
                        &quot;Test proxy&quot; is the one time the app contacts a third party on its own
                        behalf: it asks <code>api.ipify.org</code> which IP address sites see, because a
                        misconfigured proxy otherwise fails silently by simply not being used.
                      </p>
                    </div>

                    <div className="border-t border-black/10 dark:border-white/10 pt-4">
                      <div className="text-sm font-medium">Shopping</div>
                      <p className="mt-1 mb-3 text-xs text-ink-secondary">
                        Shopping tools contact retailers, who log the visit. Sigma Oasis never logs in,
                        never fills a cart and never checks out — you finish the purchase in your own
                        browser. The watchlist stays on this machine.
                      </p>
                      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.shopping.requireProxy}
                          onChange={(e) =>
                            update({ shopping: { ...draft.shopping, requireProxy: e.target.checked } })
                          }
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Require a proxy for shopping fetches
                          <span className="block text-xs text-ink-secondary">
                            Refuses rather than going out direct. Big retailers block Tor exits, so this
                            trades success rate for not handing them your IP — deliberately, and in that
                            order.
                          </span>
                        </span>
                      </label>
                      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.shopping.excludeTierX}
                          onChange={(e) =>
                            update({ shopping: { ...draft.shopping, excludeTierX: e.target.checked } })
                          }
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Exclude affiliate listicles and content farms
                          <span className="block text-xs text-ink-secondary">
                            &quot;Top 10 best…&quot; pages are written to rank, not to inform. The domain
                            list is in <code>src/main/ipc/sourceTiers.ts</code> — a ranking you can read.
                          </span>
                        </span>
                      </label>
                      <div className="mt-3">
                        <label className="mb-1 block text-xs text-ink-secondary">
                          Sellers checked per comparison: {draft.shopping.maxSellers}
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={5}
                          value={draft.shopping.maxSellers}
                          onChange={(e) =>
                            update({
                              shopping: { ...draft.shopping, maxSellers: Number(e.target.value) }
                            })
                          }
                          className="w-full accent-accent"
                        />
                        <p className="text-xs text-ink-secondary">
                          Each seller is one page fetch. The budget is checked before each fetch and the
                          stop is stated in the result.
                        </p>
                      </div>
                    </div>

                    <div className="border-t border-black/10 dark:border-white/10 pt-4">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium">Pages read this session</div>
                        <button
                          type="button"
                          onClick={() => void window.api.researchIndexStats().then(setResearchStats)}
                          className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          Refresh
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void window.api
                              .clearResearchIndex()
                              .then(() => window.api.researchIndexStats())
                              .then(setResearchStats)
                          }
                          className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs text-ink-danger hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          Forget
                        </button>
                      </div>
                      <p className="mt-1 text-xs text-ink-secondary">
                        When a model reads a web page, the text is held in memory and split into
                        passages so only the relevant parts are shown to it. This is{' '}
                        <strong>never written to disk</strong> and is discarded when you quit — it is
                        not part of your long-term memory unless you explicitly save it. Keeping it
                        means re-reading a page you already fetched costs no new network request.
                      </p>
                      {researchStats === null ||
                      (researchStats.pages === 0 &&
                        researchStats.searchQueries === 0 &&
                        (researchStats.pinnedDocs ?? 0) === 0) ? (
                        <p className="mt-3 rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-ink-secondary">
                          Nothing held in memory.
                        </p>
                      ) : (
                        <p className="mt-3 rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-ink-secondary">
                          <strong className="text-ink-primary">
                            {researchStats.pages}
                          </strong>{' '}
                          page{researchStats.pages === 1 ? '' : 's'} ·{' '}
                          <strong className="text-ink-primary">
                            {researchStats.chunks}
                          </strong>{' '}
                          passages ({researchStats.embeddedChunks} embedded) ·{' '}
                          {Math.round(researchStats.chars / 1024)} KB of text ·{' '}
                          <strong className="text-ink-primary">
                            {researchStats.searchQueries}
                          </strong>{' '}
                          cached search{researchStats.searchQueries === 1 ? '' : 'es'}
                          {(researchStats.pinnedDocs ?? 0) > 0 && (
                            <>
                              {' '}·{' '}
                              <strong className="text-ink-primary">
                                {researchStats.pinnedDocs}
                              </strong>{' '}
                              attached document{researchStats.pinnedDocs === 1 ? '' : 's'} (
                              {Math.round((researchStats.pinnedChars ?? 0) / 1024)} KB)
                            </>
                          )}
                          . In RAM only.
                        </p>
                      )}
                    </div>

                    <div className="border-t border-black/10 dark:border-white/10 pt-4">
                      <div className="text-sm font-medium">Session audit log</div>
                      <p className="mt-1 text-xs text-ink-secondary">
                        An append-only transcript of what was actually said: your inputs, the
                        model&apos;s answers, and each tool call — no system prompts or other hidden
                        layers. Every line is encrypted with your OS keychain and hash-chained, so an
                        edited or deleted line is detectable on export. Ephemeral chats are never
                        logged. Off by default.
                      </p>

                      {auditInfo && !auditInfo.available && (
                        <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-xs text-ink-warn">
                          Unavailable: your OS keychain is not accessible, and this log is never
                          written unencrypted.
                        </p>
                      )}

                      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.audit.enabled}
                          disabled={auditInfo !== null && !auditInfo.available}
                          onChange={(e) => update({ audit: { ...draft.audit, enabled: e.target.checked } })}
                          className="mt-0.5 h-4 w-4 accent-accent disabled:opacity-40"
                        />
                        <span>
                          Record a session audit log
                          <span className="block text-xs text-ink-secondary">
                            Takes effect after Save. Entries from before enabling are not recovered —
                            the log starts when you turn it on.
                          </span>
                        </span>
                      </label>

                      {draft.audit.enabled && (
                        <label className="mt-2 flex cursor-pointer items-start gap-2.5 text-sm">
                          <input
                            type="checkbox"
                            checked={draft.audit.autoPurgeOnQuit}
                            onChange={(e) =>
                              update({ audit: { ...draft.audit, autoPurgeOnQuit: e.target.checked } })
                            }
                            className="mt-0.5 h-4 w-4 accent-accent"
                          />
                          <span>
                            Purge the log automatically when the app quits
                            <span className="block text-xs text-ink-secondary">
                              Verification for the current session only; nothing accumulates.
                            </span>
                          </span>
                        </label>
                      )}

                      {auditInfo && (
                        <div className="mt-3 rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-ink-secondary">
                          {auditInfo.sessions.length === 0 ? (
                            <span>No audit logs on disk.</span>
                          ) : (
                            <span>
                              <strong className="text-ink-primary">
                                {auditInfo.sessions.length}
                              </strong>{' '}
                              session log{auditInfo.sessions.length === 1 ? '' : 's'} on disk · latest:{' '}
                              {auditInfo.sessions[0]!.entries} entries,{' '}
                              {Math.max(1, Math.round(auditInfo.sessions[0]!.sizeBytes / 1024))} KB
                              {auditInfo.sessions[0]!.sessionId === auditInfo.currentSessionId
                                ? ' (this session)'
                                : ''}
                              . The key is machine-bound, so logs do not survive an OS reinstall.
                              {' '}Kept to the newest {auditInfo.limits.maxSessions} launches and{' '}
                              {Math.round(auditInfo.limits.maxBytes / 1048576)} MB, oldest pruned first at each launch
                              {auditInfo.prunedThisLaunch.sessions > 0
                                ? ` — this launch pruned ${auditInfo.prunedThisLaunch.sessions} (${Math.max(1, Math.round(auditInfo.prunedThisLaunch.bytes / 1024))} KB)`
                                : ''}
                              .
                            </span>
                          )}
                          <div className="mt-2 flex gap-2">
                            <button
                              type="button"
                              disabled={!auditInfo.available || auditInfo.sessions.length === 0}
                              onClick={() =>
                                void window.api.auditExport().then((r) => {
                                  if (r.ok) {
                                    setAuditNotice(
                                      `Exported ${r.entries} entries to ${r.path}` +
                                        (r.chainValid
                                          ? ' — hash chain verified.'
                                          : ' — ⚠ hash chain BROKEN: the log was modified.')
                                    )
                                  } else if (!r.canceled) {
                                    setAuditNotice(`Export failed: ${r.error ?? 'unknown error'}`)
                                  }
                                })
                              }
                              className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                              title="Decrypt the latest session log to a file you choose. The export is plaintext — anyone with the file can read it."
                            >
                              Export latest (decrypted)
                            </button>
                            <button
                              type="button"
                              disabled={!auditInfo.available || auditInfo.sessions.length === 0}
                              onClick={() =>
                                void window.api.tracesExport().then((r) => {
                                  if (r.ok) {
                                    setAuditNotice(
                                      `Traces: ${r.counts.positive} positive, ${r.counts.rejected} rejected, ` +
                                        `${r.counts.unlabeled} unlabeled (excluded) — schema ${r.schemaVersion ?? 'n/a'}. ` +
                                        `Wrote ${r.paths.positive} and siblings.` +
                                        (r.chainValid
                                          ? ''
                                          : ' ⚠ Hash chain BROKEN: the log was modified.')
                                    )
                                  } else if (!r.canceled) {
                                    setAuditNotice(`Trace export failed: ${r.error ?? 'unknown error'}`)
                                  }
                                })
                              }
                              className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                              title="Export the latest session as OpenAI-format fine-tuning traces: positive and rejected JSONL, a manifest, and the tool schemas. Redacted; writes to a location you choose."
                            >
                              Export traces (SFT)
                            </button>
                            <button
                              type="button"
                              disabled={auditInfo.sessions.length === 0}
                              onClick={() => {
                                if (!window.confirm('Delete every audit log on disk? This cannot be undone.'))
                                  return
                                void window.api.auditPurge().then((r) => {
                                  setAuditNotice(`Purged ${r.removed} session log${r.removed === 1 ? '' : 's'}.`)
                                  void window.api.auditStatus().then(setAuditInfo)
                                })
                              }}
                              className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-ink-danger hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                            >
                              Purge all
                            </button>
                          </div>
                          {auditNotice && <p className="mt-2 break-all text-ink-tertiary">{auditNotice}</p>}
                        </div>
                      )}
                    </div>

                    <div className="border-t border-black/10 dark:border-white/10 pt-4">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium">Network activity</div>
                        <button
                          type="button"
                          onClick={() => void window.api.getNetworkActivity().then(setNetActivity)}
                          className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          Refresh
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void window.api.clearNetworkActivity().then(() => setNetActivity([]))
                          }
                          className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs text-ink-danger hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          Clear
                        </button>
                      </div>
                      <p className="mt-1 text-xs text-ink-secondary">
                        Every request the app makes to the outside, newest first. Only origins are
                        recorded — never full URLs, so your queries stay private even here.
                      </p>
                      <p className="mt-1 text-xs text-ink-secondary">
                        Not listed: the chat stream itself. Replies stream straight from the chat window
                        to your LM Studio server on this machine ({draft.baseUrl}); that traffic can
                        only ever go to a loopback address, is never proxied, and does not pass through
                        this log. Everything that leaves the machine does.
                      </p>
                      {netActivity.length === 0 ? (
                        <p className="mt-3 rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-ink-secondary">
                          No network activity yet this session. With search disabled, this list should
                          show nothing but your local LM Studio server.
                        </p>
                      ) : (
                        <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto">
                          {netActivity.map((a, i) => (
                            <li
                              key={i}
                              className="flex items-center gap-2 rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs"
                            >
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${
                                  a.blocked ? 'bg-red-500' : a.ok ? 'bg-green-500' : 'bg-amber-500'
                                }`}
                                title={a.blocked ? 'Blocked by egress policy' : a.ok ? 'OK' : 'Failed'}
                              />
                              <span className="shrink-0 rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.5 font-mono">
                                {a.purpose}
                              </span>
                              <span className="min-w-0 flex-1 truncate font-mono" title={a.origin}>
                                {a.origin}
                              </span>
                              <span className="shrink-0 text-ink-tertiary">
                                {a.blocked ? 'blocked' : (a.status ?? a.error?.slice(0, 30) ?? '—')}
                              </span>
                              <span className="shrink-0 text-ink-tertiary">
                                {new Date(a.at).toLocaleTimeString()}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
  )
}
