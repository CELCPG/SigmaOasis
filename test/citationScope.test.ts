import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { runAgentLoop, type AgentLoopDeps, type ApiMessage, type ApiToolCall } from '../src/renderer/src/lib/agentLoop'
import {
  citedIndices,
  danglingCitations,
  parseCitations,
  retrievedCitations
} from '../src/renderer/src/lib/citations'
import {
  LIBRARY_MISS_LABEL,
  LIBRARY_STRIP_LABEL,
  UNCITED_MARK,
  UNSETTLED_MARK,
  contextItemLabel,
  libraryStrip,
  type LibraryStrip
} from '../src/renderer/src/lib/libraryRecall'
import type { ToolCallRecord, ToolSchema } from '../src/renderer/src/types'

/**
 * A marker that resolves to the wrong passage is worse than one that resolves
 * to nothing: the reader who follows it comes away confidently misinformed.
 *
 * Both fixtures are captured turns, not written ones — the tool blocks are the
 * verbatim `record.result` text the app stored, lifted out of
 * `.h2h-runs/judge-r4/*​/run-1/transcript.json`.
 *
 * TH3/run-1 ran `reference_lookup` twice. Each result numbered its own
 * passages from [1], so the turn handed the model two different `[1]`s: the
 * FDA's power-outage passage, and the USDA line the reply then quoted
 * verbatim. The reply cites "[1]" and "[5]" meaning the second lookup's, and
 * everything that resolves a marker — the strip, the inline link, the
 * grounding check — read the first's.
 *
 * V2/run-1 ran it once. Nothing about that turn may change.
 */

interface LookupFixture {
  run: string
  prompt: string
  lookups: { args: Record<string, unknown>; result: string }[]
  reply: string
  strip: { index: number; source: string; score: number; text: string }[]
  stripAsShown: string
}

function fixture(name: string): LookupFixture {
  return JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'test/fixtures/citations', name), 'utf-8')
  ) as LookupFixture
}

const TH3 = fixture('th3-two-lookups.json')
const V2 = fixture('v2-one-lookup.json')

const LOOKUP_TOOL: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'reference_lookup',
      description: 'Search the local reference library.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, max_passages: { type: 'number' } },
        required: ['query']
      }
    }
  }
]

function toolCall(id: string, args: Record<string, unknown>): ApiToolCall {
  return { id, type: 'function', function: { name: 'reference_lookup', arguments: JSON.stringify(args) } }
}

/** The record the app-initiated pre-flight lookup leaves on the turn before the loop starts. */
function preflight(f: LookupFixture): ToolCallRecord {
  return {
    id: 'preflight',
    name: 'reference_lookup',
    args: f.lookups[0].args,
    status: 'done',
    result: f.lookups[0].result
  }
}

/**
 * Run the turn the way the app runs it: pre-flight records already on the
 * list, the model asking for one more lookup, the real result coming back.
 * Returns the shared record list and the wire history the model saw.
 */
async function turn(
  records: ToolCallRecord[],
  call: { args: Record<string, unknown>; result: string }
): Promise<{ records: ToolCallRecord[]; messages: ApiMessage[] }> {
  const rounds = [
    { content: '', toolCalls: [toolCall('c1', call.args)] },
    { content: 'answer', toolCalls: [] }
  ]
  const messages: ApiMessage[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'question' }
  ]
  const deps: AgentLoopDeps = {
    streamRound: async () => rounds.shift() ?? { content: 'done', toolCalls: [] },
    executeTool: async () => ({ ok: true, output: call.result })
  }
  await runAgentLoop({ messages, tools: LOOKUP_TOOL, records, signal: new AbortController().signal, deps })
  return { records, messages }
}

/** Every number the turn printed above a passage, in the order the model read them. */
function handedOver(records: ToolCallRecord[]): { index: number; label: string }[] {
  return records.flatMap((r) => parseCitations(r.result ?? '').map((c) => ({ index: c.index, label: c.label })))
}

/** The marker printed above the passage whose body carries `needle`. */
function markerFor(records: ToolCallRecord[], needle: string): number {
  for (const r of records) {
    const text = r.result ?? ''
    const heads = [...text.matchAll(/^\[(\d{1,3})\][ \t]+\S.*$/gm)]
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].index
      const end = i + 1 < heads.length ? heads[i + 1].index : text.length
      if (text.slice(start, end).includes(needle)) return Number(heads[i][1])
    }
  }
  throw new Error(`no passage in this turn carries "${needle}"`)
}

