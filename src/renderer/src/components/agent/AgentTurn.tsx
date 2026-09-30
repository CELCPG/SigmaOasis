import { memo, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { handleCodeBlockClick, renderMarkdown } from '../../lib/markdown'
import { describeStep, todoProgress } from '../../lib/agentTurn'
import { formatElapsed } from '../../lib/oasisRipple'
import { sendToAgent, stopAgent, undoAgentTurn } from '../../hooks/agentTasks'
import type { AgentTodo, ChatMessage, Conversation, ToolCallRecord } from '../../types'
import { DiffView, PatchBlock } from '../PatchBlock'
import { SigmaAvatar } from '../SigmaAvatar'
import { ToolCallBlock } from '../ToolCallBlock'

/**
 * An agent turn (v3.0), drawn as what it is: a piece of work in progress.
 *
 * The chat bubble puts all text above all tool calls, which reads right for a
 * reply and wrong for a task — an agent's narration, its reads, its edits and
 * its test runs only make sense in the order they happened. So the turn is a
 * timeline: each step one line saying what was done, in words, opening into
 * the full record (the diff, the command's output, a helper's own steps) on
 * request. Above it, what the reader most wants at a glance while it runs —
 * is it alive, what is it doing, how far along is the checklist. Below it,
 * the answer, what changed, and Undo.
 *
 * A proposed change waiting for review is never folded away: it opens in
 * place with Apply and Discard, because a task stops until someone answers.
 */

const STATUS: Record<NonNullable<ChatMessage['agent']>['status'], { mark: string; label: string; tone: string }> = {
  running: { mark: '●', label: 'Working', tone: 'text-accent-ink' },
  done: { mark: '✓', label: 'Done', tone: 'text-ink-ok' },
  paused: { mark: '⏸', label: 'Paused', tone: 'text-ink-warn' },
  stopped: { mark: '■', label: 'Stopped', tone: 'text-ink-secondary' },
  error: { mark: '⚠', label: 'Stopped on an error', tone: 'text-ink-danger' }
}

const PERMISSION_WORDS = { ask: 'asks before each change and command', acceptEdits: 'edits without asking, commands ask', readOnly: 'read-only' }

/** Seconds that tick while `running` — the proof of life on a long think. */
function useElapsed(since: number, until: number | undefined, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  return Math.max(0, (until ?? (running ? now : since)) - since)
}

export const AgentTurn = memo(function AgentTurn({ message, conversation }: { message: ChatMessage; conversation?: Conversation }): JSX.Element {
  const agent = message.agent!
  const running = agent.status === 'running'
  const elapsed = useElapsed(agent.startedAt, agent.endedAt, running)
  const records = message.toolCalls ?? []
  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records])
  // The array, not a Set built in the selector: a fresh Set per call would
  // re-render every turn on every store change, tokens included.
  const pendingPatches = useAppStore((s) => s.pendingPatches)
  const pendingIds = useMemo(() => new Set(pendingPatches.map((p) => p.callId)), [pendingPatches])
  const status = STATUS[agent.status]
  const progress = todoProgress(agent.todos)
  // The last text step is the answer once the turn has ended; while it runs,
  // every text step is narration on the way.
  const lastTextIndex = agent.steps.map((s) => s.kind).lastIndexOf('text')
  const finished = !running
  const lastStep = agent.steps[agent.steps.length - 1]
  const activeTool = lastStep?.kind === 'tool' ? byId.get(lastStep.callId) : undefined
  const thinking = running && (!lastStep || (lastStep.kind === 'tool' && activeTool?.status !== 'running'))

  return (
    <div className="px-4 py-2">
      <div className="mx-auto flex max-w-3xl items-start gap-3">
        <SigmaAvatar size={32} active={running} />
        <div className={`glass-panel reply-surface min-w-0 flex-1 rounded-3xl rounded-tl-md px-4 py-3 ${running ? 'bubble-live' : ''}`} data-testid="agent-turn">
          {/* Status bar: alive or not, doing what, for how long. */}
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className={`flex items-center gap-1.5 font-medium ${status.tone}`}>
              <span className={running ? 'animate-pulse' : ''} aria-hidden="true">
                {status.mark}
              </span>
              {status.label}
            </span>
            <span className="tabular-nums text-ink-tertiary">{formatElapsed(elapsed)}</span>
            {agent.round !== undefined && running && <span className="text-ink-tertiary">step {agent.round}</span>}
            {message.roleName && (
              <span className="text-ink-tertiary">
                {message.roleName} · <span className="font-mono">{message.modelId}</span>
              </span>
            )}
            {running && (
              <button
                type="button"
                onClick={() => conversation && stopAgent(conversation.id)}
                className="ml-auto rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-ink-danger hover:bg-red-500/20"
              >
                Stop
              </button>
            )}
          </div>

          {agent.todos && agent.todos.length > 0 && <Checklist todos={agent.todos} done={progress.done} />}

          <ol className="flex flex-col gap-1" aria-label="What the agent did" aria-live="polite" aria-relevant="additions">
            {agent.steps.map((step, i) => {
              if (step.kind === 'text') {
                const answer = finished && i === lastTextIndex
                return <TextStep key={`t${i}`} text={step.text} answer={answer} />
              }
              const record = byId.get(step.callId)
              if (!record) return null
              return <ToolStep key={step.callId} record={record} records={records} pending={pendingIds.has(record.id)} />
            })}
            {thinking && <ThinkingRow reasoning={message.reasoning} />}
          </ol>

          {finished && <Outcome message={message} conversation={conversation} elapsed={elapsed} />}
          {agent.elided ? (
            <p className="mt-1 text-[11px] text-ink-tertiary" title="Old tool output is removed from the model's context, oldest first, when the task outgrows the loaded window; the model is told how to fetch it again.">
              {agent.elided} earlier tool result{agent.elided === 1 ? ' was' : 's were'} set aside to fit the model’s window.
            </p>
          ) : null}
          <p className="mt-1 text-[11px] text-ink-tertiary">
            {agent.workspace ? <>📁 <span className="font-mono">{agent.workspace}</span> · </> : 'No folder · '}
            {PERMISSION_WORDS[agent.permission]}
          </p>
        </div>
      </div>
    </div>
  )
})

