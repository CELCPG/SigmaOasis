import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pickCritic, buildCriticMessages, CRITIC_INSTRUCTION } from '../src/renderer/src/lib/secondOpinion'
import type { ModelConfig } from '../src/renderer/src/types'

/**
 * Second Opinion's one structural guarantee: the reviewer is never the
 * answerer. A model grading its own answer returns "yes" nearly always —
 * that is why the critic is a different slot, and why these tests exist.
 */
function slot(id: string, modelId: string, roleName: string, enabled = true): ModelConfig {
  return {
    id,
    modelId,
    roleName,
    systemPrompt: `You are ${roleName}.`,
    color: 'blue',
    enabled,
    sampling: { temperature: 0.7, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 },
    contextWindow: null
  }
}

describe('pickCritic', () => {
  const models = [
    slot('m1', 'model-a', 'Assistant'),
    slot('m2', 'model-b', 'Researcher'),
    slot('m3', 'model-c', 'Coder', false)
  ]

  test('the explicit choice wins when usable', () => {
    const critic = pickCritic(models, { modelId: 'model-a', roleName: 'Assistant' }, 'm2')
    assert.equal(critic?.id, 'm2')
  })

  test('the answerer is never picked, even when explicitly chosen', () => {
    const critic = pickCritic(models, { modelId: 'model-a', roleName: 'Assistant' }, 'm1')
    assert.equal(critic?.id, 'm2', 'falls back to the first non-answerer')
  })

  test('auto picks the first enabled slot that did not answer', () => {
    const critic = pickCritic(models, { modelId: 'model-b', roleName: 'Researcher' }, null)
    assert.equal(critic?.id, 'm1')
  })

  test('the same model under a different persona counts as a second pair of eyes', () => {
    const same = [slot('m1', 'model-a', 'Assistant'), slot('m2', 'model-a', 'Skeptic')]
    const critic = pickCritic(same, { modelId: 'model-a', roleName: 'Assistant' }, null)
    assert.equal(critic?.id, 'm2')
  })

  test('a single enabled role means no review is possible — null, not self-grading', () => {
    const single = [slot('m1', 'model-a', 'Assistant')]
    const critic = pickCritic(single, { modelId: 'model-a', roleName: 'Assistant' }, null)
    assert.equal(critic, null)
  })

  test('disabled slots are never picked', () => {
    const withDisabled = [slot('m1', 'model-a', 'Assistant'), slot('m3', 'model-c', 'Coder', false)]
    const critic = pickCritic(withDisabled, { modelId: 'model-a', roleName: 'Assistant' }, null)
    assert.equal(critic, null)
  })
})

describe('buildCriticMessages', () => {
  const critic = slot('m2', 'model-b', 'Researcher')

  test('the system message is the critic persona plus the fixed instruction', () => {
    const [system] = buildCriticMessages(critic, 'question', 'answer', 'Assistant')
    assert.ok(system!.role === 'system')
    assert.match(system!.content, /You are Researcher\./)
    assert.match(system!.content, /Never output a confidence score/)
  })

  test('the user message carries the question and the answer under review', () => {
    const [, user] = buildCriticMessages(critic, 'What is 2+2?', '2+2 is 5.', 'Assistant')
    assert.match(user!.content, /What is 2\+2\?/)
    assert.match(user!.content, /2\+2 is 5\./)
    assert.match(user!.content, /Assistant answered/)
  })

  test('oversized inputs are capped so the review stays cheap', () => {
    const [, user] = buildCriticMessages(critic, 'q'.repeat(9000), 'a'.repeat(9000), 'Assistant')
    assert.ok(user!.content.length < 9000 + 4000, 'both inputs are truncated well under their sum')
    assert.match(user!.content, /…/)
  })

  test('the instruction bans self-graded confidence, by design', () => {
    assert.match(CRITIC_INSTRUCTION, /Never output a confidence score or/)
    assert.match(CRITIC_INSTRUCTION, /cannot verify/)
  })
})
