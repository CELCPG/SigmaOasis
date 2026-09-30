import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { load } from './harness'
import { parseCitations, renumberPassages } from '../src/renderer/src/lib/citations'
import { libraryYearCheck } from '../src/renderer/src/lib/libraryRecall'
import { webToolsForTurn } from '../src/renderer/src/lib/grounding'
import { libraryPassagesProvider } from '../src/renderer/src/lib/contextProviders/libraryPassages'
import type { ProviderIO, TurnInput } from '../src/renderer/src/lib/contextProviders'
import type { LibraryPassage, ToolSchema } from '../src/renderer/src/types'

/**
 * v4.1 (G5): year-tagged library documents. The finance pack states 2025
 * figures; "what is the standard deduction this year", asked in 2026, got the
 * 2025 passage with no web tool on the wire and nothing naming the year.
 */

const lib = load<typeof import('../src/main/ipc/library')>('library')
const YEAR = new Date().getFullYear()

const passage = (over: Partial<LibraryPassage> = {}): LibraryPassage => ({
  packId: 'finance',
  packName: 'Personal finance & tax basics',
  docId: 'standard-deduction',
  docTitle: 'Tax Topic 551 — Standard deduction',
  section: '',
  position: 0.1,
  text: 'The standard deduction for 2025 is $15,000 for single filers.',
  score: 0.8,
  source: 'https://www.irs.gov/taxtopics/tc551',
  ...over
})

describe('the manifest field', () => {
  const manifest = (appliesToYear: unknown): Record<string, unknown> => ({
    formatVersion: 1,
    id: 'ok-id',
    name: 'x',
    docs: [{ id: 'd', file: 'd.md', appliesToYear }]
  })

  test('a whole year is kept; anything else is dropped, not refused', () => {
    assert.equal(lib.validateManifest(manifest(2025)).docs[0].appliesToYear, 2025)
    for (const bad of ['2025', 2025.5, 1066, null]) {
      assert.equal(lib.validateManifest(manifest(bad)).docs[0].appliesToYear, undefined, String(bad))
    }
  })

  test('the finance pack tags its year-specific documents', () => {
    const m = JSON.parse(readFileSync(join(__dirname, '..', '..', 'packs', 'finance', 'manifest.json'), 'utf8')) as {
      docs: { id: string; appliesToYear?: number }[]
    }
    const year = (id: string): number | undefined => m.docs.find((d) => d.id === id)?.appliesToYear
    assert.equal(year('standard-deduction'), 2025)
    assert.equal(year('inflation-adjustments-2025'), 2025)
    assert.equal(year('who-should-file'), 2025)
    assert.equal(year('credit-score'), undefined, 'a document with no year-bound figures carries none')
    assert.ok(lib.validateManifest(m).docs.some((d) => d.appliesToYear === 2025))
  })
})

describe('formatLookup names the year', () => {
  const outcome = (p: LibraryPassage[]): Parameters<typeof lib.formatLookup>[0] => ({
    ok: true,
    mode: 'keyword',
    notes: [],
    passages: p
  })

  test('each tagged passage says the year it applies to, and the passage text is unchanged', () => {
    const text = lib.formatLookup(outcome([passage({ appliesToYear: 2025 })]), 'standard deduction', 2025)
    assert.match(text, /\n {4}applies to: 2025\n/)
    const [c] = parseCitations(text)
    assert.equal(c.text, 'The standard deduction for 2025 is $15,000 for single filers.')
  })

  test('an older year ends the lookup with a note naming the document and both years', () => {
    const text = lib.formatLookup(outcome([passage({ appliesToYear: 2025 })]), 'standard deduction', 2026)
    assert.match(text, /Note: "Tax Topic 551 — Standard deduction" \(2025\) states figures for its year; it is now 2026\. Check the 2026 figures with web_search/)
    // The note is not a passage header, so renumbering the lookup leaves it whole.
    assert.match(renumberPassages(text, 4), /^\[5\] /m)
    assert.match(renumberPassages(text, 4), /\(2025\) states figures/)
  })

  test('a current or untagged document adds no note', () => {
    assert.doesNotMatch(lib.formatLookup(outcome([passage({ appliesToYear: 2026 })]), 'q', 2026), /Note:/)
    assert.doesNotMatch(lib.formatLookup(outcome([passage()]), 'q', 2026), /applies to|Note:/)
  })
})