/** The USDA line the TH3 reply quoted verbatim. It is in the SECOND lookup. */
const QUOTED = 'Leftovers can be kept in the refrigerator for 3 to 4 days'
/** The passage the first lookup put at [1]: a power-outage checklist, no storage figure. */
const POWER_OUTAGE = /Refrigerator thermometers — cold facts \(FDA\) › In Case of Disaster/

describe('two lookups in one turn (judge-r4/TH3/run-1)', () => {
  test('the run: the strip lists the first lookup, the reply cites the second', () => {
    // What the strip showed — the pre-flight lookup's five, in its order.
    assert.deepEqual(TH3.strip.map((s) => s.index), [1, 2, 3, 4, 5])
    assert.match(TH3.strip[0].source, POWER_OUTAGE)
    assert.ok(TH3.stripAsShown.startsWith('Food safety › Refrigerator thermometers'))
    // What the reply cited, and where the line it quoted actually came from.
    assert.deepEqual(citedIndices(TH3.reply), [1, 5])
    assert.ok(TH3.reply.includes(QUOTED))
    assert.throws(() => markerFor([preflight(TH3)], QUOTED), /no passage in this turn carries/)
    assert.equal(markerFor([{ ...preflight(TH3), result: TH3.lookups[1].result }], QUOTED), 1)
  })

  test('every number the model is handed resolves back to the passage under it', async () => {
    const { records } = await turn([preflight(TH3)], TH3.lookups[1])
    const resolved = new Map(retrievedCitations(records).map((c) => [c.index, c.label]))
    for (const { index, label } of handedOver(records)) {
      assert.equal(resolved.get(index), label, `[${index}] was handed over for "${label}"`)
    }
  })

  test('the marker on the quoted line names the passage that carries it', async () => {
    const { records } = await turn([preflight(TH3)], TH3.lookups[1])
    const resolved = new Map(retrievedCitations(records).map((c) => [c.index, c.label]))
    const marker = markerFor(records, QUOTED)
    assert.match(resolved.get(marker) ?? '', /Leftovers and food safety \(USDA\) › Store Leftovers Safely/)
    assert.doesNotMatch(resolved.get(marker) ?? '', POWER_OUTAGE)
  })

  test('the turn hands over 17 passages, not 12 with five numbers claimed twice', async () => {
    const { records } = await turn([preflight(TH3)], TH3.lookups[1])
    assert.equal(handedOver(records).length, 17)
    assert.equal(retrievedCitations(records).length, 17)
  })
})

describe('one lookup in a turn is unchanged (judge-r4/V2/run-1)', () => {
  test('the model-facing text is byte-identical and [1] still names the quoted passage', async () => {
    const { records, messages } = await turn([], V2.lookups[0])
    assert.equal(records.length, 1)
    assert.equal(records[0].result, V2.lookups[0].result)
    assert.equal(messages.find((m) => m.role === 'tool')?.content, V2.lookups[0].result)
    const retrieved = retrievedCitations(records)
    assert.deepEqual(retrieved.map((c) => c.index), [1, 2, 3, 4, 5])
    assert.equal(markerFor(records, 'the standard deduction rises to $30,000'), 1)
    assert.match(retrieved[0].label, /^Personal finance & tax basics › Tax inflation adjustments/)
    assert.deepEqual(danglingCitations(V2.reply, retrieved), [])
  })
})

describe('the strip says which passages the answer used (judge-r4/V2/run-1)', () => {
  const cited = new Set(citedIndices(V2.reply))
  const items = V2.strip.map((s) => ({
    source: s.source,
    score: s.score,
    text: s.text,
    index: s.index,
    cited: cited.has(s.index)
  }))

  test('the reply cited one of the five passages the strip lists as provenance', () => {
    assert.deepEqual([...cited], [1])
    assert.deepEqual(items.filter((i) => !i.cited).map((i) => i.index), [2, 3, 4, 5])
  })

  test('an uncited entry is marked; a cited one is not', () => {
    assert.match(contextItemLabel(items[0]), /^\[1\] Personal finance & tax basics › Tax inflation adjustments/)
    assert.doesNotMatch(contextItemLabel(items[0]), /not cited/)
    // [4] is the entry a critic reached: scraped page furniture — a "Related"
    // list and a share widget, no figure anywhere in it — listed at 0.65 as
    // though it were a source for the answer.
    assert.equal(
      items[3].text,
      '## Related\n\nTaxable income Filing status Publication 501, Dependents, Standard Deduction, ' +
        'and Filing Information\n\n✓\nThanks for sharing!\nAddToAny\nMore…'
    )
    assert.equal(items[3].score, 0.648)
    assert.match(contextItemLabel(items[3]), /Who should file a tax return › Related/)
    assert.match(contextItemLabel(items[3]), /not cited/)
  })
})