function Checklist({ todos, done }: { todos: AgentTodo[]; done: number }): JSX.Element {
  return (
    <div className="mb-2 rounded-xl border border-black/5 bg-black/[0.02] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]" data-testid="agent-checklist">
      <div className="mb-1 text-[11px] font-medium tracking-[0.06em] text-ink-secondary">
        CHECKLIST · {done}/{todos.length}
      </div>
      <ul className="flex flex-col gap-0.5 text-xs">
        {todos.map((t, i) => (
          <li key={i} className={`flex items-start gap-2 ${t.status === 'completed' ? 'text-ink-tertiary line-through' : t.status === 'in_progress' ? 'font-medium text-ink-primary' : 'text-ink-secondary'}`}>
            <span aria-hidden="true" className={t.status === 'in_progress' ? 'text-accent-ink' : ''}>
              {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}
            </span>
            <span className="sr-only">{t.status === 'completed' ? 'done:' : t.status === 'in_progress' ? 'in progress:' : 'to do:'}</span>
            {t.content}
          </li>
        ))}
      </ul>
    </div>
  )
}

function TextStep({ text, answer }: { text: string; answer: boolean }): JSX.Element | null {
  const html = useMemo(() => (text.trim() ? renderMarkdown(text) : ''), [text])
  if (!html) return null
  return (
    <li>
      <div
        className={`markdown-body ${answer ? 'mt-1 text-sm leading-relaxed' : 'text-[13px] text-ink-secondary'}`}
        onClick={handleCodeBlockClick}
        // Sanitized by DOMPurify in renderMarkdown.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </li>
  )
}

