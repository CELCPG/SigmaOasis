import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { runAgentTask } from '../agent/engine'
import { restoreCheckpoints } from '../agent/checkpoints'
import { defaultShell } from '../agent/command'
import type { AgentEvent, AgentTaskResult, Checkpoint, ChunkTransport, ExtraTools, PermissionMode, ToolSchema } from '../agent/types'
import { PERMISSION_MODES } from '../agent/types'
import type { ApiMessage } from '../../renderer/src/lib/agentLoop'
import { TOOL_SCHEMAS } from '../../shared/tools'
import { AGENT_APP_TOOLS } from '../../shared/agentAppTools'
import { writeFileAtomic } from './fsAtomic'
import { hostWindow } from './hostWindow'
import { fetchModelCatalog } from './modelCatalog'
import { pinChatModel } from './modelPin'
import { auditedFetch } from './net'
import { requestPatchReview } from './patchReview'
import { getSettings } from './store'
import { approve } from './toolHandlers/files'
import { executeTool } from './toolHandlers/registry'

/**
 * Agent tasks in the app (v3.0).
 *
 * A task runs here, in the main process, not in the window: switch chats,
 * start another task, keep talking to the model in a third chat, and it
 * carries on. The renderer is told what happens as it happens (`agent:event`)
 * and draws it; it is never the thing keeping the task alive.
 *
 * Everything a task touches goes through the regime the rest of the app keeps:
 * requests to LM Studio through the audited transport (allowlist, activity
 * log), edits through the same diff review the chat's propose_patch uses,
 * commands through the same confirmation — with the same "Always allow"
 * grants, bound to the exact command and folder — and the app's own tools
 * only as enabled under Settings → Tools. A task can be undone: every file is
 * checkpointed before its first change, on disk under the app's data folder,
 * and Undo restores what the task found — except where someone has changed a
 * file since, which it leaves alone and says so.
 */

export { AGENT_APP_TOOLS } from '../../shared/agentAppTools'

export interface AgentRunRequest {
  taskId: string
  conversationId: string
  messageId: string
  title: string
  prompt: string
  workspace: string | null
  permission: PermissionMode
  model: string
  sampling?: Record<string, unknown>
  rules?: string
  /** Rebuilt from the visible conversation, for when this process has no history of its own. */
  history?: ApiMessage[]
}

/** What the renderer is sent: an engine event, or the task's closing account. */
export type AgentWireEvent =
  | AgentEvent
  | {
      type: 'final'
      status: AgentTaskResult['status']
      finalText: string
      changedFiles: string[]
      detail?: string
    }

export interface AgentWirePayload {
  taskId: string
  conversationId: string
  messageId: string
  event: AgentWireEvent
}

interface RunningTask {
  taskId: string
  conversationId: string
  messageId: string
  title: string
  controller: AbortController
  steers: { id: string; text: string }[]
  startedAt: number
  /** The window that started it; its tasks stop when it closes. */
  senderId: number
}

const running = new Map<string, RunningTask>()
/** The wire history per conversation, so a task's next turn continues where it left off. */
const histories = new Map<string, ApiMessage[]>()

function checkpointDir(conversationId: string): string {
  return join(app.getPath('userData'), 'agent-checkpoints', conversationId.replace(/[^\w.-]/g, '_'))
}

