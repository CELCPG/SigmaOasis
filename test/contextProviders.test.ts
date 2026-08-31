import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type {
  ProviderIO,
  TurnInput
} from '../src/renderer/src/lib/contextProviders'
import { autoSearchProvider } from '../src/renderer/src/lib/contextProviders/autoSearch'
import { libraryPassagesProvider } from '../src/renderer/src/lib/contextProviders/libraryPassages'
import { playbookProvider } from '../src/renderer/src/lib/contextProviders/playbook'
import { ledgerProvider } from '../src/renderer/src/lib/contextProviders/ledger'
import { shoppingPriceProvider } from '../src/renderer/src/lib/contextProviders/shoppingPrice'
import { memoryRecallProvider } from '../src/renderer/src/lib/contextProviders/memoryRecall'
import { projectRecallProvider } from '../src/renderer/src/lib/contextProviders/projectRecall'
import { attachmentPassagesProvider } from '../src/renderer/src/lib/contextProviders/attachmentPassages'
import { tabularProfileProvider } from '../src/renderer/src/lib/contextProviders/tabularProfile'
import { buildSearchContext, buildSearchQuery } from '../src/renderer/src/lib/grounding'
import { buildLibraryContext } from '../src/renderer/src/lib/libraryRecall'
import type { ToolSchema } from '../src/renderer/src/types'

/**
 * Each provider must reproduce its old inline block exactly: the same gate,
 * the same tool/IPC call, the same block text (golden — it is prompt surface)
 * and the same disclosure patches. The pure builders each provider delegates
 * to keep their own test files; these tests pin the glue.
 */

function schemas(...names: string[]): ToolSchema[] {
  return names.map((name) => ({
    type: 'function' as const,
    function: { name, description: '', parameters: {} }
  }))
}

function makeInput(overrides: Partial<TurnInput> = {}): TurnInput {
  const controller = new AbortController()
  return {
    convo: { id: 'c1', messages: [] },
    conversations: [],
    slot: { modelId: 'm', roleName: 'Assistant' },
    slotTools: [],
    lastUserContent: 'what is the capital of France?',
    previousUserContent: undefined,
    offline: false,
    factualTurn: false,
    referenceTurn: false,
    shoppingTurn: false,
    project: null,
    assistantMsgId: 'a1',
    signal: controller.signal,
    ...overrides
  } as unknown as TurnInput
}

interface IOCalls {
  runs: { name: string; args: Record<string, unknown> }[]
  synthetic: { name: string; args: Record<string, unknown>; output: string }[]
  patches: Record<string, unknown>[]
}

function makeIO(overrides: {
  runResult?: { ok: boolean; output?: string; error?: string }
  settings?: unknown
  api?: Partial<ProviderIO['api']>
} = {}): { io: ProviderIO; calls: IOCalls } {
  const calls: IOCalls = { runs: [], synthetic: [], patches: [] }
  const io = {
    async runTool(name: string, args: Record<string, unknown>) {
      calls.runs.push({ name, args })
      return overrides.runResult ?? { ok: true, output: 'tool output' }
    },
    recordSyntheticCall(name: string, args: Record<string, unknown>, output: string) {
      calls.synthetic.push({ name, args, output })
    },
    api: overrides.api ?? {},
    patch(p: Record<string, unknown>) {
      calls.patches.push(p)
    },
    settings: () => overrides.settings ?? null
  } as unknown as ProviderIO
  return { io, calls }
}

describe('autoSearch provider', () => {
  const enabledInput = makeInput({
    factualTurn: true,
    slotTools: schemas('web_search')
  })

  test('gate: factual + online + allowlisted web_search', () => {
    const { io } = makeIO()
    assert.equal(autoSearchProvider.enabled(enabledInput, io), true)
    assert.equal(autoSearchProvider.enabled(makeInput({ factualTurn: false, slotTools: schemas('web_search') }), io), false)
    assert.equal(autoSearchProvider.enabled(makeInput({ factualTurn: true, offline: true, slotTools: schemas('web_search') }), io), false)
    assert.equal(autoSearchProvider.enabled(makeInput({ factualTurn: true }), io), false)
    assert.equal(
      autoSearchProvider.enabled(makeInput({ factualTurn: true, slotTools: schemas('web_search'), lastUserContent: undefined }), io),
      false
    )
  })

  test('runs web_search with the anchored query and wraps the result verbatim', async () => {
    const { io, calls } = makeIO({ runResult: { ok: true, output: 'results here' } })
    const result = await autoSearchProvider.gather(enabledInput, io)
    const query = buildSearchQuery(enabledInput.lastUserContent!, undefined)
    assert.deepEqual(calls.runs, [{ name: 'web_search', args: { query } }])
    assert.deepEqual(result?.blocks, [buildSearchContext(query, 'results here')])
  })

  test('a failed search contributes nothing (the record/audit is runTool business)', async () => {
    const { io } = makeIO({ runResult: { ok: false, error: 'no provider' } })
    assert.equal(await autoSearchProvider.gather(enabledInput, io), null)
  })
})

