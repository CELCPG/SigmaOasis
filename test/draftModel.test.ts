import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { load, resetState, state, readSource } from './harness'
import {
  addAcceptance,
  draftAcceptance,
  draftModelFor,
  formatAcceptance,
  isDraftRejection,
  normalizeDraftModel,
  withoutDraft
} from '../src/shared/draftModel'
import { chatRequestBody, streamChat } from '../src/renderer/src/hooks/chatTransport'
import { useAppStore } from '../src/renderer/src/stores/appStore'
import { formatTurnCost } from '../src/renderer/src/lib/turnCost'
import { fitSentence, fitVerdict } from '../src/renderer/src/lib/modelFit'
import { withDraftFallback } from '../src/main/agent/draftFallback'
import { timedTransport, type RoundLatency } from '../src/main/agent/latency'
import { formatBenchReport, parseBenchArgs, summarizeBench, type BenchLine } from '../src/main/agent/latencyBench'
import type { ChunkTransport } from '../src/main/agent/types'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'
import type { AppSettings, ModelConfig } from '../src/renderer/src/types'

/**
 * v4.2 (S8): draft-model decoding. Off unless a role names a draft; when one
 * does, it rides the request, a refusal never fails the turn, and acceptance
 * is shown only when the server reported it. No server is called: every
 * frame below is synthetic.
 */

const pin = load<typeof import('../src/main/ipc/modelPin')>('modelPin')
const encoder = new TextEncoder()
const HELLO: ApiMessage[] = [{ role: 'user', content: 'hi' }]

