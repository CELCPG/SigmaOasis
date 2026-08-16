import { ipcMain } from 'electron'
import { getSettings } from './store'
import type { ToolToggles } from './store'
import { TOOL_SCHEMAS } from './toolSchemas'
import { executeTool } from './toolHandlers/registry'

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
    return TOOL_SCHEMAS.filter((t) => toggles[t.function.name as keyof ToolToggles])
  })

  ipcMain.handle(
    'tools:execute',
    async (
      event,
      name: keyof ToolToggles,
      args: Record<string, unknown>,
      context?: { modelId?: string }
    ) => {
      if (!getSettings().tools[name]) {
        return { ok: false, error: `Tool "${String(name)}" is disabled in Settings → Tools.` }
      }
      return executeTool(name, args ?? {}, { sender: event.sender, modelId: context?.modelId })
    }
  )
}
