import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkToolGrounding,
  describeMatchedMeasurements,
  describeUnbackedItems
} from '../src/renderer/src/lib/toolGrounding'
import { settleRevision } from '../src/renderer/src/hooks/verification'
import type { GroundingReport, ToolCallRecord } from '../src/renderer/src/types'

/**
 * Round 10, task V1 — the recorded loss, and the rule it produced.
 *
 * The app told a reader that a cooking temperature was unverified on a turn
 * whose own retrieved passages state it seventeen times. The corpus every
 * grounding rung reads is the turn's tool records, and it was read once, before
 * the correction pass ran its own two lookups — so what reached the screen was
 * a report about a turn that no longer existed.
 *
 * The fixture is that run's artifacts: the three lookups verbatim, the reply
 * verbatim, and the three lines the app printed under it.
 */
interface V1Fixture {
  run: string
  prompt: string
  reply: string
  /** How many of `lookups` the app itself ran before the model answered. */
  preflightLookups: number
  lookups: { args: Record<string, unknown>; result: string }[]
  warningAsShown: string[]
  stripAsShown: string
}

const V1 = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', 'test/fixtures/citations/v1-r10-revision-lookups.json'),
    'utf-8'
  )
) as V1Fixture

/** The turn's records as the bubble holds them: the pre-flight first, then the revision's. */
function held(take = V1.lookups.length): ToolCallRecord[] {
  return V1.lookups.slice(0, take).map((l, i) => ({
    id: i === 0 ? 'preflight' : `revision-${i}`,
    name: 'reference_lookup',
    args: l.args,
    status: 'done' as const,
    result: l.result
  }))
}

/** The badge as the reader reads it, from a report. */
function badgeLines(report: GroundingReport | null): string[] {
  if (!report) return []
  return [
    `⚠️ ${describeUnbackedItems(report)}`,
    describeMatchedMeasurements(report),
    `Checked against: ${report.checkedAgainst.join(', ')}.`
  ].filter((l) => l !== '' && l !== '⚠️ ')
}

/**
 * Grade against a **live** record list, the way the app does — `allRecords` is
 * one array for the whole turn and the correction pass appends to it.
 */
function grader(records: ToolCallRecord[]) {
  return async (content: string): Promise<GroundingReport | null> =>
    checkToolGrounding(content, records, V1.prompt, {})
}

describe('the round-10 V1 run: a corpus read before the revision retrieved the answer', () => {
  test('the run: the temperature is in the turn, and not in the lookup the check read', () => {
    // Preconditions. Without these the case below proves nothing.
    assert.equal(V1.lookups.length, 3)
    assert.equal(V1.preflightLookups, 1)
    const counts = V1.lookups.map((l) => (l.result.match(/165/g) ?? []).length)
    assert.equal(counts[0], 0, 'the pre-flight lookup states no temperature at all')
    assert.equal(
      counts.reduce((a, b) => a + b, 0),
      7,
      'the turn as a whole states it seven times in its passages'
    )
    // Including the row a reader would check it against.
    assert.match(
      V1.lookups[1]!.result,
      /\| Chicken, turkey, and other poultry \|[^|]*\| 165°F \(74°C\) \|/
    )
    assert.match(
      V1.lookups[1]!.result,
      /Poultry: Cook all poultry to an internal temperature of 165° F/
    )
    // And the two queries that prove WHEN those lookups ran: each is one of the
    // findings below, turned into a search. A model writes those only after it
    // has been handed the report.
    assert.deepEqual(
      V1.lookups.slice(1).map((l) => l.args.query),
      [
        'safe internal cooking temperature for poultry chicken',
        'how long cooked chicken lasts in the refrigerator storage time'
      ]
    )
  })

  test('the loss, reproduced: the pre-flight lookup alone prints what shipped', () => {
    const stale = checkToolGrounding(V1.reply, held(1), V1.prompt, {})
    assert.ok(stale)
    assert.deepEqual(stale.quantities, ['165 °F'])
    assert.deepEqual(badgeLines(stale), V1.warningAsShown)
  })

  test('the cure: the turn as it finally stands has nothing to fault', () => {
    assert.equal(checkToolGrounding(V1.reply, held(), V1.prompt, {}), null)
  })

  test('settleRevision publishes the turn as it stands, not as it was', async () => {
    // The app's arrangement: one record list for the turn, the report built
    // from it before the correction pass, the pass appending its own lookups.
    const records = held(1)
    const stale = checkToolGrounding(V1.reply, records, V1.prompt, {})!
    assert.deepEqual(stale.quantities, ['165 °F'], 'the report the old code carried')
    records.push(...held().slice(1))

    // The deadline cut the revision off before it rewrote anything — the V1
    // shape exactly ("Not run: the revision. The answer above is unchanged.").
    const verdict = await settleRevision({
      draft: V1.reply,
      revised: '',
      abandoned: true,
      grade: grader(records)
    })

    assert.equal(verdict.keep, 'draft', 'the answer the reader read is unchanged')
    assert.equal(verdict.grounding, null, 'and it carries no badge, because nothing is unbacked')
    assert.deepEqual(badgeLines(verdict.grounding), [])
  })

  test('every rung was stale, not only measurements', () => {
    // One reply, four rungs, all four graded against the pre-flight lookup and
    // all four wrong about the turn. The link and the passage line below appear
    // ONLY in the lookups the correction pass ran.
    const reply =
      'Cook poultry to 165 °F — "Cook all poultry to an internal temperature of 165° F ' +
      'as measured with a food thermometer" [8]. ' +
      'Source: https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/safe-temperature-chart'

    const stale = checkToolGrounding(reply, held(1), V1.prompt, {})
    assert.ok(stale, 'the pre-flight corpus faults this reply')
    // Both spellings the reply writes it in — the reader's and the passage's.
    assert.deepEqual(stale.quantities, ['165 °F', '165° F'], 'measurements')
    assert.deepEqual(stale.citations, ['[8]'], 'citations')
    assert.equal(stale.links?.length, 1, 'links')
    assert.ok((stale.quotes?.length ?? 0) > 0, 'quotations')

    // The same reply against the same turn's full records: every one of them
    // was a claim about a corpus that had already grown.
    assert.equal(checkToolGrounding(reply, held(), V1.prompt, {}), null)
  })
})

