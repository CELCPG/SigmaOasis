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
import { contextItemLabel } from '../src/renderer/src/lib/libraryRecall'
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
