import type { AgentWireEvent } from '../../../main/ipc/agent'
import type { ApiMessage } from './agentLoop'
import type { AgentTodo, AgentTurnState, ChatMessage, Conversation, ToolCallRecord } from '../types'

/**
 * The window's half of an agent turn (v3.0) — pure, so node:test reaches it
 * (test/agentTurn.test.ts).
 *
 * The task runs in the main process and reports events; this folds each one
 * into the message on screen. The message keeps the chat's own shapes — tool
 * records in `toolCalls`, chain-of-thought in `reasoning`, the answer in
 * `content` — so export, copy, read-aloud and the audit of what was said all
 * work on an agent turn unchanged. What is new is `agent.steps`: the order
 * things happened in, which is the whole point of watching an agent work.
 */

/** How much of a turn's chain-of-thought the message keeps. */
export const REASONING_KEEP_CHARS = 40_000

/** Fold one event into the message. Returns the patch, or null when nothing changed. */
export function applyAgentEvent(message: ChatMessage, event: AgentWireEvent): Partial<ChatMessage> | null {
  const agent = message.agent
  if (!agent) return null
  const steps = agent.steps
  switch (event.type) {
    case 'text': {
      if (!event.delta) return null
      const last = steps[steps.length - 1]
      const next =
        last && last.kind === 'text'
          ? [...steps.slice(0, -1), { kind: 'text' as const, text: last.text + event.delta }]
          : [...steps, { kind: 'text' as const, text: event.delta }]
      return { agent: { ...agent, steps: next } }
    }
    case 'reasoning': {
      if (!event.delta) return null
      // A forty-round task can think for megabytes, and the message is saved
      // whole; it keeps the newest stretch, which is what the timeline shows.
      const joined = (message.reasoning ?? '') + event.delta
      return { reasoning: joined.length > REASONING_KEEP_CHARS ? joined.slice(-REASONING_KEEP_CHARS) : joined }
    }
    case 'tool_start': {
      const records = [...(message.toolCalls ?? []).filter((r) => r.id !== event.record.id), event.record]
      // A helper's calls render inside the helper's block, not as steps of their own.
      const nextSteps = event.record.parentCallId ? steps : [...steps, { kind: 'tool' as const, callId: event.record.id }]
      return { toolCalls: records, agent: { ...agent, steps: nextSteps } }
    }
    case 'tool_end': {
      const records = (message.toolCalls ?? []).map((r) => (r.id === event.record.id ? event.record : r))
      if (!records.some((r) => r.id === event.record.id)) records.push(event.record)
      return { toolCalls: records }
    }
    case 'todos':
      return { agent: { ...agent, todos: event.todos } }
    case 'round':
      return { agent: { ...agent, round: event.round } }
    case 'usage':
      return { agent: { ...agent, completionTokens: event.completionTokens } }
    case 'files_changed':
      return { agent: { ...agent, changedFiles: event.paths } }
    case 'context_elided':
      return { agent: { ...agent, elided: (agent.elided ?? 0) + event.toolResults } }
    case 'question':
      return { agent: { ...agent, question: { question: event.question, choices: event.choices } } }
    case 'status':
      // 'running' is the start; the ending arrives with 'final', which also
      // carries the answer, so the bubble never shows "done" with no text.
      return event.status === 'running' ? { agent: { ...agent, status: 'running' } } : null
    case 'final':
      return {
        content: event.finalText,
        agent: {
          ...agent,
          status: event.status,
          ...(event.detail ? { detail: event.detail } : {}),
          changedFiles: event.changedFiles,
          endedAt: Date.now()
        }
      }
    case 'steer_delivered':
      return null
  }
}

/** The fresh state an agent turn starts with. */
export function newAgentTurn(taskId: string, workspace: string | null, permission: AgentTurnState['permission']): AgentTurnState {
  return { taskId, status: 'running', steps: [], startedAt: Date.now(), workspace, permission }
}

