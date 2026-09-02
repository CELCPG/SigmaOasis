// Extracted from SettingsModal.tsx (v2.4): the "connection" tab, as it was. Pure prop-drilling —
// every piece of state and every handler still lives in the modal and arrives here as a prop,
// so nothing about ordering, effects or behaviour changed; the modal just stopped being 2,500 lines.

import React from 'react'
import { describeModel } from '../../lib/modelInfo'
import type { AppSettings, ModelInfo, ConnectionStatus } from '../../types'
import { isLoopbackUrl } from './helpers'

export interface ConnectionTabProps {
  availableModels: ModelInfo[]
  connection: ConnectionStatus
  draft: AppSettings
  refresh: () => Promise<void>
  update: (partial: Partial<AppSettings>) => void
}

export function ConnectionTab(props: ConnectionTabProps): JSX.Element {
  const { availableModels, connection, draft, refresh, update } = props
  return (
    <div className="space-y-4">
                    <div>
                      <label className="mb-1 block text-sm font-medium">LM Studio base URL</label>
                      <input
                        value={draft.baseUrl}
                        onChange={(e) => update({ baseUrl: e.target.value })}
                        placeholder="http://127.0.0.1:1234/v1"
                        className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent/40"
                      />
                      <p className="mt-1 text-xs text-ink-secondary">
                        OpenAI-compatible endpoint. Default is{' '}
                        <code>http://127.0.0.1:1234/v1</code>.
                      </p>
                      {!isLoopbackUrl(draft.baseUrl) && (
                        <p className="mt-2 rounded-lg bg-amber-500/10 p-3 text-xs text-ink-warn">
                          Only servers on this machine are supported. This URL will not be saved —
                          Sigma Oasis reverts to the default. LM Studio traffic carries your
                          conversations in plaintext and is deliberately never proxied, so a
                          non-loopback address would send them off-machine unprotected.
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          connection === 'online'
                            ? 'bg-green-500'
                            : connection === 'connecting'
                              ? 'bg-amber-500'
                              : 'bg-red-500'
                        }`}
                      />
                      <span className="text-sm">
                        {connection === 'online'
                          ? `Connected — ${availableModels.length} model(s) available`
                          : connection === 'connecting'
                            ? 'Connecting…'
                            : 'Offline — is LM Studio running with the server started?'}
                      </span>
                      <button
                        type="button"
                        onClick={refresh}
                        className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        Test / Refresh
                      </button>
                    </div>
                    {availableModels.length > 0 && (
                      <div className="rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs">
                        <div className="mb-1 font-medium">Detected models:</div>
                        <ul className="list-disc pl-5 space-y-0.5">
                          {availableModels.map((m) => (
                            <li key={m.id} className="font-mono">
                              {m.id}
                              {describeModel(m) && (
                                <span className="ml-2 font-sans text-ink-secondary">
                                  {describeModel(m)}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
  )
}
