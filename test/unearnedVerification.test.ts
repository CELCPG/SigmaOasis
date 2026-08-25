import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { compareToOutput, describeRecompute, recomputeIsCircular } from '../src/renderer/src/lib/workbenchChecks'
import { checkToolGrounding, describeUnbackedItems, unsourcedFigures } from '../src/renderer/src/lib/toolGrounding'
import type { GroundingReport, ToolCallRecord } from '../src/renderer/src/types'
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
    // Strengthened in v1.17.1. This used to assert `/compared the reply against
    // that output/` — the sentence the app shipped, which was the defect: the
    // pass that follows compares NUMBERS. The assertion now pins the claim and
    // its limit together, so the claim cannot widen again without failing here.
    assert.match(shown.summary, /numbers were compared against that output/)
    assert.doesNotMatch(shown.summary, /compared the reply against/)
    assert.match(shown.summary, /was not checked/)
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

// ---- v1.17.1: the checker compared figures, and the sentence said "the reply" --

/**
 * Task VC1, run 2, round 6. The user pasted a 220-character base64 probe out of
 * a server log and asked what it decoded to. The reply put a token on a line of
 * its own to be copied; the recompute program decoded the real one, one
 * character per line; and between them the app printed
 *
 *   🧮 Recomputed the stated figures in Python; the checker compared the reply
 *      against that output.
 *
 * The two strings differ in the first eleven characters — `sigma-oasis` came
 * back as `sign-my-as-is` — and nothing said a word. A blind critic wrote: "the
 * checker compares figures but the sentence claims it compared the reply."
 *
 * The tests below are that turn, and they establish three things at once: what
 * the pass really covers, that it covered it correctly here, and why widening
 * it was rejected in favour of narrowing the sentence.
 */
const VC1_PROMPT =
  "I keep seeing this string in my server logs and I don't know what it is: c2lnbWEtb2FzaXM… — what is it, and repeat it back to me on its own line so I can copy it."

/** The line the reply put up to be copied — the model's own rendering. */
const VC1_TOKEN =
  'sign-my-as-is-head-to-head-layout-probe-a-single-unbroken-token-that-must-not-blow-out-the-chat-column-0001-0002-0003-0004-0005-0006-0007-0008-0009-0010-0011-0012-0013'

/** What the token actually decodes to, per the sandbox's own character dump. */
const VC1_DECODED =
  'sigma-oasis-head-to-head-layout-probe-a-single-unbroken-token-that-must-not-blow-out-the-chat-column-0001-0002-0003-0004-0005-0006-0007-0008-0009-0010-0011-0012-0013'

const VC1_REPLY = `This is a Base64-encoded string. When decoded, it reads as plain ASCII text (not binary data). Here's what it decodes to:

${VC1_TOKEN}

What it is: This appears to be a test token or marker string used to verify log line length handling.`

/** What the sandbox actually printed: the decoding, one character per line. */
const VC1_OUTPUT = [
  'encoded length: 220',
  `decoded length: ${VC1_DECODED.length}`,
  ...[...VC1_DECODED].map((ch, i) => `${i}: '${ch}'`)
].join('\n')

const ran = (result: string): ToolCallRecord => ({
  id: 'recompute-1',
  name: 'run_python',
  args: {},
  status: 'done',
  result
})

