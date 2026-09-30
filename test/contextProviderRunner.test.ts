import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_SEARCH_SOFT_DEADLINE_MS,
  TURN_CONTEXT_PROVIDERS,
  gatherTurnContext,
  type ContextProvider,
  type ProviderIO,
  type TurnInput
} from '../src/renderer/src/lib/contextProviders'

/**
 * The runner's contract: registry order IS block order (the turn notes are
 * prompt surface — the response cache and the eval suites fingerprint them),
 * prefetch work starts before any serial await, a failing provider degrades
 * to absence, and an abort mid-sequence stops the serial walk.
 */

const io = {} as ProviderIO

function input(overrides: Partial<TurnInput> = {}): TurnInput {
  const controller = new AbortController()
  return { signal: controller.signal, ...overrides } as TurnInput
}

function provider(
  id: string,
  phase: 'prefetch' | 'serial',
  gather: ContextProvider['gather'],
  enabled = true
): ContextProvider {
  return { id, phase, enabled: () => enabled, gather }
}

describe('turn-context provider registry', () => {
  test('the shipped registry order and phases are pinned — this is prompt surface', () => {
    assert.deepEqual(
      TURN_CONTEXT_PROVIDERS.map((p) => `${p.id}:${p.phase}`),
      [
        // v2.6: the fact ledger rides ahead of the search it can suppress.
        'factLedger:serial',
        'autoSearch:serial',
        // v4.1 (S2): beside the ledger → search chain, not after it.
        'libraryPassages:prefetch',
        // v2.7: a user's skill takes the method slot and stands the playbook down.
        'skill:serial',
        'playbook:serial',
        'ledger:serial',
        'shoppingPrice:serial',
        'memoryRecall:prefetch',
        'projectRecall:prefetch',
        'attachmentPassages:prefetch',
        'tabularProfile:serial'
      ]
    )
  })

  test('v4.1: the app-run search carries the soft deadline, and nothing else does', () => {
    assert.equal(AUTO_SEARCH_SOFT_DEADLINE_MS, 3500)
    assert.deepEqual(
      TURN_CONTEXT_PROVIDERS.filter((p) => p.softDeadlineMs !== undefined).map((p) => [p.id, p.softDeadlineMs]),
      [['autoSearch', AUTO_SEARCH_SOFT_DEADLINE_MS]]
    )
  })

  test('v4.1: the library lookup starts before the ledger lookup has answered', async () => {
    const order: string[] = []
    let releaseLedger!: () => void
    const ledgerHeld = new Promise<void>((r) => (releaseLedger = r))
    const slotTools = ['web_search', 'reference_lookup'].map((name) => ({
      type: 'function' as const,
      function: { name, description: '', parameters: {} }
    }))
    const shippedIO = {
      runTool: async () => {
        order.push('search')
        return { ok: true, output: 'results' }
      },
      recordSyntheticCall: () => {},
      patch: () => {},
      settings: () => null,
      api: {
        ledgerLookup: async () => {
          order.push('ledger:start')
          await ledgerHeld
          order.push('ledger:end')
          return { ok: true, hits: [] }
        },
        libraryLookup: async () => {
          order.push('library')
          return { ok: true, passages: [], formatted: '' }
        },
        memorySearch: async () => ({ ok: true, results: [] })
      }
    } as unknown as ProviderIO
    setTimeout(releaseLedger, 20)
    await gatherTurnContext(
      TURN_CONTEXT_PROVIDERS,
      input({
        convo: { id: 'c', messages: [] },
        conversations: [],
        slot: { modelId: 'm', roleName: 'r' },
        slotTools,
        lastUserContent: 'what is the standard deduction for a single filer?',
        factualTurn: true,
        referenceTurn: true,
        offline: false,
        project: null
      } as unknown as Partial<TurnInput>),
      shippedIO
    )
    assert.ok(order.indexOf('library') < order.indexOf('ledger:end'), order.join(' → '))
    assert.ok(order.indexOf('ledger:end') < order.indexOf('search'), order.join(' → '))
  })
})

