import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, resetState } from './harness'
import { claimKey, contentWords, expiresAtFor, FRESHNESS_MS, LEDGER_PACK_ID } from '../src/shared/factLedger'
import { extractLedgerEntries, sentencesOf, sourcesIn } from '../src/renderer/src/lib/factLedger'
import { factLedgerProvider, LEDGER_EXPIRED_LEAD, LEDGER_FRESH_LEAD } from '../src/renderer/src/lib/contextProviders/factLedger'
import { autoSearchProvider } from '../src/renderer/src/lib/contextProviders/autoSearch'
import { gatherTurnContext, TURN_CONTEXT_PROVIDERS } from '../src/renderer/src/lib/contextProviders'
import type { ProviderIO, TurnInput } from '../src/renderer/src/lib/contextProviders'
import type { LedgerHit } from '../src/shared/factLedger'
import type { ToolCallRecord } from '../src/renderer/src/types'

/**
 * v2.6: the fact ledger. A claim the reply made that a retrieved source
 * states is written with its source and date; a later ask recalls it fresh
 * and skips the search, or re-checks it expired and surfaces what changed.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

const searchRecord = (blocks: { title: string; url: string; snippet: string }[]): ToolCallRecord => ({
  id: 's1',
  name: 'web_search',
  args: { query: 'q' },
  status: 'done',
  result:
    '⚠️ UNTRUSTED EXTERNAL CONTENT\n\nSearch results for "q" via searxng:\n\n' +
    blocks.map((b, i) => `${i + 1}. ${b.title}\n   ${b.url}\n   ${b.snippet}`).join('\n\n')
})

const pageRecord = (url: string, title: string, body: string): ToolCallRecord => ({
  id: 'f1',
  name: 'fetch_webpage',
  args: { url },
  status: 'done',
  result: `⚠️ UNTRUSTED EXTERNAL CONTENT\n\nPage: ${title}\nURL: ${url}\n\n${body}`
})

describe('fact ledger — keys and freshness', () => {
  test('the key is the class and the question’s content words, in any order and any casing', () => {
    assert.deepEqual(contentWords("What is the adult ticket price at the Harrowgate Maritime Museum's door?"), [
      'adult',
      'door',
      'harrowgate',
      'maritime',
      'museum',
      'price',
      'ticket'
    ])
    assert.equal(
      claimKey('money', 'How much is an adult ticket to the Harrowgate Maritime Museum?'),
      claimKey('money', 'Harrowgate Maritime Museum — adult ticket: how much?')
    )
    assert.notEqual(claimKey('money', 'museum ticket'), claimKey('date', 'museum ticket'))
  })

  test('freshness is typed: a price expires in a day, an address in months, a founding year never', () => {
    const t = 1_000_000_000_000
    assert.equal(expiresAtFor('money', t), t + DAY)
    assert.equal(expiresAtFor('address', t), t + 180 * DAY)
    assert.equal(expiresAtFor('historical', t), null)
    assert.equal(FRESHNESS_MS.measurement, 730 * DAY)
  })
})

describe('fact ledger — the capture', () => {
  const question = 'How much is an adult ticket to the Harrowgate Maritime Museum?'
  const records = [
    searchRecord([
      { title: 'Harrowgate Maritime Museum — Visit', url: 'http://127.0.0.1:1/harrowgate-museum.html', snippet: 'admission: adult tickets cost $18.50; children under 12 enter free.' }
    ]),
    pageRecord(
      'http://127.0.0.1:1/harrowgate-museum.html',
      'Harrowgate Maritime Museum — Visit',
      'The Harrowgate Maritime Museum is at 14 Quay Street, Harrowgate. Adult tickets cost $18.50. The guided tour lasts 75 minutes. Tidewater opens on 14 March 2027. Enquiries: (555) 014-2290 or visit@harrowgate.example.'
    )
  ]

  test('sources are the search hits and the fetched page, each with its URL', () => {
    const s = sourcesIn(records)
    assert.equal(s.length, 2)
    assert.ok(s.every((x) => x.url === 'http://127.0.0.1:1/harrowgate-museum.html'))
    assert.match(s[1]!.text, /Quay Street/)
  })

  test('sentences drop markdown furniture and code', () => {
    assert.deepEqual(sentencesOf('## Price\n\n- An adult ticket costs $18.50. Children are free.\n```\n$1\n```'), [
      'An adult ticket costs $18.50.',
      'Children are free.'
    ])
  })

  test('a claim a source states is captured with that source; one entry per class', () => {
    const reply = 'An adult ticket costs $18.50 at the door. The museum is at 14 Quay Street. The tour lasts 75 minutes and Tidewater opens on 14 March 2027. Call (555) 014-2290.'
    const drafts = extractLedgerEntries(reply, records, question)
    const byClass = Object.fromEntries(drafts.map((d) => [d.claimClass, d]))
    assert.equal(byClass.money?.value, '$18.50')
    assert.equal(byClass.money?.url, 'http://127.0.0.1:1/harrowgate-museum.html')
    assert.equal(byClass.money?.sentence, 'An adult ticket costs $18.50 at the door.')
    assert.equal(byClass.address?.value, '14 quay street')
    assert.equal(byClass.measurement?.value, '75 minutes')
    assert.equal(byClass.date?.value, '14 march 2027')
    assert.equal(byClass.contact?.value, '(555) 014-2290')
    assert.ok(drafts.every((d) => d.key === claimKey(d.claimClass, question)))
  })

  test('a claim no source states is not captured, and nothing is captured without a source', () => {
    const drafts = extractLedgerEntries('An adult ticket costs $25.00 and the museum opened in 1901.', records, question)
    assert.deepEqual(drafts, [])
    assert.deepEqual(extractLedgerEntries('An adult ticket costs $18.50.', [], question), [])
  })

  test('a bare year is a claim only with a cue, and a source must state it', () => {
    const page = pageRecord('http://127.0.0.1:1/club.html', 'Club', 'Pellworth Rowing Club was founded in 1898.')
    const yes = extractLedgerEntries('The club was founded in 1898.', [page], 'When was Pellworth Rowing Club founded?')
    assert.equal(yes[0]?.claimClass, 'historical')
    assert.equal(yes[0]?.value, '1898')
    const no = extractLedgerEntries('About 1898 members row there.', [page], 'How many members?')
    assert.deepEqual(no, [])
  })
})

describe('fact ledger — the store', () => {
  const ledger = load<typeof import('../src/main/ipc/factLedger')>('factLedger')
  const lib = load<typeof import('../src/main/ipc/library')>('library')
  let dir = ''
  const draft = (value: string, sentence: string, claimClass: 'money' | 'historical' = 'money') => ({
    key: claimKey(claimClass, 'How much is an adult ticket to the Harrowgate Maritime Museum?'),
    claimClass,
    value,
    sentence,
    url: 'http://127.0.0.1:1/harrowgate-museum.html',
    question: 'How much is an adult ticket to the Harrowgate Maritime Museum?'
  })

  beforeEach(() => {
    resetState()
    dir = mkdtempSync(join(tmpdir(), 'sigma-ledger-'))
    lib.setLibraryDirForTests(dir)
    process.env.SIGMA_LEDGER_NOW = String(1_700_000_000_000)
  })
  afterEach(() => {
    delete process.env.SIGMA_LEDGER_NOW
    lib.setLibraryDirForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a first write is written; the same value again is refreshed; a new value supersedes', async () => {
    const a = await ledger.upsertClaims([draft('$18.50', 'An adult ticket costs $18.50.')])
    assert.deepEqual(a, { written: [draft('$18.50', '').key], refreshed: [], superseded: [] })
    const b = await ledger.upsertClaims([draft('$18.50', 'Adult admission is $18.50.')])
    assert.equal(b.refreshed.length, 1)
    const c = await ledger.upsertClaims([draft('$21.00', 'An adult ticket now costs $21.00.')])
    assert.equal(c.superseded.length, 1)
    assert.equal(c.superseded[0]!.previous, '$18.50')
    assert.equal(c.superseded[0]!.next, '$21.00')
    const stats = await ledger.ledgerStats()
    assert.deepEqual(stats, { entries: 1, expired: 0 })
  })

  test('the pack is kind app, keyword-searchable, and a lookup returns the entry with its dates', async () => {
    await ledger.upsertClaims([draft('$18.50', 'An adult ticket to the Harrowgate Maritime Museum costs $18.50.')])
    const packs = await lib.listPacks()
    assert.equal(packs.length, 1)
    assert.equal(packs[0]!.id, LEDGER_PACK_ID)
    assert.equal(packs[0]!.kind, 'app')
    const r = await ledger.lookupLedger('adult ticket Harrowgate Maritime Museum')
    assert.ok(r.ok)
    assert.equal(r.hits.length, 1)
    const h = r.hits[0]!
    assert.equal(h.value, '$18.50')
    assert.equal(h.checkedAt, 1_700_000_000_000)
    assert.equal(h.expiresAt, 1_700_000_000_000 + DAY)
    assert.equal(h.expired, false)
    assert.match(h.sentence, /^An adult ticket to the Harrowgate/)
    // the formatter prints the machine date for the model
    const looked = await lib.lookupLibrary({ query: 'adult ticket Harrowgate', packId: LEDGER_PACK_ID, topK: 1 })
    assert.match(lib.formatLookup(looked, 'adult ticket'), /checked: 2023-11-14/)
  })

  test('a price is expired a day and two hours later; a founding year never is; purge empties it', async () => {
    await ledger.upsertClaims([
      draft('$18.50', 'An adult ticket costs $18.50.'),
      { ...draft('1898', 'The club was founded in 1898.', 'historical'), question: 'When was the club founded?', key: claimKey('historical', 'When was the club founded?') }
    ])
    process.env.SIGMA_LEDGER_NOW = String(1_700_000_000_000 + 26 * HOUR)
    const price = await ledger.lookupLedger('adult ticket')
    assert.equal(price.hits[0]!.expired, true)
    const year = await ledger.lookupLedger('club founded')
    assert.equal(year.hits[0]!.expired, false)
    assert.equal(year.hits[0]!.expiresAt, null)
    assert.deepEqual(await ledger.ledgerStats(), { entries: 2, expired: 1 })
    await ledger.purgeLedger()
    assert.deepEqual(await ledger.ledgerStats(), { entries: 0, expired: 0 })
    assert.deepEqual(await ledger.lookupLedger('adult ticket'), { ok: true, hits: [] })
  })

  test('a draft without an http source, or with an unknown class, is refused silently', async () => {
    const r = await ledger.upsertClaims([
      { ...draft('$1', 'x'), url: 'file:///etc/passwd' },
      { ...draft('$1', 'x'), claimClass: 'secret' as never },
      'not a draft'
    ])
    assert.deepEqual(r, { written: [], refreshed: [], superseded: [] })
  })
})

describe('fact ledger — the provider', () => {
  const hit = (over: Partial<LedgerHit> = {}): LedgerHit => ({
    key: 'money|adult harrowgate museum ticket',
    claimClass: 'money',
    value: '$18.50',
    sentence: 'An adult ticket costs $18.50.',
    url: 'http://127.0.0.1:1/museum.html',
    checkedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + DAY,
    expired: false,
    score: 0.9,
    ...over
  })
  const input = (): TurnInput =>
    ({
      convo: { id: 'c', messages: [] },
      conversations: [],
      slot: { id: 's', roleName: 'A', modelId: 'm' },
      slotTools: [{ type: 'function', function: { name: 'web_search', description: '', parameters: {} } }],
      lastUserContent: 'How much is an adult ticket?',
      previousUserContent: undefined,
      offline: false,
      factualTurn: true,
      referenceTurn: false,
      shoppingTurn: false,
      project: null,
      assistantMsgId: 'a',
      signal: new AbortController().signal
    }) as unknown as TurnInput
  const io = (hits: LedgerHit[] | null, settings: unknown = { grounding: { factLedger: true } }) => {
    const runs: string[] = []
    const patches: Record<string, unknown>[] = []
    const o = {
      async runTool(name: string) {
        runs.push(name)
        return { ok: true, output: 'results' }
      },
      recordSyntheticCall() {},
      api: hits === null ? {} : { ledgerLookup: async () => ({ ok: true, hits }) },
      patch(p: Record<string, unknown>) {
        patches.push(p)
      },
      settings: () => settings
    } as unknown as ProviderIO
    return { io: o, runs, patches }
  }

  test('rides ahead of the search in the registry, and only there suppresses', () => {
    const ids = TURN_CONTEXT_PROVIDERS.map((p) => p.id)
    assert.equal(ids.indexOf('factLedger'), 0)
    assert.equal(ids.indexOf('autoSearch'), 1)
  })

  test('gated on a factual turn, a wired lookup and the setting', () => {
    assert.equal(factLedgerProvider.enabled(input(), io([]).io), true)
    assert.equal(factLedgerProvider.enabled(input(), io(null).io), false)
    assert.equal(factLedgerProvider.enabled(input(), io([], { grounding: { factLedger: false } }).io), false)
    assert.equal(factLedgerProvider.enabled({ ...input(), factualTurn: false }, io([]).io), false)
  })

  test('a fresh entry is handed over with its date and the app-run search is suppressed', async () => {
    const { io: o, runs, patches } = io([hit()])
    const gathered = await gatherTurnContext([factLedgerProvider, autoSearchProvider], input(), o)
    assert.equal(gathered.blocks.length, 1)
    assert.ok(gathered.blocks[0]!.startsWith(LEDGER_FRESH_LEAD))
    assert.match(gathered.blocks[0]!, /checked 2023-11-14/)
    assert.deepEqual(runs, [])
    assert.deepEqual(patches, [{ ledgerContext: { hits: 1, expired: false, checkedAt: '2023-11-14' } }])
  })

  test('an expired entry is handed over as such and the search runs', async () => {
    const { io: o, runs } = io([hit({ expired: true })])
    const gathered = await gatherTurnContext([factLedgerProvider, autoSearchProvider], input(), o)
    assert.equal(gathered.blocks.length, 2)
    assert.ok(gathered.blocks[0]!.startsWith(LEDGER_EXPIRED_LEAD))
    assert.deepEqual(runs, ['web_search'])
  })

  test('no entry: nothing handed over, nothing patched, search as before', async () => {
    const { io: o, runs, patches } = io([])
    const gathered = await gatherTurnContext([factLedgerProvider, autoSearchProvider], input(), o)
    assert.equal(gathered.blocks.length, 1)
    assert.deepEqual(runs, ['web_search'])
    assert.deepEqual(patches, [])
  })
})
