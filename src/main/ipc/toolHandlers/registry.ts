import type { ToolToggles } from '../store'
import { fileHandlers } from './files'
import { webHandlers } from './web'
import { researchHandlers } from './research'
import { calculatorHandlers } from './calculators'
import { noteHandlers } from './notes'
import { memoryHandlers } from './memory'
import { libraryHandlers } from './library'
import { shoppingHandlers } from './shopping'
import type { ToolContext, ToolHandler, ToolResult } from './types'

/**
 * The dispatch table: tool name → handler. Typed against ToolToggles so adding
 * a toggle without a handler (or vice versa) is a compile error, not a runtime
 * "Unknown tool". toolSchemas.ts is the third leg; test/toolRegistry.test.ts
 * pins that all three agree.
 */
export const TOOL_HANDLERS: Record<keyof ToolToggles, ToolHandler> = {
  ...fileHandlers,
  ...webHandlers,
  ...researchHandlers,
  ...calculatorHandlers,
  ...noteHandlers,
  ...memoryHandlers,
  ...libraryHandlers,
  ...shoppingHandlers
}

export const TOOL_NAMES = Object.keys(TOOL_HANDLERS) as (keyof ToolToggles)[]

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