/**
 * The conversation as a wire history, for a task whose earlier turns the main
 * process no longer holds (the app restarted). Text only — what was said, not
 * the tool calls — which is also what a chat turn replays; the files on disk
 * are the record of what an earlier turn did.
 */
export function historyFromConversation(convo: Conversation, before?: string): ApiMessage[] {
  const out: ApiMessage[] = []
  for (const m of convo.messages) {
    if (m.id === before) break
    if (m.marker) continue
    if (m.role === 'user' && m.content.trim()) out.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant' && m.content.trim()) out.push({ role: 'assistant', content: m.content })
  }
  return out
}

/** The turn is still working — its task has not reported an ending. */
export function isRunning(message: ChatMessage | undefined): boolean {
  return message?.agent?.status === 'running'
}

export function todoProgress(todos: AgentTodo[] | undefined): { done: number; total: number; current: string | null } {
  const list = todos ?? []
  return {
    done: list.filter((t) => t.status === 'completed').length,
    total: list.length,
    current: list.find((t) => t.status === 'in_progress')?.content ?? null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The first line of a tool's display result, for a one-line summary. */
function lead(record: ToolCallRecord): string {
  return (record.result ?? '').split('\n')[0] ?? ''
}

/**
 * One line for a step in the timeline — what the agent did, in words, with
 * the verb in the tense the record is in. The full arguments and output stay
 * one click away in the block itself.
 */
export function describeStep(record: ToolCallRecord): { icon: string; text: string } {
  const a = record.args
  const running = record.status === 'running'
  const failed = record.status === 'error'
  switch (record.name) {
    case 'read_file': {
      const range = typeof a.offset === 'number' ? ` (from line ${a.offset})` : ''
      return { icon: '📄', text: `${running ? 'Reading' : 'Read'} ${str(a.path)}${range}` }
    }
    case 'list_directory':
      return { icon: '📁', text: `${running ? 'Listing' : 'Listed'} ${str(a.path) || 'the workspace'}` }
    case 'glob':
      return { icon: '🔎', text: `${running ? 'Finding' : 'Found'} files matching ${str(a.pattern)}${!running && !failed ? ` — ${countLines(record)}` : ''}` }
    case 'grep':
      return { icon: '🔎', text: `${running ? 'Searching' : 'Searched'} for /${str(a.pattern)}/${a.path ? ` in ${str(a.path)}` : ''}` }
    case 'edit_file':
    case 'write_file': {
      const verb = record.name === 'edit_file' ? (running ? 'Editing' : 'Edited') : running ? 'Writing' : 'Wrote'
      const stats = /: ([^.]*(?:\d+ hunks?|new file[^.]*))\./.exec(lead(record))?.[1]
      return {
        icon: '✏️',
        text: failed ? `${record.name === 'edit_file' ? 'Edit' : 'Write'} to ${str(a.path)} not applied` : `${verb} ${str(a.path)}${stats ? ` (${stats})` : ''}`
      }
    }
    case 'run_command': {
      const exit = /\((exit code -?\d+|stopped[^,)]*)/.exec(record.result ?? '')?.[1]
      return { icon: '▶', text: `${running ? 'Running' : 'Ran'} \`${str(a.command).slice(0, 90)}\`${exit ? ` — ${exit}` : ''}` }
    }
    case 'todo_write':
      return { icon: '☑', text: 'Updated the checklist' }
    case 'task':
      return { icon: '🤝', text: `${running ? 'Helper working' : 'Helper reported'}: ${str(a.subagent_type)} — ${str(a.description)}` }
    default:
      return { icon: '⚙️', text: `${running ? 'Using' : 'Used'} ${record.name}` }
  }
}

function countLines(record: ToolCallRecord): string {
  const lines = (record.result ?? '').split('\n').filter((l) => l && !l.startsWith('No files') && !/ files? match|stopped early/.test(l))
  return `${lines.length} file${lines.length === 1 ? '' : 's'}`
}