// ---- v1.17.2: the strip, the binder and the answer, made to agree ------------

/**
 * Round 5 made a turn's passage numbering global. Three round-7 critics found
 * what that left behind: the strip is still built from ONE lookup's passages,
 * the binder still cannot see a marker written next to another one, and the
 * relevance-floor caption still speaks for a whole strip it never examined.
 *
 * All three fixtures below are captured turns from
 * `.h2h-runs/judge-r7/*​/transcript.json` — the verbatim `record.result` text
 * the app stored, its `reply.md`, and `stripAsShown`: the provenance line
 * exactly as the shipped build printed it under that answer.
 */
interface R7Fixture {
  run: string
  prompt: string
  lookups: { args: Record<string, unknown>; result: string }[]
  reply: string
  /** The 📖 line the shipped build rendered, scraped from the run's transcript. */
  stripAsShown: string
}

function r7(name: string): R7Fixture {
  return JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'test/fixtures/citations', name), 'utf-8')
  ) as R7Fixture
}

/** V1/run-2: three lookups, seventeen passages, a strip that listed five. */
const R7_V1 = r7('v1-three-lookups.json')
/** V2/run-1: the reply cites "[2][5]" and the app saw only the [2]. */
const R7_V2 = r7('v2-adjacent-markers.json')
/** TH3/run-1: the floor caption and the strip's marks contradicting each other. */
const R7_TH3 = r7('th3-floor-then-cited.json')

/** The turn's records as the bubble holds them: the pre-flight first, then the model's. */
function held(f: R7Fixture, take = f.lookups.length): ToolCallRecord[] {
  return f.lookups.slice(0, take).map((l, i) => ({
    id: i === 0 ? 'preflight' : `c${i}`,
    name: 'reference_lookup',
    args: l.args,
    status: 'done' as const,
    result: l.result
  }))
}

/** The strip's collapsed header, as one string, the way the button renders it. */
function headerOf(s: LibraryStrip): string {
  return [s.label, s.detail ?? s.items.map(contextItemLabel).join(', '), s.note].filter(Boolean).join(' ')
}

describe('three lookups, a strip that showed one (judge-r7/V1/run-2)', () => {
  test('the run: the answer cites [8] [9] [14] and none of the three is in the strip', () => {
    assert.equal(R7_V1.lookups.length, 3)
    assert.deepEqual(citedIndices(R7_V1.reply), [8, 9, 14])
    for (const marker of ['[8]', '[9]', '[14]']) {
      assert.ok(R7_V1.reply.includes(marker), `the reply cites ${marker}`)
      assert.ok(!R7_V1.stripAsShown.includes(marker), `${marker} was nowhere in the strip`)
    }
    // Every entry it did show was marked as unused, under an answer using three.
    assert.equal(R7_V1.stripAsShown.match(/— not cited/g)?.length, 5)
  })

  test('every passage the turn retrieved is now listed, and the three cited ones are among them', () => {
    const strip = libraryStrip({ records: held(R7_V1), answer: R7_V1.reply, miss: false, preflight: 5 })
    assert.ok(strip)
    assert.equal(strip.items.length, 17)
    assert.deepEqual(strip.items.map((i) => i.index), Array.from({ length: 17 }, (_, i) => i + 1))
    assert.deepEqual(strip.items.filter((i) => i.cited).map((i) => i.index), [8, 9, 14])
    assert.deepEqual(danglingCitations(R7_V1.reply, retrievedCitations(held(R7_V1))), [])
  })

  test('the five it used to list read exactly as they did, marks and all', () => {
    const strip = libraryStrip({ records: held(R7_V1), answer: R7_V1.reply, miss: false, preflight: 5 })!
    const asShown = `📖 From the library: ${strip.items.slice(0, 5).map(contextItemLabel).join(', ')}`
    assert.equal(asShown, R7_V1.stripAsShown)
  })

  test('the collapsed header answers "which one is [14]" instead of printing seventeen lines', () => {
    const strip = libraryStrip({ records: held(R7_V1), answer: R7_V1.reply, miss: false, preflight: 5 })!
    assert.equal(
      headerOf(strip),
      '📖 From the library: 17 passages from 3 lookups — the answer cites [8] [9] [14].'
    )
    // The list is not silently dropped — it moves into the panel, under a
    // heading per lookup, so [14] is one glance rather than one expansion of
    // the third tool block.
    assert.equal(strip.groups?.length, 3)
    assert.deepEqual(strip.groups?.map((g) => g.items.length), [5, 6, 6])
    assert.match(strip.groups![0].heading, /^The app looked this up before the model answered · \[1\]–\[5\] · /)
    assert.match(strip.groups![1].heading, /^The model looked this up · \[6\]–\[11\] · /)
    assert.match(strip.groups![2].heading, /^The model looked this up · \[12\]–\[17\] · /)
    assert.ok(strip.groups!.every((g) => g.heading.length < 140), 'a heading stays one line')
  })

  test('a marker the app cannot resolve withdraws "not cited" rather than asserting it', () => {
    // The same turn as the app knew it when only the pre-flight had been
    // recorded: [8], [9] and [14] name nothing it can see.
    const strip = libraryStrip({ records: held(R7_V1, 1), answer: R7_V1.reply, miss: false, preflight: 5 })!
    assert.equal(strip.items.length, 5)
    assert.ok(strip.items.every((i) => i.cited === undefined && i.unsettled === true))
    assert.equal(headerOf(strip).includes(UNCITED_MARK), false)
    assert.equal(strip.items.filter((i) => contextItemLabel(i).includes(UNSETTLED_MARK)).length, 5)
    assert.equal(strip.note, '⚠️ [8] [9] [14] name no passage listed here, so the rest are left unjudged.')
  })
})

