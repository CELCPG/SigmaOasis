// Settings → Agent (v4.0, S4): how far a task in a folder may go without
// asking, the shell it will use on this machine (decided silently in
// main/agent/command.ts until now), and the sigma command as a card.
import { useEffect, useState } from 'react'
import type { AgentExperiments, AgentPermission, AppSettings } from '../../types'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { ActionRow, Card, DangerRow, Notice, Row, Section, Segmented, Stepper, Switch, type ActionResult } from './kit'

export const ROWS = defineRows('agent', {
  defaultPermission: { label: 'A new agent chat starts as', help: 'Each chat can change it in its header; a change applies from its next task.', keywords: ['permission', 'ask first', 'accept edits', 'read-only', 'mode'] },
  maxRounds: { label: 'Steps before a task pauses', help: 'A paused task says so and carries on when you press Continue.', keywords: ['rounds', 'limit'] },
  roundMaxTokens: { label: 'Longest single step', help: 'The most one step may write, thinking included, when the model’s slot sets no limit. A step cut off here is told so and asked to go smaller; a lower cap stops a model caught thinking in circles sooner.', keywords: ['max tokens', 'output', 'thinking', 'cap'] },
  commandTimeoutSec: { label: 'Command time limit', help: 'A command past it is stopped, with its whole process tree.', keywords: ['timeout', 'seconds'] },
  appTools: { label: 'Let the agent use the app’s own tools', help: 'Web search and page reading, deep research, the reference library, memory search, dates and the Python sandbox — each only if it is enabled under Tools, and under the same privacy rules as in a chat.', keywords: ['web', 'research', 'library', 'python'] },
  notify: { label: 'Notify me when a task finishes in the background', help: 'A desktop notification, only when this window is not in front. Nothing leaves the machine.', keywords: ['notification'] },
  shell: { label: 'Shell for commands', help: 'What run_command uses on this machine, found when the app started.', keywords: ['bash', 'git bash', 'cmd', 'terminal'] },
  experiments: { label: 'Experiments', help: 'Changes to what the agent does on every task, each built and tested against a scripted model and off until eval:agent’s baseline exists on a sound machine and the change holds or improves it. Turn one on to try it; nothing here is claimed to be better yet.', keywords: ['experimental', 'unmeasured', 'lab'] },
  cli: { label: 'The sigma command', help: 'sigma runs this same agent from any terminal, in the folder you are in — the same server, model and limits as here, approvals as terminal prompts, and nothing but LM Studio on this machine to talk to.', keywords: ['cli', 'terminal', 'install', 'path'] }
})
registerRows(ROWS)

const PERMISSIONS: { value: AgentPermission; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask first', hint: 'Every edit is a diff to Apply or Discard; every command asks.' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits inside the folder land without asking — each diff is kept, and the task can be undone. Commands still ask.' },
  { value: 'readOnly', label: 'Read-only', hint: 'No edits and no commands: for questions and plans.' }
]

/** v4.2 (A3): the round caps offered (main/agent/types.ts ROUND_MAX_TOKENS_OPTIONS). */
const ROUND_CAPS: { value: string; label: string; hint: string }[] = [
  { value: '16384', label: '16K tokens', hint: 'The default since 4.0.' },
  { value: '8192', label: '8K', hint: 'Under test: a runaway round ends sooner.' },
  { value: '4096', label: '4K', hint: 'Under test: the shortest; big file writes are split into parts.' }
]

