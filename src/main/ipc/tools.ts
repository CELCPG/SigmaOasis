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
export function registerToolHandlers(): void {
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
      context?: { modelId?: string; attachments?: { name: string; sourcePath: string }[]; conversationId?: string }
    ) => {
      // v2.5: an MCP tool leaves here too. Its server's enablement and its own
      // per-tool switch are the manager's to check; the static toggle table has
      // no key for it.
      if (isMcpWireName(String(name))) return executeMcpTool(String(name), args ?? {})
      if (!getSettings().tools[name]) {
        return { ok: false, error: `Tool "${String(name)}" is disabled in Settings → Tools.` }
      }
      return executeTool(name, args ?? {}, {
        sender: event.sender,
        modelId: context?.modelId,
        conversationId: typeof context?.conversationId === 'string' ? context.conversationId : undefined,
        attachments: Array.isArray(context?.attachments)
          ? context!.attachments.filter((a) => a && typeof a.name === 'string' && typeof a.sourcePath === 'string')
          : []
      })
    }
  )
}
