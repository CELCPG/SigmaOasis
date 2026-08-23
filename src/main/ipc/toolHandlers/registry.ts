import type { ToolName } from '../../../shared/tools'
import { fileHandlers } from './files'
import { webHandlers } from './web'
import { researchHandlers } from './research'
import { calculatorHandlers } from './calculators'
import { noteHandlers } from './notes'
import { memoryHandlers } from './memory'
import { libraryHandlers } from './library'
import { workbenchHandlers } from './workbench'
import { shoppingHandlers } from './shopping'
import { marketHandlers } from './market'
import type { ToolContext, ToolHandler, ToolResult } from './types'

/**
 * The dispatch table: tool name → handler. Typed against the tool table's
 * ToolName union (src/shared/tools), so a declared tool without a handler —
 * or a handler for an undeclared tool — is a compile error, not a runtime
 * "Unknown tool". Schemas, toggles, budgets and labels all derive from that
 * same table; the handler is the one member that must stay in the main
 * process (it touches fs, net, Electron).
 */
export const TOOL_HANDLERS: Record<ToolName, ToolHandler> = {
  ...fileHandlers,
  ...webHandlers,
  ...researchHandlers,
  ...calculatorHandlers,
  ...noteHandlers,
  ...memoryHandlers,
  ...libraryHandlers,
  ...workbenchHandlers,
  ...shoppingHandlers,
  ...marketHandlers
}

export const TOOL_NAMES = Object.keys(TOOL_HANDLERS) as ToolName[]

/** Look a tool up and run it. Handler exceptions become `{ok:false}` results the model can read. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const handler = (TOOL_HANDLERS as Record<string, ToolHandler | undefined>)[name]
  if (!handler) return { ok: false, error: `Unknown tool "${name}".` }
  try {
    return await handler(args, context)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