function ToolStep({ record, records, pending }: { record: ToolCallRecord; records: ToolCallRecord[]; pending: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const { icon, text } = describeStep(record)
  const isEdit = record.name === 'edit_file' || record.name === 'multi_edit' || record.name === 'write_file'
  const children = record.name === 'task' ? records.filter((r) => r.parentCallId === record.id) : []
  const mark = record.status === 'running' ? '…' : record.status === 'done' ? '' : '✗'
  // A change waiting for the reader is open, whatever the row's own state —
  // and whatever tool proposed it (v4.1: multi_edit; a document or a chore
  // waiting in Ask first had no Apply to press).
  if (pending) {
    return (
      <li className="my-1">
        <PatchBlock record={record} />
      </li>
    )
  }
  return (
    <li className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${record.status === 'error' ? 'text-ink-warn' : 'text-ink-secondary'}`}
      >
        <span aria-hidden="true" className="w-4 shrink-0 text-center">
          {icon}
        </span>
        <span className={`min-w-0 flex-1 truncate ${record.status === 'running' ? 'shimmer-text' : ''}`}>{text}</span>
        {mark && <span aria-hidden="true">{mark}</span>}
        <span aria-hidden="true" className="text-ink-tertiary">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {record.name === 'task' && children.length > 0 && (
        <ol className="ml-6 border-l border-black/10 pl-2 dark:border-white/10" aria-label="The helper's steps">
          {children.map((c) => {
            const d = describeStep(c)
            return (
              <li key={c.id} className="flex items-center gap-2 px-2 py-0.5 text-[11px] text-ink-tertiary">
                <span aria-hidden="true">{d.icon}</span>
                <span className="min-w-0 flex-1 truncate">{d.text}</span>
                {c.status === 'running' ? <span aria-hidden="true">…</span> : c.status === 'error' ? <span aria-hidden="true">✗</span> : null}
              </li>
            )
          })}
        </ol>
      )}
      {open && (
        <div className="mt-1 pl-6">
          {isEdit ? <EditDetail record={record} /> : <ToolCallBlock record={record} />}
        </div>
      )}
    </li>
  )
}

/** An edit's record: its one-line outcome and its diff. */
function EditDetail({ record }: { record: ToolCallRecord }): JSX.Element {
  const result = record.result ?? ''
  const at = result.indexOf('\n\n')
  const lead = at < 0 ? result : result.slice(0, at)
  const diff = at < 0 ? '' : result.slice(at + 2)
  return (
    <div className="rounded-xl border border-black/10 p-2 text-xs dark:border-white/10">
      <p className="mb-1 text-ink-secondary">{lead}</p>
      {diff ? <DiffView diff={diff} /> : null}
    </div>
  )
}

/**
 * The proof of life between steps. Measured: a 35B model spends one to three
 * minutes thinking before each call of an ordinary fix, and a bare spinner for
 * that long reads as a hang. The newest line of its reasoning, moving, does
 * not — and the status bar's clock says how long.
 */
function ThinkingRow({ reasoning }: { reasoning?: string }): JSX.Element {
  const tail = (reasoning ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
  return (
    <li className="flex items-center gap-2 px-2 py-1 text-xs text-ink-tertiary" role="status" data-testid="agent-thinking">
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent shadow-[0_0_8px_rgba(0,212,170,0.8)]" />
      <span className="shimmer-text shrink-0">Thinking</span>
      {tail && <span className="min-w-0 flex-1 truncate italic">{tail.slice(-160)}</span>}
    </li>
  )
}

function Outcome({ message, conversation, elapsed }: { message: ChatMessage; conversation?: Conversation; elapsed: number }): JSX.Element {
  const agent = message.agent!
  const [undoing, setUndoing] = useState(false)
  const changed = agent.changedFiles ?? []
  const canUndo = changed.length > 0 && !agent.undo && agent.workspace
  return (
    <div className="mt-3 border-t border-black/5 pt-2 text-xs dark:border-white/10">
      {agent.detail && <p className={`mb-1 ${agent.status === 'error' ? 'text-ink-danger' : 'text-ink-warn'}`}>{agent.detail}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-secondary">
        <span>
          {STATUS[agent.status].label} in {formatElapsed(elapsed)}
          {agent.completionTokens ? ` · ${agent.completionTokens.toLocaleString()} tokens written` : ''}
        </span>
        {changed.length > 0 && (
          <span title={changed.join('\n')}>
            {changed.length} file{changed.length === 1 ? '' : 's'} changed: <span className="font-mono">{changed.slice(0, 3).join(', ')}</span>
            {changed.length > 3 ? ` +${changed.length - 3}` : ''}
          </span>
        )}
        {agent.status === 'paused' && conversation && !agent.question && (
          <button
            type="button"
            onClick={() => void sendToAgent(conversation.id, 'continue')}
            className="rounded-lg border border-[rgba(0,212,170,0.4)] bg-[rgba(0,212,170,0.12)] px-2 py-0.5 text-accent-ink hover:bg-[rgba(0,212,170,0.2)]"
          >
            Continue
          </button>
        )}
        {agent.status === 'paused' && conversation && agent.question && agent.question.choices.length > 0 && (
          <span className="flex flex-wrap items-center gap-1" role="group" aria-label="Answer the agent">
            {agent.question.choices.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => void sendToAgent(conversation.id, choice)}
                className="rounded-lg border border-[rgba(0,212,170,0.4)] bg-[rgba(0,212,170,0.12)] px-2 py-0.5 text-accent-ink hover:bg-[rgba(0,212,170,0.2)]"
              >
                {choice}
              </button>
            ))}
          </span>
        )}
        {canUndo && conversation && (
          <button
            type="button"
            disabled={undoing}
            onClick={() => {
              setUndoing(true)
              void undoAgentTurn(conversation.id, message.id).finally(() => setUndoing(false))
            }}
            className="ml-auto rounded-lg border border-black/10 px-2 py-0.5 hover:bg-black/5 disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/10"
            title="Put every file this turn changed back the way it found it. A file someone has changed since is left alone and named."
          >
            ↶ Undo changes
          </button>
        )}
      </div>
      {agent.undo && (
        <p className="mt-1 text-ink-secondary" data-testid="agent-undo">
          ↶ Undone: {agent.undo.restored.length > 0 ? `restored ${agent.undo.restored.join(', ')}` : 'nothing restored'}.
          {agent.undo.skipped.map((s) => (
            <span key={s.path} className="text-ink-warn">
              {' '}
              Left {s.path} — {s.reason}.
            </span>
          ))}
        </p>
      )}
    </div>
  )
}