/** The experiments, in the roadmap's order, each one line of what it changes. */
const EXPERIMENTS: { key: keyof AgentExperiments; label: string; help: string }[] = [
  { key: 'lowWaterMark', label: 'Context fitting keeps the cache (A1)', help: 'Once over budget, old tool output is set aside down to 70% of the window, so the history’s start moves once every several rounds instead of every round and the server’s prompt cache survives between.' },
  { key: 'multiRead', label: 'read_file takes several files (A1)', help: 'Up to three more paths in one call, each windowed as a single read, for a first look at a project in one round instead of four.' },
  { key: 'digests', label: 'Tool results shaped for a small reader (A2)', help: 'A test run says “3 failed, 41 passed” and the failures first; grep groups hits by file; a directory listing shows sizes; an edit returns the lines around it so no re-read is needed.' },
  { key: 'thinkByPhase', label: 'Think when it matters (A3)', help: 'Per model family (4.2): thought on the first round, after a failed check and before the likely report; after a successful read or edit a <think> model starts with the block closed, and a model that thinks in its own tokens gets a shorter step.' },
  { key: 'planFocus', label: 'Plan, then one step at a time (A4)', help: 'The checklist the agent writes stays in view: each step runs with the plan named, and a finished step’s output is set aside first. The plan round itself is the 4.2 switch below.' },
  { key: 'verifyRound', label: 'A verify round that cannot be skipped (A5)', help: 'When files changed and a test command is known, one more round offering only run_command before the report; a report that claims a check the timeline does not show is rewritten to say so.' },
  { key: 'askUser', label: 'ask_user as a tool (A6)', help: 'A question with optional choices pauses the task; the answer is the next message. Helpers cannot ask.' },
  { key: 'reviewer', label: 'A reviewer before the report (A7)', help: 'A review helper reads the diff of everything changed and returns “no problems” or a list, which becomes one more round.' },
  { key: 'hooks', label: 'Hooks (A8)', help: 'A project’s .sigma/hooks.json names commands to run after an edit, before a command and when a task ends — each under the same grant rule as any command, each a line on the timeline.' },
  { key: 'worktrees', label: 'A worktree per task (A9)', help: 'In a git repository a task runs in its own worktree on its own branch, sigma/<slug>; the app does the git and the model is handed none of it.' },
  { key: 'notes', label: 'Notes about a folder (A10)', help: 'At the end of a task the agent may propose an edit to .sigma/notes.md — how the tests run, where things are — shown as any edit is; the next task in the folder reads it.' },
  { key: 'documents', label: 'Documents: read and write (C1)', help: 'read_document turns .docx, .xlsx, .pptx, .pdf, .csv and .md into text with headings, tables and sheet names; write_document makes a .docx from Markdown or an .xlsx from rows. A document edit shows as the diff of what it says.' },
  { key: 'chores', label: 'Folder chores (C2)', help: 'move_file, copy_file, make_directory and delete_file — inside the folder, each checkpointed so Undo reverses a move and restores a delete; delete sends to the trash and never removes.' },
  { key: 'recipes', label: 'Recipes (C3)', help: 'A skill with an agent.md fires in an agent chat when its trigger matches the task; the app ships four — tidy a folder, summarize what is here, fill a template from data, fix the failing test.' },
  { key: 'browse', label: 'browse, read-only (C4)', help: 'browse(url, instruction): the headless renderer loads the page and returns what the instruction asks for — the links, the prices, the passages. No form is submitted, no cookie kept, no login. In the app only.' },
  { key: 'agentJobs', label: 'A read-only agent task as a job (C5)', help: 'Jobs gains a kind: a read-only task in a folder on a schedule — no edit, no command, no question — whose report lands in the digest conversation.' },
  { key: 'inbox', label: 'Files into an agent chat (C6)', help: 'Dropping files on an agent chat copies them into the folder’s .sigma/inbox/ and tells the model where they are.' },
  { key: 'commands', label: 'Slash commands (C7)', help: '.sigma/commands/<name>.md in the folder becomes /name in the composer and in sigma; $ARGUMENTS is what follows the name.' },
  { key: 'mcpTools', label: 'MCP tools for the agent (C8)', help: 'MCP servers that are on join the agent’s tools under the server’s own approval mode, marked untrusted as the chat marks them.' },
  { key: 'toolsByPhase', label: 'Tools by phase (4.1, A5)', help: 'A shorter tool list for a small model: the edit tools join once something has been read, and document, chore and MCP tools once the task mentions them or the agent uses one. The list only grows, so the server’s prompt cache is rebuilt a few times a task at most.' },
  { key: 'planRound', label: 'A plan round, evidence per step (4.2, A4)', help: 'Before the first call, one structured request for the steps; three or more become the checklist. A step is ticked only after a tool result shows it done, earlier steps’ output is set aside first, and after a failed check (or a stuck warning) the plan is revised once.' }
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
        <Row meta={ROWS.roundMaxTokens}>
          <Segmented value={String(agent.roundMaxTokens ?? 16_384)} onChange={(v) => set(ROWS.roundMaxTokens, { roundMaxTokens: Number(v) }, ROUND_CAPS.find((c) => c.value === v)?.label)} options={ROUND_CAPS} label={ROWS.roundMaxTokens.label} />
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

      <Section title="Experiments" description={ROWS.experiments.help} onReset={defaults ? () => set({ id: 'agent.experiments', label: 'Experiments' }, { experiments: defaults.agent.experiments }, 'all off') : undefined}>
        <Notice tone="warn">Unmeasured. `eval:agent`’s baseline has not run on a sound machine; each of these is judged against it before it is on by default.</Notice>
        {EXPERIMENTS.map((x) => (
          <Row key={x.key} meta={{ id: `agent.experiments.${x.key}`, label: x.label, help: x.help }}>
            <Switch checked={Boolean(agent.experiments?.[x.key])} onChange={(on) => set({ id: `agent.experiments.${x.key}`, label: x.label }, { experiments: { ...agent.experiments, [x.key]: on } })} />
          </Row>
        ))}
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