async function saveCheckpoints(conversationId: string, messageId: string, workspace: string, checkpoints: Checkpoint[]): Promise<void> {
  if (checkpoints.length === 0) return
  const dir = checkpointDir(conversationId)
  await fs.mkdir(dir, { recursive: true })
  await writeFileAtomic(join(dir, `${messageId.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify({ workspace, checkpoints }))
}

/** Remove a conversation's checkpoints — called when the conversation is deleted. */
export async function forgetAgentConversation(conversationId: string): Promise<void> {
  histories.delete(conversationId)
  await fs.rm(checkpointDir(conversationId), { recursive: true, force: true }).catch(() => {})
}

/** The app's transport: LM Studio through the audited path, bytes to the engine as they arrive. */
const auditedTransport: ChunkTransport = async (url, init) => {
  const res = await auditedFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: init.body,
      signal: init.signal,
      // A whole round, thinking included, on a slow machine; the stall
      // timeout below is what catches a dead stream.
      timeoutMs: 30 * 60_000,
      stallTimeoutMs: init.stallMs,
      onChunk: init.onChunk
    },
    'lmstudio'
  )
  if (!res.ok) return { ok: false, status: res.status, errorText: await res.text().catch(() => '') }
  return { ok: true, status: res.status }
}

function appTools(sender: Electron.WebContents, conversationId: string, model: string): ExtraTools | undefined {
  const settings = getSettings()
  if (!settings.agent.appTools) return undefined
  const names = new Set<string>(AGENT_APP_TOOLS.filter((n) => settings.tools[n as keyof typeof settings.tools]))
  const schemas: ToolSchema[] = TOOL_SCHEMAS.filter((s) => names.has(s.function.name))
  if (schemas.length === 0) return undefined
  return {
    schemas,
    execute: (name, args) =>
      // The global switch is read again at the moment of the call, as the chat's
      // tools:execute does: turning a tool off under Settings takes effect on
      // a task that is already running.
      getSettings().tools[name as keyof ReturnType<typeof getSettings>['tools']]
        ? executeTool(name, args, { sender, modelId: model, conversationId })
        : Promise.resolve({ ok: false, error: `${name} was turned off under Settings → Tools.` })
  }
}

/** Coalesce streamed text so the window gets a frame's worth at a time, not one IPC message per token. */
function batcher(send: (event: AgentWireEvent) => void): { push: (e: AgentWireEvent) => void; flush: () => void } {
  let text = ''
  let reasoning = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (reasoning) send({ type: 'reasoning', delta: reasoning })
    if (text) send({ type: 'text', delta: text })
    text = ''
    reasoning = ''
  }
  return {
    push(e) {
      if (e.type === 'text' || e.type === 'reasoning') {
        if (e.type === 'text') text += e.delta
        else reasoning += e.delta
        if (!timer) timer = setTimeout(flush, 50)
        return
      }
      flush()
      send(e)
    },
    flush
  }
}

function notifyFinished(sender: Electron.WebContents, task: RunningTask, status: string): void {
  if (!getSettings().agent.notify || !Notification.isSupported()) return
  const win = hostWindow(sender)
  if (win?.isFocused()) return
  const words: Record<string, string> = {
    done: 'finished',
    paused: 'paused — it needs you to continue',
    error: 'stopped with an error',
    stopped: 'was stopped'
  }
  const n = new Notification({ title: 'Sigma Oasis', body: `Agent task ${words[status] ?? status}: ${task.title}`, silent: false })
  n.on('click', () => {
    win?.show()
    win?.focus()
    if (!sender.isDestroyed()) sender.send('agent:focus', task.conversationId)
  })
  n.show()
}

async function startTask(sender: Electron.WebContents, req: AgentRunRequest): Promise<void> {
  const settings = getSettings()
  const controller = new AbortController()
  const task: RunningTask = {
    taskId: req.taskId,
    conversationId: req.conversationId,
    messageId: req.messageId,
    title: req.title,
    controller,
    steers: [],
    startedAt: Date.now(),
    senderId: sender.id
  }
  running.set(req.taskId, task)
  const send = (event: AgentWireEvent): void => {
    if (!sender.isDestroyed()) sender.send('agent:event', { taskId: req.taskId, conversationId: req.conversationId, messageId: req.messageId, event } satisfies AgentWirePayload)
  }
  const out = batcher(send)

  let result: AgentTaskResult
  try {
    // Pin first, as the chat does, so an embedding call elsewhere does not
    // evict the model mid-task; then read the window it was loaded with.
    await pinChatModel(req.model).catch(() => undefined)
    const catalog = await fetchModelCatalog().catch(() => null)
    const entry = catalog?.models.find((m) => m.id === req.model)
    result = await runAgentTask(
      {
        baseUrl: settings.baseUrl,
        model: req.model,
        workspace: req.workspace,
        permission: req.permission,
        prompt: req.prompt,
        history: histories.get(req.conversationId) ?? req.history,
        sampling: req.sampling,
        rules: req.rules,
        contextTokens: entry?.loadedContextLength ?? entry?.maxContextLength ?? undefined,
        maxRounds: settings.agent.maxRounds,
        commandTimeoutSec: settings.agent.commandTimeoutSec,
        signal: controller.signal,
        takeSteers: () => task.steers.splice(0)
      },
      {
        transport: auditedTransport,
        shell: defaultShell(),
        emit: (e) => out.push(e),
        reviewEdit: (r) => requestPatchReview(sender, { callId: r.callId, path: r.path, isNew: r.isNew, diff: r.diff, stats: r.stats }),
        approveCommand: ({ command, cwd, warning }) =>
          approve(sender, { tool: 'agent_command', args: { command }, cwd }, command, {
            type: warning ? 'error' : 'warning',
            title: warning ? 'DANGEROUS command — confirm' : 'Confirm agent command',
            message: warning ?? 'The agent wants to run this command:',
            detail:
              `${command}\n\nIn: ${cwd}\n\n` +
              '"Always allow" lets this exact command run in this folder without asking, until you revoke it under Settings → Tools.'
          }),
        extraTools: appTools(sender, req.conversationId, req.model)
      }
    )
  } catch (err) {
    // runAgentTask does not throw; this is the pin or the catalog, or a bug.
    result = {
      status: 'error',
      finalText: '',
      history: [],
      todos: [],
      changedFiles: [],
      checkpoints: [],
      detail: err instanceof Error ? err.message : String(err)
    }
  }
  out.flush()
  running.delete(req.taskId)
  if (result.history.length > 0) histories.set(req.conversationId, result.history)
  if (req.workspace) await saveCheckpoints(req.conversationId, req.messageId, req.workspace, result.checkpoints).catch(() => undefined)
  send({ type: 'final', status: result.status, finalText: result.finalText, changedFiles: result.changedFiles, ...(result.detail ? { detail: result.detail } : {}) })
  notifyFinished(sender, task, result.status)
}

/**
 * Undo a turn from the checkpoints saved when it ended. The rule — every file
 * back as the turn found it, except one changed since, which is named and left
 * alone — is restoreCheckpoints (../agent/checkpoints.ts), shared with the CLI.
 */
export async function undoTurn(
  conversationId: string,
  messageId: string
): Promise<{ ok: boolean; restored: string[]; skipped: { path: string; reason: string }[]; error?: string }> {
  const file = join(checkpointDir(conversationId), `${messageId.replace(/[^\w.-]/g, '_')}.json`)
  let saved: { workspace: string; checkpoints: Checkpoint[] }
  try {
    saved = JSON.parse(await fs.readFile(file, 'utf8')) as { workspace: string; checkpoints: Checkpoint[] }
  } catch {
    return { ok: false, restored: [], skipped: [], error: 'There is no record of the files this task changed (it may have been undone already).' }
  }
  const { restored, skipped } = await restoreCheckpoints(saved.workspace, saved.checkpoints)
  await fs.rm(file, { force: true })
  // The model's own memory of the task would now describe files that no
  // longer read that way; the next turn starts from the visible conversation.
  histories.delete(conversationId)
  return { ok: true, restored, skipped }
}

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:run', (e, raw: unknown) => {
    const r = raw as Partial<AgentRunRequest>
    if (!r || typeof r.taskId !== 'string' || typeof r.conversationId !== 'string' || typeof r.messageId !== 'string' || typeof r.prompt !== 'string' || typeof r.model !== 'string') {
      return { ok: false, error: 'Malformed agent request.' }
    }
    if ([...running.values()].some((t) => t.conversationId === r.conversationId)) {
      return { ok: false, error: 'A task is already running in this conversation.' }
    }
    const permission = PERMISSION_MODES.includes(r.permission as PermissionMode) ? (r.permission as PermissionMode) : 'ask'
    const req: AgentRunRequest = {
      taskId: r.taskId,
      conversationId: r.conversationId,
      messageId: r.messageId,
      title: String(r.title ?? 'Agent task').slice(0, 120),
      prompt: r.prompt,
      workspace: typeof r.workspace === 'string' && r.workspace.trim() ? r.workspace : null,
      permission,
      model: r.model,
      sampling: r.sampling && typeof r.sampling === 'object' ? r.sampling : undefined,
      rules: typeof r.rules === 'string' ? r.rules : undefined,
      history: Array.isArray(r.history) ? r.history : undefined
    }
    void startTask(e.sender, req)
    return { ok: true }
  })

  ipcMain.handle('agent:stop', (_e, taskId: unknown) => {
    running.get(String(taskId ?? ''))?.controller.abort()
    return true
  })

  ipcMain.handle('agent:steer', (_e, taskId: unknown, steer: unknown) => {
    const task = running.get(String(taskId ?? ''))
    const s = steer as { id?: unknown; text?: unknown }
    if (!task || typeof s?.id !== 'string' || typeof s?.text !== 'string' || !s.text.trim()) return false
    task.steers.push({ id: s.id, text: s.text })
    return true
  })

  ipcMain.handle('agent:list', () =>
    [...running.values()].map((t) => ({ taskId: t.taskId, conversationId: t.conversationId, messageId: t.messageId, title: t.title, startedAt: t.startedAt }))
  )

  ipcMain.handle('agent:undo', (_e, conversationId: unknown, messageId: unknown) =>
    undoTurn(String(conversationId ?? ''), String(messageId ?? ''))
  )

  ipcMain.handle('agent:forget', (_e, conversationId: unknown) => forgetAgentConversation(String(conversationId ?? '')))

  // Nothing is left running behind a closed window: the tasks it started stop
  // with it. Only those — the Workbench and page-render windows come and go on
  // their own, and must not take an agent's task down with them.
  app.on('browser-window-created', (_e, win: BrowserWindow) => {
    const id = win.webContents.id
    win.on('closed', () => {
      for (const t of running.values()) if (t.senderId === id) t.controller.abort()
    })
  })
}