describe('re-grading does not make the rungs toothless', () => {
  /**
   * The point of the fix is that the corpus spans the whole turn — never that
   * a wider corpus excuses more. Each case below is a genuine invention on the
   * SAME three-lookup turn, and each must still be caught after re-grading.
   */
  test('a temperature in none of the three lookups is still flagged', async () => {
    const invented = V1.reply.replace('165 °F', '200 °F')
    const records = held()
    const report = checkToolGrounding(invented, records, V1.prompt, {})
    assert.ok(report, 'the full corpus still faults an invented temperature')
    assert.deepEqual(report.quantities, ['200 °F'])

    const verdict = await settleRevision({
      draft: invented,
      revised: '',
      abandoned: true,
      grade: grader(records)
    })
    assert.equal(verdict.keep, 'draft')
    assert.deepEqual(verdict.grounding?.quantities, ['200 °F'])
    assert.deepEqual(badgeLines(verdict.grounding), [
      '⚠️ 1 measurement (200 °F) in this reply is not backed by the tool output.',
      'Matched by value, not by row: 4 days — [5], [14], 3 lines; 1 week — [5], [14], 10 lines.' +
        ' Where a value is stated on more than one line, only the passage itself shows which one' +
        ' the answer took it from.',
      'Checked against: reference_lookup.'
    ])
  })

  test('a link in none of the three lookups is still flagged', async () => {
    const reply = `${V1.reply}\n\nSource: https://www.example.gov/invented-chart`
    const records = held()
    const verdict = await settleRevision({
      draft: reply,
      revised: '',
      abandoned: true,
      grade: grader(records)
    })
    assert.deepEqual(verdict.grounding?.links, ['https://www.example.gov/invented-chart'])
  })

  test('a citation past the seventeen passages retrieved is still flagged', async () => {
    const reply = V1.reply.replace('[5]', '[42]')
    const records = held()
    const verdict = await settleRevision({
      draft: reply,
      revised: '',
      abandoned: true,
      grade: grader(records)
    })
    assert.deepEqual(verdict.grounding?.citations, ['[42]'])
  })

  test('a Stop during the revision still publishes what the turn can fault', async () => {
    const invented = V1.reply.replace('165 °F', '200 °F')
    const records = held()
    const verdict = await settleRevision({
      draft: invented,
      revised: 'Cook it to 200 °F.',
      abandoned: true,
      grade: grader(records)
    })
    assert.equal(verdict.keep, 'draft', 'an abandoned revision never replaces the answer')
    assert.deepEqual(verdict.grounding?.quantities, ['200 °F'])
  })
})

describe('the improvement comparison reads one corpus, not two', () => {
  /**
   * `revisionIsAnImprovement` counts findings before against findings after. If
   * "before" is graded on the pre-flight lookup and "after" on the whole turn,
   * the difference it measures is the corpus growing — so a rewrite that
   * changed nothing scores as a correction, and the app takes credit for a fix
   * it did not make.
   */
  test('a revision that changed nothing is not recorded as a correction', async () => {
    const records = held(1)
    const staleCount = checkToolGrounding(V1.reply, records, V1.prompt, {})?.quantities?.length
    assert.equal(staleCount, 1, 'the draft was faulted, on the narrow corpus')
    records.push(...held().slice(1))

    // The model returns the same claim in different words, having retrieved the
    // passages that back it. Nothing was corrected.
    const verdict = await settleRevision({
      draft: V1.reply,
      revised: 'Internal temperature: 165 °F for poultry — [1]. Fridge: 3 to 4 days — [5].',
      abandoned: false,
      grade: grader(records)
    })
    assert.equal(verdict.keep, 'draft')
    assert.equal(verdict.grounding, null)
    // Not merely undefined — the key is absent, because the draft verdict has
    // no before/after pair to claim. The type says so; this checks the value.
    assert.ok(!('corrected' in verdict), 'no before/after pair is claimed')
  })

  test('a revision that removes a real invention is still kept', async () => {
    const records = held()
    const verdict = await settleRevision({
      draft: `${V1.reply}\n\nSee https://www.example.gov/invented-chart`,
      revised: V1.reply,
      abandoned: false,
      grade: grader(records)
    })
    assert.equal(verdict.keep, 'revision')
    assert.deepEqual(verdict.corrected?.before.links, ['https://www.example.gov/invented-chart'])
    assert.equal(verdict.corrected?.after, null)
    assert.equal(verdict.grounding, null)
  })
})
