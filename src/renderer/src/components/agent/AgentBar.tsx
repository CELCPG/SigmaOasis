import { useAppStore } from '../../stores/appStore'
import { agentSlot, updateAgentConfig } from '../../hooks/agentTasks'
import type { AgentConnectionSettings, AgentPermission, Conversation } from '../../types'
import { PanelSection } from '../PanelSection'
import { Select } from '../settings/kit'

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

/**
 * 4.6 (J1): the agent connection, when it is on — then the agent runs on that
 * server's model whichever slot the chat names, and the header says so.
 */
export function agentConnectionLabel(conn: AgentConnectionSettings | undefined): { model: string; baseUrl: string } | null {
  return conn?.enabled ? { model: conn.model || 'the server’s model', baseUrl: conn.baseUrl } : null
}

function useAgentConnection(): { model: string; baseUrl: string } | null {
  return agentConnectionLabel(useAppStore((s) => s.settings?.agentConnection))
}

export const connectionHint = (baseUrl: string): string =>
  `Runs on the agent connection, ${baseUrl} (Settings → LM Studio). Chat, embeddings and titles stay on LM Studio.`

export function AgentBar({ conversation }: { conversation: Conversation }): JSX.Element {
  const agent = conversation.agent!
  const running = useAppStore((s) => Boolean(s.agentRuns[conversation.id]))
  const models = useAppStore((s) => s.settings?.models ?? [])
  const onAgent = useAgentConnection()
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
      {/* v4.0 (E3): the header's controls are the Settings kit's, so a select looks the same here as there. */}
      <Select
        compact
        label="Permission"
        title={current.hint}
        value={agent.permission}
        disabled={running}
        onChange={(v) => updateAgentConfig(conversation.id, { permission: v as AgentPermission })}
        options={PERMISSIONS.map((p) => ({ value: p.value, label: p.label }))}
      />
      {onAgent ? (
        <span className="ml-auto max-w-[45%] truncate font-mono text-ink-tertiary" title={connectionHint(onAgent.baseUrl)} data-testid="agent-connection-label">
          {onAgent.model} · agent connection
        </span>
      ) : enabled.length > 1 ? (
        <Select
          compact
          label="Model"
          title="The model slot this agent runs on"
          className="ml-auto max-w-[200px] truncate"
          value={slot?.id ?? ''}
          disabled={running}
          onChange={(v) => updateAgentConfig(conversation.id, { slotId: v })}
          options={enabled.map((m) => ({ value: m.id, label: `${m.roleName} · ${m.modelId}` }))}
        />
      ) : (
        slot && <span className="ml-auto truncate font-mono text-ink-tertiary">{slot.modelId}</span>
      )}
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
  const onAgent = useAgentConnection()
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
        {onAgent ? (
          <div>
            <dt className="text-ink-tertiary">Model</dt>
            <dd className="font-mono text-ink-secondary" title={connectionHint(onAgent.baseUrl)}>
              {onAgent.model}
              <span className="block break-all text-ink-tertiary">agent connection · {onAgent.baseUrl}</span>
            </dd>
          </div>
        ) : (
          <div>
            <dt className="text-ink-tertiary">Model</dt>
            <dd className="font-mono text-ink-secondary">{slot ? `${slot.roleName} · ${slot.modelId}` : '—'}</dd>
          </div>
        )}
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
