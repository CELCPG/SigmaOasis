// Settings → Agent (v4.0, S4): how far a task in a folder may go without
// asking, the shell it will use on this machine (decided silently in
// main/agent/command.ts until now), and the sigma command as a card.
import { useEffect, useState } from 'react'
import type { AgentPermission, AppSettings } from '../../types'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { ActionRow, Card, DangerRow, Notice, Row, Section, Segmented, Stepper, Switch, type ActionResult } from './kit'

export const ROWS = defineRows('agent', {
  defaultPermission: { label: 'A new agent chat starts as', help: 'Each chat can change it in its header; a change applies from its next task.', keywords: ['permission', 'ask first', 'accept edits', 'read-only', 'mode'] },
  maxRounds: { label: 'Steps before a task pauses', help: 'A paused task says so and carries on when you press Continue.', keywords: ['rounds', 'limit'] },
  commandTimeoutSec: { label: 'Command time limit', help: 'A command past it is stopped, with its whole process tree.', keywords: ['timeout', 'seconds'] },
  appTools: { label: 'Let the agent use the app’s own tools', help: 'Web search and page reading, deep research, the reference library, memory search, dates and the Python sandbox — each only if it is enabled under Tools, and under the same privacy rules as in a chat.', keywords: ['web', 'research', 'library', 'python'] },
  notify: { label: 'Notify me when a task finishes in the background', help: 'A desktop notification, only when this window is not in front. Nothing leaves the machine.', keywords: ['notification'] },
  shell: { label: 'Shell for commands', help: 'What run_command uses on this machine, found when the app started.', keywords: ['bash', 'git bash', 'cmd', 'terminal'] },
  cli: { label: 'The sigma command', help: 'sigma runs this same agent from any terminal, in the folder you are in — the same server, model and limits as here, approvals as terminal prompts, and nothing but LM Studio on this machine to talk to.', keywords: ['cli', 'terminal', 'install', 'path'] }
})
registerRows(ROWS)

const PERMISSIONS: { value: AgentPermission; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask first', hint: 'Every edit is a diff to Apply or Discard; every command asks.' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits inside the folder land without asking — each diff is kept, and the task can be undone. Commands still ask.' },
  { value: 'readOnly', label: 'Read-only', hint: 'No edits and no commands: for questions and plans.' }
]

export interface AgentTabProps {
  settings: AppSettings
  apply: ApplySettings
  defaults: AppSettings | null
}

export function AgentTab({ settings, apply, defaults }: AgentTabProps): JSX.Element {
  const agent = settings.agent
  const set = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['agent']>, shown?: string): void => apply(meta, { agent: { ...agent, ...patch } }, shown)
  const [shell, setShell] = useState<{ name: string; file: string } | null>(null)
  useEffect(() => {
    void window.api.agentShell().then(setShell).catch(() => setShell(null))
  }, [])
  return (
    <div className="space-y-8">
      <Section
        title="How freely"
        description="An agent chat works in a folder you choose: it searches and reads, edits with the change shown as a diff, runs commands with your approval, and keeps a checklist you can watch. Start one with ⚡ Agent task in the rail."
        onReset={defaults ? () => apply({ id: 'agent.reset', label: 'Agent' }, { agent: defaults.agent }, 'defaults') : undefined}
      >
        <Row meta={ROWS.defaultPermission} layout="stack">
          <Segmented variant="cards" value={agent.defaultPermission} onChange={(defaultPermission) => set(ROWS.defaultPermission, { defaultPermission }, PERMISSIONS.find((p) => p.value === defaultPermission)?.label)} options={PERMISSIONS} />
        </Row>
        <Row meta={ROWS.maxRounds}>
          <Stepper value={agent.maxRounds} min={5} max={200} step={5} onChange={(maxRounds) => set(ROWS.maxRounds, { maxRounds })} />
        </Row>
        <Row meta={ROWS.commandTimeoutSec}>
          <Stepper value={agent.commandTimeoutSec} min={10} max={600} step={10} unit="s" onChange={(commandTimeoutSec) => set(ROWS.commandTimeoutSec, { commandTimeoutSec })} />
        </Row>
        <Row meta={ROWS.appTools}>
          <Switch checked={agent.appTools} onChange={(appTools) => set(ROWS.appTools, { appTools })} />
        </Row>
        <Row meta={ROWS.notify}>
          <Switch checked={agent.notify} onChange={(notify) => set(ROWS.notify, { notify })} />
        </Row>
      </Section>

      <Section title="This machine" description="What the agent found here.">
        <Row meta={ROWS.shell} foot={shell ? <span className="font-mono text-xs text-ink-tertiary">{shell.file}</span> : undefined}>
          <span className="text-sm text-ink-secondary">{shell ? shell.name : 'Looking…'}</span>
        </Row>
      </Section>

      <Section title="In your terminal" description={ROWS.cli.help}>
        <Row meta={ROWS.cli} layout="stack">
          <CliCard />
        </Row>
      </Section>
    </div>
  )
}

type CliStatus = Awaited<ReturnType<typeof window.api.cliStatus>>

/** The `sigma` command: the same agent in a terminal, installed onto the PATH. */
function CliCard(): JSX.Element {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    void window.api.cliStatus().then(setStatus).catch(() => setStatus(null))
  }, [])
  const act = async (fn: () => Promise<{ ok: boolean; status?: CliStatus; error?: string }>, label: string, done: string): Promise<void> => {
    setBusy(label)
    const r = await fn().catch((e: unknown) => ({ ok: false, error: String(e) }) as { ok: boolean; status?: CliStatus; error?: string })
    setBusy(null)
    if (r.status) setStatus(r.status)
    setResult(r.ok ? { tone: 'ok', text: done } : { tone: 'danger', text: r.error ?? 'That did not work.' })
  }
  const installed = Boolean(status?.installed && status.current)
  return (
    <Card data-testid="cli-section" title="sigma" status={installed ? `installed at ${status?.launcher}` : status?.installed ? 'installed, out of date' : 'not installed'}>
      <pre className="rounded-lg bg-black/5 px-3 py-2 text-[11px] leading-relaxed text-ink-secondary dark:bg-white/5">
        {'sigma                       # a session in this folder\nsigma "fix the failing test" # one task, then exit\nsigma --read-only "explain this repo"\nsigma --help'}
      </pre>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {installed ? (
          <DangerRow variant="inline" label="" action="Remove" confirm="Remove sigma from the PATH?" onConfirm={() => act(() => window.api.cliUninstall(), 'Removing…', 'Removed.')} />
        ) : (
          <ActionRow
            action={status?.installed ? 'Update the sigma command' : 'Install the sigma command'}
            kind="primary"
            busy={busy}
            disabled={status?.bundled === false}
            title={status?.bundled === false ? 'This copy of the app was built without the CLI (npm run build:cli).' : `Writes ${status?.launcher ?? 'a launcher'}`}
            onAction={() => void act(() => window.api.cliInstall(), 'Installing…', 'Installed. Open a new terminal and run sigma.')}
            result={result}
          />
        )}
        {installed && result && <span className="text-xs text-ink-secondary">{result.text}</span>}
      </div>
      {status && status.installed && !status.onPath && (
        <Notice tone="warn" className="mt-3">
          {status.launcher.replace(/[\\/][^\\/]+$/, '')} is not on your PATH yet — add it in your shell profile, then open a new terminal.
        </Notice>
      )}
    </Card>
  )
}
