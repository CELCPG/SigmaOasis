import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReviewMessages,
  buildRevisionMessages,
  describeDeliberation,
  figuresChanged,
  numbersIn,
  pickReviewer,
  reviewFoundProblems
} from '../src/renderer/src/lib/deliberation'
import type { DeliberationRecord, ModelConfig } from '../src/renderer/src/types'

/**
 * v1.5.1 think harder — the headless rules: who reviews, what each side is
 * told, when a review warrants a revision, and how a changed figure is noticed.
 */
const sampling = { temperature: 0.3, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 }
const slot = (id: string, roleName: string, modelId: string): ModelConfig => ({
  id,
  modelId,
  roleName,
  systemPrompt: `You are ${roleName}.`,
  color: 'blue',
  enabled: true,
  sampling,
  contextWindow: null
})
const answerer = slot('a', 'Assistant', 'qwen3-9b')
const critic = slot('c', 'Reviewer', 'gemma-4-12b')

describe('pickReviewer', () => {
  test('a different slot when one exists', () => {
    const r = pickReviewer([answerer, critic], answerer, null)
    assert.equal(r.slot.id, 'c')
    assert.equal(r.self, false)
  })
  test('the answerer itself, labelled self, when alone', () => {
    const r = pickReviewer([answerer], answerer, null)
    assert.equal(r.slot.id, 'a')
    assert.equal(r.self, true)
  })
})

describe('messages', () => {
  test('review asks for problems, not a rewrite, and names the author', () => {
    const m = buildReviewMessages(critic, 'What is 17 × 23?', 'It is 381.', 'Assistant', false)
    assert.equal(m[0].role, 'system')
    assert.match(m[0].content, /You are Reviewer\./)
    assert.match(m[0].content, /Do not rewrite it/)
    assert.match(m[1].content, /Assistant's draft answer/)
    assert.match(m[1].content, /It is 381\./)
  })
  test('self-review says so', () => {
    const m = buildReviewMessages(answerer, 'q', 'd', 'Assistant', true)
    assert.match(m[0].content, /read it as a strict reviewer, not as its author/)
    assert.match(m[1].content, /Your draft answer/)
  })
  test('revision carries question, draft and review and forbids mentioning the review', () => {
    const m = buildRevisionMessages(answerer, 'q', 'draft text', '1. 17 × 23 is 391, not 381.')
    assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'user'])
    assert.equal(m[2].content, 'draft text')
    assert.match(m[3].content, /do not mention the review/)
    assert.match(m[3].content, /391, not 381/)
  })
})

describe('reviewFoundProblems', () => {
  test('the sentinel and short all-clears mean no', () => {
    assert.equal(reviewFoundProblems('No substantive problems.'), false)
    assert.equal(reviewFoundProblems('no substantive problems'), false)
    assert.equal(reviewFoundProblems('Looks good.'), false)
    assert.equal(reviewFoundProblems(''), false)
  })
  test('a numbered list means yes', () => {
    assert.equal(reviewFoundProblems('1. 17 × 23 is 391, not 381.\n2. The unit is missing.'), true)
  })
})

describe('figures', () => {
  test('numbersIn reads decimals, separators and percentages', () => {
    assert.deepEqual(numbersIn('12,500 at 4.5% over 30 years is 1,024.'), ['12500', '4.5%', '30', '1024'])
  })
  test('figuresChanged reports both directions', () => {
    const d = figuresChanged('The answer is 381.', 'The answer is 391.')
    assert.deepEqual(d, { added: ['391'], removed: ['381'] })
    assert.deepEqual(figuresChanged('same 42', 'same 42'), { added: [], removed: [] })
  })
})

describe('describeDeliberation', () => {
  const base: DeliberationRecord = {
    reviewerRole: 'Reviewer',
    reviewerModelId: 'gemma',
    self: false,
    status: 'done',
    draft: 'd',
    review: 'r',
    revised: true,
    createdAt: 1
  }
  test('states reviewer and outcome; labels self-review', () => {
    assert.equal(describeDeliberation(base), '🧠 Deliberated — reviewed by Reviewer, revised.')
    assert.equal(describeDeliberation({ ...base, revised: false }), '🧠 Deliberated — reviewed by Reviewer: no substantive problems found; draft kept.')
    assert.match(describeDeliberation({ ...base, self: true }), /reviewed its own draft, revised/)
    assert.match(describeDeliberation({ ...base, note: 'Figures changed: 381 → 391.' }), /Figures changed: 381 → 391/)
    assert.match(describeDeliberation({ ...base, status: 'reviewing' }), /in progress/)
    assert.match(describeDeliberation({ ...base, status: 'error', note: 'boom' }), /failed: boom/)
  })
})
