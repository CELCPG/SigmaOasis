import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mentionTarget, preflightRoute, routeTargets, escalationReason, escalationCandidate } from '../src/renderer/src/lib/routing'
import type { AppSettings, Attachment, Conversation, ModelConfig } from '../src/renderer/src/types'

/**
 * Layer 2 mechanical routing: the @mention matcher (2c) and the pre-flight
 * classifier (2b). Everything here is pure — the point of the layer is that
 * routing is decided in code, so these fixtures are the spec.
 */

function slot(partial: Partial<ModelConfig> & { id: string; roleName: string }): ModelConfig {
  return {
    modelId: `${partial.id}-model`,
    systemPrompt: '',
    color: 'blue',
    enabled: true,
    sampling: { temperature: 0.7, topP: 0.9, maxTokens: -1, seed: null },
    contextWindow: null,
    ...partial
  }
}

const GENERAL = slot({ id: 'g', roleName: 'Assistant' })
const CODER = slot({ id: 'c', roleName: 'Coder', specialty: 'coding' })
const RESEARCHER = slot({ id: 'r', roleName: 'Researcher', specialty: 'research' })
const FINANCE = slot({ id: 'f', roleName: 'Finance Coach', specialty: 'finance' })
const SEER = slot({ id: 'v', roleName: 'Seer' })

function settingsWith(models: ModelConfig[], pipeline: string[] = []): AppSettings {
  return { models, pipeline } as unknown as AppSettings
}

function convo(partial: Partial<Conversation>): Conversation {
  return { mode: 'independent', ...partial } as unknown as Conversation
}

const IMAGE: Attachment = {
  id: 'a1',
  kind: 'image',
  name: 'photo.png',
  mimeType: 'image/png',
  sizeBytes: 10
}

const visionIs = (...ids: string[]) => (modelId: string): boolean => ids.includes(modelId)

describe('mentionTarget (Layer 2c)', () => {
  const settings = settingsWith([GENERAL, CODER])

  test('@handle anywhere in the text routes, case-insensitively', () => {
    assert.equal(mentionTarget(settings, '@Coder please fix this')?.id, 'c')
    assert.equal(mentionTarget(settings, 'ask @coder this')?.id, 'c')
  })

  test('role names with spaces match their squashed handle', () => {
    const s = settingsWith([FINANCE])
    assert.equal(mentionTarget(s, 'hey @FinanceCoach what is APR?')?.id, 'f')
  })

  test('a handle that is a prefix of a longer word does not match', () => {
    assert.equal(mentionTarget(settings, 'check out @coderish syntax'), null)
  })

  test('mentions inside fenced or inline code are content, not routing', () => {
    assert.equal(mentionTarget(settings, '```\n@coder handles DI\n```'), null)
    assert.equal(mentionTarget(settings, 'use the `@coder` snippet here'), null)
  })

  test('disabled or empty-named slots are never mention targets', () => {
    const s = settingsWith([slot({ id: 'x', roleName: 'Coder', enabled: false })])
    assert.equal(mentionTarget(s, '@coder hi'), null)
  })
})

