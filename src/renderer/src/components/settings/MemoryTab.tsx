// Extracted from SettingsModal.tsx (v2.4): the "memory" tab, as it was. Pure prop-drilling —
// every piece of state and every handler still lives in the modal and arrives here as a prop,
// so nothing about ordering, effects or behaviour changed; the modal just stopped being 2,500 lines.

import React from 'react'
import type { AppSettings, MemoryStats } from '../../types'

export interface MemoryTabProps {
  draft: AppSettings
  memoryNotice: string | null
  memoryStats: MemoryStats | null
  setMemoryNotice: React.Dispatch<React.SetStateAction<string | null>>
  setMemoryStats: React.Dispatch<React.SetStateAction<MemoryStats | null>>
  update: (partial: Partial<AppSettings>) => void
}

export function MemoryTab(props: MemoryTabProps): JSX.Element {
  const { draft, memoryNotice, memoryStats, setMemoryNotice, setMemoryStats, update } = props
  return (
    <div className="space-y-5">
                    {/* Status */}
                    <div className="flex items-center gap-3">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          memoryStats?.available ? 'bg-green-500' : 'bg-red-500'
                        }`}
                      />
                      <span className="text-sm">
                        {memoryStats === null
                          ? 'Checking…'
                          : memoryStats.available
                            ? `Ready — ${memoryStats.totalChunks.toLocaleString()} of ${memoryStats.maxChunks.toLocaleString()} chunks indexed`
                            : 'No embedding model detected'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void window.api.memoryStats().then(setMemoryStats)}
                        className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        Refresh
                      </button>
                    </div>
                    {memoryStats && !memoryStats.available && (
                      <p className="rounded-lg bg-amber-500/10 p-3 text-xs text-ink-warn">
                        {memoryStats.reason}
                      </p>
                    )}
                    {memoryStats?.mixedModels && (
                      <p className="rounded-lg bg-amber-500/10 p-3 text-xs text-ink-warn">
                        Some sources were indexed with a different embedding model and can&apos;t be
                        searched by the current one. Remove and re-add them below, or switch back to the
                        model that indexed them.
                      </p>
                    )}

                    {/* Behavior */}
                    <div className="space-y-4">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.memory.autoContext}
                          onChange={(e) =>
                            update({ memory: { ...draft.memory, autoContext: e.target.checked } })
                          }
                          className="accent-accent"
                        />
                        Automatically recall relevant memories in every conversation
                      </label>
                      <div>
                        <label className="mb-1 block text-sm font-medium">
                          Memories to recall per turn: {draft.memory.topK}
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={8}
                          value={draft.memory.topK}
                          onChange={(e) =>
                            update({ memory: { ...draft.memory, topK: Number(e.target.value) } })
                          }
                          className="w-64 accent-accent"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium">Embedding model</label>
                        <input
                          value={draft.memory.embeddingModel}
                          onChange={(e) =>
                            update({ memory: { ...draft.memory, embeddingModel: e.target.value } })
                          }
                          placeholder={
                            memoryStats?.embeddingModel ??
                            'auto-detect (first loaded model containing "embed")'
                          }
                          className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                        />
                        <p className="mt-1 text-xs text-ink-secondary">
                          Leave empty to auto-detect from LM Studio. Currently resolved:{' '}
                          <code>{memoryStats?.embeddingModel ?? '—'}</code>
                        </p>
                      </div>
                    </div>

                    {/* Knowledge base */}
                    <div className="space-y-3 border-t border-black/10 dark:border-white/10 pt-4">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium">Knowledge base</div>
                        <button
                          type="button"
                          onClick={() =>
                            void window.api
                              .pickFile()
                              .then(async (p) => {
                                if (!p) return
                                setMemoryNotice('Indexing…')
                                const res = await window.api.memoryAddDocumentFromPath(p)
                                setMemoryNotice(
                                  res.ok
                                    ? `Indexed "${res.name}" (${res.chunks} chunk(s)${res.truncated ? ', truncated' : ''}).`
                                    : (res.error ?? 'Indexing failed.')
                                )
                                void window.api.memoryStats().then(setMemoryStats)
                              })
                          }
                          className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          + Add document
                        </button>
                      </div>
                      {memoryNotice && <p className="text-xs text-ink-secondary">{memoryNotice}</p>}
                      {(memoryStats?.sources.length ?? 0) === 0 ? (
                        <p className="text-xs text-ink-secondary">
                          Nothing indexed yet. Notes created by models are indexed automatically;
                          models can also save memories with the <code>memory_save</code> tool.
                        </p>
                      ) : (
                        <ul className="space-y-1.5">
                          {memoryStats!.sources.map((s) => (
                            <li
                              key={s.source}
                              className="flex items-center gap-2 rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm"
                            >
                              <span className="min-w-0 flex-1 truncate" title={s.source}>
                                {s.source}
                              </span>
                              <span className="shrink-0 text-xs text-ink-tertiary">
                                {s.chunks} chunk(s)
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  void window.api.memoryDeleteSource(s.source).then(() => {
                                    void window.api.memoryStats().then(setMemoryStats)
                                  })
                                }
                                className="shrink-0 rounded px-1.5 text-ink-tertiary hover:text-ink-danger"
                                title="Remove from memory"
                              >
                                ✕
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
  )
}