describe('libraryYearCheck', () => {
  test('an older document forces the web; the lookup\'s own note names the year', () => {
    assert.deepEqual(libraryYearCheck([passage({ appliesToYear: 2025 })], false, 2026), { forceWeb: true, note: null })
  })

  test('a current document, asked about now, forces the web and says the year', () => {
    const check = libraryYearCheck([passage({ appliesToYear: 2026 })], true, 2026)
    assert.equal(check.forceWeb, true)
    assert.match(check.note ?? '', /\(2026\)/)
  })

  test('a current document not asked about now, or no tag at all, leaves the turn alone', () => {
    assert.deepEqual(libraryYearCheck([passage({ appliesToYear: 2026 })], false, 2026), { forceWeb: false, note: null })
    assert.deepEqual(libraryYearCheck([passage()], true, 2026), { forceWeb: false, note: null })
  })
})

describe('the web tools on the wire', () => {
  test('a reference question about this year carries them before any lookup', () => {
    assert.deepEqual(webToolsForTurn('what is the standard deduction this year?'), ['web_search', 'fetch_webpage'])
    assert.deepEqual(webToolsForTurn('what is the current IRA contribution limit'), ['web_search', 'fetch_webpage'])
  })

  test('the same question without a year word is the library\'s, as before', () => {
    assert.deepEqual(webToolsForTurn('what is the standard deduction'), [])
  })

  function schemas(...names: string[]): ToolSchema[] {
    return names.map((name) => ({ type: 'function' as const, function: { name, description: '', parameters: {} } }))
  }

  async function gather(text: string, appliesToYear: number | undefined, offline = false): Promise<{ forced: string[]; block: string }> {
    const forced: string[] = []
    const p = passage(appliesToYear === undefined ? {} : { appliesToYear })
    const formatted = lib.formatLookup({ ok: true, mode: 'keyword', notes: [], passages: [p] }, text)
    const io = {
      runTool: async () => ({ ok: true }),
      recordSyntheticCall: (_n: string, _a: unknown, out: string) => out,
      api: { libraryLookup: async () => ({ ok: true, passages: [p], mode: 'keyword', notes: [], formatted }) },
      patch() {},
      settings: () => null,
      forceTools: (names: readonly string[]) => forced.push(...names)
    } as unknown as ProviderIO
    const input = {
      lastUserContent: text,
      previousUserContent: undefined,
      offline,
      slotTools: schemas('reference_lookup'),
      referenceTurn: true,
      factualTurn: false
    } as unknown as TurnInput
    const result = await libraryPassagesProvider.gather(input, io)
    return { forced, block: result?.blocks?.[0] ?? '' }
  }

  test('the app\'s lookup forces them when its document is older than this year', async () => {
    const { forced, block } = await gather('what is the standard deduction', YEAR - 1)
    assert.deepEqual(forced, ['web_search', 'fetch_webpage'])
    assert.match(block, new RegExp(`\\(${YEAR - 1}\\) states figures for its year`))
  })

  test('…and for a question about now, naming the year the document is for', async () => {
    const { forced, block } = await gather('what is the standard deduction this year', YEAR)
    assert.deepEqual(forced, ['web_search', 'fetch_webpage'])
    assert.match(block, new RegExp(`tagged with the year their figures are for \\(${YEAR}\\)`))
  })

  test('offline, nothing is forced and no note sends the model to a web it cannot reach', async () => {
    const { forced, block } = await gather('what is the standard deduction this year', YEAR, true)
    assert.deepEqual(forced, [])
    assert.doesNotMatch(block, /tagged with the year/)
  })
})