describe('two markers written together (judge-r7/V2/run-1)', () => {
  test('the run: the reply cites [2][5] and the strip called [5] uncited', () => {
    assert.ok(R7_V2.reply.includes('(as noted in Topic no. 551) [2][5]'))
    assert.match(
      R7_V2.stripAsShown,
      /\[5\] Personal finance & tax basics › Tax Topic 551 — Standard deduction › Topic no\. 551, Standard deduction · 0% in \(0\.63\) — not cited/
    )
  })

  test('[5] is read as a citation, so the strip stops denying it', () => {
    assert.deepEqual(citedIndices(R7_V2.reply), [1, 2, 5])
    const strip = libraryStrip({ records: held(R7_V2), answer: R7_V2.reply, miss: false, preflight: 5 })!
    const five = strip.items.find((i) => i.index === 5)!
    assert.equal(five.cited, true)
    assert.doesNotMatch(contextItemLabel(five), /not cited/)
    assert.match(contextItemLabel(five), /^\[5\] Personal finance & tax basics › Tax Topic 551/)
    // …and the marker the reader could not follow has somewhere to go: the
    // page the lookup had already retrieved, both inline and in the strip.
    assert.equal(five.url, 'https://www.irs.gov/taxtopics/tc551')
    assert.equal(retrievedCitations(held(R7_V2)).find((c) => c.index === 5)?.href, 'https://www.irs.gov/taxtopics/tc551')
  })
})