describe('libraryPassages provider', () => {
  const lookupOk = {
    ok: true,
    passages: [{ pack: 'first-aid', doc: 'burns', section: 's', text: 'cool the burn' }],
    formatted: '[first-aid › burns] cool the burn'
  }

  test('records a synthetic reference_lookup and patches libraryContext only when passages return', async () => {
    const { io, calls } = makeIO({
      api: { libraryLookup: async () => lookupOk } as unknown as ProviderIO['api']
    })
    const inp = makeInput({ referenceTurn: true, slotTools: schemas('reference_lookup') })
    const result = await libraryPassagesProvider.gather(inp, io)
    assert.equal(calls.synthetic.length, 1)
    assert.equal(calls.synthetic[0].name, 'reference_lookup')
    assert.equal(calls.synthetic[0].output, lookupOk.formatted)
    assert.equal(calls.patches.length, 1)
    assert.ok('libraryContext' in calls.patches[0])
    assert.deepEqual(result?.blocks, [buildLibraryContext(lookupOk.formatted, false)])
  })

  test('an empty library records nothing and injects nothing', async () => {
    const { io, calls } = makeIO({
      api: {
        libraryLookup: async () => ({ ok: true, passages: [], formatted: '' })
      } as unknown as ProviderIO['api']
    })
    const inp = makeInput({ referenceTurn: true, slotTools: schemas('reference_lookup') })
    assert.equal(await libraryPassagesProvider.gather(inp, io), null)
    assert.equal(calls.synthetic.length, 0)
    assert.equal(calls.patches.length, 0)
  })
})

describe('playbook provider', () => {
  test('gate: on by default, off only when settings disable it', () => {
    const inp = makeInput()
    assert.equal(playbookProvider.enabled(inp, makeIO().io), true)
    assert.equal(
      playbookProvider.enabled(inp, makeIO({ settings: { grounding: { playbooks: false } } }).io),
      false
    )
    assert.equal(playbookProvider.enabled(makeInput({ lastUserContent: undefined }), makeIO().io), false)
  })

  test('no matching playbook contributes nothing', async () => {
    const inp = makeInput({ lastUserContent: 'hello there' })
    assert.equal(await playbookProvider.gather(inp, makeIO().io), null)
  })
})

describe('ledger provider', () => {
  test('gate: on by default, off only when settings disable it', () => {
    assert.equal(ledgerProvider.enabled(makeInput(), makeIO().io), true)
    assert.equal(
      ledgerProvider.enabled(makeInput(), makeIO({ settings: { grounding: { ledger: false } } }).io),
      false
    )
  })

  test('a short conversation injects no ledger', async () => {
    const inp = makeInput({
      convo: {
        id: 'c1',
        messages: [{ id: 'u1', role: 'user', content: 'hi' }]
      } as unknown as TurnInput['convo']
    })
    assert.equal(await ledgerProvider.gather(inp, makeIO().io), null)
  })

  /**
   * Round 12, TTU2, both arms: the disclosure counted one session variable
   * fewer than the run_python block printed a few lines above it. This is
   * where that gap is made — the in-flight reply is excluded, because the
   * block it produces has to reach the model before the model answers — so
   * this is where the disclosure has to say which moment it counts.
   */
  test('the in-flight reply is excluded, and the line patched to the bubble says so', async () => {
    const inFlight = {
      id: 'a1',
      role: 'assistant',
      content: 'The sum is 824,693.',
      toolCalls: [
        {
          id: 't2',
          name: 'run_python',
          args: {},
          status: 'done',
          result: 'total: 824693\nSession variables (persist in this conversation): is_prime, primes, total.'
        }
      ]
    }
    const inp = makeInput({
      assistantMsgId: 'a1',
      convo: {
        id: 'c1',
        messages: [
          { id: 'u1', role: 'user', content: 'the sum of the first 500 primes, in Python' },
          {
            id: 'a0',
            role: 'assistant',
            content: 'Done.',
            toolCalls: [
              {
                id: 't1',
                name: 'run_python',
                args: {},
                status: 'done',
                result: 'primes found: 1229\nSession variables (persist in this conversation): is_prime, primes.'
              }
            ]
          },
          { id: 'u2', role: 'user', content: 'now sum the first 500 of them' },
          inFlight
        ]
      } as unknown as TurnInput['convo']
    })
    const { io, calls } = makeIO()
    const result = await ledgerProvider.gather(inp, io)
    // Two, not the three the reply's own run names — and the line says which
    // moment the two belong to, so the reader can reconcile them.
    assert.equal(calls.patches[0].ledger, '📒 Ledger as this turn began: 1 computed fact, 2 session variables from 2 turns')
    assert.match(result!.blocks![0], /session variables still defined: is_prime, primes\./)
  })
})

