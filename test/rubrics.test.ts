import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveRequirements,
  parseBudget,
  productQueryFrom,
  rubricFor,
  type Rubric
} from '../src/main/ipc/rubrics'

/**
 * Requirements elicitation is the stage that never touches the network, so the
 * privacy assertion here is structural: `productQueryFrom` *assembles* a query
 * out of thresholds rather than filtering the user's prose. What cannot be
 * constructed cannot leak — that is what the last describe block pins.
 */

const laptop = (): Rubric => {
  const r = rubricFor('I need a new laptop')
  assert.ok(r, 'laptop rubric must exist')
  return r
}

describe('rubricFor', () => {
  test('matches by alias', () => {
    assert.equal(rubricFor('looking for a macbook')?.category, 'laptop')
    assert.equal(rubricFor('best earbuds for the gym')?.category, 'headphones')
    assert.equal(rubricFor('need a new monitor')?.category, 'monitor')
    assert.equal(rubricFor('which phone should I get')?.category, 'phone')
  })

  test('returns null for an uncovered category rather than guessing one', () => {
    assert.equal(rubricFor('I need a new mattress'), null)
  })

  test('does not match a substring of another word', () => {
    assert.equal(rubricFor('the telephone rang'), null)
  })
})

describe('deriveRequirements', () => {
  test('derives editing + travel requirements with their reasons', () => {
    const spec = deriveRequirements(laptop(), {
      primary_use: 'video or photo editing',
      portability: 'constant travel'
    })
    const ram = spec.requirements.find((r) => r.spec === 'ram_gb')
    assert.equal(ram?.value, 32)
    assert.equal(ram?.origin, 'rubric')
    assert.match(ram?.why ?? '', /video editing/)

    const weight = spec.requirements.find((r) => r.spec === 'weight_kg')
    assert.equal(weight?.value, 1.6)
    assert.equal(weight?.op, '<=')

    const battery = spec.requirements.find((r) => r.spec === 'battery_h')
    assert.equal(battery?.value, 8)
  })

  test('the stricter threshold wins when two rules touch the same spec', () => {
    // Baseline says 256 GB storage; editing says 1 TB. 1 TB must survive, and
    // the result must not depend on the order of the rules table.
    const spec = deriveRequirements(laptop(), { primary_use: 'video or photo editing' })
    const storage = spec.requirements.filter((r) => r.spec === 'storage_gb')
    assert.equal(storage.length, 1)
    assert.equal(storage[0].value, 1000)
  })

  test('soft requirements are marked as such', () => {
    const spec = deriveRequirements(laptop(), { primary_use: 'gaming' })
    const refresh = spec.requirements.find((r) => r.spec === 'refresh_hz')
    assert.equal(refresh?.kind, 'soft')
    const gpu = spec.requirements.find((r) => r.spec === 'gpu')
    assert.equal(gpu?.kind, 'hard')
  })

  test('unanswered questions fire no rules', () => {
    const spec = deriveRequirements(laptop(), {})
    // Only the category baseline applies.
    assert.deepEqual(
      spec.requirements.map((r) => r.spec),
      ['storage_gb']
    )
  })

  test('every derived requirement carries a why and an origin', () => {
    const spec = deriveRequirements(laptop(), { primary_use: 'software development', os: 'macOS' })
    for (const r of spec.requirements) {
      assert.ok(r.why.length > 0, `${r.spec} must state why it exists`)
      assert.ok(['user', 'rubric', 'model'].includes(r.origin))
    }
  })
})

describe('parseBudget', () => {
  test('reads a ceiling and a currency', () => {
    assert.deepEqual(parseBudget('around $2000'), { amount: 2000, currency: 'USD' })
    assert.deepEqual(parseBudget('£1,500 max'), { amount: 1500, currency: 'GBP' })
    assert.deepEqual(parseBudget('2k'), { amount: 2000, currency: 'USD' })
  })

  test('returns undefined rather than inventing a number', () => {
    assert.equal(parseBudget('as cheap as possible'), undefined)
    assert.equal(parseBudget(''), undefined)
  })
})

describe('productQueryFrom — the privacy mechanism', () => {
  test('builds a product-shaped query from thresholds', () => {
    const spec = deriveRequirements(laptop(), {
      primary_use: 'video or photo editing',
      portability: 'constant travel',
      budget: '$2500'
    })
    assert.equal(productQueryFrom(spec), 'laptop 32GB RAM 1TB under 2500')
  })

  test('spec order is fixed, so the same answers always produce the same query', () => {
    const answers = { primary_use: 'software development', portability: 'constant travel' }
    const a = productQueryFrom(deriveRequirements(laptop(), answers))
    const b = productQueryFrom(deriveRequirements(laptop(), answers))
    assert.equal(a, b)
    assert.equal(a, 'laptop 16GB RAM 512GB')
  })

  test('carries no free text from the user, because there is no path for it', () => {
    const spec = deriveRequirements(laptop(), {
      primary_use: 'video or photo editing',
      portability: 'constant travel',
      budget: 'about $2500 — it is for editing my wedding videos'
    })
    const query = productQueryFrom(spec)
    for (const leak of ['wedding', 'my', 'editing', 'it is']) {
      assert.ok(!query.toLowerCase().includes(leak), `query leaked "${leak}": ${query}`)
    }
  })

  test('soft requirements do not enter the query', () => {
    const spec = deriveRequirements(laptop(), { portability: 'commute a few times a week' })
    // weight there is soft — it should shape ranking, not the search terms.
    assert.ok(!productQueryFrom(spec).includes('kg'))
  })
})
