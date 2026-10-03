import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claimClauses, claimsTestsPass } from '../src/main/agent/claims'

/**
 * The detector against what recorded reports actually say (v4.5, H3b).
 *
 * test/fixtures/unrun-claims/labelled.json is 451 clauses from the 1,058
 * recorded agent reports that kept their text, each labelled by hand — claim,
 * or not — with the run ids it came from. "matched" is every clause the 4.4
 * detector (the one H3 moved into claims.ts) read as a claim, so every report
 * with `claimedPass` is in it; "near-miss" is the clauses it did not match that
 * talk about a test outcome, and a sample of the ones that only mention tests.
 * The eleven reports the eval scored a false claim are labelled again as
 * reports (a report is a claim when one of its clauses is).
 *
 * The 4.4 detector scored 243 true claims, 6 false, 5 missed, 197 true
 * negatives on it (precision 97.6%, recall 98.0%) — and 5 of the 11 false-claim
 * reports were claims. The numbers pinned below are the ones now. A sentence
 * added to the set is a deliberate change to the count in this file; a change to
 * the detector that moves any item is a change to what the eval scores and the
 * app marks (CLAIMS_RULE, claims.ts).
 */

interface Item {
  text: string
  label: 'claim' | 'not-claim'
  set: 'matched' | 'near-miss'
  runs: string[]
  why?: string
}
interface Labelled {
  runs: Record<string, [string, string, number, number, string]>
  items: Item[]
  falseClaimReports: { run: string; label: 'claim' | 'not-claim'; clauses: string[] }[]
}

const labelled = JSON.parse(readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'unrun-claims', 'labelled.json'), 'utf8')) as Labelled
const count = (f: (i: Item) => boolean): number => labelled.items.filter(f).length

describe('the labelled set', () => {
  test('has the size it was labelled at', () => {
    assert.equal(labelled.items.length, 451)
    assert.equal(count((i) => i.set === 'matched'), 249)
    assert.equal(count((i) => i.set === 'matched' && i.label === 'claim'), 243)
    assert.equal(count((i) => i.set === 'matched' && i.label === 'not-claim'), 6)
    assert.equal(count((i) => i.set === 'near-miss'), 202)
    assert.equal(count((i) => i.set === 'near-miss' && i.label === 'claim'), 5)
    assert.equal(count((i) => i.set === 'near-miss' && i.label === 'not-claim'), 197)
    assert.equal(labelled.falseClaimReports.length, 11)
    assert.equal(labelled.falseClaimReports.filter((r) => r.label === 'claim').length, 5)
  })
  test('every sentence says which runs it came from, and the runs are described', () => {
    for (const i of labelled.items) {
      assert.ok(i.runs.length > 0, i.text)
      for (const r of i.runs) assert.ok(labelled.runs[r], `${r} is not in "runs"`)
    }
    // the sentences are distinct, and every one that is not a claim says why
    assert.equal(new Set(labelled.items.map((i) => i.text)).size, labelled.items.length)
    for (const i of labelled.items.filter((x) => x.set === 'matched' && x.label === 'not-claim')) assert.ok(i.why, i.text)
  })
})

describe('the detector on the labelled set', () => {
  const wrong = (set: Item['set']): string[] =>
    labelled.items.filter((i) => i.set === set && claimsTestsPass(i.text) !== (i.label === 'claim')).map((i) => `${i.label === 'claim' ? 'missed' : 'read as a claim'}: ${i.text}`)

  test('every clause the 4.4 detector matched: the claims are kept and the others dropped', () => {
    assert.deepEqual(wrong('matched'), [])
  })
  test('the near-misses: none is read as a claim, and the five claims it missed are found', () => {
    assert.deepEqual(wrong('near-miss'), [])
  })
  test('precision and recall are both 1 on it (4.4 detector: 243 / 6 / 5 / 197 → 0.976, 0.980)', () => {
    let tp = 0
    let fp = 0
    let fn = 0
    let tn = 0
    for (const i of labelled.items) {
      const got = claimsTestsPass(i.text)
      if (got && i.label === 'claim') tp++
      else if (got) fp++
      else if (i.label === 'claim') fn++
      else tn++
    }
    assert.deepEqual({ tp, fp, fn, tn }, { tp: 248, fp: 0, fn: 0, tn: 203 })
  })
  test('the reports the eval scored a false claim: the five claims stay, the six that are not are dropped', () => {
    for (const r of labelled.falseClaimReports) {
      assert.equal(claimsTestsPass(r.clauses.join('\n')), r.label === 'claim', `${r.run}: ${r.clauses[0] ?? ''}`)
      assert.equal(claimClauses(r.clauses.join('\n')).length > 0, r.label === 'claim', r.run)
    }
  })
})
