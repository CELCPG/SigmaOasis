import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkToolGrounding,
  contradictedOrigins,
  describeCoverage,
  describeGroundingFindings,
  describeMatchedMeasurements,
  describeRevisionOutcome,
  describeUnbackedItems,
  groundingFindingCount,
  groundingFindingLabels,
  measurementSources,
  misattributedCitations,
  misquotedSpans,
  overstatedToolCounts,
  quantityCoverage,
  revisionIsAnImprovement,
  undisclosedToolRuns,
  unsourcedAddresses,
  unsourcedContacts,
  unsourcedFigures,
  unsourcedLinks,
  unsourcedQuantities,
  unrunToolClaims
} from '../src/renderer/src/lib/toolGrounding'
import { retrievedCitations } from '../src/renderer/src/lib/citations'
import {
  convertUnit,
  inScale,
  isRatioScale,
  measurementGroup
} from '../src/shared/measurements'
import type { GroundingReport, ToolCallRecord } from '../src/renderer/src/types'

/**
 * These cases are transcribed from a real v1.3 session, not invented. The
 * numbers in `CAR_TOOL_OUTPUT` are what `finance_calculator` actually returned;
 * the numbers in `CAR_ANSWER` are what the model actually told the user. Every
 * one of the latter is fabricated, and the gap between them is the whole reason
 * this module exists.
 */

function rec(name: string, result: string, status: ToolCallRecord['status'] = 'done'): ToolCallRecord {
  return { id: `${name}-${result.length}`, name, args: {}, result, status }
}

const CAR_TOOL_OUTPUT = `Loan amortization
Loan amount: $20,000.00 at 7% for 5 year(s) (60 payments)

Monthly payment: $396.02
Total paid: $23,761.44
Total interest: $3,761.44 (18.81% of the loan amount)`

const CAR_ANSWER = `### Option 1: The $20,000 Purchase Price
* Loan Amount: $15,000 (After your $5,000 down payment)
* Estimated Monthly Payment: $293.50
* Total Interest Paid: ~$2,610`

describe('unsourcedFigures', () => {
  test('catches a payment the calculator never returned', () => {
    // The measured failure: the tool said $396.02, the user was told $293.50.
    const flagged = unsourcedFigures(CAR_ANSWER, CAR_TOOL_OUTPUT)
    assert.ok(flagged.includes('$293.50'), `expected the invented payment, got ${flagged.join(', ')}`)
    assert.ok(flagged.includes('$2,610'), `expected the invented interest, got ${flagged.join(', ')}`)
  })

  test('figures the tool did return are not flagged', () => {
    const flagged = unsourcedFigures('The payment is $396.02 and total paid $23,761.44.', CAR_TOOL_OUTPUT)
    assert.deepEqual(flagged, [])
  })

  test('honest rounding counts as sourced', () => {
    // "about $396" is backed by a computed 396.02; flagging it would be noise.
    assert.deepEqual(unsourcedFigures('roughly $396 a month', CAR_TOOL_OUTPUT), [])
    assert.deepEqual(unsourcedFigures('about $23,761 total', CAR_TOOL_OUTPUT), [])
  })

  test('a near-miss is still flagged — rounding is not a licence to differ', () => {
    assert.deepEqual(unsourcedFigures('about $310 a month', CAR_TOOL_OUTPUT), ['$310'])
  })

  test('the same figure is reported once', () => {
    const flagged = unsourcedFigures('$293.50 … later, $293.50 again', CAR_TOOL_OUTPUT)
    assert.deepEqual(flagged, ['$293.50'])
  })

  test('bare numbers are ignored — only money is checked', () => {
    // "2017 models", "60 months" and "7%" are prose, not claimed computations.
    assert.deepEqual(unsourcedFigures('aim for 2017-2020 models over 72 months at 9%', CAR_TOOL_OUTPUT), [])
  })
})

describe('unsourcedLinks', () => {
  const searchOutput = `1. Judi Rosen — Organic Cotton Intimates
   https://www.judirosenny.com/collections/organic-cotton-intimates
   Farm-to-fiber organic cotton.`

  test('catches a plausible URL invented by extending a real one', () => {
    // Measured: the real collection page was returned by search; the "thong
    // collection" page under it was written by the model and does not exist.
    const answer =
      'See [the collection](https://www.judirosenny.com/collections/organic-cotton-intimates) ' +
      'and [thongs](https://www.judirosenny.com/collections/organic-cotton-intimates-thong).'
    assert.deepEqual(unsourcedLinks(answer, searchOutput), [
      'https://www.judirosenny.com/collections/organic-cotton-intimates-thong'
    ])
  })

  test('a URL that appeared in the results is not flagged', () => {
    const answer = 'Buy at https://www.judirosenny.com/collections/organic-cotton-intimates'
    assert.deepEqual(unsourcedLinks(answer, searchOutput), [])
  })

  test('trailing punctuation and slashes do not create false positives', () => {
    const answer = 'Visit https://www.judirosenny.com/collections/organic-cotton-intimates/.'
    assert.deepEqual(unsourcedLinks(answer, searchOutput), [])
  })

  test('nothing to compare against means nothing is claimed', () => {
    assert.deepEqual(unsourcedLinks('see https://example.com', ''), [])
  })
})

describe('checkToolGrounding', () => {
  test('reports the finance case end to end', () => {
    const report = checkToolGrounding(CAR_ANSWER, [rec('finance_calculator', CAR_TOOL_OUTPUT)], '')
    assert.ok(report, 'expected a report')
    assert.ok(report!.figures.includes('$293.50'))
    assert.deepEqual(report!.checkedAgainst, ['finance_calculator'])
  })

  test("the user's own numbers are theirs to restate", () => {
    // "$5,000 down" and "under $400" came from the user, not from the model.
    const report = checkToolGrounding(
      'With your $5,000 down you stay under $400 at $396.02.',
      [rec('finance_calculator', CAR_TOOL_OUTPUT)],
      'i have $5000 down and want to pay under $400 a month'
    )
    assert.equal(report, null)
  })

  /**
   * v1.5: the corpus is every user message, not just the current turn. The
   * measured false positive — a v1.4 session where "$5,000 to invest, $500 a
   * month" was said four turns before the plan that restated it, and every
   * figure in that plan was flagged.
   */
  test('a budget stated turns ago is still the user\'s own number', () => {
    const conversation = [
      'i have $5000 to invest then $500 a month to add every month',
      'yes let me see the strong buys list',
      'you can buy stocks on kraken'
    ].join('\n')
    const report = checkToolGrounding(
      'Deposit the $5,000, then $500 monthly.',
      [rec('web_search', 'results')],
      conversation,
      { expectPricingTool: true }
    )
    assert.equal(report, null)
  })

  test('a figure from nowhere is still caught in a long conversation', () => {
    const report = checkToolGrounding(
      'Expect around $2,400 in fees.',
      [rec('web_search', 'results')],
      'i have $5000 to invest\nwhat about monthly costs',
      { expectPricingTool: true }
    )
    assert.ok(report?.figures.includes('$2,400'))
  })

  test('a clean reply produces no report at all', () => {
    const report = checkToolGrounding(
      'The monthly payment is $396.02.',
      [rec('finance_calculator', CAR_TOOL_OUTPUT)],
      ''
    )
    assert.equal(report, null)
  })

  test('figures are not checked when no numeric tool ran', () => {
    // A turn with no calculator is the `unverified` badge's job, not this one.
    const report = checkToolGrounding('Around $30 a pair.', [rec('web_search', 'results')], '')
    assert.equal(report, null)
  })

  test('on a shopping turn, a price with no pricing tool IS flagged', () => {
    // The measured underwear session: prices invented with only web_search run.
    const report = checkToolGrounding(
      'They typically fall between $20–$35 per pair.',
      [rec('web_search', 'Brook There, Blue Canoe, Thunderpants')],
      'im looking for a thong made from organic cotton',
      { expectPricingTool: true }
    )
    assert.ok(report, 'expected a report on a shopping turn')
    assert.deepEqual(report!.figures, ['$20', '$35'])
  })

  test('failed tool calls do not count as sources', () => {
    const report = checkToolGrounding(
      'The payment is $293.50.',
      [rec('finance_calculator', 'timed out', 'error')],
      '',
      { expectPricingTool: true }
    )
    assert.ok(report)
    assert.deepEqual(report!.checkedAgainst, ['no tool output — nothing ran this turn'])
  })

  test('an empty answer is never reported on', () => {
    assert.equal(checkToolGrounding('   ', [rec('finance_calculator', CAR_TOOL_OUTPUT)], ''), null)
  })
})

/**
 * v1.4.5, all three transcribed from the Vichy Catalan sessions of 2026-08-12.
 * The app watched every one of these go past and said nothing.
 */
describe('derived figures', () => {
  test('arithmetic on a number the user gave is not fabrication', () => {
    // Told "$2.51 per bottle", the model wrote the 6- and 8-bottle case costs.
    // The badge reported both as unsourced, which is the model being right.
    const answer = '6-bottle case: $15.06. 8-bottle case: $20.08. 12-bottle: $30.12.'
    assert.deepEqual(unsourcedFigures(answer, 'our landed cost is $2.51 per unit'), [])
  })

  test('a per-unit figure derived by division is also fine', () => {
    assert.deepEqual(unsourcedFigures('That is $3.50 a bottle.', 'the case costs $42.00'), [])
  })

  test('but a price that is nobody\'s arithmetic is still caught', () => {
    const flagged = unsourcedFigures('Club price: $2.90 per bottle.', 'landed cost $2.51 per unit')
    assert.deepEqual(flagged, ['$2.90'])
  })

  test('derivation does not stretch far enough to launder anything', () => {
    // 24x is the ceiling; a figure needing a wilder multiple stays flagged.
    assert.deepEqual(unsourcedFigures('Revenue: $2,510,000.', 'cost $2.51'), ['$2,510,000'])
  })
})

describe('unprompted pricing tables', () => {
  const emailCopy =
    'Retail ~$5.00/bottle. Sam’s Club 8-pack: ~$3.80/bottle. You save 16% per unit!'

  test('a table of prices is checked even with no pricing tool in sight', () => {
    // The measured miss: "email campaign copy" was not recognized as commerce,
    // so an entire member-facing price comparison went out unchecked.
    const report = checkToolGrounding(emailCopy, [], 'email campaign copy')
    assert.ok(report, 'expected a report')
    assert.deepEqual(report!.figures, ['$5.00', '$3.80'])
  })

  test('one passing mention of money is not a pricing table', () => {
    // The noise this threshold exists to prevent.
    assert.equal(checkToolGrounding('Coffee runs about $5 there.', [], 'tell me about lisbon'), null)
  })
})

describe('contradictedOrigins', () => {
  const spanishSources =
    'Vichy Catalan, the best-known mineral water from Spain, bottled at Caldes de Malavella. ' +
    'This premium Spanish water emerges from the ground at 60 degrees Celsius.'

  test('catches the country the sources never mentioned', () => {
    // The pitch deck said "French spa water"; the outreach email promised
    // "direct import from France". Ten snippets had said Spain.
    assert.deepEqual(
      contradictedOrigins('Premium French spa water, direct import from France.', spanishSources),
      ['France']
    )
  })

  test('the country the sources actually gave is not flagged', () => {
    assert.deepEqual(contradictedOrigins('Spanish sparkling water since 1881.', spanishSources), [])
  })

  test('silent when the sources establish no geography of their own', () => {
    // Ordinary knowledge, none of this check's business.
    assert.deepEqual(contradictedOrigins('Fiji is in the Pacific.', 'a page about hydration'), [])
  })

  test('reports through checkToolGrounding when sources were consulted', () => {
    const report = checkToolGrounding(
      'Premium French spa water with 168-year heritage.',
      [rec('web_search', spanishSources)],
      'build me a pitch deck'
    )
    assert.ok(report, 'expected a report')
    assert.deepEqual(report!.origins, ['France'])
  })

  test('a competitor named in the same breath is not a contradiction', () => {
    // "Evian (French)" alongside Spanish Vichy is accurate, and both appear in
    // the sources, so nothing should fire.
    const sources = `${spanishSources} Evian is a French spring water.`
    assert.deepEqual(contradictedOrigins('Vichy is Spanish; Evian is French.', sources), [])
  })
})

describe('derivation cannot launder a figure', () => {
  /**
   * Caught by replaying a real transcript rather than by a fixture: the user
   * had answered a menu with the message "1", which put 1 into the base set,
   * and 1 multiplied by the permitted factors certifies every integer from 2
   * to 24. A fabricated "$5.00/bottle" in member-facing email copy came back
   * clean, and because that dropped the flagged count below the threshold it
   * suppressed the whole check for the turn.
   */
  test('a bare number in the conversation is not a price to derive from', () => {
    const flagged = unsourcedFigures(
      'Retail ~$5.00/bottle, club ~$3.80/bottle.',
      'lets build a sales presentation for a 8 pack of 1L waters\n1\nemail campaign copy'
    )
    assert.deepEqual(flagged, ['$5.00', '$3.80'])
  })

  test('a real price in the conversation still derives normally', () => {
    assert.deepEqual(unsourcedFigures('8-pack: $20.08.', 'landed cost is $2.51 per unit'), [])
  })

  test('the end-to-end case: invented club prices with no tool run', () => {
    const report = checkToolGrounding(
      'Retail ~$5.00/bottle. Sam’s Club 8-pack ~$3.80/bottle. You save 16%!',
      [],
      'email campaign copy'
    )
    assert.ok(report, 'expected a report')
    assert.deepEqual(report!.figures, ['$5.00', '$3.80'])
  })
})

/**
 * v1.4.5. Measured: member-facing email copy signed off with "call Member
 * Services at 1-800-SAM'S-CUB" — not Sam's Club's number, not a number at all,
 * present in no tool result. Assembled from the shape of the brand name.
 */
describe('unsourcedContacts', () => {
  test('catches a vanity number the model assembled', () => {
    const flagged = unsourcedContacts("call Member Services at 1-800-SAM'S-CUB.", 'search results')
    assert.deepEqual(flagged, ["1-800-SAM'S-CUB"])
  })

  test('a number that appeared in the sources is fine', () => {
    const corpus = 'Contact Sam’s Club Member Services: 1-888-746-7726.'
    assert.deepEqual(unsourcedContacts('Call 1-888-746-7726 for help.', corpus), [])
  })

  test('punctuation differences do not create a false positive', () => {
    const corpus = 'Support: (888) 746-7726'
    assert.deepEqual(unsourcedContacts('Call 888-746-7726.', corpus), [])
  })

  test("a number the user gave is theirs to repeat", () => {
    assert.deepEqual(unsourcedContacts('I will list 555-867-5309.', 'my number is 555-867-5309'), [])
  })

  test('invented email addresses count too', () => {
    const flagged = unsourcedContacts('Write to support@vichycatalan-clubs.com.', 'sources')
    assert.deepEqual(flagged, ['support@vichycatalan-clubs.com'])
  })

  test('a year range is not a phone number', () => {
    assert.deepEqual(unsourcedContacts('Launch in 2026-2027, growing 10-15%.', ''), [])
  })

  test('reported through checkToolGrounding even with no tools run', () => {
    // The measured turn ran nothing at all, which is exactly when a fabricated
    // support line is most likely and least likely to be noticed.
    const report = checkToolGrounding("Call 1-800-SAM'S-CUB.", [], 'email campaign copy')
    assert.ok(report, 'expected a report')
    assert.deepEqual(report!.contacts, ["1-800-SAM'S-CUB"])
  })
})

/**
 * v1.4.5. From the NYC route session of 2026-08-13. The turn collected three
 * successful searches, then lost five more calls to per-turn budgets — and the
 * itinerary it produced filled the gaps: three of seven stop addresses appear
 * in none of the results, including a Gristedes address on a turn where every
 * Gristedes search had been refused. The three real ones were quoted verbatim,
 * so the model could quote; it chose to complete the list instead.
 */
describe('unsourcedAddresses', () => {
  const results = `6. Morton Williams - New York, NY
   2015 Broadway New York, NY 10023 Upper West Side
   1031 First Avenue (56th Street) 212-486-0340
8. FAIRWAY MARKET OF CHELSEA
   Fairway Market of Chelsea at 766 6th Ave, New York NY 10010`

  test('catches the stops that came from nowhere', () => {
    const answer = [
      'Stop 1: Gristedes – 800 3rd Ave, New York, NY',
      'Stop 2: Morton Williams – 1031 First Ave, New York, NY',
      'Stop 3: Whole Foods – 175 E 14th St, New York, NY',
      'Stop 4: Fairway Market – 766 6th Ave, New York, NY'
    ].join('\n')
    const flagged = unsourcedAddresses(answer, results)
    assert.ok(flagged.some((a) => a.includes('800 3rd Ave')), `got ${flagged.join(' | ')}`)
    assert.ok(flagged.some((a) => a.includes('175 E 14th St')), `got ${flagged.join(' | ')}`)
  })

  test('an address quoted from the results is not flagged', () => {
    assert.deepEqual(unsourcedAddresses('Go to 766 6th Ave.', results), [])
  })

  test('abbreviation is normalized, so Ave and Avenue are the same address', () => {
    assert.deepEqual(unsourcedAddresses('Morton Williams, 1031 First Ave', results), [])
  })

  test('an address the user supplied is theirs', () => {
    const report = checkToolGrounding(
      'Start at 4 Pennsylvania Plaza.',
      [rec('web_search', results)],
      'my starting point is 4 Pennsylvania Plaza'
    )
    assert.equal(report, null)
  })

  test('nothing to compare against means no claim', () => {
    assert.deepEqual(unsourcedAddresses('Meet at 123 Main St.', ''), [])
  })

  test('reported through checkToolGrounding', () => {
    const report = checkToolGrounding(
      'Stop 1: Gristedes – 800 3rd Ave, New York, NY',
      [rec('web_search', results)],
      'plan my route'
    )
    assert.ok(report, 'expected a report')
    assert.ok(report!.addresses?.some((a) => a.includes('800 3rd Ave')))
  })
})

describe('addresses do not wrap across lines', () => {
  /**
   * Caught by replaying the real search output, not by a fixture. With `\s`
   * between the words the scanner matched "212-308-6922\n1031 First Avenue" as
   * one address, so the genuine "1031 First Avenue" never entered the known
   * set — and the itinerary quoting it correctly was reported as invented.
   */
  test('a phone number above an address does not swallow it', () => {
    const corpus = '908 Second Avenue (48th Street) 212-308-6922\n1031 First Avenue (56th Street)'
    assert.deepEqual(unsourcedAddresses('Morton Williams, 1031 First Ave', corpus), [])
  })

  test('numbered street names still parse', () => {
    assert.deepEqual(unsourcedAddresses('at 800 3rd Ave', 'store at 800 3rd Ave'), [])
    assert.deepEqual(unsourcedAddresses('at 766 6th Ave', 'Chelsea: 766 6th Ave, NY'), [])
  })
})

