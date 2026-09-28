import { useAppStore } from '../stores/appStore'
import { applyAgentEvent, historyFromConversation, newAgentTurn } from '../lib/agentTurn'
import type { AgentWirePayload } from '../../../main/ipc/agent'
import type { AgentChatConfig, AgentPermission, ChatMessage, Conversation, ModelConfig } from '../types'
import { wireSampling } from './chatTransport'
import { audit, uid } from './turnHelpers'

/**
 * Agent chats in the window (v3.0): start a task, steer it, stop it, undo it,
 * and fold what the main process reports into the conversation.
 *
 * A message in an agent chat goes here instead of to a chat turn (the branch
 * is at the top of useLMStudio's sendMessage). The task runs in the main
 * process (main/ipc/agent.ts), so none of this holds it alive: switching
 * chats, starting a chat turn elsewhere, or a second task in another agent
 * chat all leave it running. One task per conversation at a time.
 */

/** Which slot an agent chat runs on: its own choice, else a coding slot, else the chat's, else the first enabled. */
export function agentSlot(convo: Conversation, models: ModelConfig[]): ModelConfig | undefined {
  const enabled = models.filter((m) => m.enabled && m.modelId)
  return (
    enabled.find((m) => m.id === convo.agent?.slotId) ??
    enabled.find((m) => m.specialty === 'coding') ??
    enabled.find((m) => m.id === convo.activeModelSlotId) ??
    enabled[0]
  )
}

function save(conversationId: string): void {
  const convo = useAppStore.getState().conversations.find((c) => c.id === conversationId)
  if (convo) void window.api.saveConversation(convo)
}

/** Send `text` to the agent in `conversationId`: a new turn, or a steer if one is running. */
export async function sendToAgent(conversationId: string, text: string): Promise<void> {
  const store = useAppStore.getState()
  const convo = store.conversations.find((c) => c.id === conversationId)
  const settings = store.settings
  if (!convo?.agent || !settings || !text.trim()) return

  const run = store.agentRuns[conversationId]
  if (run) {
    // Typed while the task works: it goes into the conversation now, marked
    // queued, and reaches the model at the task's next round (v2.7's steer).
    const steer: ChatMessage = { id: uid(), role: 'user', content: text, delivery: { state: 'queued' }, createdAt: Date.now() }
    store.insertMessageBefore(conversationId, run.messageId, steer)
    const accepted = await window.api.agentSteer(run.taskId, { id: steer.id, text })
    if (!accepted) store.patchMessage(conversationId, steer.id, { delivery: undefined })
    return
  }

  const slot = agentSlot(convo, settings.models)
  const title = text.length > 48 ? `${text.slice(0, 48)}…` : text
  // The chat was named after its folder when it was opened; its first task
  // is the better name, and the folder is on the chat's header anyway.
  if (convo.messages.length === 0) store.upsertConversation({ ...convo, title: `⚡ ${title}` })
  store.appendMessage(conversationId, { id: uid(), role: 'user', content: text, createdAt: Date.now() })
  audit(convo, { kind: 'user_input', text })
  if (!slot) {
    store.appendMessage(conversationId, {
      id: uid(),
      role: 'assistant',
      content: '⚠️ No model to run the agent on. Enable a slot and pick a model under Settings → Models.',
      createdAt: Date.now()
    })
    save(conversationId)
    return
  }

  const taskId = uid()
  const message: ChatMessage = {
    id: uid(),
    role: 'assistant',
    content: '',
    modelId: slot.modelId,
    roleName: slot.roleName,
    color: slot.color,
    toolCalls: [],
    agent: newAgentTurn(taskId, convo.agent.workspace, convo.agent.permission),
    createdAt: Date.now()
  }
  const history = historyFromConversation(useAppStore.getState().conversations.find((c) => c.id === conversationId)!)
  // The user's message is the last entry; the task is given it as its prompt.
  history.pop()
  store.appendMessage(conversationId, message)
  store.setAgentRun(conversationId, { taskId, messageId: message.id, title: convo.title, startedAt: Date.now() })
  save(conversationId)

  const started = await window.api.agentRun({
    taskId,
    conversationId,
    messageId: message.id,
    title: useAppStore.getState().conversations.find((c) => c.id === conversationId)?.title ?? title,
    prompt: text,
    workspace: convo.agent.workspace,
    permission: convo.agent.permission,
    model: slot.modelId,
    sampling: wireSampling(slot.sampling, slot.modelId),
    rules: slot.rules,
    history
  })
  if (!started.ok) {
    store.setAgentRun(conversationId, null)
    store.patchMessage(conversationId, message.id, {
      content: `⚠️ ${started.error ?? 'The task could not start.'}`,
      agent: { ...message.agent!, status: 'error', detail: started.error, endedAt: Date.now() }
    })
    save(conversationId)
  }
}

export function stopAgent(conversationId: string): void {
  const run = useAppStore.getState().agentRuns[conversationId]
  if (run) void window.api.agentStop(run.taskId)
}

