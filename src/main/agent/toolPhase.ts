import { splitMcpWireName } from '../../shared/mcpNames'
import type { ApiMessage } from '../../renderer/src/lib/agentLoop'
import type { ToolResult, ToolSchema } from './types'

/**
 * Tools by phase (v4.1, A5 — an experiment, off by default).
 *
 * The agent sends every schema it has on every round: with the documents,
 * chores and MCP experiments on that is well over twenty, and a 9B model
 * picks worse from a long list than from a short one (the chat learned this
 * in 2.x and ranks its tools per turn). This is the agent's smaller version,
 * kept simple on purpose:
 *
 * - **Edit tools wait for a read.** Nothing is changed before something has
 *   been looked at — the method the prompt already asks for — so edit_file,
 *   write_file and the rest join the list once a read has succeeded.
 * - **Documents, chores and MCP tools wait to be relevant.** They are offered
 *   when the task's words point at them (a `.docx`, "rename", the server's
 *   name) or once the model has used one.
 *
 * The list only grows: a tool offered once stays offered, because every
 * change to the list re-reads the whole prompt on a local server (the tools
 * ride ahead of the history), and a list that came and went would pay that
 * every round. A tool held back is still a tool — the engine runs a call to
 * it all the same — it is only not advertised.
 */

const READS = new Set(['read_file', 'read_document', 'list_directory', 'glob', 'grep'])
const EDITS = new Set(['edit_file', 'multi_edit', 'write_file', 'write_document', 'move_file', 'copy_file', 'make_directory', 'delete_file'])
const DOCUMENTS = new Set(['read_document', 'write_document'])
const CHORES = new Set(['move_file', 'copy_file', 'make_directory', 'delete_file'])

const DOCUMENT_WORDS = /\.(?:docx|xlsx|pptx|pdf|csv)\b|\b(?:document|spreadsheet|word file|excel|powerpoint|slides?|pdf)s?\b/i
const CHORE_WORDS = /\b(?:move|rename|copy|delete|remove|tidy|organi[sz]e|sort|archive|folders?|directory|directories)\b/i

export class ToolPhase {
  private readSomething: boolean
  private readonly offered = new Set<string>()
  private readonly used = new Set<string>()

  /** `history`: an earlier turn's reads count, so a later turn does not start over. */
  constructor(
    private readonly task: string,
    history: readonly ApiMessage[] = []
  ) {
    this.readSomething = history.some((m) => (m.tool_calls ?? []).some((c) => READS.has(c.function.name)))
  }

  /** One call's outcome: a successful read opens the edit tools; any use marks a tool relevant. */
  observe(name: string, result: ToolResult): void {
    this.used.add(name)
    if (result.ok && READS.has(name)) this.readSomething = true
  }

  /** The tools to advertise this round, in their original order. */
  offer(tools: readonly ToolSchema[]): ToolSchema[] {
    return tools.filter((t) => {
      const name = t.function.name
      if (this.offered.has(name) || this.wanted(name)) {
        this.offered.add(name)
        return true
      }
      return false
    })
  }

  private wanted(name: string): boolean {
    if (this.used.has(name)) return true
    if (EDITS.has(name) && !this.readSomething) return false
    if (DOCUMENTS.has(name)) return DOCUMENT_WORDS.test(this.task)
    if (CHORES.has(name)) return CHORE_WORDS.test(this.task)
    const mcp = splitMcpWireName(name)
    if (mcp) {
      const words = this.task.toLowerCase()
      return words.includes(mcp.server.toLowerCase()) || words.includes(mcp.tool.toLowerCase().replace(/_[0-9a-f]{6,}$/, ''))
    }
    return true
  }
}