describe('the floor caption and the strip, in one message (judge-r7/TH3/run-1)', () => {
  test('the run: "the answer is not backed by it", over a strip marking [5] as used', () => {
    assert.equal(R7_TH3.stripAsShown.startsWith(LIBRARY_MISS_LABEL), true)
    assert.deepEqual(citedIndices(R7_TH3.reply), [5])
    assert.ok(R7_TH3.reply.includes('The closest passage is [5]'))
    assert.ok(R7_TH3.reply.includes('3 to 4 days'))
  })

  test('the caption now says what the answer did, and the marks agree with it', () => {
    const strip = libraryStrip({ records: held(R7_TH3), answer: R7_TH3.reply, miss: true, preflight: 5 })!
    assert.equal(
      strip.label,
      '📖 Nothing in the library covers this question — the answer cites [5] from it anyway.'
    )
    assert.doesNotMatch(strip.label, /not backed by it/)
    // The measured half survives: the floor finding is still the lead.
    assert.match(strip.label, /^📖 Nothing in the library covers this question/)
    // …and the one entry the caption names is the one entry left unmarked.
    assert.deepEqual(strip.items.filter((i) => i.cited).map((i) => i.index), [5])
    assert.deepEqual(strip.items.filter((i) => i.cited === false).map((i) => i.index), [1, 2, 3, 4])
    assert.equal(strip.detail, R7_TH3.stripAsShown.slice(LIBRARY_MISS_LABEL.length + 1))
  })

  test('a floor miss the answer leaned on nothing keeps the original caption, word for word', () => {
    const strip = libraryStrip({
      records: held(R7_TH3),
      answer: 'The library has nothing on how long cooked rice keeps. I would not guess at it.',
      miss: true,
      preflight: 5
    })!
    assert.equal(strip.label, LIBRARY_MISS_LABEL)
    assert.equal(headerOf(strip), R7_TH3.stripAsShown)
  })

  test('a floor miss whose turn went on to retrieve more stops speaking for what it never saw', () => {
    const strip = libraryStrip({ records: held(R7_V1), answer: R7_V1.reply, miss: true, preflight: 5 })!
    assert.equal(
      strip.label,
      '📖 Nothing in the 5 passages the app looked up covers this question; the model then retrieved 12 more.'
    )
    assert.doesNotMatch(strip.label, /Nothing in the library covers this question/)
  })
})

describe('one lookup and honest citations produces no new noise', () => {
  /** The turn from judge-r4/V2/run-1: one lookup, five passages, `[1]` cited. */
  const records: ToolCallRecord[] = [
    { id: 'preflight', name: 'reference_lookup', args: V2.lookups[0].args, status: 'done', result: V2.lookups[0].result }
  ]

  test('no grouping, no summary, no warning — the flat numbered line, spelled out', () => {
    const strip = libraryStrip({ records, answer: V2.reply, miss: false, preflight: 5 })!
    assert.equal(strip.groups, undefined)
    assert.equal(strip.detail, undefined)
    assert.equal(strip.note, undefined)
    assert.equal(strip.label, LIBRARY_STRIP_LABEL)
    assert.equal(
      headerOf(strip),
      '📖 From the library: ' +
        '[1] Personal finance & tax basics › Tax inflation adjustments for tax year 2025 › ' +
        'Notable changes for tax year 2025 · 10% in (1.00), ' +
        '[2] Personal finance & tax basics › Tax Topic 501 — Should I itemize? › ' +
        'Topic no. 501, Should I itemize? · 0% in (1.00) — not cited, ' +
        '[3] Personal finance & tax basics › Tax Topic 551 — Standard deduction › ' +
        'Not eligible for the standard deduction · 63% in (0.70) — not cited, ' +
        '[4] Personal finance & tax basics › Who should file a tax return › Related · 97% in (0.65) — not cited, ' +
        '[5] Personal finance & tax basics › Tax Topic 551 — Standard deduction › ' +
        'Topic no. 551, Standard deduction · 0% in (0.63) — not cited'
    )
    // `stripAsShown` in this round-4 fixture predates both the numbers and the
    // marks, so it is the citation list and nothing else: what has been ADDED
    // since is exactly the numbering and the "not cited", and nothing else.
    for (const entry of V2.stripAsShown.split(', ')) assert.ok(headerOf(strip).includes(entry), entry)
  })

  test('the marks are the ones the round-4 fixture already pinned: [1] used, the rest not', () => {
    const strip = libraryStrip({ records, answer: V2.reply, miss: false, preflight: 5 })!
    assert.deepEqual(strip.items.map((i) => i.cited), [true, false, false, false, false])
    assert.ok(strip.items.every((i) => i.unsettled === undefined))
    // The strip is built from the tool record now, so it has to reproduce what
    // the passage array produced: same citation, same relevance, same text.
    for (const [i, recorded] of V2.strip.entries()) {
      assert.equal(strip.items[i].index, recorded.index)
      assert.equal(strip.items[i].source, recorded.source)
      assert.equal(strip.items[i].score, recorded.score)
      assert.equal(strip.items[i].text, recorded.text)
    }
  })

  test('a turn that ran no library lookup has no strip at all', () => {
    assert.equal(libraryStrip({ records: [], answer: V2.reply, miss: false, preflight: 0 }), null)
    assert.equal(
      libraryStrip({
        records: [{ id: 'w', name: 'web_search', args: {}, status: 'done', result: V2.lookups[0].result }],
        answer: V2.reply,
        miss: false,
        preflight: 0
      }),
      null
    )
  })
})