describe('gatherTurnContext', () => {
  test('blocks assemble in registry order even when a prefetch resolves first', async () => {
    let releaseSlow!: () => void
    const slow = new Promise<void>((r) => (releaseSlow = r))
    const providers = [
      provider('serialA', 'serial', async () => {
        await slow
        return { blocks: ['A'] }
      }),
      provider('pre', 'prefetch', async () => ({ blocks: ['P'] })),
      provider('serialB', 'serial', async () => ({ blocks: ['B'] }))
    ]
    setTimeout(releaseSlow, 10)
    const result = await gatherTurnContext(providers, input(), io)
    assert.deepEqual(result.blocks, ['A', 'P', 'B'])
    assert.equal(result.aborted, false)
  })

  test('prefetch gathers start before any serial gather runs', async () => {
    const order: string[] = []
    const providers = [
      provider('serial1', 'serial', async () => {
        order.push('serial1')
        return null
      }),
      provider('pre1', 'prefetch', async () => {
        order.push('pre1')
        return null
      }),
      provider('pre2', 'prefetch', async () => {
        order.push('pre2')
        return null
      })
    ]
    await gatherTurnContext(providers, input(), io)
    assert.deepEqual(order, ['pre1', 'pre2', 'serial1'])
  })

  test('a disabled provider is never gathered — prefetch is not even started', async () => {
    let started = 0
    const providers = [
      provider(
        'pre',
        'prefetch',
        async () => {
          started++
          return { blocks: ['x'] }
        },
        false
      ),
      provider(
        'serial',
        'serial',
        async () => {
          started++
          return { blocks: ['y'] }
        },
        false
      )
    ]
    const result = await gatherTurnContext(providers, input(), io)
    assert.equal(started, 0)
    assert.deepEqual(result.blocks, [])
  })

  test('a throwing serial provider and a rejecting prefetch both degrade to absence', async () => {
    const providers = [
      provider('boom', 'serial', async () => {
        throw new Error('provider bug')
      }),
      provider('reject', 'prefetch', () => Promise.reject(new Error('ipc down'))),
      provider('ok', 'serial', async () => ({ blocks: ['still here'] }))
    ]
    const result = await gatherTurnContext(providers, input(), io)
    assert.deepEqual(result.blocks, ['still here'])
    assert.equal(result.aborted, false)
  })

  test('an abort during a serial gather stops the walk and reports aborted', async () => {
    const controller = new AbortController()
    const ran: string[] = []
    const providers = [
      provider('first', 'serial', async () => {
        ran.push('first')
        controller.abort()
        return { blocks: ['first'] }
      }),
      provider('second', 'serial', async () => {
        ran.push('second')
        return { blocks: ['second'] }
      })
    ]
    const result = await gatherTurnContext(providers, input({ signal: controller.signal }), io)
    assert.equal(result.aborted, true)
    assert.deepEqual(ran, ['first'])
    // The completed provider's blocks are kept — the caller decides to return.
    assert.deepEqual(result.blocks, ['first'])
  })

  test('the provider holding the turn open is announced by name, then cleared', async () => {
    const seen: (string | null)[] = []
    const providers: ContextProvider[] = [
      { ...provider('named', 'serial', async () => ({ blocks: ['a'] })), wait: { label: 'Searching the web', detail: 'before the model is asked' } },
      provider('anonymous', 'serial', async () => ({ blocks: ['b'] })),
      provider('pre', 'prefetch', async () => null)
    ]
    await gatherTurnContext(providers, input(), io, (w) => seen.push(w ? w.label : null))
    // Announced before its own await; the next provider clears it, so a name
    // never outlives the work it describes.
    assert.deepEqual(seen, ['Searching the web', null, null])
  })

  test('an abort mid-wait still clears the name', async () => {
    const controller = new AbortController()
    const seen: (string | null)[] = []
    const providers: ContextProvider[] = [
      {
        ...provider('named', 'serial', async () => {
          controller.abort()
          return null
        }),
        wait: { label: 'Checking prices', detail: 'real offers' }
      }
    ]
    const result = await gatherTurnContext(providers, input({ signal: controller.signal }), io, (w) =>
      seen.push(w ? w.label : null)
    )
    assert.equal(result.aborted, true)
    assert.deepEqual(seen, ['Checking prices', null])
  })

  test('v4.1: a provider past its soft deadline is left behind, and what it does later is discarded', async () => {
    let releaseLate!: () => void
    const lateDone = new Promise<void>((r) => (releaseLate = r))
    const seen: (string | null)[] = []
    const runs: { name: string; discarded: boolean | undefined }[] = []
    const patches: unknown[] = []
    const lateIO = {
      runTool: async (name: string, _args: unknown, options?: { discardAfter?: AbortSignal }) => {
        await lateDone
        runs.push({ name, discarded: options?.discardAfter?.aborted })
        return { ok: true, output: 'late results' }
      },
      recordSyntheticCall: () => patches.push('record'),
      patch: (p: unknown) => patches.push(p)
    } as unknown as ProviderIO
    const providers: ContextProvider[] = [
      {
        ...provider('slow', 'serial', async (_input, pio) => {
          const r = await pio.runTool('web_search', { query: 'q' })
          pio.patch({ content: 'late' })
          pio.recordSyntheticCall('web_search', {}, 'x')
          return { blocks: [r.output ?? ''] }
        }),
        wait: { label: 'Searching the web', detail: 'd' },
        softDeadlineMs: 20
      },
      provider('after', 'serial', async () => ({ blocks: ['after'] }))
    ]
    const startedAt = Date.now()
    const result = await gatherTurnContext(providers, input(), lateIO, (w) => seen.push(w ? w.label : null))
    assert.ok(Date.now() - startedAt < 1000, 'the walk did not wait for the slow provider')
    assert.deepEqual(result.blocks, ['after'])
    // The wait on the reader's screen ended with the walk.
    assert.equal(seen[seen.length - 1], null)
    releaseLate()
    await new Promise((r) => setTimeout(r, 10))
    // The call came back flagged as discarded, and nothing it did landed.
    assert.deepEqual(runs, [{ name: 'web_search', discarded: true }])
    assert.deepEqual(patches, [])
    assert.deepEqual(result.blocks, ['after'])
  })

  test('v4.1: a provider inside its soft deadline is folded as before', async () => {
    const providers: ContextProvider[] = [
      { ...provider('quick', 'serial', async () => ({ blocks: ['quick'] })), softDeadlineMs: 1000 },
      provider('after', 'serial', async () => ({ blocks: ['after'] }))
    ]
    const result = await gatherTurnContext(providers, input(), io)
    assert.deepEqual(result.blocks, ['quick', 'after'])
  })

  test('v4.1: a prefetch that declares a wait is named while the walk waits on it', async () => {
    const seen: (string | null)[] = []
    const providers: ContextProvider[] = [
      { ...provider('lib', 'prefetch', async () => ({ blocks: ['L'] })), wait: { label: 'Reading the reference library', detail: 'd' } },
      provider('after', 'serial', async () => ({ blocks: ['after'] }))
    ]
    const result = await gatherTurnContext(providers, input(), io, (w) => seen.push(w ? w.label : null))
    assert.deepEqual(result.blocks, ['L', 'after'])
    assert.deepEqual(seen, ['Reading the reference library', null, null])
  })

  test('projectTokens accumulate across providers', async () => {
    const providers = [
      provider('recall', 'prefetch', async () => ({ projectTokens: { recall: 40 } })),
      provider('files', 'prefetch', async () => ({ projectTokens: { files: 7 } })),
      provider('more', 'serial', async () => ({ blocks: ['b'], projectTokens: { files: 3 } }))
    ]
    const result = await gatherTurnContext(providers, input(), io)
    assert.deepEqual(result.projectTokens, { recall: 40, files: 10 })
  })
})
