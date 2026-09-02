// Extracted from SettingsModal.tsx (v2.4): the "search" tab, as it was. Pure prop-drilling —
// every piece of state and every handler still lives in the modal and arrives here as a prop,
// so nothing about ordering, effects or behaviour changed; the modal just stopped being 2,500 lines.

import React from 'react'
import type { AppSettings } from '../../types'

export interface SearchTabProps {
  braveKeyInfo: { set: boolean; encrypted: boolean; } | null
  braveKeyInput: string
  braveKeyNotice: string | null
  draft: AppSettings
  searchTest: { ok: boolean; detail: string; } | null
  searchTesting: boolean
  setBraveKeyInfo: React.Dispatch<React.SetStateAction<{ set: boolean; encrypted: boolean; } | null>>
  setBraveKeyInput: React.Dispatch<React.SetStateAction<string>>
  setBraveKeyNotice: React.Dispatch<React.SetStateAction<string | null>>
  setSearchTest: React.Dispatch<React.SetStateAction<{ ok: boolean; detail: string; } | null>>
  setSearchTesting: React.Dispatch<React.SetStateAction<boolean>>
  setSettings: (settings: AppSettings) => void
  update: (partial: Partial<AppSettings>) => void
}

export function SearchTab(props: SearchTabProps): JSX.Element {
  const { braveKeyInfo, braveKeyInput, braveKeyNotice, draft, searchTest, searchTesting, setBraveKeyInfo, setBraveKeyInput, setBraveKeyNotice, setSearchTest, setSearchTesting, setSettings, update } = props
  return (
    <div className="space-y-5">
                    <p className="rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-ink-secondary">
                      Web search is the only feature that sends your words off this machine — and only
                      the query itself, only to the provider you choose below, only when the{' '}
                      <code>web_search</code> / <code>fetch_webpage</code> tools are enabled. Obvious
                      personal data and secrets are redacted from queries before they are sent, and
                      every request appears in the Privacy tab&apos;s activity log.
                    </p>

                    <div>
                      <label className="mb-1 block text-sm font-medium">Search provider</label>
                      <div className="space-y-1.5">
                        {(
                          [
                            {
                              id: 'searxng',
                              label: 'Self-hosted SearXNG (most private)',
                              hint: 'Metasearch over 70+ engines from a server you run. No keys, no tracking.'
                            },
                            {
                              id: 'brave',
                              label: 'Brave Search API',
                              hint: 'Independent index, no user profiling. Requires a free API key.'
                            },
                            {
                              id: 'duckduckgo',
                              label: 'DuckDuckGo',
                              hint: 'No key needed, no tracking. Rate-limited; best for light use.'
                            }
                          ] as const
                        ).map((p) => (
                          <label
                            key={p.id}
                            className={`block cursor-pointer rounded-lg border px-3 py-2 ${
                              draft.search.provider === p.id
                                ? 'border-accent/50 bg-accent/10'
                                : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5'
                            }`}
                          >
                            <span className="flex items-center gap-2 text-sm font-medium">
                              <input
                                type="radio"
                                name="search-provider"
                                checked={draft.search.provider === p.id}
                                onChange={() =>
                                  update({ search: { ...draft.search, provider: p.id } })
                                }
                                className="accent-accent"
                              />
                              {p.label}
                            </span>
                            <span className="mt-0.5 block pl-6 text-xs text-ink-secondary">{p.hint}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {draft.search.provider === 'searxng' && (
                      <div>
                        <label className="mb-1 block text-sm font-medium">SearXNG instance URL</label>
                        <input
                          value={draft.search.searxngUrl}
                          onChange={(e) =>
                            update({ search: { ...draft.search, searxngUrl: e.target.value } })
                          }
                          placeholder="http://127.0.0.1:8888"
                          className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                        />
                        <p className="mt-1 text-xs text-ink-secondary">
                          Run one with <code>docker run -p 8888:8080 searxng/searxng</code> and enable
                          JSON output (<code>formats: [html, json]</code>). A loopback instance means
                          only infrastructure you control ever sees your queries.
                        </p>
                      </div>
                    )}

                    {draft.search.provider === 'brave' && (
                      <div>
                        <label className="mb-1 block text-sm font-medium">Brave Search API key</label>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={braveKeyInput}
                            onChange={(e) => setBraveKeyInput(e.target.value)}
                            placeholder={
                              braveKeyInfo?.set
                                ? `Key saved${braveKeyInfo.encrypted ? ' (OS-keychain encrypted)' : ''} — enter a new one to replace`
                                : 'Get a free key at brave.com/search/api'
                            }
                            className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                          />
                          <button
                            type="button"
                            disabled={!braveKeyInput.trim()}
                            onClick={() =>
                              void window.api.setBraveApiKey(braveKeyInput).then((res) => {
                                setBraveKeyInput('')
                                setBraveKeyNotice(res.warning ?? (res.ok ? 'API key saved.' : 'Failed.'))
                                void window.api.braveKeyStatus().then(setBraveKeyInfo)
                              })
                            }
                            className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                          >
                            Save key
                          </button>
                          {braveKeyInfo?.set && (
                            <button
                              type="button"
                              onClick={() =>
                                void window.api.setBraveApiKey('').then(() => {
                                  setBraveKeyNotice('API key removed.')
                                  void window.api.braveKeyStatus().then(setBraveKeyInfo)
                                })
                              }
                              className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm text-ink-danger hover:bg-black/5 dark:hover:bg-white/10"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        {braveKeyNotice && (
                          <p className="mt-1 text-xs text-ink-secondary">{braveKeyNotice}</p>
                        )}
                        <p className="mt-1 text-xs text-ink-secondary">
                          Stored via your OS keychain (Electron safeStorage) — never in the settings
                          file the UI can read back.
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="mb-1 block text-sm font-medium">
                          Results per search: {draft.search.maxResults}
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={10}
                          value={draft.search.maxResults}
                          onChange={(e) =>
                            update({ search: { ...draft.search, maxResults: Number(e.target.value) } })
                          }
                          className="w-full accent-accent"
                        />
                      </div>
                      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.search.confirmBeforeSearch}
                          onChange={(e) =>
                            update({
                              search: { ...draft.search, confirmBeforeSearch: e.target.checked }
                            })
                          }
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Confirm every query
                          <span className="block text-xs text-ink-secondary">
                            Show the exact outgoing query for approval before each search.
                          </span>
                        </span>
                      </label>
                      <div>
                        <label className="mb-1 block text-xs text-ink-secondary">
                          Deep research budget
                        </label>
                        <select
                          value={draft.research.depth}
                          onChange={(e) =>
                            update({
                              research: {
                                ...draft.research,
                                depth: e.target.value as AppSettings['research']['depth']
                              }
                            })
                          }
                          className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm"
                        >
                          <option value="quick">Quick — up to 3 searches, 4 pages, 4 domains</option>
                          <option value="standard">Standard — up to 6 searches, 10 pages, 8 domains</option>
                          <option value="thorough">Thorough — up to 10 searches, 16 pages, 12 domains</option>
                        </select>
                        <p className="mt-1 text-xs text-ink-secondary">
                          Hard ceiling on what one <code>deep_research</code> call may spend. The
                          distinct-domain cap is the privacy-relevant one — it limits how many separate
                          sites learn anything at all.
                        </p>
                      </div>
                      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.research.confirmPlan}
                          onChange={(e) =>
                            update({
                              research: { ...draft.research, confirmPlan: e.target.checked }
                            })
                          }
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Approve research plans
                          <span className="block text-xs text-ink-secondary">
                            Before a deep research run sends anything, show every sub-question and every
                            outgoing query for approval — one dialog for the whole plan.
                          </span>
                        </span>
                      </label>
                      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.search.useHeadlessRenderer}
                          onChange={(e) =>
                            update({
                              search: { ...draft.search, useHeadlessRenderer: e.target.checked }
                            })
                          }
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Read JavaScript-dependent pages
                          <span className="block text-xs text-ink-secondary">
                            When a page returns no readable text (documentation sites, single-page apps),
                            re-read it in an offscreen browser. Only the page&apos;s own origin is
                            contacted — every third-party request is blocked and logged — and the session
                            keeps no cookies, cache or storage. Off by default, because unlike a plain
                            fetch this runs the page&apos;s scripts.
                          </span>
                        </span>
                      </label>
                    </div>

                    <div className="flex items-center gap-3 border-t border-black/10 dark:border-white/10 pt-4">
                      <button
                        type="button"
                        disabled={searchTesting}
                        onClick={async () => {
                          // Test uses the saved provider; save first so the test matches the draft.
                          await window.api.setSettings(draft)
                          setSettings(draft)
                          setSearchTesting(true)
                          setSearchTest(null)
                          try {
                            setSearchTest(await window.api.testSearchProvider())
                          } finally {
                            setSearchTesting(false)
                          }
                        }}
                        className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                      >
                        {searchTesting ? 'Testing…' : 'Test connection'}
                      </button>
                      {searchTest && (
                        <span
                          className={`text-xs ${searchTest.ok ? 'text-ink-ok' : 'text-ink-danger'}`}
                        >
                          {searchTest.detail}
                        </span>
                      )}
                    </div>
                  </div>
  )
}
