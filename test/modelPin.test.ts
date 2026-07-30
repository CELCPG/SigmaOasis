import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { load, state, resetState } from './harness'

const { pinChatModel, restApiRoot, hasLegacyPins, unloadLegacyPins } =
  load<typeof import('../src/main/ipc/modelPin')>('modelPin')
const { chatComplete } = load<typeof import('../src/main/ipc/llm')>('llm')

describe('restApiRoot', () => {
  test('strips a trailing /v1 to reach the REST API root', () => {
    assert.equal(restApiRoot('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234')
    assert.equal(restApiRoot('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234')
  })

  test('leaves a versionless base URL alone', () => {
    assert.equal(restApiRoot('http://127.0.0.1:1234'), 'http://127.0.0.1:1234')
  })
})

describe('pinChatModel — modern endpoint', () => {
  test('explicitly loads the model through the REST API with a TTL', async () => {
    resetState()
    await pinChatModel('pin-target-a')
    assert.equal(state.pinCalls.length, 1)
    assert.equal(state.pinCalls[0].model, 'pin-target-a')
    assert.equal(typeof state.pinCalls[0].ttl, 'number')
    assert.ok((state.pinCalls[0].ttl ?? 0) >= 3600)
    // TTL makes the pin self-cleaning — nothing to undo at quit.
    assert.equal(hasLegacyPins(), false)
  })

  test('pins through the audited lmstudio purpose, not a side channel', async () => {
    resetState()
    await pinChatModel('pin-target-b')
    const pinFetch = state.fetchLog.find((f) => f.url.endsWith('/api/v0/models/load'))
    assert.ok(pinFetch)
    assert.equal(pinFetch.purpose, 'lmstudio')
  })

  test('memoizes: a second pin for the same model makes no request', async () => {
    resetState()
    await pinChatModel('pin-target-c')
    await pinChatModel('pin-target-c')
    assert.equal(state.pinCalls.length, 1)
  })

  test('pins each distinct model once', async () => {
    resetState()
    await pinChatModel('pin-target-d1')
    await pinChatModel('pin-target-d2')
    assert.equal(state.pinCalls.length, 2)
  })

  test('an empty model id is a no-op', async () => {
    resetState()
    await pinChatModel('   ')
    assert.equal(state.pinCalls.length, 0)
  })

  test('a model that is already resident is never pinned', async () => {
    resetState()
    // The user's own load — not ours. Leaving it alone means we also never
    // unload it at quit.
    state.modelStates['pin-target-f'] = 'loaded'
    await pinChatModel('pin-target-f')
    assert.equal(state.pinCalls.length, 0)
    assert.equal(state.legacyPinCalls.length, 0)
  })
})

describe('pinChatModel — legacy fallback', () => {
  test('falls back to /api/v1/models/load when the v0 endpoint is missing', async () => {
    resetState()
    state.pinUnavailable = true
    await pinChatModel('pin-target-g')
    assert.equal(state.pinCalls.length, 0)
    assert.equal(state.legacyPinCalls.length, 1)
    assert.equal(state.legacyPinCalls[0].model, 'pin-target-g')
  })

  test('legacy pins are recorded for quit-time unload (the legacy API has no TTL)', async () => {
    resetState()
    state.pinUnavailable = true
    await pinChatModel('pin-target-h')
    assert.equal(hasLegacyPins(), true)
  })

  test('unloadLegacyPins unloads exactly what we loaded, by instance id', async () => {
    resetState()
    // Drain legacy pins recorded by earlier tests in this file — the registry
    // is module-level, like in the real app.
    await unloadLegacyPins()
    resetState()
    state.pinUnavailable = true
    await pinChatModel('pin-target-i')
    await unloadLegacyPins()
    assert.deepEqual(state.unloadCalls, [{ instance_id: 'pin-target-i' }])
    assert.equal(hasLegacyPins(), false)
  })

  test('with neither endpoint available the pin resolves and stays out of the way', async () => {
    resetState()
    state.pinUnavailable = true
    state.pinLegacyUnavailable = true
    await pinChatModel('pin-target-j')
    assert.equal(hasLegacyPins(), false)
    // Both routes were tried once; no retry storm.
    await pinChatModel('pin-target-j')
    const tries = state.fetchLog.filter((f) => f.url.includes('/models/load'))
    assert.equal(tries.length, 2)
  })

  test('a guardrail refusal is settled, not retried every turn', async () => {
    resetState()
    state.pinUnavailable = true
    state.pinRefused = true
    await pinChatModel('pin-target-k')
    assert.equal(hasLegacyPins(), false)
    // The guardrail will not change its mind between messages; the refusal
    // stays memoized instead of adding a failed load attempt to every turn.
    await pinChatModel('pin-target-k')
    await pinChatModel('pin-target-k')
    const tries = state.fetchLog.filter((f) => f.url.endsWith('/api/v1/models/load'))
    assert.equal(tries.length, 1)
  })
})

describe('chatComplete pinning', () => {
  test('pins the model before asking it to reason', async () => {
    resetState()
    state.completions.push('done')
    const text = await chatComplete({
      model: 'fake-chat',
      messages: [{ role: 'user', content: 'hi' }]
    })
    assert.equal(text, 'done')
    assert.equal(state.pinCalls.length, 1)
    assert.equal(state.pinCalls[0].model, 'fake-chat')

    // Order matters: the pin must land before the completion, or the
    // completion's own JIT load is what auto-evict targets.
    const pinIdx = state.fetchLog.findIndex((f) => f.url.endsWith('/api/v0/models/load'))
    const chatIdx = state.fetchLog.findIndex((f) => f.url.endsWith('/chat/completions'))
    assert.ok(pinIdx !== -1 && chatIdx !== -1 && pinIdx < chatIdx)
  })
})
