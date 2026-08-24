import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { describeRecompute, recomputeIsCircular } from '../src/renderer/src/lib/workbenchChecks'
import {
  LIBRARY_MISS_LABEL,
  LIBRARY_STRIP_LABEL,
  libraryMissedTheQuestion,
  questionCoverage
} from '../src/renderer/src/lib/libraryRecall'

/**
 * v1.12.2 — the chrome may not claim a check the app did not make. Both cases
 * are the recorded faucet-drip turn (head-to-head V3), which showed a passed
 * recomputation and a "From the library:" provenance strip on a turn where
 * neither the figures nor the answer had been compared with anything.
 */
const QUESTION =
  'My kitchen faucet drips about once a second. How much water is that wasting a month, and is it worth fixing myself?'

/** Verbatim from the recording — the program the app ran and disclosed as a check. */
const CIRCULAR_PROGRAM = `def calculate_faucet_waste():
    # Inputs from the question
    drip_rate_per_second = 1  # once per second
    days_per_month = 30
    gallons_per_day_at_one_drip_per_sec = 20  # EPA standard estimate

    # Compute monthly waste in gallons
    gallons_per_month = drip_rate_per_second * gallons_per_day_at_one_drip_per_sec * days_per_month

    # Compute cost (assuming $5 per 1,000 gallons)
    cost_per_1000_gallons = 5.0
    monthly_cost = gallons_per_month / 1000 * cost_per_1000_gallons

    print(f"gallons wasted per month: {gallons_per_month:.0f}")
    print(f"monthly water cost: \${monthly_cost:.2f}")

calculate_faucet_waste()`

/** The five passages the library actually returned, at their recorded scores. */
const RETRIEVED = [
  {
    score: 0.931,
    text:
      'terproof dressing or keeping it away from water and changing it as often as you need. You can take it off after a few days, once the wound has closed.'
  },
  {
    score: 0.72,
    text:
      'While boiling and chlorination will kill most microbes in water, distillation will remove microbes (germs) that resist these methods, as well as heavy metals, salts and most other chemicals. To distill, fill a pot halfway with water and boil the water for 20 minutes. The water that drips from the lid into the cup is distilled.'
  },
  {
    score: 0.701,
    text:
      'Germs that cause food poisoning can survive in many places and spread around your kitchen. Wash your hands before, during, and after preparing food. Wash utensils, cutting boards, and countertops with hot, soapy water.'
  },
  {
    score: 0.549,
    text:
      'Wash hands and surfaces often. Wash your cutting boards, dishes, utensils, and counter tops with hot soapy water after preparing each food item. Rinse fresh fruits and vegetables under running tap water.'
  },
  {
    score: 0.48,
    text:
      'Evacuate immediately, if told to do so. Do not walk, swim or drive through flood waters. Stay off bridges over fast-moving water.'
  }
]

describe('a turn that verified nothing says so', () => {
  test('a recomputation fed by the model\'s own constants is not a check', () => {
    assert.equal(recomputeIsCircular(CIRCULAR_PROGRAM, QUESTION), true)
    const shown = describeRecompute({ ran: true, ok: true, circular: true })
    assert.equal(shown.ok, false)
    assert.doesNotMatch(shown.summary, /compared the reply against/)
    assert.doesNotMatch(shown.summary, /^🧮 Recomputed the stated figures/)
    assert.match(shown.summary, /checks nothing|unverified/)
  })

  test('a recomputation that uses the question\'s own inputs still counts', () => {
    const grounded = 'p = 250000\nr = 6.5 / 100 / 12\nn = 30 * 12\nprint(f"monthly payment: {p*r/(1-(1+r)**-n):.2f}")'
    assert.equal(recomputeIsCircular(grounded, 'borrow 250000 at 6.5% for 30 years'), false)
    const shown = describeRecompute({ ran: true, ok: true, circular: false })
    assert.equal(shown.ok, true)
    assert.match(shown.summary, /compared the reply against that output/)
  })

  test('retrieval that returned nothing about the question loses the provenance caption', () => {
    // Every recorded passage scored high — scores are normalized inside one
    // result set — and every one is off-topic.
    assert.ok(Math.max(...RETRIEVED.map((p) => p.score)) > 0.9)
    for (const p of RETRIEVED) assert.ok(questionCoverage(QUESTION, p.text) < 0.3)
    assert.equal(libraryMissedTheQuestion(QUESTION, RETRIEVED), true)
    const label = libraryMissedTheQuestion(QUESTION, RETRIEVED) ? LIBRARY_MISS_LABEL : LIBRARY_STRIP_LABEL
    assert.doesNotMatch(label, /From the library/)
    assert.match(label, /Nothing in the library covers this question/)
  })

  test('a passage that is about the question keeps it', () => {
    const onTopic = [
      {
        text:
          'A dripping faucet wastes water: at one drip per second a kitchen faucet loses about 3,000 gallons a year. Fixing the worn washer is a job most people can do in under an hour.'
      }
    ]
    assert.ok(questionCoverage(QUESTION, onTopic[0].text) >= 0.3)
    assert.equal(libraryMissedTheQuestion(QUESTION, onTopic), false)
  })
})
