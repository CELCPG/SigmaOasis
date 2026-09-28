import { useAppStore } from '../../stores/appStore'
import { agentSlot, updateAgentConfig } from '../../hooks/agentTasks'
import type { AgentPermission, Conversation } from '../../types'
import { PanelSection } from '../PanelSection'

/**
 * The header of an agent chat (v3.0): what it works on, how freely, and on
 * which model — each changeable here, taking effect on the next task. While a
 * task runs they are fixed: the running task was started with them, and a
 * header that said otherwise would describe a task that is not the one
 * running.
 */

const PERMISSIONS: { value: AgentPermission; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask first', hint: 'Every edit is shown as a diff to Apply or Discard, and every command asks.' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits inside the folder land without asking — each diff is kept and the task can be undone. Commands still ask.' },
  { value: 'readOnly', label: 'Read-only', hint: 'The agent can look but not touch: no edits, no commands. For questions and plans.' }
]

export function AgentBar({ conversation }: { conversation: Conversation }): JSX.Element {
  const agent = conversation.agent!
  const running = useAppStore((s) => Boolean(s.agentRuns[conversation.id]))
  const models = useAppStore((s) => s.settings?.models ?? [])
  const slot = agentSlot(conversation, models)
  const enabled = models.filter((m) => m.enabled && m.modelId)
  const current = PERMISSIONS.find((p) => p.value === agent.permission) ?? PERMISSIONS[0]!

  const changeFolder = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) updateAgentConfig(conversation.id, { workspace: dir })
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 pt-3 text-xs" data-testid="agent-bar">
      <span className="rounded-full border border-[rgba(0,212,170,0.35)] bg-[rgba(0,212,170,0.12)] px-2 py-0.5 font-medium text-accent-ink">⚡ Agent</span>
      <button
        type="button"
        onClick={() => void changeFolder()}
        disabled={running}
        className="min-w-0 max-w-[45%] truncate rounded-lg px-1.5 py-0.5 text-left font-mono text-ink-secondary hover:bg-black/5 hover:text-ink-primary disabled:opacity-60 dark:hover:bg-white/10"
        title={agent.workspace ? `${agent.workspace}\n\nClick to work in a different folder.` : 'No folder: the agent has no files or commands. Click to choose one.'}
      >
        📁 {agent.workspace ? agent.workspace.split(/[\\/]/).filter(Boolean).pop() : 'no folder — choose one'}
      </button>
      {agent.workspace && !running && (
        <button
          type="button"
          onClick={() => updateAgentConfig(conversation.id, { workspace: null })}
          className="rounded px-1 text-ink-tertiary hover:text-ink-primary"
          title="Work without a folder: no files, no commands — the web, the library and Python only, as enabled under Tools"
          aria-label="Work without a folder"
        >
          ✕
        </button>
      )}
      <label className="flex items-center gap-1 text-ink-tertiary" title={current.hint}>
        <span className="sr-only">Permission</span>
        <select
          value={agent.permission}
          disabled={running}
          onChange={(e) => updateAgentConfig(conversation.id, { permission: e.target.value as AgentPermission })}
          className="rounded-lg border border-black/10 bg-transparent px-1.5 py-0.5 text-xs text-ink-secondary outline-none dark:border-white/10"
        >
          {PERMISSIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {enabled.length > 1 ? (
        <label className="ml-auto flex items-center gap-1 text-ink-tertiary">
          <span className="sr-only">Model</span>
          <select
            value={slot?.id ?? ''}
            disabled={running}
            onChange={(e) => updateAgentConfig(conversation.id, { slotId: e.target.value })}
            className="max-w-[180px] truncate rounded-lg border border-black/10 bg-transparent px-1.5 py-0.5 text-xs text-ink-secondary outline-none dark:border-white/10"
            title="The model slot this agent runs on"
          >
            {enabled.map((m) => (
              <option key={m.id} value={m.id}>
                {m.roleName} · {m.modelId}
              </option>
            ))}
          </select>
        </label>
      ) : (
        slot && <span className="ml-auto truncate font-mono text-ink-tertiary">{slot.modelId}</span>
      )}
    </div>
  )
}

/** Starters for an agent chat with nothing in it yet — tasks, not questions. */
export function AgentEmpty({ conversation }: { conversation: Conversation }): JSX.Element {
  const hasFolder = Boolean(conversation.agent?.workspace)
  const starters = hasFolder
    ? [
        { icon: '🗺️', text: 'Explain how this project is organized and where to start reading.' },
        { icon: '🧪', text: 'Run the tests, and fix whatever fails.' },
        { icon: '🔍', text: 'Review the code for bugs and risky spots, and list them with file and line.' },
        { icon: '📝', text: 'Write or update the README so a newcomer can run the project.' }
      ]
    : [
        { icon: '🔎', text: 'Research a question across several sources and give me a cited summary.' },
        { icon: '🧮', text: 'Work through a calculation step by step with Python and show the result.' }
      ]
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="text-3xl" aria-hidden="true">
        ⚡
      </div>
      <h2 className="mt-3 text-lg font-semibold">What should the agent do?</h2>
      <p className="mt-1 max-w-md text-sm text-ink-secondary">
        {hasFolder
          ? 'It reads, edits and runs things in this folder until the task is done — keeping a checklist you can watch, asking before what you asked it to ask about.'
          : 'No folder is chosen, so it works with the web, the library and Python — whatever is enabled under Settings → Tools.'}
      </p>
      <div className="mt-5 grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {starters.map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => useAppStore.getState().setComposerPrefill(s.text)}
            className="glass-panel glass-panel--hover rounded-2xl px-3 py-2.5 text-left text-sm text-ink-secondary"
          >
            <span className="mr-1.5" aria-hidden="true">
              {s.icon}
            </span>
            {s.text}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The chat panel's section for an agent chat, in place of the chat's strategy
 * and memory controls — none of which drive a task. What it works on, how
 * freely, on which model, and every file its turns have changed.
 */
export function AgentPanelSection({ conversation }: { conversation: Conversation }): JSX.Element {
  const agent = conversation.agent!
  const models = useAppStore((s) => s.settings?.models ?? [])
  const slot = agentSlot(conversation, models)
  const changed = [...new Set(conversation.messages.flatMap((m) => (m.agent && !m.agent.undo ? (m.agent.changedFiles ?? []) : [])))]
  const permission = PERMISSIONS.find((p) => p.value === agent.permission) ?? PERMISSIONS[0]!
  return (
    <PanelSection title="Agent" hint="What this agent chat works on">
      <dl className="space-y-1.5 text-xs">
        <div>
          <dt className="text-ink-tertiary">Folder</dt>
          <dd className="break-all font-mono text-ink-secondary">{agent.workspace ?? 'none — no files or commands'}</dd>
        </div>
        <div>
          <dt className="text-ink-tertiary">Works</dt>
          <dd className="text-ink-secondary" title={permission.hint}>
            {permission.label}
          </dd>
        </div>
        <div>
          <dt className="text-ink-tertiary">Model</dt>
          <dd className="font-mono text-ink-secondary">{slot ? `${slot.roleName} · ${slot.modelId}` : '—'}</dd>
        </div>
        {changed.length > 0 && (
          <div>
            <dt className="text-ink-tertiary">Changed in this chat</dt>
            <dd>
              <ul className="font-mono text-ink-secondary">
                {changed.map((f) => (
                  <li key={f} className="truncate" title={f}>
                    {f}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </PanelSection>
  )
}
