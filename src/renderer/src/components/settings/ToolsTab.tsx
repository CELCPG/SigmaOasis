// Extracted from SettingsModal.tsx (v2.4): the "tools" tab, as it was. Pure prop-drilling —
// every piece of state and every handler still lives in the modal and arrives here as a prop,
// so nothing about ordering, effects or behaviour changed; the modal just stopped being 2,500 lines.

import React, { useCallback, useEffect, useState } from 'react'
import { TOOL_LABELS } from '../../../../shared/tools'
import { splitMcpWireName } from '../../../../shared/mcpNames'
import type { AppSettings, Grant, ToolToggles, WorkbenchStatus } from '../../types'

/** v2.6: what a grant row calls its tool — `server › tool` for an MCP wire name. */
function grantToolLabel(tool: string): string {
  const mcp = splitMcpWireName(tool)
  return mcp ? `${mcp.server} › ${mcp.tool}` : tool
}

/**
 * v2.6: the standing grants, listed with their use counts and revoked one at
 * a time. Self-fetching, like the MCP tab: grants are minted by dialogs in
 * the main process, not by the Settings draft, so they are not a setting.
 */
function GrantsSection(): JSX.Element {
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const refresh = useCallback(async () => {
    setGrants(await window.api.grantsList().catch(() => []))
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium">Standing grants</span>
        {grants && grants.length > 0 && (
          <button
            type="button"
            onClick={() => void window.api.grantsRevokeAll().then(refresh)}
            className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-2.5 py-1 text-xs text-ink-danger hover:bg-black/5 dark:hover:bg-white/10"
          >
            Revoke all
          </button>
        )}
      </div>
      <p className="mb-2 text-xs text-ink-secondary">
        “Always allow” in a confirmation dialog mints a grant for that exact call — the command in
        that working directory, the file path, or the MCP tool with those arguments. One byte
        different asks again. Revoking takes effect on the next call.
      </p>
      {grants === null ? (
        <p className="text-xs text-ink-tertiary">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="text-xs text-ink-tertiary">No standing grants.</p>
      ) : (
        <ul className="space-y-1.5">
          {grants.map((g) => (
            <li
              key={g.id}
              className="flex items-center gap-2 rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs" title={g.summary}>
                  {g.summary}
                </span>
                <span className="block text-xs text-ink-tertiary">
                  {grantToolLabel(g.tool)}
                  {g.cwd ? ` · in ${g.cwd}` : ''}
                  {` · used ${g.uses} time${g.uses === 1 ? '' : 's'}`}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void window.api.grantsRevoke(g.id).then(refresh)}
                className="shrink-0 rounded-lg px-2 py-1 text-xs text-ink-danger hover:bg-black/5 dark:hover:bg-white/10"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export interface ToolsTabProps {
  draft: AppSettings
  pickWorkingDir: () => Promise<void>
  setWarming: React.Dispatch<React.SetStateAction<boolean>>
  setWorkbench: React.Dispatch<React.SetStateAction<WorkbenchStatus | null>>
  update: (partial: Partial<AppSettings>) => void
  warming: boolean
  workbench: WorkbenchStatus | null
}

export function ToolsTab(props: ToolsTabProps): JSX.Element {
  const { draft, pickWorkingDir, setWarming, setWorkbench, update, warming, workbench } = props
  return (
    <div className="space-y-4">
                    <div>
                      <label className="mb-1 block text-sm font-medium">Default working directory</label>
                      <div className="flex gap-2">
                        <input
                          value={draft.workingDirectory}
                          onChange={(e) => update({ workingDirectory: e.target.value })}
                          placeholder="Scopes the file tools — leave empty to be asked before each write"
                          className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                        />
                        <button
                          type="button"
                          onClick={pickWorkingDir}
                          className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          Browse…
                        </button>
                      </div>
                      <p className="mt-1 text-xs text-ink-secondary">
                        Relative paths resolve here, and the file tools cannot read or write outside
                        it. Leave empty for unrestricted paths — each write is then confirmed.
                      </p>
                    </div>
                    <div className="rounded-xl border border-black/10 dark:border-white/10 p-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            workbench === null
                              ? 'bg-neutral-400'
                              : !workbench.available
                                ? 'bg-red-500'
                                : workbench.warm
                                  ? 'bg-green-500'
                                  : 'bg-amber-500'
                          }`}
                        />
                        <span className="text-sm font-medium">Workbench (sandboxed Python)</span>
                        <span className="text-xs text-ink-tertiary">
                          {workbench === null
                            ? 'checking…'
                            : !workbench.available
                              ? 'not installed'
                              : `Pyodide ${workbench.version ?? '?'} · ${workbench.warm ? 'running' : 'idle'}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setWorkbench(null)
                            void window.api.workbenchStatus().then(setWorkbench).catch(() => setWorkbench(null))
                          }}
                          className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          Refresh
                        </button>
                        {workbench?.available && !workbench.warm && (
                          <button
                            type="button"
                            disabled={warming}
                            onClick={() => {
                              setWarming(true)
                              void window.api
                                .warmWorkbench()
                                // Loading the runtime takes a second or two; re-read once it can have finished.
                                .then(() => new Promise((r) => setTimeout(r, 2500)))
                                .then(() => window.api.workbenchStatus())
                                .then(setWorkbench)
                                .catch(() => undefined)
                                .finally(() => setWarming(false))
                            }}
                            className="rounded-lg border border-black/10 dark:border-white/10 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                            title="Load the runtime now so the first run_python of the session does not pay the cold start"
                          >
                            {warming ? 'Starting…' : 'Start now'}
                          </button>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-ink-secondary">
                        {workbench?.available
                          ? `Python runs in WebAssembly inside a sandboxed window: no network — not even your LM Studio server — and no access to your disk beyond the files you attach. Available offline: the standard library${
                              workbench.packages.length > 0 ? ` plus ${workbench.packages.join(', ')}` : ''
                            }. The sandbox is torn down after ten minutes idle.`
                          : 'run_python and analyze_file report themselves unavailable until the runtime is installed. Everything else in the app is unaffected.'}
                      </p>
                      {workbench && !workbench.available && workbench.reason && (
                        <p className="mt-2 rounded-lg bg-amber-500/10 p-2.5 text-xs text-ink-warn">
                          {workbench.reason}
                          <br />
                          In a checkout, run <code>bash scripts/fetch-pyodide.sh</code>; packaged builds
                          include it.
                        </p>
                      )}
                    </div>

                    <div>
                      <div className="mb-2 text-sm font-medium">Enabled tools</div>
                      <div className="space-y-1.5">
                        {(Object.keys(TOOL_LABELS) as (keyof ToolToggles)[]).map((key) => (
                          <label
                            key={key}
                            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
                          >
                            <input
                              type="checkbox"
                              checked={draft.tools[key]}
                              onChange={(e) =>
                                update({ tools: { ...draft.tools, [key]: e.target.checked } })
                              }
                              className="accent-accent"
                            />
                            {TOOL_LABELS[key]}
                            <code className="ml-auto text-xs text-ink-tertiary">{key}</code>
                          </label>
                        ))}
                      </div>
                    </div>

                    <GrantsSection />
                  </div>
  )
}
