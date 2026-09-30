import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ALWAYS_ON_TOOLS } from '../src/renderer/src/lib/toolSelection'
import type { ToolSchema } from '../src/renderer/src/types'

/**
 * v4.1 (S5): subsetForTurn keeps a conversation's tool list where the prompt
 * cache needs it — a ranking failure falls back to the previous turn's list,
 * not the whole allowlist, and the web pair stays once it has been sent.
 * window.api.rankTools is the one seam; each test scripts its answers.
 */

const tool = (name: string): ToolSchema => ({ type: 'function', function: { name, description: `${name} tool`, parameters: {} } })
const SLOT = [...ALWAYS_ON_TOOLS, 'web_search', 'fetch_webpage', 'read_file', 'reference_lookup', 'memory_search', 'deep_research', 'run_python'].map(tool)
const names = (ts: ToolSchema[]): string[] => ts.map((t) => t.function.name)

/** Scores that pick `top` decisively (a spread well past MIN_RANK_SPREAD). */
function decisive(...top: string[]): Record<string, number> {
  return Object.fromEntries(SLOT.map((t) => [t.function.name, top.includes(t.function.name) ? 0.9 : 0.2]))
}

let answers: ({ ok: boolean; scores?: Record<string, number> } | 'throw')[] = []
beforeEach(() => {
  answers = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      rankTools: async () => {
        const next = answers.shift()
        if (!next || next === 'throw') throw new Error('no embedding model')
        return next
      }
    }
  }
})

let convo = 0
async function subset(): Promise<typeof import('../src/renderer/src/hooks/turnHelpers').subsetForTurn> {
  return (await import('../src/renderer/src/hooks/turnHelpers')).subsetForTurn
}

describe('subsetForTurn (v4.1 S5)', () => {
  test('a ranking failure mid-conversation keeps the previous turn’s tools, not the whole list', async () => {
    const subsetForTurn = await subset()
    const id = `c${convo++}`
    answers.push({ ok: true, scores: decisive('read_file', 'memory_search') })
    const first = await subsetForTurn(SLOT, 'read my notes file please', id)
    answers.push({ ok: false })
    const second = await subsetForTurn(SLOT, 'and summarize it', id)
    answers.push('throw')
    const third = await subsetForTurn(SLOT, 'shorter please', id)
    assert.deepEqual(names(second), names(first))
    assert.deepEqual(names(third), names(first))
    assert.ok(second.length < SLOT.length)
  })

  test('with no previous turn a failure still sends the whole list', async () => {
    const subsetForTurn = await subset()
    answers.push('throw')
    assert.equal(await subsetForTurn(SLOT, 'first message', `c${convo++}`), SLOT)
  })

  test('the web pair stays on the wire once sent: factual → chatty → factual is one tool list', async () => {
    const subsetForTurn = await subset()
    const id = `c${convo++}`
    // The ranking keeps reaching for the date-ish tools; the web pair is
    // forced onto the factual turns only (lib/grounding.ts webToolsForTurn).
    answers.push({ ok: true, scores: decisive('reference_lookup', 'memory_search') })
    const factual = await subsetForTurn(SLOT, 'weather in richmond today?', id, ['web_search', 'fetch_webpage'])
    answers.push({ ok: true, scores: decisive('reference_lookup', 'memory_search') })
    const chatty = await subsetForTurn(SLOT, 'ha, I love a rainy day to be honest', id, [])
    answers.push({ ok: true, scores: decisive('reference_lookup', 'memory_search') })
    const again = await subsetForTurn(SLOT, 'and tomorrow?', id, ['web_search', 'fetch_webpage'])
    assert.ok(names(factual).includes('web_search'))
    assert.deepEqual(names(chatty), names(factual))
    assert.deepEqual(names(again), names(factual))
  })

  test('a one-shot caller (no conversation) is untouched: failure is the whole list, nothing sticks', async () => {
    const subsetForTurn = await subset()
    answers.push('throw')
    assert.equal(await subsetForTurn(SLOT, 'task'), SLOT)
  })
})
