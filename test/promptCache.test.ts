import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, Conversation, ModelConfig, ToolSchema } from '../src/renderer/src/types'

/**
 * v4.1 (S7, roadmap M4): a cache-friendliness test with no model.
 *
 * LM Studio reuses its KV cache for the longest prefix a request shares with
 * the one before it, and a small local model spends most of a turn in prefill
 * — so the request a turn sends must extend the previous one, not rewrite it.
 * These build consecutive turns with the turn's own functions (the system
 * prompt, subsetForTurn, planAndCompact, assembleTurnMessages,
 * chatRequestBody), render each request the way a ChatML template does —
 * tools inside the system block, ahead of the history — and assert that the
 * previous request, minus the notes that ride only its own user message, is a
 * prefix of the next. The first differing byte must come after the previous
 * user message: never inside the system prompt, the tools or older history.
 *
 * Would have caught S1 (a full conversation re-summarized every turn, moving
 * the summary in the system prompt) and S5 (the web tools on and off the wire
 * as factual and chatty turns alternated).
 */

const MODEL = 'qwen3.8-9b'
const TODAY = new Date('2026-09-30T15:00:00Z')

let rankedPicks: string[] = []
let summaries = 0

beforeEach(async () => {
  summaries = 0
  rankedPicks = ['reference_lookup', 'memory_search']
  ;(globalThis as { window?: unknown }).window = {
    api: {
      // A decisive ranking that keeps reaching for the same two tools — the
      // measured shape of "weather today" against nomic-embed (grounding.ts).
      rankTools: async (_query: string, tools: { name: string }[]) => ({
        ok: true,
        scores: Object.fromEntries(tools.map((t) => [t.name, rankedPicks.includes(t.name) ? 0.9 : 0.2]))
      }),
      // A summary that changes whenever anything new is folded into it.
      summarizeConversation: async (req: { previousSummary?: string; droppedText: string }) => {
        summaries++
        return { ok: true, summary: `Summary #${summaries} (${req.droppedText.length} new chars).` }
      },
      saveConversation: async () => true
    }
  }
})

function slot(contextWindow: number): ModelConfig {
  return {
    id: 'slot',
    modelId: MODEL,
    roleName: 'Assistant',
    systemPrompt: 'You are a helpful assistant.',
    color: 'green',
    enabled: true,
    sampling: { temperature: 0.7, topP: 0.95, maxTokens: -1, seed: null, topK: -1, minP: -1 },
    contextWindow
  } as ModelConfig
}

/** A request as a ChatML template renders it: tools in the system block, then the history. */
function rendered(body: Record<string, unknown>): { text: string; headEnd: number } {
  const messages = body.messages as { role: string; content: unknown }[]
  const tools = (body.tools as ToolSchema[] | undefined) ?? []
  const text = (m: { content: unknown }): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
  let out = `<|im_start|>system\n${text(messages[0])}`
  if (tools.length > 0) out += `\n\n# Tools\n${tools.map((t) => JSON.stringify(t)).join('\n')}`
  out += '<|im_end|>\n'
  const headEnd = out.length
  for (const m of messages.slice(1)) out += `<|im_start|>${m.role}\n${text(m)}<|im_end|>\n`
  return { text: out, headEnd }
}

interface Turn {
  prompt: { text: string; headEnd: number }
  /** The same request without this turn's notes — what the next turn replays. */
  replayed: string
  summarized: boolean
}

let ids = 0
function message(role: 'user' | 'assistant', content: string): ChatMessage {
  return { id: `m${ids++}`, role, content, createdAt: ids }
}

/** One chat turn's request, built the way hooks/chatTurn.ts builds it, then its reply appended. */
async function turn(conversationId: string, s: ModelConfig, userText: string, notes: string[] = []): Promise<Turn> {
  const { useAppStore } = await import('../src/renderer/src/stores/appStore')
  const { planAndCompact, subsetForTurn, assembleTurnMessages } = await import('../src/renderer/src/hooks/turnHelpers')
  const { chatRequestBody } = await import('../src/renderer/src/hooks/chatTransport')
  const { withGrounding, withToolCallPreamble, webToolsForTurn, buildTurnContext } = await import('../src/renderer/src/lib/grounding')
  const { estimateTokens } = await import('../src/renderer/src/lib/contextBudget')
  const { schemasAvailableTo, withBudgetNotes } = await import('../src/renderer/src/lib/toolSelection')
  const { TOOL_TURN_BUDGETS, DEFAULT_TOOL_TOGGLES } = await import('../src/shared/tools')

  useAppStore.getState().appendMessage(conversationId, message('user', userText))
  const convo = useAppStore.getState().conversations.find((c) => c.id === conversationId)!
  const before = summaries

  const systemPrompt = withToolCallPreamble(withGrounding(s.systemPrompt, TODAY, { offline: false }), s.modelId)
  const slotTools = schemasAvailableTo(s, DEFAULT_TOOL_TOGGLES)
  const turnTools = await subsetForTurn(slotTools, userText, conversationId, webToolsForTurn(userText))
  const turnContextBlock = buildTurnContext(notes)
  const { history, summaryText } = await planAndCompact(
    convo,
    s,
    estimateTokens(systemPrompt) + estimateTokens(turnContextBlock ?? ''),
    estimateTokens(JSON.stringify(turnTools))
  )
  const wireTools = withBudgetNotes(turnTools, TOOL_TURN_BUDGETS)
  const body = chatRequestBody(s.modelId, assembleTurnMessages({ systemPrompt, summaryText, history, turnContextBlock })!, wireTools, s.sampling)
  const replay = chatRequestBody(s.modelId, assembleTurnMessages({ systemPrompt, summaryText, history, turnContextBlock: null })!, wireTools, s.sampling)

  useAppStore.getState().appendMessage(conversationId, message('assistant', `Answer to: ${userText}`))
  return { prompt: rendered(body), replayed: rendered(replay).text, summarized: summaries > before }
}

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
}

