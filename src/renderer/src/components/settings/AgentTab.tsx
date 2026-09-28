// v3.0: Settings → Agent — how far a task may go, what a new agent chat may do
// unasked, whether the app's own tools join the folder's, and the `sigma`
// command for the terminal.
import { useEffect, useState } from 'react'
import type { AgentPermission, AppSettings } from '../../types'

const PERMISSIONS: { value: AgentPermission; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask first', hint: 'Every edit is a diff to Apply or Discard; every command asks.' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits inside the folder land without asking — each diff is kept, and the task can be undone. Commands still ask.' },
  { value: 'readOnly', label: 'Read-only', hint: 'No edits and no commands: for questions and plans.' }
]

export function AgentTab({ draft, update }: { draft: AppSettings; update: (patch: Partial<AppSettings>) => void }): JSX.Element {
  const agent = draft.agent
  const set = (patch: Partial<AppSettings['agent']>): void => update({ agent: { ...agent, ...patch } })
  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm font-medium">The agent</div>
        <p className="mt-1 text-xs text-ink-secondary">
          An agent chat works in a folder you choose: it searches and reads the files, edits them with the change shown as a
          diff, runs commands like your tests with your approval, keeps a checklist you can watch, and hands broad searches to
          helpers so its own context stays small. Tasks run in the background — switch chats and they carry on; the rail lists
          what is working now. Start one with ⚡ Agent task in the rail.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">A new agent chat starts as</label>
        <div className="flex flex-col gap-1.5">
          {PERMISSIONS.map((p) => (
            <label key={p.value} className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="radio"
                name="agent-permission"
                checked={agent.defaultPermission === p.value}
                onChange={() => set({ defaultPermission: p.value })}
                className="mt-1 accent-accent"
              />
              <span>
                {p.label}
                <span className="block text-xs text-ink-secondary">{p.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-tertiary">Each chat can change it in its header; a change applies from its next task.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="agent-rounds">
            Steps before a task pauses
          </label>
          <input
            id="agent-rounds"
            type="number"
            min={5}
            max={200}
            value={agent.maxRounds}
            onChange={(e) => set({ maxRounds: Number(e.target.value) })}
            className="w-28 rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none dark:border-white/10"
          />
          <p className="mt-1 text-xs text-ink-secondary">A paused task says so and carries on when you press Continue.</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="agent-timeout">
            Command time limit (seconds)
          </label>
          <input
            id="agent-timeout"
            type="number"
            min={10}
            max={600}
            value={agent.commandTimeoutSec}
            onChange={(e) => set({ commandTimeoutSec: Number(e.target.value) })}
            className="w-28 rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none dark:border-white/10"
          />
          <p className="mt-1 text-xs text-ink-secondary">A command past it is stopped, with its whole process tree.</p>
        </div>
      </div>

      <div className="space-y-3">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input type="checkbox" checked={agent.appTools} onChange={(e) => set({ appTools: e.target.checked })} className="mt-1 h-4 w-4 accent-accent" />
          <span>
            Let the agent use the app’s own tools
            <span className="block text-xs text-ink-secondary">
              Web search and page reading, deep research, the reference library, memory search, dates and the Python sandbox —
              each only if it is enabled under Tools, and under the same privacy rules as in a chat.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input type="checkbox" checked={agent.notify} onChange={(e) => set({ notify: e.target.checked })} className="mt-1 h-4 w-4 accent-accent" />
          <span>
            Notify me when a task finishes in the background
            <span className="block text-xs text-ink-secondary">A desktop notification, only when this window is not in front. Nothing leaves the machine.</span>
          </span>
        </label>
      </div>

      <CliSection />
    </div>
  )
}

type CliStatus = Awaited<ReturnType<typeof window.api.cliStatus>>

/** The `sigma` command: the same agent in a terminal, installed onto the PATH. */
function CliSection(): JSX.Element {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.api.cliStatus().then(setStatus).catch(() => setStatus(null))
  }, [])
  const act = async (fn: () => Promise<{ ok: boolean; status?: CliStatus; error?: string }>, done: string): Promise<void> => {
    setBusy(true)
    const r = await fn().catch((e: unknown) => ({ ok: false, error: String(e) }) as { ok: boolean; status?: CliStatus; error?: string })
    setBusy(false)
    if (r.status) setStatus(r.status)
    setNotice(r.ok ? done : (r.error ?? 'That did not work.'))
  }
  const BUTTON = 'rounded-lg border border-black/10 px-2.5 py-1 text-xs hover:bg-black/5 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/10'
  return (
    <div className="border-t border-black/5 pt-5 dark:border-white/10" data-testid="cli-section">
      <div className="text-sm font-medium">The agent in your terminal</div>
      <p className="mt-1 text-xs text-ink-secondary">
        <code>sigma</code> runs this same agent from any terminal, in the folder you are in — with the same server, model and
        limits as set here, approvals as terminal prompts, and nothing but LM Studio on this machine to talk to.
      </p>
      <pre className="mt-2 rounded-lg bg-black/5 px-3 py-2 text-[11px] leading-relaxed dark:bg-white/5">
        {'sigma                       # a session in this folder\nsigma "fix the failing test" # one task, then exit\nsigma --read-only "explain this repo"\nsigma --help'}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {status?.installed && status.current ? (
          <>
            <span className="text-ink-ok">✓ Installed</span>
            <span className="font-mono text-ink-tertiary">{status.launcher}</span>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void act(() => window.api.cliUninstall(), 'Removed.')}>
              Remove
            </button>
          </>
        ) : (
          <button
            type="button"
            className={BUTTON}
            disabled={busy || status?.bundled === false}
            onClick={() => void act(() => window.api.cliInstall(), 'Installed. Open a new terminal and run sigma.')}
            title={status?.bundled === false ? 'This copy of the app was built without the CLI (npm run build:cli).' : `Writes ${status?.launcher ?? 'a launcher'}`}
          >
            {status?.installed ? 'Update the sigma command' : 'Install the sigma command'}
          </button>
        )}
      </div>
      {status && status.installed && !status.onPath && (
        <p className="mt-1 text-xs text-ink-warn">
          {status.launcher.replace(/[\\/][^\\/]+$/, '')} is not on your PATH yet — add it in your shell profile, then open a new terminal.
        </p>
      )}
      {notice && <p className="mt-1 text-xs text-ink-secondary">{notice}</p>}
    </div>
  )
}