describe('the recompute line says which half of the reply was compared (v1.17.1)', () => {
  test('the numbers in the recorded reply WERE compared, and did agree', () => {
    // Thirteen digit groups, every one of them present in the character dump.
    // This is the half the sentence was entitled to speak for.
    assert.deepEqual(unsourcedFigures(VC1_REPLY, `${VC1_OUTPUT}\n${VC1_PROMPT}`, ''), [])
  })

  test('…and the letters were not, so the whole turn produced no finding', () => {
    assert.notEqual(VC1_TOKEN, VC1_DECODED)
    assert.equal(checkToolGrounding(VC1_REPLY, [ran(VC1_OUTPUT)], VC1_PROMPT), null)
  })

  test('so the line claims the numbers and disclaims the rest', () => {
    const shown = describeRecompute({ ran: true, ok: true, circular: false })
    assert.match(shown.summary, /numbers were compared against that output/)
    assert.doesNotMatch(shown.summary, /compared the reply against/)
    assert.match(shown.summary, /text it copies from the run.*was not checked/)
  })

  test('widening the comparison to strings would not have caught this either', () => {
    // Why the fix is the sentence and not the check. The program printed its
    // decoding one character per line, so neither token occurs contiguously in
    // that output — the right one no more than the wrong one — and there is no
    // `label: <string>` line for a string-valued comparison to read at all.
    assert.equal(VC1_OUTPUT.includes(VC1_DECODED), false)
    assert.equal(VC1_OUTPUT.includes(VC1_TOKEN), false)
    assert.deepEqual(compareToOutput(VC1_REPLY, VC1_OUTPUT), { agreed: 0, mismatches: [] })
    // And the blunt version — "a long token in the reply must occur in the
    // output" — fires identically on the CORRECT answer, which is round 4's
    // cry-wolf in a new costume.
    const honest = VC1_REPLY.replace(VC1_TOKEN, VC1_DECODED)
    assert.equal(VC1_OUTPUT.includes(VC1_DECODED), false, 'the honest reply is equally absent')
    assert.equal(checkToolGrounding(honest, [ran(VC1_OUTPUT)], VC1_PROMPT), null)
  })
})

// ---- v1.17.1: the verb agreed with the categories, not the items --------------

/**
 * Round 6's critiques, "everywhere" row: `⚠️ 3 figures (…) in this reply is not
 * backed`. `parts.length` counted the CATEGORIES the banner names — figures,
 * links, measurements — so every plural-within-one-category case shipped
 * ungrammatical, on the single sentence carrying the app's verifiability claim.
 *
 * The three strings below are verbatim from recorded runs.
 */
const report = (r: Partial<GroundingReport>): GroundingReport => ({
  figures: [],
  links: [],
  checkedAgainst: ['reference_lookup'],
  ...r
})

describe('the unbacked-items sentence agrees with the items (v1.17.1)', () => {
  test('the three recorded plurals are no longer ungrammatical', () => {
    assert.equal(
      describeUnbackedItems(report({ quantities: ['165°F', '74°C'] })),
      '2 measurements (165°F, 74°C) in this reply are not backed by the tool output.'
    )
    assert.equal(
      describeUnbackedItems(report({ figures: ['$0.01', '$36', '$10'] })),
      '3 figures ($0.01, $36, $10) in this reply are not backed by the tool output.'
    )
    assert.equal(
      describeUnbackedItems(report({ links: ['a', 'b', 'c', 'd'] })),
      '4 links in this reply are not backed by the tool output.'
    )
  })

  test('one item still takes a singular verb — the true negative', () => {
    // Round 6's V1, verbatim, and the case the plural fix must not break.
    assert.equal(
      describeUnbackedItems(report({ quantities: ['165°F'] })),
      '1 measurement (165°F) in this reply is not backed by the tool output.'
    )
    assert.equal(
      describeUnbackedItems(report({ links: ['https://example.invalid/x'] })),
      '1 link in this reply is not backed by the tool output.'
    )
  })

  test('the two-category case that used to be right by accident still is', () => {
    // One figure and one link: two items, so plural — and it read correctly
    // before only because a compound subject is plural whatever its halves
    // count. Now it is plural for the reason it is plural.
    assert.equal(
      describeUnbackedItems(report({ figures: ['$36'], links: ['https://example.invalid/x'] })),
      '1 figure ($36) and 1 link in this reply are not backed by the tool output.'
    )
  })

  test('three categories read as a list, not as "and … and"', () => {
    assert.equal(
      describeUnbackedItems(
        report({ figures: ['$36'], links: ['https://example.invalid/x'], quantities: ['74°C'] })
      ),
      '1 figure ($36), 1 link and 1 measurement (74°C) in this reply are not backed by the tool output.'
    )
  })

  test('a report with nothing in these three categories writes no sentence', () => {
    // The banner still renders — it has quotes, contacts, citations of its own —
    // but this line must not appear with an empty subject.
    assert.equal(describeUnbackedItems(report({ contacts: ['1-800-555-0134'] })), '')
  })
})
