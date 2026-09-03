import { isUntrustedTool } from '../../../shared/tools'
import type { ToolExecuteContext } from './contextProviders/types'
import type { ToolResult } from '../types'

/**
 * v2.6: a turn is tainted from the moment a tool returns content from outside
 * the machine — a search, a fetched page, a research brief, anything an MCP
 * server said. The flag rides the turn's shared tool context, so every later
 * tool call in the same turn carries it to the main process, where the memory
 * store reads it and never a tool argument. Set once, never cleared within a
 * turn: the model's prose after the fetch is downstream of the fetch.
 *
 * Only a successful call taints. A refused or failed fetch put nothing in
 * front of the model.
 */
export function noteToolResult(context: ToolExecuteContext, name: string, result: ToolResult): void {
  if (result.ok && isUntrustedTool(name)) context.tainted = true
}
