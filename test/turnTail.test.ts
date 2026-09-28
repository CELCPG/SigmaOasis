import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, Conversation, ModelConfig, ResponseStats } from '../src/renderer/src/types'
import type { TurnTailContext } from '../src/renderer/src/hooks/turnTail'

/**
 * v3.1: the chat turn's tail, out of useLMStudio.ts (hooks/turnTail.ts). The
 * code moved verbatim; these pin the behaviour it had in place, on turns that
 * need no model: the echo scrub at the tail's start, the stat line's length
 * stamped at its end, the phase labels in order, the ledger kept out of
 * ephemeral chats, and the offer to re-run on a bigger slot.
 */

const slot = (id: string, contextWindow: number | null, extra: Partial<ModelConfig> = {}): ModelConfig =>
  ({ id, modelId: `${id}-model`, roleName: id, enabled: true, contextWindow, ...extra }) as ModelConfig

let ledgerCalls = 0
beforeEach(async () => {
  ledgerCalls = 0
  ;(globalThis as { window?: unknown }).window = {
    api: {
      ledgerUpsert: async () => {
        ledgerCalls++
        return { ok: true, written: [], refreshed: [], superseded: 0 }
      },
      saveConversation: async () => true
    }
  }
  const { useAppStore } = await import('../src/renderer/src/stores/appStore')
  useAppStore.setState({
    settings: {
      models: [slot('small', 8192), slot('big', 32768)],
      grounding: { workbenchChecks: false, autoCorrect: true, factLedger: true },
      claimCheck: { enabled: false }
    } as never,
    conversations: [],
    availableModels: []
  } as never)
})

function context(over: Partial<TurnTailContext> = {}): { ctx: TurnTailContext; patches: Partial<ChatMessage>[]; phases: (string | null)[] } {
  const patches: Partial<ChatMessage>[] = []
  const phases: (string | null)[] = []
  const assistantMsg = { id: 'a1', role: 'assistant', content: 'Hello! Good to see you.', createdAt: 0 } as ChatMessage
  const convo = {
    id: 'c1',
    title: 't',
    messages: [{ id: 'u1', role: 'user', content: 'hello', createdAt: 0 }, assistantMsg]
  } as unknown as Conversation
  const ctx: TurnTailContext = {
    convo,
    slot: slot('small', 8192),
    slotTools: [],
    tools: [],
    baseUrl: 'http://127.0.0.1:1/v1',
    signal: new AbortController().signal,
    assistantMsg,
    patch: (p) => patches.push(p),
    verifying: (step) => phases.push(step),
    allRecords: [],
    toolContext: { modelId: 'small-model', attachments: [], conversationId: 'c1' } as never,
    lastUserContent: 'hello',
    shoppingTurn: false,
    checkableTurn: false,
    answerEndedAt: Date.now(),
    lastStats: { ttftMs: 120, totalMs: 900 } as ResponseStats,
    turnOpenedAt: Date.now() - 5_000,
    ...over
  }
  return { ctx, patches, phases }
}

describe('startTurnTail', () => {
  test('a reply that echoed the turn notes is scrubbed when the tail starts, before it runs', async () => {
    const { startTurnTail } = await import('../src/renderer/src/hooks/turnTail')
    const { TURN_CONTEXT_HEADER } = await import('../src/renderer/src/lib/grounding')
    const { ctx, patches } = context()
    ctx.assistantMsg.content = `${TURN_CONTEXT_HEADER}\n- a note\n\nParis is the capital of France.`
    startTurnTail(ctx)
    assert.ok(!ctx.assistantMsg.content.includes(TURN_CONTEXT_HEADER))
    const echo = patches.flatMap((p) => p.checks ?? []).find((c) => c.kind === 'echo')
    assert.ok(echo, 'the scrub says so')
  })

  test('a plain reply is left exactly as it was', async () => {
    const { startTurnTail } = await import('../src/renderer/src/hooks/turnTail')
    const { ctx, patches } = context()
    startTurnTail(ctx)
    assert.equal(ctx.assistantMsg.content, 'Hello! Good to see you.')
    assert.deepEqual(patches, [])
  })
})

describe('the tail’s run', () => {
  test('a turn with nothing to check stamps the turn’s length and clears the phase', async () => {
    const { startTurnTail } = await import('../src/renderer/src/hooks/turnTail')
    const { ctx, patches, phases } = context()
    await startTurnTail(ctx).run()
    const stamped = patches.map((p) => p.stats).find(Boolean)
    assert.ok(stamped, 'the stat line learns the turn’s real length')
    assert.equal(stamped.ttftMs, 120)
    assert.ok(stamped.turnMs! >= 5_000 && stamped.turnMs! < 60_000)
    assert.deepEqual(phases, ['grounding', null])
    assert.ok(!patches.some((p) => p.unverified), 'not a checkable turn')
  })

  test('the fact ledger is never written from an ephemeral chat', async () => {
    const { startTurnTail } = await import('../src/renderer/src/hooks/turnTail')
    const { ctx } = context()
    ctx.convo = { ...ctx.convo, ephemeral: true }
    await startTurnTail(ctx).run()
    assert.equal(ledgerCalls, 0)
  })
})

describe('offerEscalation', () => {
  const offer = async (stopReason: 'completed' | 'iteration_cap', routingNote?: string) => {
    const { offerEscalation } = await import('../src/renderer/src/hooks/turnTail')
    const { useAppStore } = await import('../src/renderer/src/stores/appStore')
    const { ctx, patches } = context()
    useAppStore.setState({ conversations: [ctx.convo] } as never)
    offerEscalation({ conversationId: 'c1', routingNote, stopReason, slot: ctx.slot, assistantMsg: ctx.assistantMsg, patch: ctx.patch })
    return patches.map((p) => p.escalation).find(Boolean) ?? null
  }

  test('a turn that ran out of tool rounds is offered the bigger slot', async () => {
    const escalation = await offer('iteration_cap')
    assert.deepEqual(escalation, { slotId: 'big', roleName: 'big', reason: 'iteration_cap' })
  })

  test('a turn that ended well is offered nothing', async () => {
    assert.equal(await offer('completed'), null)
  })

  test('an escalated turn is never escalated again', async () => {
    assert.equal(await offer('iteration_cap', 'escalated to big'), null)
  })
})