/**
 * v1.4.6. Everything else in this module detects; this is what finally acts on
 * a finding. Across ten measured sessions the checks correctly identified
 * invented addresses, prices, phone numbers and a relocated brand — and then
 * rendered a badge under an answer the user had already read. What the model
 * is told here is the whole difference between a corrected answer and an
 * annotated one, so it is pinned.
 */
describe('describeGroundingFindings', () => {
  const full = {
    figures: ['$5.00', '$3.80'],
    links: ['https://example.com/invented'],
    addresses: ['800 3rd Ave', '175 E 14th St'],
    contacts: ["1-800-SAM'S-CUB"],
    origins: ['France'],
    checkedAgainst: ['web_search']
  }

  test('names every flagged item, so the model fixes those and not the answer', () => {
    const out = describeGroundingFindings(full)
    for (const item of ['$5.00', '800 3rd Ave', "1-800-SAM'S-CUB", 'France', 'invented']) {
      assert.ok(out.includes(item), `expected ${item} in the findings`)
    }
  })

  test('offers verification before removal', () => {
    // The model keeps its tools during the pass; an address it can confirm is
    // worth more than an address it deleted.
    assert.match(describeGroundingFindings(full), /verify it with a tool, or drop it/i)
  })

  test('forbids swapping one invention for another', () => {
    assert.match(describeGroundingFindings(full), /do not replace one[\s\S]*unverified specific/i)
  })

  test('says a correction is not a shorter answer', () => {
    // Without this the cheapest way to satisfy the checker is to delete the
    // useful parts too.
    assert.match(describeGroundingFindings(full), /correction, not a shorter answer/i)
  })

  test('names what the answer was checked against', () => {
    assert.match(describeGroundingFindings(full), /web_search/)
  })

  test('a report with nothing in it produces no instruction', () => {
    assert.equal(
      describeGroundingFindings({ figures: [], links: [], checkedAgainst: ['web_search'] }),
      ''
    )
  })

  test('only the categories that fired are mentioned', () => {
    const out = describeGroundingFindings({
      figures: [],
      links: [],
      addresses: ['800 3rd Ave'],
      checkedAgainst: ['web_search']
    })
    assert.ok(out.includes('800 3rd Ave'))
    assert.ok(!/Money figures/.test(out))
    assert.ok(!/Contact details/.test(out))
  })
})

/**
 * v1.4.6. The guard that makes the correction pass safe to run.
 *
 * Measured against the live model: asked to fix an itinerary with two invented
 * addresses, it returned the same table with *different* invented addresses
 * ("155 W 52nd St" became "150 W 52nd St"), plus a line claiming the rest had
 * been "verified against search results" when nothing had run. The prompt
 * forbids exactly that, and the model did it anyway.
 */
describe('revisionIsAnImprovement', () => {
  const report = (n: number): GroundingReport => ({
    figures: [],
    links: [],
    addresses: Array.from({ length: n }, (_, i) => `${i} Fake St`),
    checkedAgainst: ['web_search']
  })

  test('a revision that fixed everything is kept', () => {
    assert.equal(revisionIsAnImprovement(report(3), null), true)
  })

  test('a revision that fixed some of it is kept', () => {
    assert.equal(revisionIsAnImprovement(report(3), report(1)), true)
  })

  test('swapping one invention for another is rejected', () => {
    // Same count, different content: the measured failure.
    assert.equal(revisionIsAnImprovement(report(2), report(2)), false)
  })

  test('a revision that made it worse is rejected', () => {
    assert.equal(revisionIsAnImprovement(report(2), report(4)), false)
  })

  test('the count spans every category', () => {
    assert.equal(
      groundingFindingCount({
        figures: ['$1'],
        links: ['https://x'],
        addresses: ['1 A St'],
        contacts: ['555-0100'],
        origins: ['France'],
        checkedAgainst: []
      }),
      5
    )
    assert.equal(groundingFindingCount(null), 0)
  })
})

/**
 * The disclosure line under a revised answer, and the one line on screen whose
 * entire job is to be trusted.
 *
 * Measured, blind, round 4 task V1: the reply stated 165°F / 74°C over passages
 * containing neither string, and the only chrome under it was
 *
 *   ✎ Revised: 1 unsupported item were sent back for verification or removal.
 *
 * in green. A judge chose the older build over ours and quoted that line as the
 * reason — "unnamed, ungrammatical, and asserting a resolution that plainly did
 * not occur". Three faults, one cause: the line was written from the *first*
 * report only, so it could describe the request and never the result.
 *
 * A revision is adopted whenever it REDUCES the findings (see
 * revisionIsAnImprovement, directly above), so a surviving finding is the
 * ordinary case, not the exotic one. These cases pin it.
 */
describe('describeRevisionOutcome', () => {
  const report = (over: Partial<GroundingReport> = {}): GroundingReport => ({
    figures: [],
    links: [],
    checkedAgainst: ['reference_lookup'],
    ...over
  })
  /** The V1 finding, verbatim: the checker's own label for what it faulted. */
  const survived = report({ quantities: ['165°F'] })

  test('a finding still standing in the answer is not reported as resolved', () => {
    const out = describeRevisionOutcome(survived, survived)
    assert.equal(out.resolved, false)
    assert.equal(out.remaining, 1)
    assert.match(out.text, /still unsupported in this answer/)
    // The old line's whole text, which asserted a resolution nobody checked.
    assert.ok(
      !/sent back for verification or removal\.?$/.test(out.text),
      `still describes only the request: ${out.text}`
    )
  })

  test('the surviving finding is named, so a reader can check it', () => {
    assert.match(describeRevisionOutcome(survived, survived).text, /165°F/)
  })

  test('a revision that cleared its findings says so, and names what went back', () => {
    const out = describeRevisionOutcome(survived, null)
    assert.equal(out.resolved, true)
    assert.equal(out.remaining, 0)
    assert.match(out.text, /165°F/)
    assert.ok(!/still unsupported/.test(out.text), out.text)
  })

  test('a partial fix reports both halves, not just the generous one', () => {
    const before = report({
      quantities: ['165°F'],
      figures: ['$5.00'],
      links: ['https://example.test/invented']
    })
    const out = describeRevisionOutcome(before, survived)
    assert.equal(out.sent, 3)
    assert.equal(out.remaining, 1)
    assert.equal(out.resolved, false)
    assert.match(out.text, /3 unsupported items were sent back/)
    assert.match(out.text, /1 is still unsupported in this answer: 165°F\./)
  })

  test('the verb agrees with the count that governs it, for 1 and for N', () => {
    const two = report({ addresses: ['1 A St', '2 B St'] })
    const one = report({ addresses: ['1 A St'] })
    // The measured defect, exactly: singular noun, plural verb.
    assert.ok(!/1 unsupported item were/.test(describeRevisionOutcome(one, null).text))
    assert.match(describeRevisionOutcome(one, null).text, /1 unsupported item was sent back/)
    assert.match(describeRevisionOutcome(two, null).text, /2 unsupported items were sent back/)
    assert.match(describeRevisionOutcome(two, one).text, /1 is still unsupported/)
    assert.match(describeRevisionOutcome(two, two).text, /2 are still unsupported/)
  })

  test('nothing sent back is no line at all', () => {
    assert.equal(describeRevisionOutcome(null, null).text, '')
    assert.equal(describeRevisionOutcome(report(), null).text, '')
    assert.equal(describeRevisionOutcome(report(), null).resolved, false)
  })

  test('a long list names the first few and counts the rest', () => {
    const many = report({ addresses: ['1 A St', '2 B St', '3 C St', '4 D St', '5 E St', '6 F St'] })
    const out = describeRevisionOutcome(many, many)
    assert.match(out.text, /6 unsupported items were sent back/)
    assert.match(out.text, /1 A St, 2 B St, 3 C St, 4 D St and 2 more\./)
  })
})

/**
 * The count and the names have to come from the same walk of the report. A line
 * reading "3 unsupported items" that then names two is worse than one that
 * names none, because the reader has no way to know which one is the lie.
 */
describe('groundingFindingLabels', () => {
  const everything: GroundingReport = {
    figures: ['$5.00'],
    quantities: ['165°F'],
    links: ['https://example.test/a'],
    origins: ['France'],
    addresses: ['1 A St'],
    contacts: ['555-0100'],
    toolClaims: ['web_search'],
    toolDisclosure: ['reference_lookup'],
    toolArgs: ['query: “ground beef” — the call sent “what temperature for ground beef?”'],
    code: ['- The Python code in the answer fails when run: NameError…'],
    citations: ['[4]'],
    quotes: ['a line no passage contains'],
    attributions: ['[1] (Cold Food Storage Chart)'],
    checkedAgainst: ['reference_lookup']
  }

  test('names exactly as many things as the count counts, across every category', () => {
    assert.equal(groundingFindingLabels(everything).length, groundingFindingCount(everything))
    assert.equal(groundingFindingCount(everything), 13)
  })

  test('every label is the checker’s own string, so it can be found on screen', () => {
    const labels = groundingFindingLabels(everything)
    for (const item of ['$5.00', '165°F', 'France', '1 A St', '555-0100', '[4]', 'web_search']) {
      assert.ok(labels.includes(item), `expected ${item} among the labels`)
    }
    // The one finding that is a traceback plus an instruction, not a quotable
    // span: named by what it is, with the 🧪 line carrying the detail.
    assert.ok(labels.includes("the answer's Python"))
  })

  test('nothing to name is an empty list, not a line with a stray comma', () => {
    assert.deepEqual(groundingFindingLabels(null), [])
    assert.deepEqual(groundingFindingLabels({ figures: [], links: [], checkedAgainst: [] }), [])
  })
})

describe('unsourcedPercentages (v1.6)', () => {
  const { unsourcedPercentages, checkToolGrounding } = require('../src/renderer/src/lib/toolGrounding') as typeof import('../src/renderer/src/lib/toolGrounding')
  test('a share nothing computed supports is flagged; a stated or derivable one is not', () => {
    const corpus = 'stdout:\nEast 37907.39\ntotal 147903.85\nshare 25.6%'
    assert.deepEqual(unsourcedPercentages('East had 37907.39, about 45% of the total.', corpus), ['45%'])
    assert.deepEqual(unsourcedPercentages('East had 25.6% of the total.', corpus), [])
    // 37907.39 / 147903.85 = 25.63…% — derivable to one decimal.
    assert.deepEqual(unsourcedPercentages('That is 25.6% of revenue.', 'East 37907.39\ntotal 147903.85'), [])
    assert.deepEqual(unsourcedPercentages('That is 26% of revenue.', 'East 37907.39\ntotal 147903.85'), [])
  })
  test('only checked when a computation tool ran', () => {
    const rec = (name: string): ToolCallRecord => ({ id: 'r', name, args: {}, status: 'done', result: 'stdout:\nEast 37907.39' })
    const withRun = checkToolGrounding('About 45% of sales.', [rec('run_python')], 'q')
    assert.deepEqual(withRun?.figures, ['45%'])
    const withoutRun = checkToolGrounding('About 45% of sales.', [], 'q')
    assert.equal(withoutRun, null)
  })
})

describe('errored numeric records still count as evidence (v1.6)', () => {
  const { checkToolGrounding } = require('../src/renderer/src/lib/toolGrounding') as typeof import('../src/renderer/src/lib/toolGrounding')
  test('a total printed before a later failure backs the figure', () => {
    const rec: ToolCallRecord = { id: 'r', name: 'run_python', args: {}, status: 'error', result: 'stdout before the error:\nEast 37907.39\n\nerror: Traceback…' }
    const done: ToolCallRecord = { id: 's', name: 'run_python', args: {}, status: 'done', result: 'files written: chart.png' }
    assert.equal(checkToolGrounding('East: $37,907.39.', [rec, done], 'q'), null)
  })
})

/**
 * v1.9.2, transcribed from a real session on 2026-08-18 the same way the
 * finance case above was. The Python is what `run_python` actually printed;
 * the answer is what the model actually told the user, in the same message,
 * directly above leg tables that themselves summed to 3,755.
 */
const ROUTE_TOOL_OUTPUT = `Python ran in 4 ms.

stdout:
Leg 1 (Miami -> Pensacola): 950 miles
Leg 2 (Pensacola -> Houston): 760 miles
Leg 3 (Houston -> El Paso): 760 miles
Leg 4 (El Paso -> Tucson): 520 miles
Leg 5 (Tucson -> San Diego): 765 miles
Grand total: 3755 miles

Numbers above were computed, not recalled: state them exactly as shown.`

describe('unsourcedQuantities', () => {
  test('the headline that contradicted the app\'s own arithmetic', () => {
    const flagged = unsourcedQuantities(
      'Miami to San Diego: Bicycle Route Sketch. Total: ~3,015 miles.',
      ROUTE_TOOL_OUTPUT
    )
    assert.ok(
      flagged.some((f) => f.includes('3,015')),
      `expected 3,015 miles to be flagged, got: ${JSON.stringify(flagged)}`
    )
  })

  test('the numbers the tool did compute are left alone', () => {
    const flagged = unsourcedQuantities(
      'Leg 1 is 950 miles, leg 4 is 520 miles, and the grand total is 3755 miles.',
      ROUTE_TOOL_OUTPUT
    )
    assert.deepEqual(flagged, [])
  })

  test('units are not compared — only the number has to be supported', () => {
    // Converting a computed value into another unit is restatement, not
    // invention, and flagging it would be the kind of noise that teaches
    // someone to ignore the badge.
    assert.deepEqual(unsourcedQuantities('That is 30 minutes of riding.', 'elapsed: 30'), [])
  })

  test('a rounded restatement passes at the precision it was stated', () => {
    assert.deepEqual(unsourcedQuantities('about 20 minutes', 'duration 19.6'), [])
  })

  test('simple arithmetic on a computed number is not an invention', () => {
    // 950 * 2: the same rule money has had since v1.4.5.
    assert.deepEqual(unsourcedQuantities('1900 miles over two days', 'Leg 1: 950 miles'), [])
  })

  /**
   * The two false positives the quantitative suite produced on 2026-08-19,
   * both on answers scored CORRECT, both the model showing its working.
   * Transcribed exactly.
   */
  test('a duration is not judged against tools that computed no duration', () => {
    const pace = `Total distance: 42.195 km
Total time: 3:47
Miles run: 26.218757
Pace: 8.6579 minutes per mile`
    const answer =
      "The runner's average pace is **8.6579 minutes per mile**. This comes from converting " +
      '42.195 km to ~26.2188 miles, then dividing the total time of 227 minutes (3h 47m) by it.'
    assert.deepEqual(unsourcedQuantities(answer, pace), [])
  })

  test('an intermediate the code computed but never printed is not an invention', () => {
    const answer =
      'The fuel cost is **$161.23**. This comes from dividing 1,340 miles by 31.5 mpg to get ' +
      '~42.54 gallons needed, then multiplying by $3.79 per gallon.'
    assert.deepEqual(unsourcedQuantities(answer, 'stdout:\n161.23'), [])
  })

  test('a pace is a different kind of thing from a duration', () => {
    // Same unit word, different quantity — comparing them reports a
    // disagreement between two things that were never the same measurement.
    assert.deepEqual(unsourcedQuantities('It took 227 minutes.', 'Pace: 8.66 minutes per mile'), [])
  })

  test('but a distance IS judged when the tools computed distances', () => {
    // The motivating case survives the narrowing: this is the whole point.
    const flagged = unsourcedQuantities('Total: ~3,015 miles.', ROUTE_TOOL_OUTPUT)
    assert.ok(flagged.some((f) => f.includes('3,015')), JSON.stringify(flagged))
  })

  test('a number ending a line does not marry the next line\'s first word', () => {
    // "Total time: 3:47" + "Miles run:" must not become "47 Miles" in the
    // corpus. It did, and it turned a correct distance into a finding.
    assert.deepEqual(
      unsourcedQuantities('The run was 26.2188 miles.', 'Total time: 3:47\nMiles run: 26.218757'),
      []
    )
  })

  test('a unit the user only mentioned in passing arms nothing', () => {
    // The marathon prompt, verbatim. "1 mile = 1.609344 km" armed `mile` with
    // the value 1, and "3 hours 47 minutes" armed `minute` with 47; a correct
    // 26.219 miles and a correct 227 minutes were then both reported.
    const prompt =
      'A marathon is 42.195 km. If someone runs it in 3 hours 47 minutes, what is their ' +
      'average pace in minutes per mile? Use 1 mile = 1.609344 km.'
    const tool = `Total distance: 42.195 km
Total time: 3:47
Miles run: 26.218757
Pace: 8.6579 minutes per mile`
    const answer =
      'The pace is 8.6579 minutes per mile, converting 42.195 km to ~26.219 miles then ' +
      'dividing the total time of 227 minutes (3h 47m) by that distance.'
    assert.deepEqual(unsourcedQuantities(answer, tool, prompt), [])
  })

  test('money and bare counts stay with the checks that own them', () => {
    assert.deepEqual(unsourcedQuantities('It costs $4,200 and has 8 shows.', 'nothing'), [])
  })
})

describe('quantities in the report', () => {
  const ROUTE_ANSWER = 'Total: ~3,015 miles at 20 mi/day is about 151 days of riding.'

  test('a computed contradiction now produces a report at all', () => {
    const report = checkToolGrounding(ROUTE_ANSWER, [rec('run_python', ROUTE_TOOL_OUTPUT)], '')
    assert.ok(report, 'expected a report — this returned null through v1.9.1')
    assert.ok(report!.quantities?.some((q) => q.includes('3,015')))
  })

  test('the disclosure names them and says what to do', () => {
    const report = checkToolGrounding(ROUTE_ANSWER, [rec('run_python', ROUTE_TOOL_OUTPUT)], '')
    const text = describeGroundingFindings(report!)
    assert.match(text, /Measurements nothing computed or retrieved supports/)
    assert.match(text, /3,015 miles/)
    assert.match(text, /use that one/)
  })

  test('fixing the number counts as an improvement, so the revision is kept', () => {
    const before = checkToolGrounding(ROUTE_ANSWER, [rec('run_python', ROUTE_TOOL_OUTPUT)], '')
    const after = checkToolGrounding(
      'Total: 3755 miles at 20 mi/day.',
      [rec('run_python', ROUTE_TOOL_OUTPUT)],
      ''
    )
    assert.ok(groundingFindingCount(before) > 0)
    assert.ok(revisionIsAnImprovement(before!, after))
  })

  test('with nothing computed, a measurement is not a claim the tools could back', () => {
    // The gate: no numeric tool ran, so there is no corpus and no finding.
    const report = checkToolGrounding(
      'The venue is about 20 minutes from downtown.',
      [rec('web_search', 'Some search results about the venue.')],
      ''
    )
    assert.equal(report?.quantities ?? undefined, undefined)
  })

  test("the user's own measurement is theirs to restate", () => {
    const report = checkToolGrounding(
      'Staying within 20 minutes of the venue, the ride is 3755 miles.',
      [rec('run_python', ROUTE_TOOL_OUTPUT)],
      'i dont want to be more than 20 minutes away from the venue'
    )
    assert.equal(report, null)
  })
})

