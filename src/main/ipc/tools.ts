import { ipcMain } from 'electron'
import { getSettings } from './store'
import type { ToolToggles } from './store'
import { TOOL_SCHEMAS } from '../../shared/tools'
import { executeTool } from './toolHandlers/registry'
import { executeMcpTool, mcpManager } from './mcp'
import { isMcpWireName } from './mcp/naming'

/**
 * IPC surface for agentic tools. The implementations live in
 * ./toolHandlers/* — one module per domain, assembled into a dispatch table in
 * ./toolHandlers/registry.ts. This file only checks the user's toggles and
 * forwards.
 */
/**
 * v2.7 Code Mode: a program in the sandbox asked for a tool. The decision is
 * the renderer's — the turn that owns the program holds the slot allowlist,
 * the per-turn ledger and the audit — so the call is handed to the renderer
 * that asked for the run and its answer awaited by id. No renderer, no run.
 */
const innerCalls = new Map<string, (result: { ok: boolean; output?: string; error?: string }) => void>()
let innerCounter = 0
const INNER_CALL_TIMEOUT_MS = 180_000

export function requestInnerCall(
  sender: Electron.WebContents,
  name: string,
  args: Record<string, unknown>,
  parentCallId?: string
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (sender.isDestroyed()) return Promise.resolve({ ok: false, error: 'The turn that started this program is gone.' })
  const callId = `inner-${++innerCounter}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      innerCalls.delete(callId)
      resolve({ ok: false, error: `The app did not answer "${name}" within ${INNER_CALL_TIMEOUT_MS / 1000}s.` })
    }, INNER_CALL_TIMEOUT_MS)
    innerCalls.set(callId, (r) => {
      clearTimeout(timer)
      innerCalls.delete(callId)
      resolve(r)
    })
    sender.send('tools:innerCall', { callId, name, args, ...(parentCallId ? { parentCallId } : {}) })
  })
}

export function registerToolHandlers(): void {
  ipcMain.handle('tools:innerResult', (_e, callId: unknown, result: unknown) => {
    const done = innerCalls.get(String(callId ?? ''))
    if (!done) return
    const r = (result ?? {}) as { ok?: unknown; output?: unknown; error?: unknown }
    done({
      ok: r.ok === true,
      ...(r.ok === true ? { output: typeof r.output === 'string' ? r.output : '' } : { error: typeof r.error === 'string' ? r.error : 'failed' })
    })
  })

  // Only enabled tools are exposed to the models at all.
  ipcMain.handle('tools:list', () => {
    const toggles = getSettings().tools
    // v2.5: MCP tools enter here as a second source after the built-ins, in a
    // stable order (server id, then the server's own order), so the wire list
    // is the same across launches and the prompt cache holds.
    return [...TOOL_SCHEMAS.filter((t) => toggles[t.function.name as keyof ToolToggles]), ...mcpManager().schemas()]
  })

  ipcMain.handle(
    'tools:execute',
    async (
      event,
      name: keyof ToolToggles,
      args: Record<string, unknown>,
      context?: {
        modelId?: string
        attachments?: { name: string; sourcePath: string }[]
        conversationId?: string
        tainted?: boolean
        parentCallId?: string
      }
    ) => {
      // v2.5: an MCP tool leaves here too. Its server's enablement and its own
      // per-tool switch are the manager's to check; the static toggle table has
      // no key for it.
      if (isMcpWireName(String(name))) return executeMcpTool(String(name), args ?? {}, event.sender)
      if (!getSettings().tools[name]) {
        return { ok: false, error: `Tool "${String(name)}" is disabled in Settings → Tools.` }
      }
      return executeTool(name, args ?? {}, {
        sender: event.sender,
        modelId: context?.modelId,
        conversationId: typeof context?.conversationId === 'string' ? context.conversationId : undefined,
        tainted: context?.tainted === true,
        ...(typeof context?.parentCallId === 'string' ? { parentCallId: context.parentCallId } : {}),
        attachments: Array.isArray(context?.attachments)
          ? context!.attachments.filter((a) => a && typeof a.name === 'string' && typeof a.sourcePath === 'string')
          : []
      })
    }
  )
}
