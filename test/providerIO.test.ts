import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCallRecord, ToolSchema } from '../src/renderer/src/types'

/**
 * v4.1 (S2): the app-run search has a soft deadline, and a result that comes
 * back after the turn stopped waiting for it must not pass for one the model
 * read. These pin what makeProviderIO does with such a result: the record says
 * it was not used, and the turn's ledger and taint flag never see it.
 */

let release!: () => void
beforeEach(async () => {
  const held = new Promise<void>((r) => (release = r))
  ;(globalThis as { window?: unknown }).window = {
    api: {
      executeTool: async () => {
        await held
        return { ok: true, output: '1. A foreign page — https://example.com' }
      },
      auditRecord: async () => true
    }
  }
  const { useAppStore } = await import('../src/renderer/src/stores/appStore')
  useAppStore.setState({ settings: { audit: { enabled: false } } as never })
})

const webSearch: ToolSchema = { type: 'function', function: { name: 'web_search', description: '', parameters: {} } }

async function makeIO(): Promise<{
  io: import('../src/renderer/src/lib/contextProviders').ProviderIO
  records: ToolCallRecord[]
  ledger: import('../src/renderer/src/lib/agentLoop').TurnToolLedger
  toolContext: import('../src/renderer/src/lib/contextProviders').ToolExecuteContext
}> {
  const { makeProviderIO } = await import('../src/renderer/src/hooks/providerIO')
  const { createTurnToolLedger } = await import('../src/renderer/src/lib/agentLoop')
  const records: ToolCallRecord[] = []
  const ledger = createTurnToolLedger()
  const toolContext = { modelId: 'm' }
  const io = makeProviderIO({
    convo: { id: 'c', title: 't', messages: [] } as never,
    slot: { modelId: 'm', roleName: 'r' } as never,
    slotTools: [webSearch],
    toolContext,
    allRecords: records,
    ledger,
    patch: () => {},
    settings: () => null
  })
  return { io, records, ledger, toolContext }
}

describe('makeProviderIO runTool with a soft deadline (v4.1 S2)', () => {
  test('a result that lands after the deadline is recorded as not used, and charges nothing', async () => {
    const { LATE_RESULT_NOTE } = await import('../src/renderer/src/hooks/providerIO')
    const { io, records, ledger, toolContext } = await makeIO()
    const late = new AbortController()
    const pending = io.runTool('web_search', { query: 'q' }, { discardAfter: late.signal })
    assert.equal(records[0].status, 'running')
    late.abort()
    release()
    await pending
    assert.equal(records[0].status, 'error')
    assert.equal(records[0].result, LATE_RESULT_NOTE)
    assert.equal(ledger.executedCounts.get('web_search'), undefined, 'no budget spent')
    assert.equal(ledger.previousCalls.size, 0, 'no repeat seeded')
    assert.notEqual(toolContext.tainted, true, 'nothing foreign reached the model')
  })

  test('inside the deadline, the result is the turn’s as before', async () => {
    const { io, records, ledger, toolContext } = await makeIO()
    const pending = io.runTool('web_search', { query: 'q' }, { discardAfter: new AbortController().signal })
    release()
    await pending
    assert.equal(records[0].status, 'done')
    assert.equal(ledger.executedCounts.get('web_search'), 1)
    assert.equal(toolContext.tainted, true)
  })
})