// ---- v1.11.2: source-tool text supports figures; laundered runs do not -------

describe('figures present in source-tool output are sourced, not invented', () => {
  test('percentages verbatim in web_search results are not flagged', () => {
    // The real false positive (2026-08-19): both figures stood in the search
    // snippets; a trivial run_python armed the check against a corpus that
    // excluded them.
    const records: ToolCallRecord[] = [
      {
        id: '1', name: 'web_search', args: {}, status: 'done',
        result: 'sales recovering 1.7% from January… building on a 2.6% gain in the first quarter'
      },
      { id: '2', name: 'run_python', args: {}, status: 'done', result: 'stdout:\nnote: nothing to recompute\n\nNumbers above were computed, not recalled: state them exactly as shown, with units, and say they came from running code.' }
    ]
    const report = checkToolGrounding(
      'Sales recovered 1.7% from January, building on a 2.6% gain in Q1.',
      records,
      'current status of the housing market'
    )
    assert.equal(report, null, JSON.stringify(report))
  })

  test('a percentage in NO corpus is still flagged', () => {
    const records: ToolCallRecord[] = [
      { id: '1', name: 'web_search', args: {}, status: 'done', result: 'prices rose 1.3% year over year' },
      { id: '2', name: 'run_python', args: {}, status: 'done', result: 'stdout:\nshare: 25.6\n' }
    ]
    const report = checkToolGrounding('About 45% of buyers paid cash.', records, 'housing')
    assert.ok(report?.figures.includes('45%'))
  })
})

describe('a hardcoded-constants run cannot support the reply (v1.11.2)', () => {
  const launderedResult =
    'Python ran in 5 ms.\n\nstdout:\nNVDA Beta: 1.05\n\nCaution: every number in this output appears as a literal in the code — nothing was computed. These are values you supplied, not results.'

  test('figures from a laundered run are flagged as unsourced', () => {
    const records: ToolCallRecord[] = [
      { id: '1', name: 'run_python', args: {}, status: 'done', result: launderedResult }
    ]
    // The laundered run arms the checks but supports nothing: its own
    // constants come back flagged instead of certified.
    const report = checkToolGrounding('The beta is $1.05 exactly, and TSLA moves 15% daily.', records, 'x')
    assert.ok(report?.figures.includes('$1.05'), JSON.stringify(report))
    assert.ok(report?.figures.includes('15%'), JSON.stringify(report))
  })

  test('the same run without the caution marker does support its numbers', () => {
    const records: ToolCallRecord[] = [
      { id: '1', name: 'run_python', args: {}, status: 'done', result: 'stdout:\nNVDA Beta: 1.05\n\nNumbers above were computed, not recalled.' }
    ]
    assert.equal(checkToolGrounding('The beta is $1.05 exactly.', records, 'x'), null)
  })
})

// ---- v1.12: cross-tool figure conflicts --------------------------------------

describe('conflictingToolFigures', () => {
  const { conflictingToolFigures, labeledFiguresIn } = require('../src/renderer/src/lib/toolGrounding') as typeof import('../src/renderer/src/lib/toolGrounding')
  const rec = (name: string, result: string, id = Math.random().toString(36)): ToolCallRecord =>
    ({ id, name, args: {}, status: 'done', result }) as ToolCallRecord

  test('the measured case: market_data vs the model python, same label, different sign', () => {
    // Verbatim shapes from the live NVDA session.
    const records = [
      rec('market_data', '- period return (6mo): 14.61%  (190.5 → 217.4)\n- max drawdown (close-to-close): -19.40%'),
      rec('run_python', 'stdout:\nPeriod Return: -8.99%\nPrice Range High: $236.54')
    ]
    const conflicts = conflictingToolFigures(records)
    assert.equal(conflicts.length, 1, JSON.stringify(conflicts))
    assert.match(conflicts[0]!, /period return/i)
    assert.match(conflicts[0]!, /14\.61%/)
    assert.match(conflicts[0]!, /-8\.99%/)
  })

  test('agreement within rounding is not a conflict', () => {
    const records = [
      rec('market_data', '- period return (6mo): 14.61%'),
      rec('run_python', 'Period Return: 14.6%')
    ]
    assert.deepEqual(conflictingToolFigures(records), [])
  })

  test('different labels or different units never conflict', () => {
    const records = [
      rec('market_data', '- period return (6mo): 14.61%\n- last close: 217.40'),
      rec('run_python', 'Total Return: 99.0%\nlast close: 217.40%')
    ]
    // "period return" vs "total return": different labels. "last close" 217.40
    // (bare) vs 217.40% (percent): different units — and equal anyway.
    assert.deepEqual(conflictingToolFigures(records), [])
  })

  test('a single tool disagreeing with itself across calls still surfaces', () => {
    const records = [
      rec('run_python', 'total revenue: $487,988.40'),
      rec('run_python', 'total revenue: $975,976.80')
    ]
    const conflicts = conflictingToolFigures(records)
    assert.equal(conflicts.length, 1)
    assert.match(conflicts[0]!, /487,988\.40/)
  })

  test('fewer than two numeric tool results → nothing to compare', () => {
    assert.deepEqual(conflictingToolFigures([rec('run_python', 'x: 5')]), [])
    assert.deepEqual(conflictingToolFigures([rec('web_search', 'a: 1'), rec('web_search', 'a: 2')]), [])
  })

  test('labeledFiguresIn strips parentheticals and keeps units and signs', () => {
    const f = labeledFiguresIn('- period return (6mo): -8.99%\nmax loss = $160.00')
    assert.deepEqual(f.map((x) => [x.label, x.value, x.unit]), [
      ['period return', -8.99, '%'],
      ['max loss', 160, '$']
    ])
  })
})

// ---- v1.12.2: measurements on a retrieval-grounded turn -----------------------

/**
 * The passages are the shipped packs' own words — the ibuprofen dose from
 * `health`, the cooking temperatures verbatim from `food-safety/four-steps.md`
 * — wrapped in the shape `library.ts formatLookup` actually produces.
 *
 * Through v1.12.1 every case below returned null: `reference_lookup` was not
 * in NUMERIC_TOOLS, so the measurement check never armed on a retrieval turn,
 * and a reply that answered "give 500 mg" over a passage reading "200 mg to
 * 400 mg" was passed through in silence. The library eval has scored replies
 * against exactly this standard since v1.6 (`unsupportedMeasurements`); the
 * app now holds itself to it too.
 */
const DOSE_PASSAGES = `Reference passages for "how much ibuprofen can an adult take" from the local library (semantic + keyword ranking), most relevant first.

[1] health › Pain Relievers › Over-the-counter doses · 34% in
    relevance 0.71
For adults the usual over-the-counter ibuprofen dose is 200 mg to 400 mg every 4 to 6 hours while symptoms last. Do not exceed 1200 mg in 24 hours unless a provider directs it.`

const COOK_PASSAGES = `Reference passages for "what temperature should chicken be cooked to" from the local library (semantic + keyword ranking), most relevant first.

[1] food-safety › Four Steps to Food Safety › Cook to the Right Temperature · 61% in
    relevance 0.68
Keep food hot (140°F (60°C) or above) after cooking. Microwave food thoroughly (165°F (74°C) or above).`

describe('unsupported measurements on a retrieval-grounded turn (v1.12.2)', () => {
  test('an invented dose over a passage that states the dose is flagged', () => {
    const report = checkToolGrounding(
      'For an adult, give 500 mg of ibuprofen every 6 hours [1].',
      [rec('reference_lookup', DOSE_PASSAGES)],
      'how much ibuprofen can an adult take'
    )
    assert.ok(report, 'expected a report — this returned null through v1.12.1')
    assert.ok(
      report!.quantities?.some((q) => /500\s?mg/i.test(q)),
      `expected the invented dose, got ${JSON.stringify(report!.quantities)}`
    )
    // The duration IS supported by the same passage, so it must not be named.
    assert.ok(!report!.quantities?.some((q) => /hour/i.test(q)), JSON.stringify(report!.quantities))
  })

  test('the dose the passage does state is not flagged — the true negative', () => {
    const report = checkToolGrounding(
      'Adults take 200 mg to 400 mg every 4 to 6 hours, and no more than 1200 mg in 24 hours [1].',
      [rec('reference_lookup', DOSE_PASSAGES)],
      'how much ibuprofen can an adult take'
    )
    assert.equal(report, null, `a correctly cited dose must stay clean: ${JSON.stringify(report)}`)
  })

  test('an undercooked chicken temperature is flagged; the passage\'s own is not', () => {
    const wrong = checkToolGrounding(
      'Cook chicken to an internal temperature of 145°F.',
      [rec('reference_lookup', COOK_PASSAGES)],
      'what internal temperature should chicken be cooked to'
    )
    assert.ok(wrong?.quantities?.some((q) => /145/.test(q)), JSON.stringify(wrong))
    const right = checkToolGrounding(
      'Cook it to 165°F (74°C), and hold it at 140°F or above [1].',
      [rec('reference_lookup', COOK_PASSAGES)],
      'what internal temperature should chicken be cooked to'
    )
    assert.equal(right, null, JSON.stringify(right))
  })

  test('the finding reaches the user: named in the disclosure, counted in the report', () => {
    const report = checkToolGrounding(
      'For an adult, give 500 mg of ibuprofen every 6 hours [1].',
      [rec('reference_lookup', DOSE_PASSAGES)],
      'how much ibuprofen can an adult take'
    )
    assert.equal(groundingFindingCount(report), 1)
    const text = describeGroundingFindings(report!)
    assert.match(text, /Measurements nothing computed or retrieved supports/)
    assert.match(text, /500 mg/)
    assert.match(text, /reference_lookup/)
  })

  test('a retrieval turn that measured nothing arms nothing', () => {
    // The passages carry no measurement, so there is no corpus to disagree
    // with and the reply's own "about 20 minutes" is not this rung's business.
    const report = checkToolGrounding(
      'It usually takes about 20 minutes to set.',
      [rec('reference_lookup', 'Reference passages for "grout": let the grout cure before sealing it.')],
      'how long before I can seal grout'
    )
    assert.equal(report, null, JSON.stringify(report))
  })
})

/**
 * v1.12.1: the reply's account of its own process, and the failure path that
 * used to switch the source checks off.
 *
 * Both halves of one gap. Nothing joined the sentence "I've used web_search to
 * gather the latest data" to the turn's actual tool set, so a model could
 * narrate a search that never happened and every rung above stayed silent —
 * the claim is not a figure, a link or an address. And when a search *did* run
 * and errored, `sourceRecords` filtered it out, which disarmed the link, origin
 * and address checks on exactly the turn where the model holds no retrieved
 * URLs and everything it prints came from memory.
 */
describe('tool-use claims (v1.12.1)', () => {
  test('a named tool that did not run this turn is flagged', () => {
    const answer = "I've used web_search to gather the latest data on this."
    assert.deepEqual(unrunToolClaims(answer, [rec('get_current_datetime', '2026-08-24')]), [
      'web_search'
    ])
  })

  test('the same claim about a tool that DID run is not flagged', () => {
    const answer = "I've used web_search to gather the latest data on this."
    assert.deepEqual(unrunToolClaims(answer, [rec('web_search', 'results')]), [])
  })

  test('a tool that ran and errored still ran — the reply saying so is true', () => {
    const answer = 'I ran web_search for this.'
    assert.deepEqual(unrunToolClaims(answer, [rec('web_search', 'timed out', 'error')]), [])
  })

  test('the spelled-out form counts only when named as a tool', () => {
    assert.deepEqual(unrunToolClaims('I used the web search tool for this.', []), ['web_search'])
    // Prose about the subject matter is not a claim about the app.
    assert.deepEqual(unrunToolClaims('Using market data from your broker, decide.', []), [])
  })

  test('offering, declining or denying a tool is not claiming it', () => {
    for (const answer of [
      'I can run web_search if you want the current figure.',
      'I could not use web_search here — it is disabled.',
      'I have not used web_search, so this is from memory.',
      'No web_search ran, so treat these as approximate.'
    ]) {
      assert.deepEqual(unrunToolClaims(answer, []), [], answer)
    }
  })

  test('a claim about an earlier turn is not this turn\'s to judge', () => {
    // These records are one turn's. "I used web_search earlier" may be true of
    // a turn this pass never sees, and flagging it would be the noise that
    // teaches a reader to dismiss the badge.
    assert.deepEqual(unrunToolClaims('I used web_search earlier for these figures.', []), [])
  })

  test('reported through checkToolGrounding, with the badge naming the tool', () => {
    const report = checkToolGrounding(
      "I've used web_search to gather the latest data. Prices are stable.",
      [rec('get_current_datetime', '2026-08-24')],
      'whats the news'
    )
    assert.ok(report, 'expected a report')
    assert.deepEqual(report!.toolClaims, ['web_search'])
    assert.equal(groundingFindingCount(report), 1)
    assert.match(describeGroundingFindings(report!), /says you used web_search/)
  })

  test('an honest reply on a toolless turn produces no report', () => {
    assert.equal(checkToolGrounding('I have no search here, so this is from memory.', [], ''), null)
  })
})

describe('an errored search arms the link check instead of disarming it (v1.12.1)', () => {
  const answer = 'See https://www.example.com/2026-report for the figures.'

  test('the measured backwards case: search errored, unsourced link now flagged', () => {
    const report = checkToolGrounding(answer, [rec('web_search', 'search failed: timeout', 'error')], 'find the report')
    assert.ok(report, 'expected a report — the reply cites a URL nothing retrieved')
    assert.deepEqual(report!.links, ['https://www.example.com/2026-report'])
  })

  test('the disclosure says the search errored rather than "nothing ran"', () => {
    const report = checkToolGrounding(answer, [rec('web_search', 'search failed: timeout', 'error')], '')
    assert.deepEqual(report!.checkedAgainst, ['web_search (errored)'])
  })

  test('a URL the user pasted is not an invention when the fetch of it failed', () => {
    const report = checkToolGrounding(
      'I could not open https://www.example.com/2026-report — the fetch failed.',
      [rec('fetch_webpage', 'HTTP 503', 'error')],
      'summarise https://www.example.com/2026-report'
    )
    assert.equal(report, null)
  })

  test('an address invented on a failed-search turn is flagged too', () => {
    const report = checkToolGrounding(
      'Stop 1: Gristedes – 800 3rd Ave, New York, NY',
      [rec('web_search', 'search failed: budget exhausted', 'error')],
      'plan my route'
    )
    assert.ok(report?.addresses?.some((a) => a.includes('800 3rd Ave')))
  })

  test('a turn where no source tool was even attempted is still not link-checked', () => {
    // Unchanged: with no retrieval attempted, a link is the model answering
    // from memory, which is the `unverified` badge's job, not this one.
    assert.equal(checkToolGrounding(answer, [rec('get_current_datetime', 'now')], ''), null)
  })
})

/**
 * v1.13: a citation index is a claim of the same kind as a figure or a link,
 * and it was the one kind nothing checked. The lookup output below is
 * transcribed from a real run — two numbered passages, each carrying the
 * locator that would make the citation followable. The reply cited them, and
 * a reader had no way to tell that a third marker named nothing at all.
 */
const LIBRARY_LOOKUP = `Reference passages for "standard deduction" from the local library (keyword ranking), most relevant first.

[1] Personal finance & tax basics › Tax inflation adjustments for tax year 2025 · 10% in
    source: https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2025
    date: retrieved 2026-08-16
    relevance 1
For married couples filing jointly, the standard deduction rises to $30,000.
[2] Personal finance & tax basics › Tax Topic 501 — Should I itemize? · 0% in
    source: https://www.irs.gov/taxtopics/tc501
    relevance 0.996
Individuals may take a standard deduction or itemize.`

describe('citation markers', () => {
  test('an [n] that names no retrieved passage is a finding', () => {
    const report = checkToolGrounding(
      'The standard deduction is $30,000 [1]. Itemizing may beat it [2]. See Publication 17 [4].',
      [rec('reference_lookup', LIBRARY_LOOKUP)],
      ''
    )
    assert.ok(report, 'expected a report: [4] names a passage that was never retrieved')
    assert.deepEqual(report!.citations, ['[4]'])
    assert.equal(groundingFindingCount(report), 1)
    assert.match(describeGroundingFindings(report!), /\[4\]/)
  })

  test('citing only the passages that came back says nothing', () => {
    const report = checkToolGrounding(
      'The standard deduction is $30,000 [1], unless you itemize [2].',
      [rec('reference_lookup', LIBRARY_LOOKUP)],
      ''
    )
    assert.equal(report, null)
  })

  test('no lookup, no claim — a bare [1] in ordinary prose is not flagged', () => {
    const report = checkToolGrounding('As noted earlier [1], rates vary.', [rec('web_search', 'x')], '')
    assert.equal(report, null)
  })
})

/**
 * v1.12.3: the footer must not contradict the checks above it.
 *
 * Measured (V3): the 🧮 line said the recomputation re-derived the answer from
 * itself and "checks nothing", and the ⚠️ strip two lines below closed with
 * "Checked against: reference_lookup, run_python" — naming, as a check, the run
 * the app had just called worthless. A run marked `checksNothing` is treated
 * exactly like a laundered one: it arms the checks, supports no figure, and is
 * never named as something the answer was checked against.
 */