describe('preflightRoute (Layer 2b)', () => {
  const models = [GENERAL, CODER, RESEARCHER, FINANCE, SEER]

  test('an image routes to the first vision-capable slot', () => {
    const d = preflightRoute({
      text: 'what is in this picture?',
      hasImages: true,
      models,
      isVisionCapable: visionIs('v-model')
    })
    assert.equal(d?.slot.id, 'v')
    assert.equal(d?.signal, 'image')
    assert.equal(d?.reason, 'image attached')
  })

  test('an image with no vision slot abstains', () => {
    const d = preflightRoute({
      text: 'hello there',
      hasImages: true,
      models,
      isVisionCapable: () => false
    })
    assert.equal(d, null)
  })

  test('fenced code routes to the coding slot', () => {
    const d = preflightRoute({
      text: 'why does this fail?\n```\nfoo(bar)\n```',
      hasImages: false,
      models
    })
    assert.equal(d?.slot.id, 'c')
    assert.equal(d?.signal, 'code')
    assert.equal(d?.reason, 'fenced code detected')
  })

  test('a stack trace routes to the coding slot', () => {
    const d = preflightRoute({
      text: 'TypeError: boom\n    at run (/app/index.js:10:5)',
      hasImages: false,
      models
    })
    assert.equal(d?.reason, 'stack trace detected')
    assert.equal(d?.slot.id, 'c')
  })

  test('a file path routes to the coding slot', () => {
    const d = preflightRoute({
      text: 'explain src/main/ipc/store.ts please',
      hasImages: false,
      models
    })
    assert.equal(d?.reason, 'file path detected')
    assert.equal(d?.slot.id, 'c')
  })

  test('finance vocabulary routes to the finance slot, ahead of factual', () => {
    const d = preflightRoute({
      text: 'What monthly payment would a $300k mortgage have?',
      hasImages: false,
      models
    })
    assert.equal(d?.slot.id, 'f')
    assert.equal(d?.signal, 'finance')
    assert.equal(d?.reason, 'finance vocabulary')
  })

  test('a factual question routes to the research slot', () => {
    const d = preflightRoute({ text: 'Who is Ada Lovelace?', hasImages: false, models })
    assert.equal(d?.slot.id, 'r')
    assert.equal(d?.signal, 'factual')
    assert.equal(d?.reason, 'factual question')
  })

  test('plain chat abstains', () => {
    assert.equal(preflightRoute({ text: 'hey, how are you doing', hasImages: false, models }), null)
  })

  test('an image beats a code signal', () => {
    const d = preflightRoute({
      text: '```\ncode\n```',
      hasImages: true,
      models,
      isVisionCapable: visionIs('v-model')
    })
    assert.equal(d?.signal, 'image')
  })

  test('a signal with no matching slot abstains (disabled or wrong specialty)', () => {
    const noCoder = [GENERAL, slot({ id: 'c', roleName: 'Coder', specialty: 'coding', enabled: false })]
    assert.equal(
      preflightRoute({ text: '```\nx()\n```', hasImages: false, models: noCoder }),
      null
    )
    const noModelId = [slot({ id: 'c', roleName: 'Coder', specialty: 'coding', modelId: '' })]
    assert.equal(
      preflightRoute({ text: '```\nx()\n```', hasImages: false, models: noModelId }),
      null
    )
  })
})

describe('routeTargets', () => {
  const models = [GENERAL, CODER, RESEARCHER, FINANCE, SEER]
  const settings = settingsWith(models, [CODER.id])

  test('@mention wins over the pre-flight classifier', () => {
    const r = routeTargets(settings, convo({}), '@Researcher fix ```\ncode\n```')
    assert.deepEqual(r.targets.map((t) => t.id), ['r'])
    assert.equal(r.routingNote, undefined)
  })

  test('collaborative mode is explicit: the pipeline runs, no classifier', () => {
    const r = routeTargets(
      settings,
      convo({ mode: 'collaborative' }),
      'What monthly payment would a mortgage have?'
    )
    assert.deepEqual(r.targets.map((t) => t.id), ['c'])
    assert.equal(r.routingNote, undefined)
  })

  test('independent mode: a classified message carries a routing note', () => {
    const r = routeTargets(settings, convo({ activeModelSlotId: 'g' }), 'why?\n```\nfoo()\n```')
    assert.deepEqual(r.targets.map((t) => t.id), ['c'])
    assert.equal(r.routingNote, 'routed to Coder — fenced code detected')
  })

  test('independent mode: abstention keeps the active slot with no note', () => {
    const r = routeTargets(settings, convo({ activeModelSlotId: 'g' }), 'hey, how are you doing')
    assert.deepEqual(r.targets.map((t) => t.id), ['g'])
    assert.equal(r.routingNote, undefined)
  })

  test('independent mode: an attached image routes to the vision slot', () => {
    const r = routeTargets(
      settings,
      convo({ activeModelSlotId: 'g' }),
      'what is this?',
      [IMAGE],
      visionIs('v-model')
    )
    assert.deepEqual(r.targets.map((t) => t.id), ['v'])
    assert.equal(r.routingNote, 'routed to Seer — image attached')
  })

  test('orchestrated mode: a classified message reroutes and keeps delegation', () => {
    const r = routeTargets(
      settings,
      convo({ mode: 'orchestrated', orchestratorSlotId: 'g' }),
      'Who is Ada Lovelace?'
    )
    assert.deepEqual(r.targets.map((t) => t.id), ['r'])
    assert.equal(r.routingNote, 'routed to Researcher — factual question')
    assert.ok(r.delegation)
    assert.ok(!r.delegation!.specialists.some((s) => s.id === 'r'))
  })

  test('orchestrated mode: abstention keeps the orchestrator', () => {
    const r = routeTargets(
      settings,
      convo({ mode: 'orchestrated', orchestratorSlotId: 'g' }),
      'hey, how are you doing'
    )
    assert.deepEqual(r.targets.map((t) => t.id), ['g'])
    assert.equal(r.routingNote, undefined)
    assert.ok(r.delegation!.specialists.length > 0)
  })
})