/** The next request extends the previous one past its user message. */
function extends_(prev: Turn, next: Turn): { ok: boolean; why: string } {
  const at = firstDiff(prev.replayed, next.prompt.text)
  const ok = at >= prev.replayed.length
  const where = at < next.prompt.headEnd ? 'the system prompt or the tools' : 'the history'
  return { ok, why: ok ? '' : `first differing byte at ${at} of ${prev.replayed.length}, inside ${where}` }
}

async function newConversation(id: string, messages: ChatMessage[] = []): Promise<void> {
  const { useAppStore } = await import('../src/renderer/src/stores/appStore')
  const { DEFAULT_TOOL_TOGGLES } = await import('../src/shared/tools')
  useAppStore.setState({
    settings: { contextManagement: 'summarize', audit: { enabled: false }, tools: DEFAULT_TOOL_TOGGLES } as never,
    availableModels: [],
    conversations: [{ id, title: 't', mode: 'independent', messages, createdAt: 1, updatedAt: 1 } as Conversation]
  } as never)
}

describe('consecutive turns extend the previous request (v4.1 S7)', () => {
  test('a normal second turn: the first difference is after the previous user message', async () => {
    await newConversation('plain')
    const s = slot(32_768)
    const first = await turn('plain', s, 'Can you explain how a heat pump keeps working in winter?')
    const second = await turn('plain', s, 'And what does the defrost cycle do?')
    const check = extends_(first, second)
    assert.ok(check.ok, check.why)
  })

  test('the turn notes ride only their own turn and do not break the next prefix', async () => {
    await newConversation('notes')
    const s = slot(32_768)
    const first = await turn('notes', s, 'Explain compound interest.', ['Reference notes: principal × (1 + r)^n.'])
    const second = await turn('notes', s, 'Now with monthly deposits?', ['Reference notes: annuity formula.'])
    assert.ok(first.prompt.text.includes('principal × (1 + r)^n'))
    assert.ok(!second.prompt.text.includes('principal × (1 + r)^n'), 'old notes are not replayed')
    const check = extends_(first, second)
    assert.ok(check.ok, check.why)
  })

  test('an over-budget conversation: the prefix holds between compactions, and only a compaction moves it', async () => {
    // 32 messages of ~400 tokens against a 12K window: far past its budget.
    const long = (i: number): string => `Point ${i}: ${'the details of this part of the plan, spelled out at length. '.repeat(26)}`
    const seeded = Array.from({ length: 32 }, (_, i) => message(i % 2 === 0 ? 'user' : 'assistant', long(i)))
    await newConversation('full', seeded)
    const s = slot(12_000)
    const turns: Turn[] = []
    for (let i = 0; i < 8; i++) turns.push(await turn('full', s, long(100 + i)))
    assert.ok(turns[0].summarized, 'the conversation really was over its budget')
    let friendly = 0
    for (let i = 1; i < turns.length; i++) {
      const check = extends_(turns[i - 1], turns[i])
      if (check.ok) friendly++
      // A break is only ever a compaction — the summary in the system prompt moving.
      else assert.ok(turns[i].summarized, `turn ${i} broke the prefix without compacting: ${check.why}`)
    }
    // Pre-4.1 every one of these seven re-summarized and re-read the whole prompt.
    assert.ok(friendly >= 4, `only ${friendly} of 7 transitions kept the prefix`)
    assert.ok(summaries <= 3, `${summaries} summaries in 8 turns`)
  })

  test('factual → chatty → factual keeps one tool list on the wire', async () => {
    await newConversation('alternate')
    const s = slot(32_768)
    const search = (q: string): string[] => [`Web results for "${q}": 1. Forecast — rain after 3pm, high 64°F.`]
    const factual = await turn('alternate', s, 'what is the weather in richmond va today?', search('richmond weather today'))
    const chatty = await turn('alternate', s, 'ha, I love a rainy day to be honest')
    const again = await turn('alternate', s, 'will it rain in richmond tomorrow too?', search('richmond weather tomorrow'))
    assert.ok(factual.prompt.text.includes('"name":"web_search"'), 'the factual turn carries the web tools')
    for (const [prev, next] of [[factual, chatty], [chatty, again]] as const) {
      const check = extends_(prev, next)
      assert.ok(check.ok, check.why)
    }
  })
})