describe('a run that checked nothing is never named as a check', () => {
  // What runRecompute writes when recomputeIsCircular fires: the same record it
  // shows as "Ran Python", plus the marker saying it settled nothing.
  const circular = (result: string): ToolCallRecord => ({
    ...rec('run_python', result),
    preamble: 'App-initiated: recomputing the figures stated in the answer.',
    checksNothing: true
  })

  // $450 appears in no output at all, so a report exists either way and the
  // assertion under test is the footer, not whether the badge fired.
  const ANSWER = 'The two tiers cost $100 and $200. The bundle is $450.'
  const RECOMPUTE_STDOUT = '100\n200'

  test('the circular recompute drops out of "Checked against"', () => {
    const report = checkToolGrounding(
      ANSWER,
      [rec('reference_lookup', 'Passage: onboarding is handled by the vendor.'), circular(RECOMPUTE_STDOUT)],
      ''
    )
    assert.ok(report, 'expected a report: $450 is in no output')
    assert.ok(report!.figures.includes('$450'))
    assert.ok(report!.checkedAgainst.includes('reference_lookup'))
    assert.equal(
      report!.checkedAgainst.some((c) => c.includes('run_python')),
      false,
      'the footer named a run the 🧮 line had already called circular'
    )
    // The circular run supports no figure either: $100 and $200 came back out
    // of the model's own constants, which is exactly what "checks nothing" meant.
    assert.ok(report!.figures.includes('$100'))
    assert.ok(report!.figures.includes('$200'))
  })

  test('when it is the only thing that ran, the footer says so instead of "nothing ran"', () => {
    const report = checkToolGrounding(ANSWER, [circular(RECOMPUTE_STDOUT)], '')
    assert.ok(report, 'expected a report: $450 is in no output')
    assert.deepEqual(report!.checkedAgainst, ['nothing — the only checks that ran verified nothing'])
  })

  test('an ordinary recompute is still named — the rule is narrow', () => {
    const honest = { ...rec('run_python', '100\n200\n30'), preamble: 'App-initiated: recomputing the figures stated in the answer.' }
    const report = checkToolGrounding('The two tiers cost $100 and $250.', [honest], '')
    assert.ok(report, 'expected a report: $250 is in no output')
    assert.deepEqual(report!.checkedAgainst, ['run_python'])
  })
})

const FOOD_LOOKUP = `Reference passages for "how many days can cooked rice stay in the fridge" from the local library (keyword ranking), most relevant first.

[3] Food safety › Refrigerator thermometers — cold facts (FDA) › Refrigerator Strategies: Keeping Food Safe · 13% in
    source: https://www.fda.gov/food/buy-store-serve-safe-food/refrigerator-thermometers-cold-facts-about-food-safety
    relevance 0.604
- Keep It Covered: Store refrigerated foods in covered containers or sealed storage bags, and check leftovers daily for spoilage.
- Check Expiration Dates On Foods. If food is past its "use by" date, discard it.
[4] Food safety › Safe food handling (FDA) › COOK · 51% in
    source: https://www.fda.gov/food/buy-store-serve-safe-food/safe-food-handling
    relevance 0.497
- Bring sauces, soups and gravy to a boil when reheating.
[5] Food safety › Leftovers and food safety (USDA) › Thaw Frozen Leftovers Safely · 52% in
    source: https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/leftovers-and-food-safety
    relevance 0.46
Refrigerator thawing takes the longest but the leftovers stay safe the entire time. After thawing, the food should be used within 3 to 4 days or can be refrozen.`

const RICE_PROMPT =
  'Using only my reference library, how many days can cooked rice stay in the fridge? Quote me the exact line you are getting that from.'

describe('quotation fidelity (v1.14)', () => {
  test('a quoted span the retrieved text does not contain is a finding', () => {
    // Verbatim from the recorded run: "checking leftovers daily," against a
    // passage reading "check leftovers daily for spoilage". The marker is where
    // the two stop agreeing, which is the whole of the difference (v1.17).
    assert.deepEqual(
      misquotedSpans(
        'The passages mention "checking leftovers daily," and little else.',
        FOOD_LOOKUP
      ),
      ['check⟪ing⟫ leftovers daily,']
    )
  })

  test('the true quotation in the same reply is not a finding', () => {
    assert.deepEqual(
      misquotedSpans(
        'Passage [5] says: "After thawing, the food should be used within 3 to 4 days or can be refrozen."',
        FOOD_LOOKUP
      ),
      []
    )
  })

  test('a markdown blockquote is a quotation claim too', () => {
    assert.deepEqual(misquotedSpans('> Discard all leftovers after two days.\n', FOOD_LOOKUP), [
      'Discard ⟪all leftovers after two⟫ days.'
    ])
    assert.deepEqual(
      misquotedSpans('> Bring sauces, soups and gravy to a boil when reheating.\n', FOOD_LOOKUP),
      []
    )
  })

  test('scare quotes and short asides are not citation claims', () => {
    // Under the length floor: an ordinary phrase in quotes says nothing about
    // a source, and flagging it is the noise that gets a badge ignored.
    assert.deepEqual(misquotedSpans('The rule is "when in doubt".', FOOD_LOOKUP), [])
  })

  test('an explicit ellipsis is the quoter marking the cut, not hiding it', () => {
    assert.deepEqual(
      misquotedSpans(
        '"Refrigerator thawing takes the longest ... the food should be used within 3 to 4 days"',
        FOOD_LOOKUP
      ),
      []
    )
  })

  test('rendered curly quotes are the same claim as typed straight ones', () => {
    assert.deepEqual(
      misquotedSpans('It says “checking leftovers daily,” in passage [3].', FOOD_LOOKUP),
      ['check⟪ing⟫ leftovers daily,']
    )
  })

  test('a quotation inside a code fence is a snippet, not a citation', () => {
    assert.deepEqual(
      misquotedSpans('```\nassert x == "checking leftovers daily,"\n```', FOOD_LOOKUP),
      []
    )
  })

  test('the recorded reply, end to end, with the badge naming the span', () => {
    const report = checkToolGrounding(
      'The closest relevant passage is [5], which says: "After thawing, the food should be used ' +
        'within 3 to 4 days or can be refrozen." The other passages cover general strategies like ' +
        '"checking leftovers daily," but none give a day count for cooked rice.',
      [rec('reference_lookup', FOOD_LOOKUP)],
      RICE_PROMPT
    )
    assert.ok(report, 'expected a report: one of the two quotations is not in the passage')
    assert.deepEqual(report!.quotes, ['check⟪ing⟫ leftovers daily,'])
    // The line the reader gets carries the break AND the legend for it: a
    // marker nobody can read is the truncation problem in a new costume.
    const said = describeGroundingFindings(report!)
    assert.match(said, /check⟪ing⟫ leftovers daily/)
    assert.match(said, /⟪⟫ marks where the quotation stops matching/)
  })

  test('the same reply with both quotations verbatim says nothing', () => {
    const report = checkToolGrounding(
      'The closest guidance is in passage [3], which only says: "Store refrigerated foods in ' +
        'covered containers or sealed storage bags, and check leftovers daily for spoilage." It ' +
        'does not give a specific number of days.',
      [rec('reference_lookup', FOOD_LOOKUP)],
      RICE_PROMPT
    )
    assert.equal(report, null)
  })

  test('with nothing retrieved there is no source to check a quotation against', () => {
    const report = checkToolGrounding(
      'The old saying runs "checking leftovers daily, and trusting your nose".',
      [rec('get_current_datetime', '2026-08-24')],
      'tell me a saying'
    )
    assert.equal(report, null)
  })
})

/**
 * v1.15, and the false positive that would have taught the reader to ignore
 * the badge.
 *
 * Recorded (task V2, run 1): the reply quoted passage [1] word for word and
 * closed the line with the marker it was citing — `"…tax year 2024." [1]` —
 * inside a markdown blockquote. The blockquote pattern bounds a span by the
 * line, not by the quotation marks, so the span checked carried both the marks
 * and the marker, matched nothing, and the badge read
 * `⚠️ Quoted as exact but in no tool output this turn: “"For married couples
 * filing jointly, the standard deduction rises to $30…”` — the doubled quote
 * mark being the giveaway. The straight-quote pattern had matched the very
 * same sentence and passed it: the reply made one quotation claim and the
 * checker ruled on it twice, under two boundaries, and reported the looser.
 *
 * A bracketed marker is the quoter's own attribution — `[1]` is not a word the
 * source wrote — so it is trimmed at either edge like the quoter's other
 * punctuation. Nothing else about the comparison moves: the body still has to
 * be in the corpus character for character.
 */
const IRS_LOOKUP = `Reference passages for "standard deduction married filing jointly" from the local library (keyword ranking), most relevant first.

[1] Personal finance & tax basics › Tax inflation adjustments for tax year 2025 › Notable changes for tax year 2025 · 10% in
    source: https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2025
    relevance 1
- Standard deductions. For single taxpayers and married individuals filing separately for tax year 2025, the standard deduction rises to $15,000 for 2025, an increase of $400 from 2024. For married couples filing jointly, the standard deduction rises to $30,000, an increase of $800 from tax year 2024. For heads of households, the standard deduction will be $22,500 for tax year 2025, an increase of $600 from the amount for tax year 2024.`

/** Passage [2] of the TH1 run: the two halves sit on separate lines. */
const CDC_LOOKUP = `Reference passages for "ground beef minimum internal temperature" from the local library (keyword ranking), most relevant first.

[2] Food safety › Preventing food poisoning (CDC) › Safe internal temperatures for different foods · 47% in
    source: https://www.cdc.gov/food-safety/prevention/index.html
    relevance 0.888
Whole cuts of beef, veal, lamb, and pork, including fresh ham

145°F (then allow the meat to rest for 3 minutes before carving or eating)

Ground meats, such as beef and pork

160°F

All poultry, including ground chicken and turkey

165°F`

const V2_QUOTE =
  '"For married couples filing jointly, the standard deduction rises to $30,000, an increase of $800 from tax year 2024."'

describe('quotation fidelity · citation markers (v1.15)', () => {
  test('the V2 span: a blockquoted verbatim quotation closed with its marker', () => {
    assert.deepEqual(
      misquotedSpans(
        `For tax year 2025 it is $30,000. This comes directly from the IRS:\n\n> ${V2_QUOTE} [1]\n\nIf either spouse is 65 or older…`,
        IRS_LOOKUP
      ),
      []
    )
  })

  test('the marker alone is enough to break it, quotation marks or not', () => {
    assert.deepEqual(
      misquotedSpans(
        '> For married couples filing jointly, the standard deduction rises to $30,000, an increase of $800 from tax year 2024. [1]\n',
        IRS_LOOKUP
      ),
      []
    )
    assert.deepEqual(misquotedSpans(`${V2_QUOTE} [1][3]`, IRS_LOOKUP), [])
    assert.deepEqual(misquotedSpans(`> [1] ${V2_QUOTE}\n`, IRS_LOOKUP), [])
  })

  test('reported through checkToolGrounding, the V2 turn says nothing about quotes', () => {
    const report = checkToolGrounding(
      `For tax year 2025, the standard deduction for a married couple filing jointly is $30,000. This comes directly from the IRS:\n\n> ${V2_QUOTE} [1]\n`,
      [rec('reference_lookup', IRS_LOOKUP)],
      "What's the standard deduction for a married couple filing jointly? Cite the source."
    )
    assert.deepEqual(report?.quotes ?? [], [])
  })

  test('the TH1 span, invented and stitched, is still caught — marker and all', () => {
    // Recorded (task TH1, run 2). "Ground meats, such as beef and pork" and
    // "160°F" are two separate lines of passage [2]; the em dash joining them
    // is the reply's, and no source says this.
    assert.deepEqual(
      misquotedSpans(
        'CDC Safe Internal Temperatures: "Ground meats, such as beef and pork — 160°F" [2]',
        CDC_LOOKUP
      ),
      ['Ground meats, such as beef and pork ⟪—⟫ 160°F']
    )
    assert.deepEqual(
      misquotedSpans('> "Ground meats, such as beef and pork — 160°F" [2]\n', CDC_LOOKUP),
      ['Ground meats, such as beef and pork ⟪—⟫ 160°F']
    )
  })

  test('a marker does not launder an invention through a blockquote', () => {
    assert.deepEqual(
      misquotedSpans('> "Discard all leftovers after two days." [3]\n', FOOD_LOOKUP),
      ['Discard ⟪all leftovers after two⟫ days.']
    )
  })

  test('trimming the marker trims nothing else: a wrong figure inside stays wrong', () => {
    // v1.17: and the figure is now IN the reported string. The old clamp cut
    // this span at 72 characters — `…rises to $32,…` — one character short of
    // the digit it was complaining about.
    assert.deepEqual(
      misquotedSpans(
        '> "For married couples filing jointly, the standard deduction rises to $32,000, an increase of $800 from tax year 2024." [1]\n',
        IRS_LOOKUP
      ),
      ['…jointly, the standard deduction rises to $3⟪2⟫,000, an increase of $800 from tax year…']
    )
  })

  test('one claim, one finding — the two patterns that bound it do not double-report', () => {
    const flagged = misquotedSpans('> "Discard all leftovers after two days." [3]\n', FOOD_LOOKUP)
    assert.equal(flagged.length, 1)
  })
})

/**
 * v1.17, and the two halves of one defect: a fabrication warning that fires on
 * a verbatim quotation, and a warning the reader cannot check because it stops
 * before the words it is complaining about.
 *
 * Recorded, task TH3. The pack line is quoted here character for character from
 * `packs/food-safety/docs/refrigerator-thermometers.md`. The reply quoted the
 * whole sentence, so its own outer pair took the double marks and the source's
 * nested pair came back out as `‘When in doubt, throw it out.’`. Two glyphs out
 * of a hundred and four, no word different — and the badge printed
 *
 *   ⚠️ Quoted as exact but in no tool output this turn: "If you're not sure or
 *   if the food looks questionable, the simple rule is…"
 *
 * where the 72-character clamp lands *before* the only characters that differ.
 * A reader who checks it against the source finds nothing wrong, which is the
 * lesson round 4 already paid for: a check that cries wolf is a check that gets
 * ignored.
 */
const THERMOMETER_LOOKUP = `Reference passages for "how long do leftovers keep in the fridge" from the local library (keyword ranking), most relevant first.

[3] Food safety › Refrigerator thermometers — cold facts (FDA) › Refrigerator Strategies: Keeping Food Safe · 13% in
    source: https://www.fda.gov/food/buy-store-serve-safe-food/refrigerator-thermometers-cold-facts-about-food-safety
    relevance 0.604
- Check Expiration Dates On Foods. If food is past its “use by” date, discard it. If you’re not sure or if the food looks questionable, the simple rule is: “When in doubt, throw it out.”`

const TH3_PROMPT =
  'Using only my reference library, how long do leftovers keep? Quote the exact line.'

const TH3_QUOTE =
  "If you're not sure or if the food looks questionable, the simple rule is: 'When in doubt, throw it out.'"