describe('shoppingPrice provider', () => {
  test('gate: shopping turns only', () => {
    const { io } = makeIO()
    assert.equal(shoppingPriceProvider.enabled(makeInput({ shoppingTurn: true }), io), true)
    assert.equal(shoppingPriceProvider.enabled(makeInput({ shoppingTurn: false }), io), false)
  })

  test('with shop_compare off, the no-price warning block is injected verbatim', async () => {
    const inp = makeInput({ shoppingTurn: true, lastUserContent: 'best laptop under $1000?' })
    const result = await shoppingPriceProvider.gather(inp, makeIO().io)
    assert.equal(result?.blocks?.length, 1)
    assert.ok(result!.blocks![0].startsWith('This turn is a purchase decision and no price-checking tool is enabled.'))
    assert.ok(result!.blocks![0].includes('Settings → Tools'))
  })

  test('with shop_compare allowlisted, prices the subject and wraps the table', async () => {
    const { io, calls } = makeIO({ runResult: { ok: true, output: '| seller | price |' } })
    const inp = makeInput({
      shoppingTurn: true,
      lastUserContent: 'I want to buy a laptop with 32GB RAM',
      slotTools: schemas('shop_compare')
    })
    const result = await shoppingPriceProvider.gather(inp, io)
    if (calls.runs.length > 0) {
      // shoppingSubject extracted a product; the block wraps the tool output.
      assert.equal(calls.runs[0].name, 'shop_compare')
      const product = calls.runs[0].args.product as string
      assert.deepEqual(result?.blocks, [
        buildSearchContext(`prices for "${product}"`, '| seller | price |')
      ])
    } else {
      // No extractable subject means no call and no block — never a warning
      // (the warning arm is only for a disabled tool).
      assert.equal(result, null)
    }
  })
})

describe('memoryRecall provider', () => {
  const settings = { memory: { autoContext: true, topK: 3 } }

  test('gate: autoContext on, sources not opted out, and a user message', () => {
    const { io } = makeIO({ settings })
    assert.equal(memoryRecallProvider.enabled(makeInput(), io), true)
    assert.equal(memoryRecallProvider.enabled(makeInput(), makeIO({ settings: { memory: { autoContext: false } } }).io), false)
    const optedOut = makeInput({
      convo: { id: 'c1', messages: [], memorySources: [] } as unknown as TurnInput['convo']
    })
    assert.equal(memoryRecallProvider.enabled(optedOut, io), false)
  })

  test('recalled chunks ride the notes with the standing preamble and are disclosed', async () => {
    const { io, calls } = makeIO({
      settings,
      api: {
        memorySearch: async () => ({
          ok: true,
          results: [{ source: 'favorites', score: 0.9, text: 'The user likes Phish.' }]
        })
      } as unknown as ProviderIO['api']
    })
    const result = await memoryRecallProvider.gather(makeInput(), io)
    assert.equal(result?.blocks?.length, 1)
    assert.ok(
      result!.blocks![0].startsWith('Background notes from your long-term local memory.')
    )
    assert.ok(result!.blocks![0].includes('- [favorites] The user likes Phish.'))
    assert.deepEqual(calls.patches, [
      { memoryContext: [{ source: 'favorites', score: 0.9, text: 'The user likes Phish.' }] }
    ])
  })
})

