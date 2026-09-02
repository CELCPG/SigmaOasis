// Extracted from SettingsModal.tsx (v2.4): the "general" tab, as it was. Pure prop-drilling —
// every piece of state and every handler still lives in the modal and arrives here as a prop,
// so nothing about ordering, effects or behaviour changed; the modal just stopped being 2,500 lines.

import React from 'react'
import type { AppSettings } from '../../types'
import type { UpdateStatus } from '../../types'

export interface GeneralTabProps {
  checkForUpdates: () => Promise<void>
  draft: AppSettings
  installUpdate: () => void
  update: (partial: Partial<AppSettings>) => void
  updateStatus: UpdateStatus | null
}

export function GeneralTab(props: GeneralTabProps): JSX.Element {
  const { checkForUpdates, draft, installUpdate, update, updateStatus } = props
  return (
    <div className="space-y-5">
                    <div>
                      <label className="mb-1 block text-sm font-medium">Theme</label>
                      <div className="flex rounded-lg bg-black/5 dark:bg-white/10 p-0.5 text-sm w-fit">
                        {(['light', 'dark'] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => update({ theme: t })}
                            className={`px-4 py-1.5 rounded-md capitalize ${
                              draft.theme === t ? 'bg-white dark:bg-neutral-700 shadow-sm' : 'text-ink-secondary'
                            }`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium">
                        Font size: {draft.fontSize}px
                      </label>
                      <input
                        type="range"
                        min={12}
                        max={20}
                        value={draft.fontSize}
                        onChange={(e) => update({ fontSize: Number(e.target.value) })}
                        className="w-64 accent-accent"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium">
                        Conversation history limit
                      </label>
                      <input
                        type="number"
                        min={10}
                        max={1000}
                        value={draft.historyLimit}
                        onChange={(e) => update({ historyLimit: Number(e.target.value) })}
                        className="w-32 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                      />
                      <p className="mt-1 text-xs text-ink-secondary">
                        Maximum number of conversations to keep.
                      </p>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium">Chat appearance</label>
                      <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.hideToolCalls}
                          onChange={(e) => update({ hideToolCalls: e.target.checked })}
                          className="h-4 w-4 accent-accent"
                        />
                        Hide tool-call details
                      </label>
                      <p className="mt-1 text-xs text-ink-secondary">
                        When on, tool activity collapses to a subtle thinking animation — the chat
                        stays clean. Off by default.
                      </p>
                      <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.showResponseStats}
                          onChange={(e) => update({ showResponseStats: e.target.checked })}
                          className="h-4 w-4 accent-accent"
                        />
                        Show response stats
                      </label>
                      <p className="mt-1 text-xs text-ink-secondary">
                        Tokens/sec and time to first token under each reply. Token counts come from LM
                        Studio; when a server does not report them, only timing is shown.
                      </p>
                      <div className="mt-3">
                        <label className="mb-1 block text-sm">Reasoning display</label>
                        <select
                          value={draft.reasoningDisplay}
                          onChange={(e) =>
                            update({
                              reasoningDisplay: e.target.value as AppSettings['reasoningDisplay']
                            })
                          }
                          className="w-64 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                        >
                          <option value="collapsed">Collapsed behind a &quot;Thought&quot; header</option>
                          <option value="expanded">Always expanded</option>
                          <option value="hidden">Hidden</option>
                        </select>
                        <p className="mt-1 text-xs text-ink-secondary">
                          How a model&apos;s chain-of-thought appears above its reply. Applies to new
                          views of a message; the reasoning itself is always kept.
                        </p>
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium">
                        When a conversation outgrows the context window
                      </label>
                      <select
                        value={draft.contextManagement}
                        onChange={(e) =>
                          update({ contextManagement: e.target.value as 'compact' | 'trim' })
                        }
                        className="w-64 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                      >
                        <option value="compact">Summarize what no longer fits</option>
                        <option value="trim">Drop it silently</option>
                      </select>
                      <p className="mt-1 text-xs text-ink-secondary">
                        Summarizing costs one extra local model call when the limit is first reached,
                        and keeps the model aware of how the conversation began. Dropping is what
                        versions before 0.8.2 did.
                      </p>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium">Plan mode (📋 in the composer)</label>
                      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.plan.confirmPlan}
                          onChange={(e) => update({ plan: { ...draft.plan, confirmPlan: e.target.checked } })}
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Show the plan for approval before executing
                          <span className="block text-xs text-ink-secondary">
                            One dialog with every step before anything runs — the moment to catch a plan
                            that misread the task. Off means generated plans run immediately.
                          </span>
                        </span>
                      </label>
                      <div className="mt-2 flex items-center gap-2">
                        <label className="text-xs text-ink-secondary">Max steps per plan</label>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={draft.plan.maxSteps}
                          onChange={(e) => update({ plan: { ...draft.plan, maxSteps: Number(e.target.value) } })}
                          className="w-20 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                        />
                        <span className="text-xs text-ink-tertiary">
                          Each step is a bounded sub-turn with the enabled tools.
                        </span>
                      </div>
                    </div>
                    <div className="border-t border-black/10 dark:border-white/10 pt-4">
                      <label className="mb-1 block text-sm font-medium">About</label>
                      <p className="text-sm text-ink-secondary">
                        Sigma Oasis v{updateStatus?.currentVersion ?? '…'}
                      </p>
                      <div className="mt-2 flex items-center gap-3">
                        <span className="text-xs text-ink-secondary">
                          {updateStatus?.state === 'dev'
                            ? 'Development build — updates apply to packaged releases.'
                            : updateStatus?.state === 'checking'
                              ? 'Checking for updates…'
                              : updateStatus?.state === 'available'
                                ? `Update ${updateStatus.version} found — downloading…`
                                : updateStatus?.state === 'downloading'
                                  ? `Downloading update… ${updateStatus.percent ?? 0}%`
                                  : updateStatus?.state === 'downloaded'
                                    ? `Update ${updateStatus.version} is ready to install.`
                                    : updateStatus?.state === 'error'
                                      ? `Update check failed: ${updateStatus.error ?? 'unknown error'}`
                                      : 'You’re up to date.'}
                        </span>
                        {updateStatus?.state === 'downloaded' ? (
                          <button
                            type="button"
                            onClick={installUpdate}
                            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
                          >
                            Restart to update
                          </button>
                        ) : updateStatus?.state !== 'dev' ? (
                          <button
                            type="button"
                            onClick={() => void checkForUpdates()}
                            disabled={updateStatus?.state === 'checking' || updateStatus?.state === 'downloading'}
                            className="rounded-lg border border-black/10 dark:border-white/15 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                          >
                            Check now
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
  )
}
