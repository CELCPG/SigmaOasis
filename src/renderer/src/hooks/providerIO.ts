import type {
  AppSettings,
  ChatMessage,
  Conversation,
  ModelConfig,
  ToolCallRecord,
  ToolResult,
  ToolSchema
} from '../types'
import type { ProviderIO, ToolExecuteContext } from '../lib/contextProviders'
import type { TurnToolLedger } from '../lib/agentLoop'
import { audit, uid } from './turnHelpers'
import { noteToolResult } from '../lib/taint'

/**
 * The one place app-initiated tool bookkeeping is written (it used to be
 * copy-pasted into each pre-flight block of runTurn): create the record, push
 * it onto the turn's shared list, patch it onto the reply, execute, record
 * status and result, audit — the identical text format the audit log always
 * carried. Because it delegates to turnHelpers.audit, the ephemeral flag
 * rides through unchanged and main still refuses to persist ephemeral chats.
 */
export function makeProviderIO(opts: {
  convo: Conversation
  slot: ModelConfig
  /** The per-slot security set; runTool refuses anything outside it. */
  slotTools: ToolSchema[]
  toolContext: ToolExecuteContext
  /** The turn's shared record list — the agent loop appends to the same one. */
  allRecords: ToolCallRecord[]
  /**
   * The turn's shared tool ledger. Provider calls charge budgets and seed
   * repeat detection exactly like loop calls, so the model repeating the
   * app's byte-identical query gets the reuse path, not a re-fetch.
   */
  ledger: TurnToolLedger
  patch: (p: Partial<ChatMessage>) => void
  settings: () => AppSettings | null
}): ProviderIO {
  const { convo, slot, slotTools, toolContext, allRecords, ledger, patch, settings } = opts

  const auditCall = (name: string, args: Record<string, unknown>, ok: boolean, text: string): void =>
    audit(convo, {
      kind: 'tool_call',
      roleName: slot.roleName,
      modelId: slot.modelId,
      toolName: name,
      ok,
      text: `${name}(${JSON.stringify(args)})\n→ ${text}`
    })

  return {
    async runTool(name, args) {
      // The per-slot allowlist is a security boundary. Every provider also
      // gates on it, but the refusal here makes the boundary structural: a
      // future provider that forgets the check cannot widen it.
      if (!slotTools.some((t) => t.function.name === name)) {
        return { ok: false, error: `Tool "${name}" is not allowlisted for this role.` }
      }
      const record: ToolCallRecord = { id: uid(), name, args, status: 'running' }
      allRecords.push(record)
      patch({ toolCalls: [...allRecords] })
      const result: ToolResult = await window.api
        .executeTool(name, args, toolContext)
        .catch((err: unknown) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }))
      record.status = result.ok ? 'done' : 'error'
      record.result = result.ok ? (result.output ?? '') : (result.error ?? 'Unknown tool error')
      noteToolResult(toolContext, name, result)
      ledger.note(name, args, result)
      patch({ toolCalls: [...allRecords] })
      auditCall(
        name,
        args,
        result.ok,
        result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`
      )
      return result
    },

    recordSyntheticCall(name, args, output) {
      const record: ToolCallRecord = { id: uid(), name, args, status: 'done', result: output }
      allRecords.push(record)
      ledger.note(name, args, { ok: true, output })
      patch({ toolCalls: [...allRecords] })
      auditCall(name, args, true, output)
    },

    api: {
      memorySearch: window.api.memorySearch,
      libraryLookup: window.api.libraryLookup,
      ledgerLookup: window.api.ledgerLookup,
      skillsList: window.api.skillsList,
      skillHelpers: window.api.skillHelpers,
      attachmentPassages: window.api.attachmentPassages,
      projectRecall: window.api.projectRecall
    },

    patch,
    settings
  }
}