describe('projectRecall provider', () => {
  const project = { id: 'p1', name: 'Kitchen reno', recall: true, files: [] } as unknown as TurnInput['project']
  const conversations = [
    { id: 'c1', projectId: 'p1' },
    { id: 'c2', projectId: 'p1' }
  ] as unknown as TurnInput['conversations']
  const inp = makeInput({
    project,
    conversations,
    convo: { id: 'c1', projectId: 'p1', messages: [] } as unknown as TurnInput['convo']
  })

  test('gate: project recall on and a sibling to recall from', () => {
    const { io } = makeIO()
    assert.equal(projectRecallProvider.enabled(inp, io), true)
    assert.equal(
      projectRecallProvider.enabled(makeInput({ project, conversations: [] }), io),
      false
    )
  })

  test('recalled items ride the notes, count tokens, and are disclosed', async () => {
    const { io, calls } = makeIO({
      api: {
        projectRecall: async () => ({
          ok: true,
          items: [{ conversationId: 'c2', title: 'Budget chat', text: 'The budget is $12k.', score: 0.8 }]
        })
      } as unknown as ProviderIO['api']
    })
    const result = await projectRecallProvider.gather(inp, io)
    assert.equal(result?.blocks?.length, 1)
    assert.ok((result?.projectTokens?.recall ?? 0) > 0)
    assert.equal(calls.patches.length, 1)
    assert.ok('projectContext' in calls.patches[0])
  })
})

describe('attachmentPassages provider', () => {
  const convo = {
    id: 'c1',
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'summarize',
        attachments: [{ id: 'att1', kind: 'file', name: 'doc.pdf', indexed: true, sourcePath: '/tmp/doc.pdf' }]
      }
    ]
  } as unknown as TurnInput['convo']

  test('gate: an indexed attachment or a pinned project file', () => {
    const { io } = makeIO()
    assert.equal(attachmentPassagesProvider.enabled(makeInput({ convo }), io), true)
    assert.equal(attachmentPassagesProvider.enabled(makeInput(), io), false)
  })

  test('passages ride the notes and pinned-file tokens are counted separately', async () => {
    const { io, calls } = makeIO({
      api: {
        attachmentPassages: async () => ({
          ok: true,
          passages: [
            { attachmentId: 'att1', name: 'doc.pdf', text: 'chapter one', score: 0.7 },
            { attachmentId: 'project-file-9', name: 'notes.md', text: 'pinned text', score: 0.6 }
          ],
          notes: []
        })
      } as unknown as ProviderIO['api']
    })
    const result = await attachmentPassagesProvider.gather(makeInput({ convo }), io)
    assert.equal(result?.blocks?.length, 1)
    assert.ok((result?.projectTokens?.files ?? 0) > 0)
    assert.equal(calls.patches.length, 1)
    assert.ok('attachmentContext' in calls.patches[0])
  })
})

describe('tabularProfile provider', () => {
  const convo = {
    id: 'c1',
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'analyze this',
        attachments: [
          { id: 'a1', kind: 'file', name: 'sales.csv', sourcePath: '/tmp/sales.csv' },
          { id: 'a2', kind: 'file', name: 'extra.csv', sourcePath: '/tmp/extra.csv' },
          { id: 'a3', kind: 'file', name: 'third.csv', sourcePath: '/tmp/third.csv' }
        ]
      }
    ]
  } as unknown as TurnInput['convo']

  test('gate: a tabular attachment on the turn and analyze_file allowlisted', () => {
    const { io } = makeIO()
    assert.equal(
      tabularProfileProvider.enabled(makeInput({ convo, slotTools: schemas('analyze_file') }), io),
      true
    )
    assert.equal(tabularProfileProvider.enabled(makeInput({ convo }), io), false)
    assert.equal(
      tabularProfileProvider.enabled(makeInput({ slotTools: schemas('analyze_file') }), io),
      false
    )
  })

  test('profiles at most two files, one block each, naming /work/<file>', async () => {
    const { io, calls } = makeIO({ runResult: { ok: true, output: 'rows: 10' } })
    const result = await tabularProfileProvider.gather(
      makeInput({ convo, slotTools: schemas('analyze_file') }),
      io
    )
    assert.deepEqual(
      calls.runs.map((r) => r.args.file),
      ['sales.csv', 'extra.csv']
    )
    assert.equal(result?.blocks?.length, 2)
    assert.ok(result!.blocks![0].includes('run_python on /work/sales.csv'))
  })
})
