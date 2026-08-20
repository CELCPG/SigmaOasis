import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkToolGrounding,
  contradictedOrigins,
  describeGroundingFindings,
  groundingFindingCount,
  revisionIsAnImprovement,
  unsourcedAddresses,
  unsourcedContacts,
  unsourcedFigures,
  unsourcedLinks,
  unsourcedQuantities
} from '../src/renderer/src/lib/toolGrounding'
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