function sse(chunks: string[], status = 200): Response {
  if (status !== 200) return new Response(chunks.join(''), { status })
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(encoder.encode(chunk))
        c.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

const slot = (over: Partial<ModelConfig>): ModelConfig => ({
  id: 's1',
  modelId: 'dense-32b',
  roleName: 'Coder',
  systemPrompt: '',
  color: 'blue',
  enabled: true,
  sampling: { temperature: 0.3, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 },
  contextWindow: null,
  ...over
})

describe('the setting', () => {
  test('a draft is a trimmed id, never the role’s own model, never a non-string', () => {
    assert.equal(normalizeDraftModel('  dense-0.5b ', 'dense-32b'), 'dense-0.5b')
    assert.equal(normalizeDraftModel('dense-32b', 'dense-32b'), undefined)
    assert.equal(normalizeDraftModel('', 'x'), undefined)
    assert.equal(normalizeDraftModel(7, 'x'), undefined)
    assert.equal(normalizeDraftModel(undefined, 'x'), undefined)
  })

  test('found by model, from an enabled role only; absent is none', () => {
    assert.equal(draftModelFor('dense-32b', [slot({ draftModel: 'dense-0.5b' })]), 'dense-0.5b')
    assert.equal(draftModelFor('dense-32b', [slot({ draftModel: 'dense-0.5b', enabled: false })]), undefined)
    assert.equal(draftModelFor('dense-32b', [slot({})]), undefined)
    assert.equal(draftModelFor('other', [slot({ draftModel: 'dense-0.5b' })]), undefined)
    assert.equal(draftModelFor('dense-32b', undefined), undefined)
  })

  /** D5: export and import both pass through normalizeSettings; a 4.1 file must come back byte for byte. */
  test('a 4.1 settings file reads unchanged; a 4.2 one keeps its draft; a bad one loses it', () => {
    // store.ts cannot load under node (electron-store at import), so the rule is
    // applied as normalizeSettings applies it, and the source is held to it below.
    const rule = (m: Record<string, unknown>): Record<string, unknown> => ({ ...m, draftModel: normalizeDraftModel(m.draftModel, String(m.modelId ?? '')) })
    const v41 = { id: 's1', modelId: 'qwen3.8-9b-distill', roleName: 'Assistant', enabled: true, keepLoaded: true, thinking: 'off' }
    assert.equal(JSON.stringify(rule(v41)), JSON.stringify(v41))
    assert.equal(rule({ ...v41, draftModel: 'qwen3.8-0.6b' }).draftModel, 'qwen3.8-0.6b')
    assert.equal(JSON.stringify(rule({ ...v41, draftModel: 42 })), JSON.stringify(v41))
    const store = readSource('src/main/ipc/store.ts')
    assert.match(store, /draftModel: normalizeDraftModel\(m\?\.draftModel, str\(m\?\.modelId, ''\)\)/)
    // Export writes normalizeSettings' output and import reads through it — no second path to miss the field.
    assert.match(store, /const settings = normalizeSettings\(\{ \.\.\.defaultSettings\(\), \.\.\.readSettings\(\) \}\)/)
    assert.match(store, /const next = normalizeSettings\(/)
  })
})

describe('the request body', () => {
  test('without a draft the body is 4.1’s, byte for byte; with one, draft_model comes last', () => {
    const plain = chatRequestBody('dense-32b', HELLO, [])
    assert.equal('draft_model' in plain, false)
    const drafted = chatRequestBody('dense-32b', HELLO, [], undefined, 'dense-0.5b')
    assert.equal(drafted.draft_model, 'dense-0.5b')
    // The prompt cache keys on the prefix: everything before the new field is unchanged.
    assert.ok(JSON.stringify(drafted).startsWith(JSON.stringify(plain).slice(0, -1)))
    assert.deepEqual(Object.keys(drafted).slice(-1), ['draft_model'])
  })

  test('withoutDraft strips the field and nothing else; null when there was none', () => {
    const body = JSON.stringify({ model: 'm', messages: [], temperature: 0, draft_model: 'd' })
    assert.equal(withoutDraft(body), JSON.stringify({ model: 'm', messages: [], temperature: 0 }))
    assert.equal(withoutDraft(JSON.stringify({ model: 'm' })), null)
    assert.equal(withoutDraft('not json'), null)
  })

  test('a refusal is one that mentions the draft', () => {
    assert.ok(isDraftRejection('Draft model vocabulary does not match the main model'))
    assert.ok(isDraftRejection('speculative decoding is not supported for this model'))
    assert.equal(isDraftRejection('context length exceeded'), false)
    assert.equal(isDraftRejection(undefined), false)
  })
})

describe('the chat: streamChat with a role’s draft', () => {
  const run = async (responses: Response[]): Promise<{ bodies: Record<string, unknown>[]; content: string; result: Awaited<ReturnType<typeof streamChat>> }> => {
    const original = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return responses.shift() ?? sse(['data: [DONE]\n\n'])
    }) as typeof fetch
    let content = ''
    try {
      const result = await streamChat('http://localhost:1234/v1', 'dense-32b', HELLO, [], new AbortController().signal, (c) => {
        content += c
      })
      return { bodies, content, result }
    } finally {
      globalThis.fetch = original
    }
  }
  const setDraft = (draftModel: string | undefined, modelId = 'dense-32b'): void =>
    useAppStore.setState({ settings: { models: [slot({ modelId, draftModel })] } as unknown as AppSettings })
  const ANSWER = ['data: {"choices":[{"delta":{"content":"Hello."}}]}\n\n']

  test('no draft set: no field, one request — the default path is 4.1’s', async () => {
    setDraft(undefined)
    const { bodies, content } = await run([sse([...ANSWER, 'data: [DONE]\n\n'])])
    assert.equal(bodies.length, 1)
    assert.equal('draft_model' in bodies[0]!, false)
    assert.equal(content, 'Hello.')
  })

  test('a draft set: sent, and the acceptance the server reports comes back with the reply', async () => {
    setDraft('dense-0.5b')
    const usage = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":40},"stats":{"accepted_draft_tokens_count":30,"rejected_draft_tokens_count":10,"total_draft_tokens_count":40}}\n\n'
    const { bodies, result } = await run([sse([...ANSWER, usage, 'data: [DONE]\n\n'])])
    assert.equal(bodies[0]!.draft_model, 'dense-0.5b')
    assert.deepEqual(result.draft, { accepted: 30, drafted: 40 })
  })

  test('an HTTP refusal naming the draft is retried once without it, and the turn does not fail', async () => {
    setDraft('other-family-1b', 'dense-32b-http')
    const original = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    const queue = [sse(['{"error":"Draft model other-family-1b is not compatible with dense-32b-http"}'], 400), sse([...ANSWER, 'data: [DONE]\n\n'])]
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return queue.shift()!
    }) as typeof fetch
    let content = ''
    try {
      await streamChat('http://localhost:1234/v1', 'dense-32b-http', HELLO, [], new AbortController().signal, (c) => {
        content += c
      })
    } finally {
      globalThis.fetch = original
    }
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0]!.draft_model, 'other-family-1b')
    assert.equal('draft_model' in bodies[1]!, false)
    assert.equal(content, 'Hello.')
  })

  test('a refusal in the first frame is retried too, and the pair is not sent again this session', async () => {
    setDraft('bad-draft', 'dense-32b-frame')
    const original = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    const queue = [sse(['data: {"error":{"message":"Failed to load draft model: vocab mismatch"}}\n\n']), sse([...ANSWER, 'data: [DONE]\n\n']), sse([...ANSWER, 'data: [DONE]\n\n'])]
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return queue.shift()!
    }) as typeof fetch
    try {
      const go = (): ReturnType<typeof streamChat> => streamChat('http://localhost:1234/v1', 'dense-32b-frame', HELLO, [], new AbortController().signal, () => undefined)
      await go()
      await go()
    } finally {
      globalThis.fetch = original
    }
    assert.deepEqual(bodies.map((b) => 'draft_model' in b), [true, false, false])
  })

  test('a failure that is not about the draft still fails, as it did', async () => {
    setDraft('dense-0.5b', 'dense-32b-ctx')
    const original = globalThis.fetch
    globalThis.fetch = (async () => sse(['data: {"error":{"message":"context length exceeded"}}\n\n'])) as typeof fetch
    try {
      await assert.rejects(() => streamChat('http://localhost:1234/v1', 'dense-32b-ctx', HELLO, [], new AbortController().signal, () => undefined), /context/)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('the agent: the transport wrapper', () => {
  const frames = (xs: string[]): Uint8Array[] => xs.map((x) => encoder.encode(x))
  const scripted = (script: ((body: string) => { ok: boolean; status: number; errorText?: string; chunks?: Uint8Array[] })[]): { t: ChunkTransport; bodies: string[] } => {
    const bodies: string[] = []
    const t: ChunkTransport = async (_url, init) => {
      bodies.push(init.body)
      const r = script.shift()!(init.body)
      for (const c of r.chunks ?? []) init.onChunk(c)
      return { ok: r.ok, status: r.status, ...(r.errorText ? { errorText: r.errorText } : {}) }
    }
    return { t, bodies }
  }
  const body = JSON.stringify({ model: 'm', messages: [], draft_model: 'd' })
  const read = (): { onChunk: (c: Uint8Array) => void; text: () => string } => {
    let s = ''
    const dec = new TextDecoder()
    return { onChunk: (c) => (s += dec.decode(c)), text: () => s }
  }

  test('a stream the draft did not trouble passes through byte for byte, one request', async () => {
    const ok = frames(['data: {"choices":[{"delta":{"content":"a"}}]}\n', '\ndata: [DONE]\n\n'])
    const { t, bodies } = scripted([() => ({ ok: true, status: 200, chunks: ok })])
    const out = read()
    const refusals: string[] = []
    await withDraftFallback(t, (d) => refusals.push(d))('u', { body, signal: new AbortController().signal, stallMs: 1000, onChunk: out.onChunk })
    assert.equal(out.text(), 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n')
    assert.equal(bodies.length, 1)
    assert.deepEqual(refusals, [])
  })

  test('an error frame about the draft is swallowed and the round sent again without it; later rounds skip it', async () => {
    const { t, bodies } = scripted([
      () => ({ ok: true, status: 200, chunks: frames(['data: {"error":"draft model refused"}\n\n']) }),
      () => ({ ok: true, status: 200, chunks: frames(['data: {"choices":[{"delta":{"content":"b"}}]}\n\n']) }),
      () => ({ ok: true, status: 200, chunks: [] })
    ])
    const out = read()
    const refusals: string[] = []
    const wrapped = withDraftFallback(t, (d) => refusals.push(d))
    await wrapped('u', { body, signal: new AbortController().signal, stallMs: 1000, onChunk: out.onChunk })
    assert.equal(out.text(), 'data: {"choices":[{"delta":{"content":"b"}}]}\n\n')
    assert.deepEqual(refusals, ['draft model refused'])
    await wrapped('u', { body, signal: new AbortController().signal, stallMs: 1000, onChunk: () => undefined })
    assert.deepEqual(bodies.map((b) => 'draft_model' in JSON.parse(b)), [true, false, false])
  })

  test('an HTTP refusal about the draft is retried; any other error is returned as it was', async () => {
    const a = scripted([() => ({ ok: false, status: 400, errorText: 'unknown draft_model' }), () => ({ ok: true, status: 200 })])
    const r1 = await withDraftFallback(a.t, () => undefined)('u', { body, signal: new AbortController().signal, stallMs: 1000, onChunk: () => undefined })
    assert.equal(r1.ok, true)
    assert.equal(a.bodies.length, 2)
    const b = scripted([() => ({ ok: false, status: 500, errorText: 'model crashed' })])
    const r2 = await withDraftFallback(b.t, () => undefined)('u', { body, signal: new AbortController().signal, stallMs: 1000, onChunk: () => undefined })
    assert.equal(r2.status, 500)
    assert.equal(b.bodies.length, 1)
  })

  test('a body with no draft is not touched', async () => {
    const plain = JSON.stringify({ model: 'm' })
    const { t, bodies } = scripted([() => ({ ok: true, status: 200, chunks: frames(['data: {"error":"draft"}\n\n']) })])
    const out = read()
    await withDraftFallback(t, () => undefined)('u', { body: plain, signal: new AbortController().signal, stallMs: 1000, onChunk: out.onChunk })
    assert.equal(bodies.length, 1)
    assert.match(out.text(), /draft/)
  })
})

describe('acceptance, read defensively', () => {
  test('LM Studio’s stats block, top level or under usage', () => {
    assert.deepEqual(draftAcceptance({ stats: { accepted_draft_tokens_count: 12, total_draft_tokens_count: 20 } }), { accepted: 12, drafted: 20 })
    assert.deepEqual(draftAcceptance({ usage: { accepted_draft_tokens_count: 5, rejected_draft_tokens_count: 3 } }), { accepted: 5, drafted: 8 })
  })

  test('OpenAI’s predicted-output shape', () => {
    assert.deepEqual(draftAcceptance({ usage: { completion_tokens_details: { accepted_prediction_tokens: 9, rejected_prediction_tokens: 1 } } }), { accepted: 9, drafted: 10 })
  })

  test('nothing said is not zero: absent, zeros, garbage and impossible figures all read as no figure', () => {
    assert.equal(draftAcceptance({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), null)
    assert.equal(draftAcceptance({ usage: { completion_tokens_details: { accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } } }), null)
    assert.equal(draftAcceptance({ stats: { accepted_draft_tokens_count: 'many' } }), null)
    assert.equal(draftAcceptance({ stats: { accepted_draft_tokens_count: 9, total_draft_tokens_count: 4 } }), null)
    assert.equal(draftAcceptance(null), null)
    assert.equal(draftAcceptance('frame'), null)
  })

  test('summed over a turn’s rounds, and said on the stats line only when reported', () => {
    const turn = addAcceptance(addAcceptance(undefined, { accepted: 30, drafted: 40 }), { accepted: 18, drafted: 40 })
    assert.deepEqual(turn, { accepted: 48, drafted: 80 })
    assert.deepEqual(addAcceptance(turn, null), turn)
    assert.equal(formatAcceptance(turn), '60% of 80 drafted accepted')
    assert.equal(formatAcceptance(undefined), '')
    const line = formatTurnCost({ ttftMs: 400, totalMs: 2000, completionTokens: 80, tokensPerSecond: 40, draft: turn })
    assert.match(line, /40\.0 tok\/s · 60% of 80 drafted accepted · 0\.40s to first token/)
    assert.doesNotMatch(formatTurnCost({ ttftMs: 400, totalMs: 2000, completionTokens: 80 }), /draft/)
  })
})

describe('fit with a draft beside the model', () => {
  const card = 12 * 1024 ** 3
  test('the draft’s weights and cache count against the card, and the sentence says so', () => {
    const alone = fitVerdict({ id: 'dense-14b', quantization: 'Q4_K_M', loadedContextLength: 32768 }, card)!
    const both = fitVerdict({ id: 'dense-14b', quantization: 'Q4_K_M', loadedContextLength: 32768 }, card, { id: 'dense-1.5b', quantization: 'Q8_0' })!
    assert.ok(both.weightsGb > alone.weightsGb && both.cacheGb > alone.cacheGb)
    assert.ok(both.draftGb! > 1.5 && both.draftGb! < 2.5, String(both.draftGb))
    assert.match(fitSentence(both, 'dense-14b'), /^With its draft model \(\d+\.\d GB of the total\) — (Fits|Tight|Does not fit)/)
    assert.equal(alone.draftGb, undefined)
  })

  test('a draft that tips a tight model over is the difference in the verdict', () => {
    const m = { id: 'dense-14b', quantization: 'Q4_K_M', loadedContextLength: 16384 }
    assert.notEqual(fitVerdict(m, card)!.kind, 'no')
    assert.equal(fitVerdict(m, card, { id: 'dense-3b', quantization: 'Q8_0' })!.kind, 'no')
  })

  test('a draft whose size the id does not say is left out, not guessed', () => {
    const m = { id: 'dense-14b', quantization: 'Q4_K_M' }
    assert.deepEqual(fitVerdict(m, card, { id: 'tiny-draft' }), fitVerdict(m, card))
  })
})

describe('pinned beside its model', () => {
  test('the draft is pinned after the main model, and kept as long when the role keeps its model loaded', async () => {
    resetState()
    ;(state.settings as Record<string, unknown>).models = [slot({ modelId: 'pin-main-x', draftModel: 'pin-draft-x', keepLoaded: true })]
    await pin.pinChatModel('pin-main-x')
    assert.deepEqual(state.pinCalls.map((c) => c.model), ['pin-main-x', 'pin-draft-x'])
    assert.equal(state.pinCalls[1]!.ttl, pin.KEEP_LOADED_TTL_S)
  })

  test('a pair refused this session is not pinned again; the notice lists it', async () => {
    resetState()
    ;(state.settings as Record<string, unknown>).models = [slot({ modelId: 'pin-main-y', draftModel: 'pin-draft-y' })]
    pin.noteDraftRejected('pin-main-y', 'pin-draft-y', 'vocab mismatch')
    await pin.pinChatModel('pin-main-y')
    assert.deepEqual(state.pinCalls.map((c) => c.model), ['pin-main-y'])
    assert.ok(pin.draftNotices().some((n) => n.draft === 'pin-draft-y' && n.detail === 'vocab mismatch'))
  })

  test('no draft set: one pin, as before', async () => {
    resetState()
    ;(state.settings as Record<string, unknown>).models = [slot({ modelId: 'pin-main-z' })]
    await pin.pinChatModel('pin-main-z')
    assert.deepEqual(state.pinCalls.map((c) => c.model), ['pin-main-z'])
    assert.equal(pin.keepLoadedTtl('pin-draft-z', [slot({ modelId: 'pin-main-z', draftModel: 'pin-draft-z' })]), pin.PIN_TTL_S)
  })
})

describe('bench:latency --draft', () => {
  test('arguments: the flag anywhere, an id required after it', () => {
    assert.deepEqual(parseBenchArgs(['dense-32b', '4.2-dev', '--draft', 'dense-0.5b']), { model: 'dense-32b', label: '4.2-dev', draft: 'dense-0.5b' })
    assert.deepEqual(parseBenchArgs(['--draft', 'dense-0.5b', 'dense-32b']), { model: 'dense-32b', label: 'unlabelled', draft: 'dense-0.5b' })
    assert.deepEqual(parseBenchArgs(['dense-32b']), { model: 'dense-32b', label: 'unlabelled' })
    assert.equal(parseBenchArgs(['dense-32b', '--draft']), null)
    assert.equal(parseBenchArgs(['dense-32b', '--draft', '--x']), null)
    assert.equal(parseBenchArgs([]), null)
  })

  test('the timer records acceptance off the wire; the summary pools it; the report names the arm', async () => {
    const got: RoundLatency[] = []
    let clock = 0
    const inner: ChunkTransport = async (_u, init) => {
      for (const f of ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 'data: {"choices":[],"usage":{"completion_tokens":20},"stats":{"accepted_draft_tokens_count":15,"total_draft_tokens_count":20}}\n\n']) {
        clock += 100
        init.onChunk(encoder.encode(f))
      }
      return { ok: true, status: 200 }
    }
    await timedTransport(inner, (r) => got.push(r), () => clock)('u', { body: '{}', signal: new AbortController().signal, stallMs: 1000, onChunk: () => undefined })
    assert.deepEqual(got[0]!.draft, { accepted: 15, drafted: 20 })
    const s = summarizeBench([
      { scenario: 'cold', latency: got[0]! },
      { scenario: 'cold', latency: { ...got[0]!, draft: { accepted: 5, drafted: 20 } } }
    ])
    assert.equal(s.cold!.draftAcceptance, 0.5)
    // A plain arm's summary carries no acceptance key at all: 4.1 lines and reports read unchanged.
    assert.equal('draftAcceptance' in summarizeBench([{ scenario: 'cold', latency: { ...got[0]!, draft: undefined } }]).cold!, false)
    const line: BenchLine = { label: '4.2-dev+draft', model: 'dense-32b', draft: 'dense-0.5b', at: 'x', window: 8192, repeats: 1, scenarios: s }
    assert.match(formatBenchReport([line]), /\| 4\.2-dev\+draft \| dense-32b \+ draft dense-0\.5b \(50% kept\) \|/)
    assert.match(formatBenchReport([{ ...line, label: '4.1', draft: undefined }]), /\| 4\.1 \| dense-32b \|/)
  })
})