describe('escalationReason (Layer 2d)', () => {
  test('a clean completed turn offers nothing', () => {
    assert.equal(escalationReason({}, 'completed'), null)
  })

  test('an aborted turn never escalates, however weak the partial answer', () => {
    assert.equal(escalationReason({ unverified: true }, 'aborted'), null)
  })

  test('the iteration cap is the strongest signal', () => {
    assert.equal(escalationReason({ unverified: true }, 'iteration_cap'), 'iteration_cap')
  })

  test('a contradicted claim outranks a merely unverified answer', () => {
    const claimCheck = {
      roleName: 'Critic',
      modelId: 'm',
      createdAt: 0,
      claims: [
        { text: 'a', verdict: 'confirmed' as const },
        { text: 'b', verdict: 'contradicted' as const }
      ]
    }
    assert.equal(escalationReason({ unverified: true, claimCheck }, 'completed'), 'contradicted')
  })

  test('all-confirmed claims with an unverified flag fall back to unverified', () => {
    const claimCheck = {
      roleName: 'Critic',
      modelId: 'm',
      createdAt: 0,
      claims: [{ text: 'a', verdict: 'confirmed' as const }]
    }
    assert.equal(escalationReason({ unverified: true, claimCheck }, 'completed'), 'unverified')
  })
})

describe('escalationCandidate (Layer 2d)', () => {
  const ctx = (sizes: Record<string, number>) => (m: ModelConfig): number | undefined =>
    sizes[m.id]

  test('the biggest enabled slot wins when it beats the current window', () => {
    const sizes = { g: 8192, c: 32768, r: 131072 }
    const best = escalationCandidate(GENERAL, [GENERAL, CODER, RESEARCHER], ctx(sizes))
    assert.equal(best?.id, 'r')
  })

  test('nothing bigger than the current window means no offer', () => {
    const sizes = { g: 131072, c: 32768, r: 8192 }
    assert.equal(escalationCandidate(GENERAL, [GENERAL, CODER, RESEARCHER], ctx(sizes)), null)
  })

  test('an unknown current window takes the largest known candidate', () => {
    const sizes = { c: 32768, r: 131072 }
    const best = escalationCandidate(GENERAL, [GENERAL, CODER, RESEARCHER], ctx(sizes))
    assert.equal(best?.id, 'r')
  })

  test('candidates with unknown windows are skipped', () => {
    const sizes = { g: 8192 }
    assert.equal(escalationCandidate(GENERAL, [GENERAL, CODER, RESEARCHER], ctx(sizes)), null)
  })

  test('disabled and unassigned slots are never candidates', () => {
    const disabled = slot({ id: 'x', roleName: 'X', enabled: false })
    const unassigned = slot({ id: 'y', roleName: 'Y', modelId: '' })
    const sizes = { g: 8192, x: 262144, y: 262144 }
    assert.equal(escalationCandidate(GENERAL, [GENERAL, disabled, unassigned], ctx(sizes)), null)
  })
})