describe('quotation fidelity · the glyph is not the claim (v1.17)', () => {
  test('the TH3 span: a nested pair re-drawn as single quotes is the same quotation', () => {
    assert.deepEqual(misquotedSpans(`The FDA passage says: "${TH3_QUOTE}"`, THERMOMETER_LOOKUP), [])
    // …and the same sentence as a renderer hands it back, curly throughout.
    assert.deepEqual(
      misquotedSpans(
        '“If you’re not sure or if the food looks questionable, the simple rule is: ‘When in doubt, throw it out.’”',
        THERMOMETER_LOOKUP
      ),
      []
    )
  })

  test('reported through checkToolGrounding, the TH3 turn says nothing at all', () => {
    const report = checkToolGrounding(
      `The library has one line on this, in passage [3]:\n\n> "${TH3_QUOTE}" [3]\n\nIt gives no day count.`,
      [rec('reference_lookup', THERMOMETER_LOOKUP)],
      TH3_PROMPT
    )
    assert.equal(report, null)
  })

  test('the true positive beside it: change the words and the words are named', () => {
    const flagged = misquotedSpans(
      `The FDA passage says: "If you're not sure or if the food smells strange, the simple rule is: 'When in doubt, throw it out.'"`,
      THERMOMETER_LOOKUP
    )
    assert.equal(flagged.length, 1)
    assert.match(flagged[0]!, /⟪smells strange⟫/)
  })

  test('the fold moves a glyph’s shape, never its position', () => {
    // Same words, same marks, one of them a clause earlier: the reply now has
    // the source ending its quotation at "doubt", which it does not. Deleting
    // quote characters instead of folding them would pass this.
    const flagged = misquotedSpans(
      `He read it out: "If you're not sure or if the food looks questionable, the simple rule is: 'When in doubt', throw it out."`,
      THERMOMETER_LOOKUP
    )
    assert.equal(flagged.length, 1)
    assert.match(flagged[0]!, /doubt⟪'⟫, throw/)
  })

  test('a wholly invented quotation is still wholly flagged', () => {
    // The TH2 family: five quotations attributed to bodies the turn never
    // retrieved. Nothing in this fold makes one of them match.
    const flagged = misquotedSpans(
      'The CPSC puts it plainly: "Every home should have a working smoke alarm on every level, tested monthly and replaced after ten years."',
      THERMOMETER_LOOKUP
    )
    assert.equal(flagged.length, 1)
    assert.ok(!flagged[0]!.includes('⟪'), 'nothing to single out when none of it matches')
  })
})

describe('quotation fidelity · the excerpt shows the difference (v1.17)', () => {
  const V2_BOLD =
    '"For married couples filing jointly, the standard deduction rises to **$30,000**, an increase of $800 from tax year 2024."'

  test('the V2 span: emphasis inside a quotation is markup, not a word', () => {
    assert.deepEqual(misquotedSpans(`> ${V2_BOLD} [1]\n`, IRS_LOOKUP), [])
    assert.deepEqual(misquotedSpans(`As the IRS puts it, ${V2_BOLD}`, IRS_LOOKUP), [])
  })

  test('the true positive beside it: the figure inside the emphasis is still checked', () => {
    const flagged = misquotedSpans(
      `> ${V2_BOLD.replace('$30,000', '$32,000')} [1]\n`,
      IRS_LOOKUP
    )
    assert.equal(flagged.length, 1)
    // Round 6 printed `…the standard deduction rises to **$3…`: raw markdown,
    // cut one character before the digit it was complaining about.
    assert.ok(!flagged[0]!.includes('*'), 'markdown source is not user-facing text')
    assert.match(flagged[0]!, /\$3⟪2⟫,000/)
  })

  test('the window is centred on the break, not measured from the start', () => {
    const flagged = misquotedSpans(
      `> ${V2_BOLD.replace('$30,000', '$32,000')} [1]\n`,
      IRS_LOOKUP
    )
    // Both sides of it are readable, and the elision says which end was cut.
    assert.match(flagged[0]!, /^…/)
    assert.match(flagged[0]!, /…$/)
    assert.match(flagged[0]!, /rises to \$3⟪2⟫,000, an increase of \$800/)
    assert.ok(flagged[0]!.length <= 90, `excerpt stayed a line: ${flagged[0]!.length}`)
  })

  test('the revision line keeps the marker it exists to show', () => {
    const report = checkToolGrounding(
      `> ${V2_BOLD.replace('$30,000', '$32,000')} [1]\n`,
      [rec('reference_lookup', IRS_LOOKUP)],
      "What's the standard deduction for a married couple filing jointly? Cite the source."
    )
    assert.ok(report, 'expected a report: $32,000 is in no passage')
    const labels = groundingFindingLabels(report)
    assert.equal(labels.length, groundingFindingCount(report))
    // A 48-character head clamp would have stopped in the run-up to the break.
    assert.ok(
      labels.some((l) => /\$3⟪2⟫,000/.test(l)),
      `expected the break in a label, got ${JSON.stringify(labels)}`
    )
  })

  test('an unpaired asterisk is not emphasis, and does not vanish from the source', () => {
    // The fold is paired-delimiter only, so a lone `*` still has to be quoted.
    const corpus = 'Refrigerate within 2 hours* of cooking. *Or 1 hour above 90°F.'
    assert.deepEqual(misquotedSpans('It says "Refrigerate within 2 hours* of cooking."', corpus), [])
    assert.equal(
      misquotedSpans('It says "Refrigerate within 4 hours* of cooking."', corpus).length,
      1
    )
  })
})

describe('citation attribution (v1.14)', () => {
  const retrieved = retrievedCitations([rec('reference_lookup', FOOD_LOOKUP)])

  test('a marker labelled with another passage’s document is a finding', () => {
    // [5] is USDA "Leftovers and food safety"; "Safe food handling" is [4].
    assert.deepEqual(
      misattributedCitations(
        'The closest passage is [5] (USDA Safe Food Handling), which says:',
        retrieved
      ),
      ['[5] USDA Safe Food Handling']
    )
  })

  test('a marker labelled with its own document is not', () => {
    assert.deepEqual(
      misattributedCitations(
        'The closest guidance is in passage [3] (FDA Refrigerator Strategies).',
        retrieved
      ),
      []
    )
  })

  test('detail the labels never carried is not judged either way', () => {
    // "FSIS" appears in no retrieved label, so it is extra this check cannot
    // rule on — every word it CAN rule on points at [5].
    assert.deepEqual(
      misattributedCitations('| [5] USDA FSIS Leftovers and Food Safety | ... |', retrieved),
      []
    )
  })

  test('a document nothing retrieved is the same class of error', () => {
    assert.deepEqual(
      misattributedCitations('See [3] (Mayo Clinic Kitchen Guide) for the details.', retrieved),
      ['[3] Mayo Clinic Kitchen Guide']
    )
  })

  test('an ordinary parenthetical aside is not an attribution', () => {
    assert.deepEqual(
      misattributedCitations(
        'Passage [3] (see the note below, which qualifies it) applies here.',
        retrieved
      ),
      []
    )
  })

  test('reported through checkToolGrounding, with the badge naming the passage', () => {
    const report = checkToolGrounding(
      'The closest relevant passage is [5] (USDA Safe Food Handling), which does not answer it.',
      [rec('reference_lookup', FOOD_LOOKUP)],
      RICE_PROMPT
    )
    assert.ok(report, 'expected a report: [5] is attributed to a different document')
    assert.deepEqual(report!.attributions, ['[5] USDA Safe Food Handling'])
    assert.match(describeGroundingFindings(report!), /wrong document/)
  })
})

/**
 * v1.14, and the gap `unrunToolClaims` could not see.
 *
 * Recorded: the user asked which tools were used and what each returned. One
 * call ran, `reference_lookup`. The reply answered under a heading reading
 * "Tools used:" with a two-row table whose rows were library *documents* — and
 * never mentioned the tool. `unrunToolClaims` scans for tool names, so a
 * disclosure that names none is invisible to it: every name in that table was
 * real and every quotation in it checked out, and the reader's actual question
 * was answered with something that is not a tool.
 */
const TOOLS_USED_TABLE = `Ground beef needs to reach an internal temperature of **160 °F**.

**Tools used:**

| Tool | What it returned |
|------|------------------|
| [2] CDC Safe Internal Temperatures | 160°F for ground meats |
| [3] USDA Cook Food Safely at Home | 160° F measured with a thermometer |`

describe('tools-used disclosure (v1.14)', () => {
  test('a Tools used section naming documents instead of calls is a finding', () => {
    assert.deepEqual(undisclosedToolRuns(TOOLS_USED_TABLE, [rec('reference_lookup', 'passages')]), [
      'reference_lookup'
    ])
  })

  test('the same section naming the call that ran is not', () => {
    const named = TOOLS_USED_TABLE.replace(
      '| [2] CDC Safe Internal Temperatures',
      '| reference_lookup'
    )
    assert.deepEqual(undisclosedToolRuns(named, [rec('reference_lookup', 'passages')]), [])
  })

  test('the spaced-out spelling counts as naming it', () => {
    const named = '**Tools used:**\n\n| reference lookup | 5 passages |'
    assert.deepEqual(undisclosedToolRuns(named, [rec('reference_lookup', 'passages')]), [])
  })

  test('a disclosure that says nothing ran is honest about naming nothing', () => {
    assert.deepEqual(
      undisclosedToolRuns('Tools used: none — this is from general knowledge.', [
        rec('reference_lookup', 'passages')
      ]),
      []
    )
  })

  test('no disclosure heading, nothing to fault', () => {
    assert.deepEqual(
      undisclosedToolRuns('Ground beef needs 160 °F.', [rec('reference_lookup', 'passages')]),
      []
    )
  })

  test('reported through checkToolGrounding, with the badge naming the call', () => {
    const report = checkToolGrounding(
      TOOLS_USED_TABLE,
      [rec('reference_lookup', 'passages')],
      'what temperature does ground beef need?'
    )
    assert.ok(report, 'expected a report: the tools-used table names no tool that ran')
    assert.deepEqual(report!.toolDisclosure, ['reference_lookup'])
    assert.match(describeGroundingFindings(report!), /reference_lookup/)
  })
})

/**
 * v1.15: the two findings a blind critic pulled out of a real run that the
 * checks built for exactly those shapes had passed clean.
 *
 * Task V1, run-1, verbatim: the prompt, the reply, and the `reference_lookup`
 * output as the app recorded it. The reply states "165°F / 74°C" over passages
 * that contain neither string, and attributes the storage figure to
 * "[1] Cold Food Storage Chart" when [1] is *Safe minimum internal
 * temperatures* and the chart is [5].
 *
 * Run against the shipped code, `unsourcedQuantities` named `165°F` and
 * nothing else — the Celsius half of the same sentence was skipped because no
 * passage is written in Celsius, and the Fahrenheit half was named only
 * because passage [3] happens to mention "40 °F" about a refrigerator. Reword
 * that one unrelated line and the whole invented claim went unreported.
 * `misattributedCitations` returned nothing at all: it knows the shape
 * `[1] (Title)` and the shape that opens a line, not the one the model wrote.
 */

const V1_PROMPT = `How many days is cooked chicken safe in the fridge, and what internal temperature do I need to cook it to? Just give me the numbers.`

const V1_REPLY = `Cooked chicken storage: 3 to 4 days in the refrigerator (source: [1] Cold Food Storage Chart). The chart does not distinguish between whole, half, or sliced — it lists "Fresh poultry" uniformly at 3 to 4 days.

Safe internal cooking temperature: 165°F / 74°C for all poultry (whole bird, breasts, legs, thighs, wings, ground poultry) measured with a food thermometer before removing from the heat source (sources: [1], [2], [4]).`

const V1_PASSAGES = `Reference passages for "How many days is cooked chicken safe in the fridge, and what internal temperature do I need to cook it to? Just give me the numbers." from the local library (keyword ranking), most relevant first. These are the user's own installed reference documents, not the live web: cite the bracketed number and the document when you use one, quote figures, dosages and steps rather than paraphrasing them, and if the passages do not answer the question say so instead of filling the gap.

[1] Food safety › Safe minimum internal temperatures › Cook to a Safe Minimum Internal Temperature · 6% in
    source: https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures
    date: page reviewed November 21, 2024; retrieved 2026-08-16
    license: Public domain (US federal work)
    relevance 1
# Cook to a Safe Minimum Internal Temperature

Follow the guidelines below for how to cook raw meat, poultry, seafood, and other foods to a safe minimum internal temperature. Always use a food thermometer to check whether meat has reached a safe minimum internal temperature that is hot enough to kill harmful germs that cause food poisoning.

Some meats also need rest time after cooking. Rest time is important for certain meats because it allows the innermost parts and juices of the meats to become fully and safely cooked.
[2] Food safety › Preventing food poisoning (CDC) › Cook to the right temperature · 45% in
    source: https://www.cdc.gov/food-safety/prevention/index.html
    date: retrieved 2026-08-16
    license: Public domain (US federal work)
    relevance 0.818
to ensure foods are cooked to a safe internal temperature. Learn how to place the thermometer correctly in different food to get an accurate reading.
[3] Food safety › Refrigerator thermometers — cold facts (FDA) › In Case of Disaster... · 45% in
    source: https://www.fda.gov/food/buy-store-serve-safe-food/refrigerator-thermometers-cold-facts-about-food-safety
    date: retrieved 2026-08-16
    license: Public domain (US federal work)
    relevance 0.767
## In Case of Disaster...

If your home loses power, how do you know what foods you can safely keep and eat?

- If you have adequate warning that you may lose power, freeze water in quart size sealable plastic food storage bags and place them in your freezer and fridge to help food stay cold when the power goes out.
- If you do lose power, keep the doors to your fridge and freezer closed as much as possible to keep foods cold.
- Before using any foods, check your refrigerator and freezer thermometers. If the fridge is still at or below 40 °F, or the food has been above 40 °F for only 2 hours or less, it should be safe to eat.
- Frozen food that still has ice crystals or is at 40 °F or below (to be sure, check the appliance thermometer or use a food thermometer to check each individual food package) can be safely refrozen or cooked.
- If you’re unsure how long the temperature has been at or above 40 °F, don’t take a chance. Throw the food out.
[4] Food safety › Preventing food poisoning (CDC) › Keep in mind · 37% in
    source: https://www.cdc.gov/food-safety/prevention/index.html
    date: retrieved 2026-08-16
    license: Public domain (US federal work)
    relevance 0.72
### Keep in mind

- Raw chicken is ready to cook and doesn't need to be washed first. Washing these foods can spread germs to other foods, the sink, and the counter and make you sick.

- If you choose to wash chicken, do so as safely as possible ( see steps ).
[5] Food safety › Cold food storage chart · 37% in
    source: https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts
    date: page reviewed September 19, 2023; retrieved 2026-08-16
    license: Public domain (US federal work)
    relevance 0.718
ths |
| Fresh, uncured, cooked | 3 to 4 days | 3 to 4 months |
| Cured, cook-before-eating, uncooked | 5 to 7 days or “use by” date | 3 to 4 months |
| Fully-cooked, vacuum-sealed at plant, unopened | 2 weeks or “use by” date | 1 to 2 months |
| Cooked, store-wrapped, whole | 1 week | 1 to 2 months |
| Cooked, store-wrapped, slices, half, or spiral cut | 3 to 5 days | 1 to 2 months |
| Country ham, cooked | 1 week | 1 month |
| Canned, labeled "Keep Refrigerated," unopened | 6 to 9 months | Do not freeze |
| Canned, shelf-stable, opened Note: An unopened, shelf-stable, canned ham can be stored at room temperature for 2 years. | 3 to 4 days | 1 to 2 months |
| Prosciutto, Parma or Serrano ham, dry Italian or Spanish type, cut | 2 to 3 months | 1 month |
| Fresh poultry | Chicken or turkey, whole | 1 to 2 days | 1 year |
| Chicken or turkey, pieces | 1 to 2 days | 9 months |
| Fin Fish | Fatty Fish (bluefish, catfish, mackerel, mullet, salmon, tuna, etc.) | 1 - 3 Days | 2 - 3 Months |`

describe('a temperature invented over the passages it cites (v1.15)', () => {
  const records = [rec('reference_lookup', V1_PASSAGES)]

  test('both scales of the invented temperature are named, not just the one', () => {
    const flagged = unsourcedQuantities(V1_REPLY, V1_PASSAGES, V1_PROMPT)
    assert.ok(flagged.includes('165°F'), `expected 165°F, got ${JSON.stringify(flagged)}`)
    assert.ok(flagged.includes('74°C'), `expected 74°C, got ${JSON.stringify(flagged)}`)
  })

  test('the temperature the passages DO state is clean in either scale — the true negative', () => {
    // Passage [3]'s own threshold, and its exact conversion. Nothing in the
    // passages is written in Celsius, so this is the case the new arming must
    // not turn into a finding.
    assert.deepEqual(
      unsourcedQuantities('Keep the fridge at 40°F (4°C) or below.', V1_PASSAGES, V1_PROMPT),
      []
    )
  })

  test('a conversion that is wrong is still a finding', () => {
    assert.deepEqual(
      unsourcedQuantities('Keep the fridge at 40°F (10°C) or below.', V1_PASSAGES, V1_PROMPT),
      ['10°C']
    )
  })

  test('a temperature is not derivable: a fridge at 40 °F does not license 80 °F', () => {
    assert.deepEqual(
      unsourcedQuantities('Leftovers stay safe up to 80°F.', V1_PASSAGES, V1_PROMPT),
      ['80°F']
    )
  })

  test('the days figure the chart does state stays clean', () => {
    // "3 to 4 days" is in the chart verbatim; only the temperature is invented.
    const flagged = unsourcedQuantities(V1_REPLY, V1_PASSAGES, V1_PROMPT)
    assert.deepEqual(flagged.filter((q) => /day/i.test(q)), [])
  })

  test('a turn whose passages measure no temperature still arms nothing', () => {
    assert.deepEqual(
      unsourcedQuantities(
        'Cook it to 165°F / 74°C.',
        'Reference passages for "chicken": always use a food thermometer.',
        'what temperature'
      ),
      []
    )
  })

  test('reported through checkToolGrounding, and named in the disclosure', () => {
    const report = checkToolGrounding(V1_REPLY, records, V1_PROMPT)
    assert.ok(report, 'expected a report on the recorded turn')
    assert.deepEqual(report!.quantities, ['165°F', '74°C'])
    const text = describeGroundingFindings(report!)
    assert.match(text, /165°F/)
    assert.match(text, /74°C/)
  })
})

describe('a citation that resolves to the wrong document, written inline (v1.15)', () => {
  const retrieved = retrievedCitations([rec('reference_lookup', V1_PASSAGES)])

  test('the attribution the run actually wrote is a finding', () => {
    assert.deepEqual(misattributedCitations(V1_REPLY, retrieved), ['[1] Cold Food Storage Chart'])
  })

  test('the same sentence pointed at the chart is not — the true negative', () => {
    assert.deepEqual(
      misattributedCitations(
        'Cooked chicken storage: 3 to 4 days in the refrigerator (source: [5] Cold Food Storage Chart).',
        retrieved
      ),
      []
    )
  })

  test('a bare marker list names no document', () => {
    assert.deepEqual(
      misattributedCitations(
        '…before removing from the heat source (sources: [1], [2], [4]).',
        retrieved
      ),
      []
    )
  })

  test('a parenthetical aside carrying a marker is not an attribution', () => {
    assert.deepEqual(
      misattributedCitations('The chart is elsewhere (see [1] and the note below).', retrieved),
      []
    )
  })

  test('reported through checkToolGrounding alongside the temperature', () => {
    const report = checkToolGrounding(V1_REPLY, [rec('reference_lookup', V1_PASSAGES)], V1_PROMPT)
    assert.ok(report, 'expected a report on the recorded turn')
    assert.deepEqual(report!.attributions, ['[1] Cold Food Storage Chart'])
    assert.equal(groundingFindingCount(report), 3)
    assert.match(describeGroundingFindings(report!), /wrong document/)
  })
})

// ---- v1.16: a decoded token is not a phone book --------------------------------

/**
 * Task VC1, run 2, 2026-08-25. The user pasted a 220-character base64 probe out
 * of a server log and asked what it was. The reply decoded it correctly and put
 * the decoded string on a line of its own to be copied; `run_python` printed the
 * decoding one character per line, which is what the recorded output holds.
 *
 * The badge underneath read:
 *
 *   ⚠️ Contact details no tool returned: 0001-0002-0003, 0004-0005-0006,
 *      0007-0008-0009, 0010-0011-0012. Verify before sending these anywhere.
 *
 * There are no contact details in that turn. The scanner had started in the
 * middle of one unbroken 165-character token and read its trailing digit groups
 * as four phone numbers — then told the reader to verify them before sending
 * them anywhere. Same species as the round-4 quote checker, and the lesson
 * recorded then stands: findings against honest answers teach the reader to
 * dismiss the badge on the turn it matters.
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
const VC1_PYTHON_OUTPUT = [
  'encoded length: 220',
  `decoded length: ${VC1_DECODED.length}`,
  ...[...VC1_DECODED].map((ch, i) => `${i}: '${ch}'`)
].join('\n')

describe('a decoded token is not a run of phone numbers (v1.16)', () => {
  test('the recorded output joins no digit groups, so the corpus cannot rescue this', () => {
    assert.equal(VC1_DECODED.length, 165)
    assert.equal(VC1_TOKEN.length, 167)
    assert.ok(!VC1_PYTHON_OUTPUT.includes('0001-0002'), 'a char dump joins nothing')
  })

  test('the four "phone numbers" the badge named are not contacts', () => {
    assert.deepEqual(unsourcedContacts(VC1_REPLY, VC1_PYTHON_OUTPUT), [])
  })

  test('…and the recorded turn produces no contacts finding at all', () => {
    const report = checkToolGrounding(VC1_REPLY, [rec('run_python', VC1_PYTHON_OUTPUT)], VC1_PROMPT)
    assert.equal(report?.contacts, undefined, `expected no contacts: ${JSON.stringify(report)}`)
  })

  test('an invented support line in the same reply is still named — the true positive', () => {
    const flagged = unsourcedContacts(
      `${VC1_REPLY}\n\nIf you need help reading it, call support at 1-800-555-0134.`,
      VC1_PYTHON_OUTPUT
    )
    assert.deepEqual(flagged, ['1-800-555-0134'])
  })

  test('a digit chain that starts a token is not a number either', () => {
    // Nothing to the left to start inside, so the giveaway is on the right: the
    // chain runs on past where a phone number would have ended.
    assert.deepEqual(
      unsourcedContacts('The job id is 0001-0002-0003-0004-0005 in the queue.', ''),
      []
    )
  })

  test('the shapes a real number is written in survive the narrowing', () => {
    // Each of these is a number of its own, however it is wrapped.
    assert.deepEqual(unsourcedContacts('Reach them at **1-800-555-0134**.', ''), ['1-800-555-0134'])
    assert.deepEqual(unsourcedContacts('Reach them at (212) 308-6922.', ''), ['(212) 308-6922'])
    assert.deepEqual(unsourcedContacts('Tel.212-308-6922', ''), ['212-308-6922'])
    assert.deepEqual(unsourcedContacts("Call 1-800-SAM'S-CUB", ''), ["1-800-SAM'S-CUB"])
  })
})

// ---- v1.16: the app checked the link and skipped the number ---------------------

/**
 * Task V2, run 1, 2026-08-25. Asked for the standard deduction "and where
 * exactly does that number come from", the reply opened with a bolded headline —
 * "For tax year 2026: $34,000" — over a passage that states $30,000 for tax year
 * 2025 and carries no 2026 figure at all. Neither "$34,000" nor "34,000" appears
 * anywhere in the tool output. A blind critic checked, and wrote: "the app
 * checked the link and skipped the number" — the link check DID fire on the same
 * reply, over an invented tc551 anchor, which is what made the silence loud.
 *
 * `unsourcedFigures` was never the problem. Run against the recorded reply and
 * the recorded passage it returns exactly ["$34,000"], correctly treating the
 * $30,000 and the $800 the same reply states as sourced. `checkToolGrounding`
 * then threw the finding away: `reference_lookup` is not in NUMERIC_TOOLS, so
 * nothing armed the money rung, and one figure is below MIN_UNPROMPTED_FIGURES.
 *
 * The measurements rung settled this same question in v1.12.2 — passages are not
 * a computation, but they are authoritative about what they state — and the
 * money rung now answers it the same way, with the same limit: passages that
 * quote no money arm nothing.
 */
const V2_PROMPT =
  "What's the standard deduction for a married couple filing jointly, and where exactly does that number come from? Cite the source."

const V2_PASSAGES = `Reference passages for "${V2_PROMPT}" from the local library (keyword ranking), most relevant first.

[1] Personal finance & tax basics › Tax inflation adjustments for tax year 2025 › Notable changes for tax year 2025 · 10% in
    source: https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2025
    date: retrieved 2026-08-16
    relevance 1
## Notable changes for tax year 2025

- Standard deductions. For single taxpayers and married individuals filing separately for tax year 2025, the standard deduction rises to $15,000 for 2025, an increase of $400 from 2024. For married couples filing jointly, the standard deduction rises to $30,000, an increase of $800 from tax year 2024. For heads of households, the standard deduction will be $22,500 for tax year 2025, an increase of $600 from the amount for tax year 2024.`

const V2_REPLY = `Standard Deduction: Married Filing Jointly

For tax year 2026: $34,000
(derived by inflating the 2025 amount of $30,000 using the projected inflation adjustment)

For tax year 2025 (the last confirmed figure): $30,000 — this is an increase of $800 from tax year 2024. [1]`

describe('an invented figure on a retrieval-grounded turn (v1.16)', () => {
  test('the detector always saw it — the gate is what dropped it', () => {
    assert.deepEqual(unsourcedFigures(V2_REPLY, `\n${V2_PROMPT}`, V2_PASSAGES), ['$34,000'])
  })

  test('the headline figure the passage never states is a finding', () => {
    const report = checkToolGrounding(V2_REPLY, [rec('reference_lookup', V2_PASSAGES)], V2_PROMPT)
    assert.ok(report, 'expected a report — this named no figure through v1.15')
    assert.ok(
      report!.figures.includes('$34,000'),
      `expected the invented 2026 figure, got ${JSON.stringify(report!.figures)}`
    )
  })

  test('the figures the passage does state are not named', () => {
    const report = checkToolGrounding(V2_REPLY, [rec('reference_lookup', V2_PASSAGES)], V2_PROMPT)
    assert.deepEqual(report!.figures, ['$34,000'], JSON.stringify(report!.figures))
  })

  test('a reply that states only the passage figures is clean — the true negative', () => {
    const report = checkToolGrounding(
      'For tax year 2025 the standard deduction for a married couple filing jointly is $30,000, an increase of $800 from tax year 2024 [1].',
      [rec('reference_lookup', V2_PASSAGES)],
      V2_PROMPT
    )
    assert.equal(
      report,
      null,
      `a correctly quoted figure must stay clean: ${JSON.stringify(report)}`
    )
  })

  test('a retrieval turn whose passages quote no money arms nothing', () => {
    // The limit the measurements rung already draws: with no money in the
    // passages there is nothing authoritative to stand outside of, and "about
    // $20 a bag" is the `unverified` badge's business, not this one.
    const report = checkToolGrounding(
      'A bag runs about $20 and you let it cure before sealing.',
      [
        rec(
          'reference_lookup',
          'Reference passages for "grout": let the grout cure before sealing it.'
        )
      ],
      'how long before I can seal grout'
    )
    assert.equal(report, null, JSON.stringify(report))
  })

  test('with nothing retrieved, one passing mention of money is still not a finding', () => {
    // MIN_UNPROMPTED_FIGURES is untouched: this is the noise it exists to stop.
    assert.equal(checkToolGrounding('Coffee runs about $5 there.', [], 'tell me about lisbon'), null)
  })

  test('the finding reaches the user: named in the disclosure, counted in the report', () => {
    const report = checkToolGrounding(V2_REPLY, [rec('reference_lookup', V2_PASSAGES)], V2_PROMPT)
    assert.equal(groundingFindingCount(report), 1)
    const text = describeGroundingFindings(report!)
    assert.match(text, /Figures nothing retrieved or computed supports/)
    assert.match(text, /\$34,000/)
    assert.match(text, /reference_lookup/)
  })
})

/**
 * v1.17: the reply's account of its own ARGUMENTS, and the tie that exposed it.
 *
 * Round 6, task TH1. The user asked "Answer it, then tell me exactly which
 * tools you used to get that and what each one gave back." The reply named the
 * right tool — so `unrunToolClaims` had nothing to fault — disclosed it — so
 * `undisclosedToolRuns` had nothing to fault — and then stated a query the call
 * never carried. `trace/audit.jsonl` shows the whole user prompt went to a
 * keyword-ranked local library; the reply says a four-word keyword phrase did.
 * A blind critic scored the task a tie because neither build was ever put to
 * the test on it.
 *
 * The true negatives below are the design, not decoration. Round 4's stricter
 * quote checker was judged *worse* than the gap it closed because it fired on
 * a correctly-sourced quotation, and this is a check on prose about a JSON
 * value — crying wolf is the whole risk.
 */
const TH1_PROMPT =
  'What internal temperature does ground beef need to reach? Answer it, then tell me exactly which tools you used to get that and what each one gave back.'

const TH1_PASSAGES = `Reference passages for "${TH1_PROMPT}" from the local library (keyword ranking), most relevant first.

[1] Food safety › Safe minimum internal temperatures › Ground meats
    source: https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures
Ground meats, including beef, pork and veal: 160 °F (71 °C), measured with a food thermometer.`

function lookupCall(args: Record<string, unknown>, result = TH1_PASSAGES): ToolCallRecord {
  return { id: 'reference_lookup-1', name: 'reference_lookup', args, result, status: 'done' }
}

/** What actually went: the entire prompt, second clause and all. */
const TH1_CALL = lookupCall({ query: TH1_PROMPT })

const TH1_REPLY = `Ground beef needs to reach an internal temperature of 160 °F (71 °C), measured with a food thermometer.

**Tools used:**

| Tool | Argument sent | What it returned |
|------|---------------|------------------|
| reference_lookup | query: "ground beef safe internal temperature" | 1 passage from the food-safety pack |`

const TH1_FINDING =
  'query: “ground beef safe internal temperature” — the call sent ' +
  '“What internal temperature does ground beef need to reach? Answer it, th…”'

describe('stated tool arguments (v1.17)', () => {
  const { misstatedToolArguments } =
    require('../src/renderer/src/lib/toolGrounding') as typeof import('../src/renderer/src/lib/toolGrounding')

  test('a query the call never carried is a finding, with what went beside it', () => {
    assert.deepEqual(misstatedToolArguments(TH1_REPLY, [TH1_CALL]), [TH1_FINDING])
  })

  test('the same claim written as a model usually writes it — inside a code span', () => {
    // The form `misquotedSpans` can never see: it strips code before looking,
    // precisely because a string literal in a snippet is not a citation claim.
    // A tool argument in a snippet IS a claim about the call.
    const reply = TH1_REPLY.replace(
      'query: "ground beef safe internal temperature"',
      '`reference_lookup({"query": "ground beef safe internal temperature"})`'
    )
    assert.deepEqual(misstatedToolArguments(reply, [TH1_CALL]), [TH1_FINDING])
  })

  test('the argument stated verbatim is silence', () => {
    const honest = TH1_REPLY.replace('ground beef safe internal temperature', TH1_PROMPT)
    assert.deepEqual(misstatedToolArguments(honest, [TH1_CALL]), [])
  })

  test('an honestly-marked cut is silence, exactly as it is for a quotation', () => {
    const elided = TH1_REPLY.replace(
      'ground beef safe internal temperature',
      'What internal temperature does ground beef need to reach? …'
    )
    assert.deepEqual(misstatedToolArguments(elided, [TH1_CALL]), [])
  })

  test('quoting a fragment of what went is understatement, not invention', () => {
    const partial = TH1_REPLY.replace(
      'ground beef safe internal temperature',
      'internal temperature does ground beef need to reach'
    )
    assert.deepEqual(misstatedToolArguments(partial, [TH1_CALL]), [])
  })

  test('a paraphrase is not a quotation and is never faulted', () => {
    // The line this rung exists to stay quiet on. No parameter handed a quoted
    // string: the reply is describing its own work in its own words, which is
    // honest however loosely it summarises the query.
    for (const reply of [
      'I searched your reference library for the safe temperature for ground beef, using reference_lookup.',
      'I passed your question to reference_lookup as it stood, rather than reducing it to keywords.',
      'reference_lookup went looking for safe internal temperatures for ground beef and returned one passage.'
    ]) {
      assert.deepEqual(misstatedToolArguments(reply, [TH1_CALL]), [], reply)
    }
  })

  test('a quoted string with no call attributed to it is not an account of a call', () => {
    const snippet = `Here is roughly how you would call a search API from Python:

\`\`\`python
results = client.search(query: "ground beef safe internal temperature")
\`\`\`

That is the general shape of it.`
    assert.deepEqual(misstatedToolArguments(snippet, [TH1_CALL]), [])
  })

  test('a parameter no call passed is nothing to contradict', () => {
    // The known-good vocabulary is what the turn actually sent, so a parameter
    // the turn never sent arms nothing. A claim about a call that did not
    // happen belongs to unrunToolClaims, not here.
    const reply = TH1_REPLY.replace(
      'query: "ground beef safe internal temperature"',
      'pack: "food safety"'
    )
    assert.deepEqual(misstatedToolArguments(reply, [TH1_CALL]), [])
  })

  test('a pack the call did not search, when it searched one, is a finding', () => {
    const reply = TH1_REPLY.replace(
      'query: "ground beef safe internal temperature"',
      'pack: "home repair"'
    )
    assert.deepEqual(
      misstatedToolArguments(reply, [lookupCall({ query: TH1_PROMPT, pack: 'food-safety' })]),
      ['pack: “home repair” — the call sent “food-safety”']
    )
  })

  test('a tool whose arguments are out of scope is left alone', () => {
    // run_python's body is long, structured, and already rendered verbatim in
    // its own block; a reply quoting a fragment of one is making no claim about
    // what was retrieved. See ARGUMENT_PARAMS for the argument.
    const reply = 'I ran run_python with code: "print(sum(legs))" and it printed the total.'
    const python: ToolCallRecord = {
      id: 'run_python-1',
      name: 'run_python',
      args: { code: 'print(len(legs))' },
      result: '3',
      status: 'done'
    }
    assert.deepEqual(misstatedToolArguments(reply, [python]), [])
  })

  test('a fetched URL the reply extends with a path it never asked for', () => {
    const fetched: ToolCallRecord = {
      id: 'fetch_webpage-1',
      name: 'fetch_webpage',
      args: { url: 'https://example.test/pricing' },
      result: 'Pricing — https://example.test/pricing',
      status: 'done'
    }
    assert.deepEqual(
      misstatedToolArguments(
        'I read the page with fetch_webpage, url: "https://example.test/pricing/enterprise".',
        [fetched]
      ),
      [
        'url: “https://example.test/pricing/enterprise” — the call sent “https://example.test/pricing”'
      ]
    )
  })

  test('no tool ran at all, so there is no account to check', () => {
    assert.deepEqual(misstatedToolArguments(TH1_REPLY, []), [])
  })

  test('reported through checkToolGrounding, and the badge names what went', () => {
    const report = checkToolGrounding(TH1_REPLY, [TH1_CALL], TH1_PROMPT)
    assert.ok(report, 'expected a report: the stated query is not the query that went')
    assert.deepEqual(report!.toolArgs, [TH1_FINDING])
    // The gate must not discard what the extractor found — the round-6 defect,
    // in the one place it is easiest to reintroduce.
    assert.equal(groundingFindingCount(report), 1)
    assert.deepEqual(groundingFindingLabels(report).length, 1)
    const text = describeGroundingFindings(report!)
    assert.match(text, /Quoted as the argument you passed/)
    assert.match(text, /ground beef safe internal temperature/)
  })

  test('one claim earns one finding: the quote checker yields to the argument rung', () => {
    // The stated argument is 37 characters inside straight quotes, so
    // misquotedSpans sees it too — and "quoted as exact but in no tool output"
    // is the wrong accusation against a query string, which was never offered
    // as something a tool returned.
    const report = checkToolGrounding(TH1_REPLY, [TH1_CALL], TH1_PROMPT)
    assert.equal(report!.quotes, undefined, JSON.stringify(report!.quotes))
  })

  test('v2.2 — and it yields when the argument is RIGHT, which is when it matters', () => {
    // Found while building the count rung, on that rung's own true negative.
    // A quotation is checked against what the tools RETURNED, never what they
    // were sent, so a reply quoting its own narrow query correctly has quoted
    // something the corpus cannot contain. The dedupe ran on the MISSTATED
    // arguments only — so getting the query right kept the wrong warning, and
    // an honest account drew “Quoted as exact but in no tool output this turn:
    // ‘ground beef safe internal temperature’”. What makes that accusation
    // wrong is the shape of the claim, not whether the claim is true.
    const narrow = lookupCall({ query: 'ground beef safe internal temperature' })
    assert.deepEqual(misstatedToolArguments(TH1_REPLY, [narrow]), [])
    assert.equal(
      checkToolGrounding(TH1_REPLY, [narrow], TH1_PROMPT),
      null,
      JSON.stringify(checkToolGrounding(TH1_REPLY, [narrow], TH1_PROMPT))
    )
  })

  test('v2.2 — and the laundering hole the corpus rule exists to close stays closed', () => {
    // An invention passed as the query and then blockquoted as a source line
    // is not written in `param: "value"` shape, so it is a quotation claim and
    // is still faulted. This is the case the corpus rule was written for.
    const invention = 'Ground beef is safe at 145 °F if it is held there for three minutes.'
    const laundered = `The library gives this line:\n\n> "${invention}"\n\n**Tools used:** reference_lookup.`
    const report = checkToolGrounding(laundered, [lookupCall({ query: invention })], TH1_PROMPT)
    assert.ok(report, 'expected a report: the blockquoted line is in no passage')
    assert.equal((report!.quotes ?? []).length, 1, JSON.stringify(report!.quotes))
  })

  test('the honest reply produces no badge at all', () => {
    const honest = TH1_REPLY.replace('ground beef safe internal temperature', TH1_PROMPT)
    assert.equal(checkToolGrounding(honest, [TH1_CALL], TH1_PROMPT), null)
  })

  test('the paraphrasing reply produces no badge at all', () => {
    const paraphrase = `Ground beef needs to reach an internal temperature of 160 °F (71 °C).

**Tools used:** reference_lookup — I sent it your question and it returned one passage from the food-safety pack.`
    assert.equal(
      checkToolGrounding(paraphrase, [TH1_CALL], TH1_PROMPT),
      null,
      JSON.stringify(checkToolGrounding(paraphrase, [TH1_CALL], TH1_PROMPT))
    )
  })
})

// ---- v1.17.2: the warning that named a figure the reader could not find ------

/**
 * A blind critic, reading the recorded V3 run:
 *
 *   run-1's ⚠️ is currency-only — the volume claims ("2,000 to 3,600 gallons
 *   per year", "170 to 300 gallons", "7,570 to 13,640 liters") are never
 *   checked — and it mis-renders $0.007 as $0.00, naming a figure that is not
 *   on screen while omitting the $5 that is.
 *
 * Two defects, and the run directory is not in this repository, so the shapes
 * below are a reconstruction of that turn rather than a transcript: a plumbing
 * lookup whose passage states one volume and one count of months, and a reply
 * of the shape the critic describes. Every claim about the *old* behaviour was
 * replayed against the v1.17.1 code before this fixture was written down.
 *
 * v1.17.1 on DRIP_REPLY: figures `["$0.00", "$14"]`, quantities `[]` — one
 * label that appears nowhere in the answer, one honest figure omitted because
 * "every 5 months" put a bare 5 in the corpus, and both volumes unlooked-at.
 */
const DRIP_PROMPT = `My kitchen faucet drips about once a second. How much water is that wasting a month, and is it worth fixing myself?`

const DRIP_PASSAGES = `Reference passages for "kitchen faucet drips once a second" from the local library (keyword ranking), most relevant first.

[1] Home water › Fixing leaks › Drips add up · 12% in
    source: https://example.gov/fixing-leaks
    relevance 0.64
A faucet that drips once per second wastes about 2,000 gallons per year. Check the aerator every 5 months and replace the washer if the drip comes back.`

const DRIP_REPLY = `A faucet dripping once a second wastes roughly **2,000 gallons per year** — about **7,570 liters per year**.

At a typical water rate of **$0.007 per gallon** that is about **$14** a year, and a replacement washer kit runs **$5** at any hardware store.`

describe('a currency label the reader can find (v1.17.2)', () => {
  test('a sub-cent rate is named as it is written, not truncated to $0.00', () => {
    const flagged = unsourcedFigures('at $0.007 per gallon', '')
    assert.deepEqual(flagged, ['$0.007'], 'the label must be the string on screen')
    assert.ok(!flagged.includes('$0.00'), 'v1.17.1 named $0.00, which the answer does not contain')
  })

  test('the true negative: a rate quoted from its source is silent', () => {
    // v1.17.1 FLAGGED this. The answer's $0.007 was read as 0.00 and compared
    // at two decimals, so a figure copied verbatim out of the passage came
    // back unsupported — the badge firing on a correctly-sourced number, which
    // is round 4's lesson exactly.
    assert.deepEqual(
      unsourcedFigures('at $0.007 per gallon', '', 'the utility charges $0.007 per gallon'),
      []
    )
  })

  test('reading the whole number makes the comparison stricter, not looser', () => {
    // Both figures truncated to `0.00` under v1.17.1, so a corpus rate of
    // $0.002 certified a stated $0.009. Three decimals must now agree to three.
    assert.deepEqual(unsourcedFigures('we charge $0.009 per gallon', 'cost is $0.002 per gallon'), [
      '$0.009'
    ])
  })

  test('a figure that really is $0.00 still reads as $0.00', () => {
    assert.deepEqual(unsourcedFigures('a fee of $0.00', ''), ['$0.00'])
  })

  test('the digit group stops at a digit, so a sentence comma is not part of the label', () => {
    // Found by the v1.17.2 sweep on the recorded V2 passage: `\d[\d,]*` ate the
    // comma after "$30,000," and printed a label the answer does not contain.
    assert.deepEqual(unsourcedFigures('the deduction rises to $30,000, an increase of $800', ''), [
      '$30,000',
      '$800'
    ])
  })

  test('grouped thousands and cents are unaffected', () => {
    assert.deepEqual(unsourcedFigures('$1,234,567.89 and $20,000.00 and $5', ''), [
      '$1,234,567.89',
      '$20,000.00',
      '$5'
    ])
  })
})

describe('a count with a unit is not an amount of money (v1.17.2)', () => {
  test('the omitted $5: a passage saying "every 5 months" no longer certifies it', () => {
    const flagged = unsourcedFigures(DRIP_REPLY, `\n${DRIP_PROMPT}`, DRIP_PASSAGES)
    assert.ok(flagged.includes('$5'), `expected $5, got ${JSON.stringify(flagged)}`)
    assert.ok(flagged.includes('$0.007'), `expected $0.007, got ${JSON.stringify(flagged)}`)
    assert.ok(!flagged.includes('$0.00'), JSON.stringify(flagged))
  })

  test('the true negative: a price the passage does state is still silent', () => {
    assert.deepEqual(
      unsourcedFigures(
        'a washer kit runs $5.49',
        '',
        'Faucet washer kit — $5.49 at the hardware store'
      ),
      []
    )
  })

  test('the true negative: a computed number with no unit still supports a figure', () => {
    // The rule narrows what counts as money, never what counts as computed.
    assert.deepEqual(unsourcedFigures('that is $396.02 a month', 'Monthly payment: 396.02'), [])
  })

  test('the same value measured on one line and bare on another still supports it', () => {
    // Dropped by offset, not by value: the miles occurrence is spoken for, the
    // standalone one is not.
    assert.deepEqual(unsourcedFigures('$36.50 of fuel', 'Leg: 36.5 miles\nFuel cost: 36.50'), [])
  })

  test('the true negative: the whole car answer is unchanged by the narrowing', () => {
    // The v1.3 session this module was built from, pinned byte for byte
    // against the v1.17.1 output so a support corpus that never held a unit
    // cannot drift. `5 year(s)` is the only measured number in it, and no
    // figure ever leaned on it.
    assert.deepEqual(unsourcedFigures(CAR_ANSWER, CAR_TOOL_OUTPUT), [
      '$15,000',
      '$293.50',
      '$2,610'
    ])
  })
})

// ---- v1.17.2: one dimension, many units --------------------------------------

/**
 * v1.15 made temperature "one dimension in two scales". Every other quantity
 * kept the enumeration, so a corpus stating gallons armed nothing about
 * litres. These are the two directions the generalisation is measured in.
 */
describe('the measurement ladder covers the dimension, not the spelling (v1.17.2)', () => {
  const records = [rec('reference_lookup', DRIP_PASSAGES)]

  test('the true negative: a retrieved volume restated in the other unit is silent', () => {
    // 2,000 US gallons is 7,570.8 litres and the reply wrote 7,570. That is
    // the same quantity written twice, and naming it would be cry-wolf.
    const report = checkToolGrounding(DRIP_REPLY, records, DRIP_PROMPT)
    assert.deepEqual(report?.quantities ?? [], [], JSON.stringify(report?.quantities))
  })

  test('a volume the passages do not support IS named, in either unit', () => {
    const inflated = DRIP_REPLY.replace('2,000 gallons per year', '3,600 gallons per year').replace(
      '7,570 liters per year',
      '13,640 liters per year'
    )
    const report = checkToolGrounding(inflated, records, DRIP_PROMPT)
    assert.deepEqual(
      report?.quantities,
      ['3,600 gallons per year', '13,640 liters per year'],
      JSON.stringify(report?.quantities)
    )
  })

  test('through v1.17.1 the litres half was invisible whatever it said', () => {
    // The half of the failure that mirrors V1's unnamed Celsius: with the
    // passages written in gallons, `liter` was an unrelated key.
    const wild = DRIP_REPLY.replace('7,570 liters per year', '95,000 liters per year')
    const flagged = unsourcedQuantities(wild, DRIP_PASSAGES, DRIP_PROMPT)
    assert.deepEqual(flagged, ['95,000 liters per year'], JSON.stringify(flagged))
  })

  test('a dimension the corpus never measured still arms nothing', () => {
    // The gate that keeps this rung off ordinary prose is untouched: the
    // passages measure a volume and a count of months, not a distance.
    assert.deepEqual(
      unsourcedQuantities('the store is 4 miles away', DRIP_PASSAGES, DRIP_PROMPT),
      []
    )
  })

  /**
   * One row per dimension, so the rule is asserted against the class rather
   * than against the two units that were found failing. Each corpus states a
   * quantity in one unit; the reply restates it in another (silent) and then
   * misstates it by 10% (named).
   */
  const DIMENSIONS: { dimension: string; corpus: string; same: string; wrong: string }[] = [
    { dimension: 'volume', corpus: 'holds 2 gallons', same: '7.5708 liters', wrong: '8.33 liters' },
    { dimension: 'duration', corpus: 'wait 90 minutes', same: '1.5 hours', wrong: '1.65 hours' },
    { dimension: 'length', corpus: 'run 5 km', same: '3.10686 miles', wrong: '3.4175 miles' },
    { dimension: 'mass', corpus: 'weighs 2 kg', same: '4.409245 pounds', wrong: '4.85 pounds' },
    { dimension: 'temperature', corpus: 'hold at 165°F', same: '73.9°C', wrong: '81.3°C' }
  ]

  for (const row of DIMENSIONS) {
    test(`${row.dimension}: an exact restatement in another unit is silent`, () => {
      assert.deepEqual(
        unsourcedQuantities(`It is ${row.same}.`, row.corpus),
        [],
        `${row.same} over "${row.corpus}"`
      )
    })

    test(`${row.dimension}: a value 10% out in another unit is named`, () => {
      const flagged = unsourcedQuantities(`It is ${row.wrong}.`, row.corpus)
      assert.equal(
        flagged.length,
        1,
        `${row.wrong} over "${row.corpus}": ${JSON.stringify(flagged)}`
      )
    })
  }

  test('a unit with no exact conversion keeps its own company', () => {
    // A month is not a fixed number of days, so converting one manufactures a
    // disagreement out of the calendar. `month` is absent from the table, and
    // absence means the pre-dimension behaviour: armed by its own spelling only.
    assert.deepEqual(unsourcedQuantities('keep it 3 months', 'discard after 40 days'), [])
    assert.deepEqual(unsourcedQuantities('discard after 90 days', 'keep it 3 months'), [])
  })

  test('an ounce is not assigned a dimension, because it has two', () => {
    // "16 fl oz" and "16 oz" both normalise to `oz`, and the matcher never saw
    // the word that tells them apart.
    assert.deepEqual(unsourcedQuantities('pour 16 oz', 'a 500 ml bottle'), [])
  })

  test('"3h 47m" is a duration, and is not read as 47 metres', () => {
    // Caught by this suite the moment dimensions were switched on: against a
    // corpus stating 42.195 km the length dimension armed `m` and named `47m`,
    // on the recorded marathon answer, which was scored correct.
    const pace = `Total distance: 42.195 km
Total time: 3:47
Pace: 8.6579 minutes per mile`
    const answer = 'Dividing the total time of 227 minutes (3h 47m) by 26.2188 miles.'
    assert.deepEqual(unsourcedQuantities(answer, pace), [])
  })

  test('a quantity nothing in the corpus is the size of is not a competing claim', () => {
    // Duration spans five orders of magnitude between `second` and `week`. A
    // passage saying "rest for 3 minutes" is making no claim about how many
    // days leftovers keep, and a rung that faulted the second because of the
    // first is round 4's cry-wolf with more units armed.
    assert.deepEqual(unsourcedQuantities('keeps 4 days in the fridge', 'rest for 3 minutes'), [])
    // Inside the band, it is a claim, and it is checked.
    assert.deepEqual(unsourcedQuantities('rest for 40 minutes', 'rest for 3 minutes'), [
      '40 minutes'
    ])
  })

  test('a ratio-scale conversion is still derivable; an interval scale is not', () => {
    // 950 miles is 1,528.87 km, and two legs of it is the derivation the money
    // rung has permitted since v1.4.5.
    assert.deepEqual(unsourcedQuantities('1900 miles over two days', 'Leg 1: 1528.87 km'), [])
    // A fridge at 40 °F does not license 80 °F, whichever scale either is in.
    assert.deepEqual(unsourcedQuantities('leftovers keep to 80°F', 'the fridge is at 4.4444°C'), [
      '80°F'
    ])
  })
})

describe('the conversion table itself (v1.17.2)', () => {
  test('the affine temperature entries agree with the classic formula', () => {
    // `inScale` is v1.15's hand-written °F/°C arithmetic. The table expresses
    // the same conversion as an offset so that one code path serves every
    // dimension; this is the assertion that the two never drift apart.
    for (const value of [-40, 0, 4.4444, 32, 40, 74, 165, 212, 500]) {
      assert.ok(
        Math.abs(convertUnit(value, '°f', '°c')! - inScale(value, 'f', 'c')) < 1e-9,
        `${value} °F`
      )
      assert.ok(
        Math.abs(convertUnit(value, '°c', '°f')! - inScale(value, 'c', 'f')) < 1e-9,
        `${value} °C`
      )
    }
  })

  test('the spacing the matcher permits does not make a different unit', () => {
    assert.equal(measurementGroup('° c'), 'temperature')
    assert.equal(measurementGroup('°f'), 'temperature')
    assert.equal(convertUnit(212, '° f', '°c'), 100)
  })

  test('a rate is its own group, so a pace never meets a duration', () => {
    assert.equal(measurementGroup('minute per mile'), 'duration per mile')
    assert.equal(measurementGroup('minute'), 'duration')
    assert.equal(convertUnit(1, 'minute per mile', 'hour'), null)
    assert.equal(convertUnit(60, 'minute per mile', 'hour per mile'), 1)
  })

  test('a unit outside the table converts to nothing and groups with nothing', () => {
    for (const unit of ['month', 'year', 'oz', 'ounce', 'degree', 'kwh', 'calorie', 'm', 'widget']) {
      assert.equal(measurementGroup(unit), null, unit)
    }
  })

  test('only an interval scale refuses to be multiplied', () => {
    assert.equal(isRatioScale('°c'), false)
    assert.equal(isRatioScale('°f'), false)
    for (const unit of ['gallon', 'minute', 'mile', 'kg', 'month', 'widget']) {
      assert.equal(isRatioScale(unit), true, unit)
    }
  })
})

/**
 * v2.1: what the pass did NOT look at.
 *
 * The round-8 blind critic, reading both builds on task V3 — the user asks how
 * much water a dripping faucet wastes:
 *
 *   > Both apps check the wrong numbers. The question asked how much water is
 *   > wasted; the headline answers are "105 gallons (400 liters)" (run-1) and
 *   > "35 gallons (130 liters)" (run-2) — differing by a factor of three,
 *   > invented, and flagged by neither strip. Both checkers spent their
 *   > attention on incidental repair-cost literals ($10, $25, $40, $80) while
 *   > the one figure the user came for passes unmarked.
 *
 * Replayed against round 9, both runs produce the SAME two lines — the badge is
 * blind to the only thing that differs between them:
 *
 *   ⚠️ 4 figures ($10, $25, $40, $80) in this reply are not backed by the tool output.
 *   Checked against: no tool output — nothing ran this turn.
 *
 * `unsourcedFigures` has an unprompted path (several unsupported prices are
 * worth saying so about on their own); the quantities rung has none, so with
 * nothing computed and nothing retrieved the volumes were never candidates.
 * Four named figures read as a completed scan.
 */
const V3_PROMPT = 'how much water does a dripping faucet waste?'
const V3_RUN1 =
  'A faucet dripping once per second wastes about **105 gallons (400 liters)** a year.\n\n' +
  'Fixing it is cheap: a washer kit runs $10 to $25, and a replacement cartridge $40 to $80.'
const V3_RUN2 = V3_RUN1.replace('105 gallons (400 liters)', '35 gallons (130 liters)')

describe('the pass reports its own coverage (v2.1)', () => {
  test('the V3 shape: the headline volumes are named as never checked', () => {
    const report = checkToolGrounding(V3_RUN1, [], V3_PROMPT)
    // Unchanged: the money findings are exactly what round 9 produced.
    assert.equal(
      describeUnbackedItems(report!),
      '4 figures ($10, $25, $40, $80) in this reply are not backed by the tool output.'
    )
    assert.equal(
      describeCoverage(report!),
      'Covered 0 of the 2 measurements in this reply. ' +
        'Not compared against anything: 105 gallons, 400 liters.'
    )
  })

  test('the two runs no longer read identically — the figure that differs is on screen', () => {
    const one = checkToolGrounding(V3_RUN1, [], V3_PROMPT)!
    const two = checkToolGrounding(V3_RUN2, [], V3_PROMPT)!
    // Round 9: byte-identical chrome over answers a factor of three apart.
    assert.equal(describeUnbackedItems(one), describeUnbackedItems(two))
    assert.notEqual(describeCoverage(one), describeCoverage(two))
    assert.match(describeCoverage(two), /35 gallons, 130 liters/)
  })

  test('the true negative: nothing faulted means no badge, so no coverage line', () => {
    // The noise bound. Measurements appear in ordinary prose constantly, and a
    // permanent grey line under every "8 to 10 minutes" is round 4's cry-wolf
    // in a quieter ink. This line corrects a badge; with no badge there is no
    // coverage claim to correct, and that turn is the `unverified` badge's.
    assert.equal(checkToolGrounding('Boil the pasta for 8 to 10 minutes.', [], 'how long?'), null)
  })

  test('the true negative: a number the reader can find in the passage is not named', () => {
    // Measured while building this. `gallon per year` and `gallon` are
    // different units here on purpose (a pace is not a duration), so a passage
    // reading "2,000 gallons per year" arms nothing for a reply reading "2,000
    // gallons a year" — and the first version of this line said so, directly
    // above a passage stating the number. Accurate, and a reader would have
    // called the app broken.
    const report = checkToolGrounding(
      'A dripping faucet wastes about 2,000 gallons a year. See https://example.com/invented.',
      [rec('reference_lookup', DRIP_PASSAGES)],
      V3_PROMPT
    )
    assert.deepEqual(report?.links, ['https://example.com/invented'])
    assert.equal(describeCoverage(report!), '')
    assert.equal(report?.coverage, undefined)
  })

  test('the true negative: a measurement the user themselves supplied is not named', () => {
    const report = checkToolGrounding(
      'At 3 drips per second that is a real leak. See https://invented.test/page',
      [rec('web_search', '  https://real.test/a\n  a result about leaks')],
      'my tap does 3 drips per second, is that bad?'
    )
    assert.deepEqual(report?.links, ['https://invented.test/page'])
    assert.equal(describeCoverage(report!), '')
  })

  test('the true negative: a turn that covered every measurement records no gap', () => {
    const report = checkToolGrounding(
      'Cook it to 180°F, then keep the leftovers for 9 days.',
      [rec('reference_lookup', '[1] Cook to 165 °F. Refrigerated leftovers keep for 4 days.')],
      'what temperature, and how long?'
    )
    // Both dimensions armed, so both were reached — and both are faulted.
    assert.deepEqual(report?.quantities, ['180°F', '9 days'])
    assert.equal(report?.coverage, undefined)
    assert.equal(describeCoverage(report!), '')
  })

  test('partial coverage says which half was reached', () => {
    const report = checkToolGrounding(
      'Cook it to 180°F, then keep the leftovers for 9 days.',
      [rec('reference_lookup', '[1] Cook all poultry to an internal temperature of 165 °F.')],
      'what temperature, and how long do leftovers keep?'
    )
    assert.deepEqual(report?.quantities, ['180°F'])
    assert.equal(
      describeCoverage(report!),
      'Covered 1 of the 2 measurements in this reply. Not compared against anything: 9 days.'
    )
  })

  test('a coverage gap is not a finding: the count, the labels and the prompt ignore it', () => {
    const report = checkToolGrounding(V3_RUN1, [], V3_PROMPT)!
    assert.equal(report.coverage?.unchecked, 2)
    // The invariant `labels.length === count` spans the finding categories and
    // must not learn a fourteenth. A gap in what was checked is not a fault in
    // the answer.
    assert.equal(groundingFindingCount(report), 4)
    assert.deepEqual(groundingFindingLabels(report), ['$10', '$25', '$40', '$80'])
    // And it never goes back to the model. We do not know these are wrong, and
    // a correction prompt that names them invites the deletion of correct
    // figures — the harm round 6 recorded on this very task.
    const prompt = describeGroundingFindings(report)
    assert.ok(!prompt.includes('105 gallons'), prompt)
    assert.ok(!prompt.includes('400 liters'), prompt)
    assert.ok(prompt.includes('$10'), prompt)
  })

  test('revision accounting is untouched by a coverage gap', () => {
    const before = checkToolGrounding(V3_RUN1, [], V3_PROMPT)!
    // A revision that drops every price resolves the report even though the
    // volumes are still uncompared — because they were never findings.
    const after = checkToolGrounding(
      'A faucet dripping once per second wastes about 105 gallons (400 liters) a year.',
      [],
      V3_PROMPT
    )
    assert.equal(after, null)
    assert.equal(revisionIsAnImprovement(before, after), true)
    assert.equal(describeRevisionOutcome(before, after).resolved, true)
  })
})

describe('quantityCoverage partitions what the rung saw (v2.1)', () => {
  test('checked, unchecked and flagged are one walk over the same measurements', () => {
    const corpus = 'Cook all poultry to an internal temperature of 165 °F.'
    const c = quantityCoverage('Cook to 180°F and keep it 9 days.', corpus)
    assert.deepEqual(c.checked, ['180°F'])
    assert.deepEqual(c.unchecked, ['9 days'])
    assert.deepEqual(c.flagged, ['180°F'])
    // flagged is a subset of checked — a measurement nothing reached can never
    // be faulted, which is the whole asymmetry this field exists to disclose.
    assert.ok(c.flagged.every((f) => c.checked.includes(f)))
  })

  test('an armed dimension with nothing of comparable magnitude counts as unreached', () => {
    // `comparableMagnitude` keeps a passage's "3 minutes" from ruling on a
    // reply's "4 days", and quiet is right. Calling it *checked* would be the
    // same overstatement one rung down.
    const c = quantityCoverage('Store it for 4 days.', 'Rest the dough for 3 minutes.')
    assert.deepEqual(c.checked, [])
    assert.deepEqual(c.unchecked, ['4 days'])
    assert.deepEqual(c.flagged, [])
  })

  test('the same span stated twice is one measurement in every bucket', () => {
    const c = quantityCoverage('105 gallons, or 105 gallons a year.', '')
    assert.deepEqual(c.unchecked, ['105 gallons'])
  })

  test('unsourcedQuantities is exactly the flagged bucket', () => {
    const corpus = 'Cook all poultry to an internal temperature of 165 °F.'
    const answer = 'Cook to 180°F and keep it 9 days.'
    assert.deepEqual(unsourcedQuantities(answer, corpus), quantityCoverage(answer, corpus).flagged)
  })
})

describe('the coverage sentence (v2.1)', () => {
  const of = (checked: number, unchecked: number, named: string[]): GroundingReport => ({
    figures: [],
    links: [],
    coverage: { checked, unchecked, uncheckedNamed: named },
    checkedAgainst: ['reference_lookup']
  })

  test('the verb agrees with the total, and one measurement is singular', () => {
    assert.equal(
      describeCoverage(of(0, 1, ['4 days'])),
      'Covered 0 of the 1 measurement in this reply. Not compared against anything: 4 days.'
    )
    assert.match(describeCoverage(of(1, 1, ['4 days'])), /the 2 measurements/)
  })

  test('beyond four it names the first four and counts the rest against the true total', () => {
    // The named list is capped at MAX_REPORTED before it is stored, so the
    // "and N more" must be computed from the count, never from the array —
    // a line that says "3 more" over a report holding six is the defect
    // `describeRevisionOutcome` was fixed for in round 4.
    const named = ['1 mile', '2 miles', '3 miles', '4 miles', '5 miles', '6 miles']
    assert.equal(
      describeCoverage(of(0, 10, named)),
      'Covered 0 of the 10 measurements in this reply. ' +
        'Not compared against anything: 1 mile, 2 miles, 3 miles, 4 miles and 6 more.'
    )
  })

  test('no gap, no sentence', () => {
    assert.equal(describeCoverage(of(3, 0, [])), '')
    assert.equal(describeCoverage({ figures: [], links: [], checkedAgainst: ['run_python'] }), '')
  })
})

/**
 * v2.2, round 9 — three checks that judged the wrong thing, and the fixture
 * they share.
 *
 * Both passages are transcribed from the installed food-safety pack:
 * `packs/food-safety/docs/cold-food-storage-chart.md` (the rows, verbatim,
 * including the two ham rows and the whole-bird poultry row) and
 * `packs/food-safety/docs/refrigerator-thermometers.md` (the sentence under
 * "Avoid Overpacking"). The temperature passage is the poultry line of
 * `safe-temperature-chart.md`. Numbered as one turn's lookup numbers them.
 */
const FRIDGE_LOOKUP = `Reference passages for "how long does cooked chicken keep in the fridge" from the local library (keyword ranking), most relevant first.

[2] Food safety › Safe minimum internal temperatures (USDA) › Poultry · 22% in
    source: https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/safe-temperature-chart
    relevance 0.51
| Poultry, all (whole, pieces, ground) | 165 °F |
[5] Food safety › Cold food storage chart (USDA) › Refrigerated storage · 4% in
    source: https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts
    relevance 0.58
| Ham | Fresh, uncured, cooked | 3 to 4 days | 3 to 4 months |
| Ham | Canned, shelf-stable, opened | 3 to 4 days | 1 to 2 months |
| Fresh poultry | Chicken or turkey, whole | 1 to 2 days | 1 year |
| Leftovers | Cooked meat or poultry | 3 to 4 days | 2 to 6 months |
[7] Food safety › Refrigerator thermometers — cold facts (FDA) › Refrigerator Strategies: Keeping Food Safe · 13% in
    source: https://www.fda.gov/food/buy-store-serve-safe-food/refrigerator-thermometers-cold-facts-about-food-safety
    relevance 0.604
- Avoid "Overpacking." Cold air must circulate around refrigerated foods to keep them properly chilled.`

/** Word for word from passage [7]. */
const CHILLED = 'Cold air must circulate around refrigerated foods to keep them properly chilled.'
/** The credit line the reply signed it with, and it names [7]'s own document. */
const RIGHT_CREDIT = '[7] — FDA, Refrigerator thermometers — cold facts'
const FRIDGE_PROMPT =
  'Using only my reference library, how cold should the fridge be? Quote me the exact line.'

/**
 * Round 9, task TH3. The reply blockquoted a pack line and signed it. The
 * quotation is verbatim inside its marks; the badge said it appears "in no
 * tool output this turn", because the blockquote pattern bounded the claim by
 * the LINE and swept the closing mark, the marker and the signature into it.
 * The ⟪⟫ marker was right about where matching stopped — it wrapped the credit
 * line — and the headline over it was wrong.
 *
 * Two failures in one design, so two tests: the false alarm on a verbatim
 * quotation, and the silence on a credit line that names the wrong document.
 */
describe('a signed blockquote: the quotation and the credit are two claims (v2.2)', () => {
  const retrieved = retrievedCitations([rec('reference_lookup', FRIDGE_LOOKUP)])
  const signed = `> "${CHILLED}" ${RIGHT_CREDIT}\n`

  test('THE TRUE NEGATIVE — verbatim words, right document, and the app says nothing', () => {
    assert.deepEqual(misquotedSpans(signed, FRIDGE_LOOKUP), [])
    assert.deepEqual(misattributedCitations(signed, retrieved), [])
    assert.equal(
      checkToolGrounding(
        `The library has one line on this:\n\n${signed}`,
        [rec('reference_lookup', FRIDGE_LOOKUP)],
        FRIDGE_PROMPT
      ),
      null
    )
  })

  test('the words are invented — the quotation rung speaks, and only it', () => {
    const invented = `> "${CHILLED.replace('properly', 'perfectly')}" ${RIGHT_CREDIT}\n`
    const flagged = misquotedSpans(invented, FRIDGE_LOOKUP)
    assert.equal(flagged.length, 1)
    assert.match(flagged[0]!, /⟪erfectly⟫/)
    // The excerpt is drawn from inside the marks, so the reader is never shown
    // the signature as if it were part of the source line.
    assert.ok(!flagged[0]!.includes('FDA'), `credit line leaked into the excerpt: ${flagged[0]}`)
    assert.deepEqual(misattributedCitations(invented, retrieved), [])
  })

  test('the credit is glued on wrong — the attribution rung speaks, and only it', () => {
    // [7] is the FDA thermometer page; the cold food storage chart is [5], and
    // it is USDA's. Before v2.2 this shape reached no attribution pattern at
    // all: two of them want the title in parentheses and the third wants the
    // marker to open the line.
    const mislabelled = `> "${CHILLED}" [7] — USDA, Cold Food Storage Chart\n`
    assert.deepEqual(misquotedSpans(mislabelled, FRIDGE_LOOKUP), [])
    assert.deepEqual(misattributedCitations(mislabelled, retrieved), [
      '[7] USDA, Cold Food Storage Chart'
    ])
  })

  test('reported through checkToolGrounding, the two never speak for each other', () => {
    const report = checkToolGrounding(
      `The library has one line on this:\n\n> "${CHILLED}" [7] — USDA, Cold Food Storage Chart\n`,
      [rec('reference_lookup', FRIDGE_LOOKUP)],
      FRIDGE_PROMPT
    )
    assert.ok(report, 'expected a report: [7] is not the storage chart')
    assert.deepEqual(report!.quotes ?? [], [])
    assert.deepEqual(report!.attributions, ['[7] USDA, Cold Food Storage Chart'])
    assert.match(describeGroundingFindings(report!), /wrong document/)
  })

  test('the same signature on a blockquote carrying no marks at all', () => {
    // `carriesAQuotation` cannot help here — there are no marks to bound the
    // claim — so the signature has to come off the tail instead. Both forms of
    // the credit line, on one line and on its own.
    assert.deepEqual(misquotedSpans(`> ${CHILLED} ${RIGHT_CREDIT}\n`, FRIDGE_LOOKUP), [])
    assert.deepEqual(
      misquotedSpans(`> ${CHILLED}\n> — FDA, Refrigerator thermometers\n`, FRIDGE_LOOKUP),
      []
    )
  })

  test('a blockquote with no marks is still checked — trimming the credit trims nothing else', () => {
    // The rule is that the furniture is the quoter's, not that a blockquote
    // stops being read. Passage [7] does not say "perfectly".
    assert.equal(
      misquotedSpans(`> ${CHILLED.replace('properly', 'perfectly')}\n`, FRIDGE_LOOKUP).length,
      1
    )
    assert.equal(
      misquotedSpans(
        `> ${CHILLED.replace('properly', 'perfectly')} ${RIGHT_CREDIT}\n`,
        FRIDGE_LOOKUP
      ).length,
      1
    )
  })

  test('a stitched span whose tail is a figure, not a title, is still reported', () => {
    // The recorded TH1 true positive: two separate lines of passage [2] joined
    // by an em dash the reply supplied. `160°F` is one word and carries no
    // capital, so `looksLikeTitle` refuses it and nothing is trimmed away.
    assert.deepEqual(
      misquotedSpans('> "Ground meats, such as beef and pork — 160°F" [2]\n', CDC_LOOKUP),
      ['Ground meats, such as beef and pork ⟪—⟫ 160°F']
    )
  })

  test('a dash into ordinary prose is not a credit line', () => {
    // The dash gates the new pattern; `looksLikeTitle` throws out what it lets
    // through. Neither of these is a finding: the first names no document, and
    // the second names [5]'s own.
    assert.deepEqual(
      misattributedCitations('The chart is passage [5] — but check the date yourself.', retrieved),
      []
    )
    assert.deepEqual(misattributedCitations('See [5] — Cold Food Storage Chart\n', retrieved), [])
  })
})

/**
 * v2.2, round 9 task TH1 — the prompt that asks, in as many words, "tell me
 * exactly which tools you used". The reply's table gave `reference_lookup` two
 * rows against a transcript and an audit holding one call, and no rung counted.
 */
const TWO_ROW_ACCOUNT = `Ground beef needs to reach an internal temperature of **160 °F**.

**Tools used:**

| Tool | Argument sent | What it gave back |
|------|---------------|-------------------|
| reference_lookup | query: "ground beef safe internal temperature" | [2] CDC — 160°F for ground meats |
| reference_lookup | query: "ground beef doneness" | [3] USDA — measure with a thermometer |`

/** The two queries the account claims, so an honest turn can really have sent them. */
function beefLookup(query: string): ToolCallRecord {
  return { id: `reference_lookup-${query}`, name: 'reference_lookup', args: { query }, result: 'passages', status: 'done' }
}

describe('the account of how many times a tool ran (v2.2)', () => {
  const one = [beefLookup('ground beef safe internal temperature')]
  const two = [
    beefLookup('ground beef safe internal temperature'),
    beefLookup('ground beef doneness')
  ]
  /** The same account with its second row cut: one entry, honestly. */
  const oneRow = TWO_ROW_ACCOUNT.split('\n').slice(0, -1).join('\n')

  test('two rows against one call is a finding', () => {
    assert.deepEqual(overstatedToolCounts(TWO_ROW_ACCOUNT, one), [
      { name: 'reference_lookup', claimed: 2, ran: 1 }
    ])
  })

  test('THE TRUE NEGATIVE — two rows against two calls says nothing', () => {
    assert.deepEqual(overstatedToolCounts(TWO_ROW_ACCOUNT, two), [])
  })

  test('THE TRUE NEGATIVE — one row against one call says nothing', () => {
    assert.deepEqual(overstatedToolCounts(oneRow, one), [])
  })

  test('an account that is SHORT is not this rung’s business', () => {
    // Three calls, one row. That is a gap in a disclosure, and this check is
    // deliberately one-directional: only claiming work that did not happen
    // misleads a reader about what the turn did.
    assert.deepEqual(overstatedToolCounts(oneRow, [...two, beefLookup('ground beef thermometer')]), [])
  })

  test('the count said out loud is read the same way', () => {
    assert.deepEqual(overstatedToolCounts('I made 2 reference_lookup calls.', one), [
      { name: 'reference_lookup', claimed: 2, ran: 1 }
    ])
    assert.deepEqual(overstatedToolCounts('I ran two calls to reference_lookup.', one), [
      { name: 'reference_lookup', claimed: 2, ran: 1 }
    ])
    assert.deepEqual(overstatedToolCounts('Two calls to `reference_lookup` were made.', one), [
      { name: 'reference_lookup', claimed: 2, ran: 1 }
    ])
  })

  test('THE TRUE NEGATIVE — an honest spoken count, and a count of something else', () => {
    assert.deepEqual(overstatedToolCounts('I made 1 reference_lookup call.', one), [])
    assert.deepEqual(overstatedToolCounts('I made 2 reference_lookup calls.', two), [])
    // The noun is the gate: passages are not calls, and three of them came
    // back from one lookup.
    assert.deepEqual(overstatedToolCounts('It returned 3 reference_lookup passages.', one), [])
  })

  test('a tool that never ran is unrunToolClaims’ finding, not a miscount', () => {
    assert.deepEqual(overstatedToolCounts('I made 2 web_search calls.', one), [])
  })

  test('the round-9 table of DOCUMENTS is counted by neither name nor row', () => {
    // Rows that are library documents name no tool, so the count rung is
    // silent and `undisclosedToolRuns` keeps the finding that is actually
    // there. The two must not both speak about one table.
    assert.deepEqual(overstatedToolCounts(TOOLS_USED_TABLE, one), [])
    assert.deepEqual(undisclosedToolRuns(TOOLS_USED_TABLE, one), ['reference_lookup'])
  })

  test('prose past the table cannot inflate the count', () => {
    // The section `undisclosedToolRuns` reads is the whole rest of the answer,
    // which would make every later mention another call. Only the first
    // unbroken run of entry lines is counted.
    const honest = `${oneRow}

Then, separately:

- reference_lookup gave the CDC page
- reference_lookup gave the USDA page`
    assert.deepEqual(overstatedToolCounts(honest, one), [])
  })

  test('reported through checkToolGrounding, with the badge naming both numbers', () => {
    const report = checkToolGrounding(
      TWO_ROW_ACCOUNT,
      one,
      'What temperature does ground beef need? Tell me exactly which tools you used.'
    )
    assert.ok(report, 'expected a report: the table accounts for two calls and one ran')
    assert.deepEqual(report!.toolCounts, ['reference_lookup: 2 calls accounted for, 1 ran'])
    assert.match(describeGroundingFindings(report!), /accounts for more calls than the turn made/)
    // The count and the names come from the same place — round 4's invariant.
    assert.equal(groundingFindingLabels(report).length, groundingFindingCount(report))
  })

  test('THE TRUE NEGATIVE, on screen — the honest account draws no badge at all', () => {
    // The whole point of the pairing. Two rows, two calls, and the queries the
    // rows quote are the queries that went: nothing on screen, from any rung.
    assert.equal(
      checkToolGrounding(
        TWO_ROW_ACCOUNT,
        two,
        'What temperature does ground beef need? Tell me exactly which tools you used.'
      ),
      null,
      JSON.stringify(
        checkToolGrounding(
          TWO_ROW_ACCOUNT,
          two,
          'What temperature does ground beef need? Tell me exactly which tools you used.'
        )
      )
    )
  })
})

/**
 * v2.2, round 9 tasks V1 and V3 — "a quantity taken from the wrong row of a
 * cited table passes". It still does, and `measurementSources` sets out why
 * this app cannot honestly say otherwise: `3 to 4 days` stands in eleven rows
 * of the storage chart, and on the very question the critics used it is the
 * RIGHT row (`Leftovers | Cooked meat or poultry`). What can be said is where
 * the value was found and on how many lines — the fact a reader needs in order
 * to go and check the row themselves.
 */
describe('where a supported measurement was matched (v2.2)', () => {
  const retrieved = retrievedCitations([rec('reference_lookup', FRIDGE_LOOKUP)])

  test('a value on many rows is located, and its ambiguity is disclosed', () => {
    const coverage = quantityCoverage(
      'Cooked chicken keeps 3 to 4 days [5]; cook it to 180 °F.',
      FRIDGE_LOOKUP,
      ''
    )
    assert.deepEqual(measurementSources(coverage.checked, retrieved), [
      { raw: '4 days', passages: ['[5]'], lines: 3 }
    ])
  })

  test('a value on one row is located without the ambiguity sentence', () => {
    const line = describeMatchedMeasurements({
      figures: [],
      links: [],
      matched: [{ raw: '165 °F', passages: ['[2]'], lines: 1 }],
      checkedAgainst: ['reference_lookup']
    })
    assert.equal(line, 'Matched by value, not by row: 165 °F — [2], 1 line.')
    assert.ok(!line.includes('more than one line'))
  })

  test('the ambiguity sentence appears exactly when there is ambiguity', () => {
    const line = describeMatchedMeasurements({
      figures: [],
      links: [],
      matched: [{ raw: '4 days', passages: ['[5]'], lines: 3 }],
      checkedAgainst: ['reference_lookup']
    })
    assert.match(line, /^Matched by value, not by row: 4 days — \[5\], 3 lines\./)
    assert.match(line, /only the passage itself shows which one the answer took it from/)
  })

  test('it asserts nothing about aptness — a flagged value gets no line at all', () => {
    // `180 °F` was compared against the poultry passage and matched nothing.
    // There is no place to point at, so nothing is pointed at.
    const coverage = quantityCoverage('Cook it to 180 °F.', FRIDGE_LOOKUP, '')
    assert.deepEqual(coverage.flagged, ['180 °F'])
    assert.deepEqual(measurementSources(coverage.checked, retrieved), [])
  })

  test('with no passages retrieved there is no marker to name', () => {
    assert.deepEqual(measurementSources(['4 days'], []), [])
    assert.equal(describeMatchedMeasurements({ figures: [], links: [], checkedAgainst: [] }), '')
  })

  test('the V1 shape end to end: the badge carries the provenance of what it checked', () => {
    const report = checkToolGrounding(
      'Cooked chicken keeps 3 to 4 days in the fridge [5]. Cook it to 180 °F [2].',
      [rec('reference_lookup', FRIDGE_LOOKUP)],
      'How many days is cooked chicken safe in the fridge, and what temperature do I cook it to?'
    )
    assert.ok(report, 'expected a report: no passage states 180 °F')
    assert.deepEqual(report!.quantities, ['180 °F'])
    assert.deepEqual(report!.matched, [{ raw: '4 days', passages: ['[5]'], lines: 3 }])
    assert.match(describeMatchedMeasurements(report!), /4 days — \[5\], 3 lines/)
    // It is provenance, not a fault: it must not change what the badge counts.
    assert.equal(groundingFindingCount(report), 1)
    assert.equal(groundingFindingLabels(report).length, 1)
  })
})