/** Fold one reported event into its message; save when the task has ended. */
export function handleAgentEvent(payload: AgentWirePayload): void {
  const store = useAppStore.getState()
  const { event } = payload
  // The task is over whatever became of its chat: a chat deleted mid-task
  // must not leave its task on the rail's Working now card for good.
  if (event.type === 'final' && store.agentRuns[payload.conversationId]?.taskId === payload.taskId) {
    store.setAgentRun(payload.conversationId, null)
  }
  const convo = store.conversations.find((c) => c.id === payload.conversationId)
  const message = convo?.messages.find((m) => m.id === payload.messageId)
  if (!convo || !message) return
  if (event.type === 'steer_delivered') {
    store.patchMessage(convo.id, event.id, { delivery: { state: 'delivered', round: event.round } })
    audit(convo, { kind: 'user_steer', text: `[agent, before round ${event.round + 1}] ${convo.messages.find((m) => m.id === event.id)?.content ?? ''}` })
    return
  }
  if (event.type === 'tool_end') {
    const r = event.record
    audit(convo, {
      kind: 'tool_call',
      roleName: message.roleName,
      modelId: message.modelId,
      toolName: r.name,
      ok: r.status === 'done',
      text: `[agent] ${r.name}(${JSON.stringify(r.args)})\n→ ${r.result ?? ''}`
    })
  }
  const patch = applyAgentEvent(message, event)
  if (patch) store.patchMessage(convo.id, message.id, patch)
  if (event.type === 'final') {
    // A steer the task ended before delivering stays in the conversation as
    // the user's next message; say so rather than leave it "queued".
    for (const m of useAppStore.getState().conversations.find((c) => c.id === convo.id)?.messages ?? []) {
      if (m.delivery?.state === 'queued') store.patchMessage(convo.id, m.id, { delivery: { state: 'delivered' } })
    }
    if (event.finalText) audit(convo, { kind: 'assistant_output', roleName: message.roleName, modelId: message.modelId, text: event.finalText })
    save(convo.id)
  }
}

/** Undo a turn's file changes; the outcome is written onto the turn. */
export async function undoAgentTurn(conversationId: string, messageId: string): Promise<void> {
  const r = await window.api.agentUndo(conversationId, messageId)
  const store = useAppStore.getState()
  const message = store.conversations.find((c) => c.id === conversationId)?.messages.find((m) => m.id === messageId)
  if (!message?.agent) return
  store.patchMessage(conversationId, messageId, {
    agent: r.ok ? { ...message.agent, undo: { restored: r.restored, skipped: r.skipped } } : { ...message.agent, undo: { restored: [], skipped: [{ path: '—', reason: r.error ?? 'Undo failed.' }] } }
  })
  save(conversationId)
}

/**
 * Line the window up with the tasks the main process is running, after the
 * conversations load.
 *
 * A window that reloads while a task runs (the main process keeps it going)
 * relearns it here, so Stop and the tasks list work again. And after a
 * restart, a turn saved mid-task still says "running" while nothing is: the
 * task died with the process that ran it. It is marked stopped, with the
 * reason, so the chat does not show a spinner for a task that no longer exists.
 */
export async function syncAgentRuns(): Promise<void> {
  const tasks = await window.api.agentList().catch(() => [])
  const live = new Set(tasks.map((t) => t.messageId))
  const store = useAppStore.getState()
  for (const t of tasks) store.setAgentRun(t.conversationId, { taskId: t.taskId, messageId: t.messageId, title: t.title, startedAt: t.startedAt })
  for (const convo of store.conversations) {
    let touched = false
    for (const m of convo.messages) {
      if (m.agent?.status === 'running' && !live.has(m.id)) {
        store.patchMessage(convo.id, m.id, {
          agent: { ...m.agent, status: 'stopped', detail: 'The app closed while this task was running.', endedAt: m.agent.endedAt ?? Date.now() }
        })
        touched = true
      }
    }
    if (touched) save(convo.id)
  }
}

/** A new agent chat in `workspace` (null: no files), made active. */
export function createAgentConversation(workspace: string | null, permission?: AgentPermission): Conversation | null {
  const store = useAppStore.getState()
  const settings = store.settings
  if (!settings) return null
  const agent: AgentChatConfig = { workspace, permission: permission ?? settings.agent.defaultPermission }
  const folderName = workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : null
  const convo: Conversation = {
    id: uid(),
    title: folderName ? `⚡ ${folderName}` : '⚡ Agent task',
    mode: 'independent',
    activeModelSlotId: settings.models.find((m) => m.enabled)?.id,
    messages: [],
    agent,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  store.upsertConversation(convo)
  store.setActiveConversationId(convo.id)
  void window.api.saveConversation(convo)
  return convo
}

/** Ask for a folder, then open a new agent chat in it. Cancelling the picker opens nothing. */
export async function pickWorkspaceAndStart(): Promise<void> {
  const dir = await window.api.pickDirectory()
  if (dir) createAgentConversation(dir)
}

/** Change what an agent chat works on or how freely; takes effect on its next turn. */
export function updateAgentConfig(conversationId: string, patch: Partial<AgentChatConfig>): void {
  const store = useAppStore.getState()
  const convo = store.conversations.find((c) => c.id === conversationId)
  if (!convo?.agent) return
  const next: Conversation = { ...convo, agent: { ...convo.agent, ...patch }, updatedAt: Date.now() }
  store.upsertConversation(next)
  void window.api.saveConversation(next)
}
