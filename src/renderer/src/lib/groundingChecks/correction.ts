// Split out of lib/toolGrounding.ts (v2.4): the "correction" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import { GroundingReport, MAX_REPORTED } from './report'
import { QUOTE_BREAK_MARKS, marksABreak } from './quotations'
import { MAX_SOURCE_PASSAGES } from './measurementSources'



// ---- correction ----------------------------------------------------------------

/**
 * The findings, written for the model that produced them.
 *
 * v1.4.6. Everything above this line detects; nothing acted on what it found.
 * Across ten measured sessions the checks correctly identified invented
 * addresses, prices, phone numbers and a relocated brand — and then rendered a
 * badge underneath an answer the user had already read. The detection was
 * right and the answer was still wrong.
 *
 * So the findings go back to the model for one revision. Two things make that
 * safe rather than destructive: it names the specific items rather than
 * asking for a general rewrite, and it offers verification as the first
 * option — the model still has its tools, and an address it can confirm is
 * better kept than deleted.
 */
/** How many separate unsupported things a report names. */
export function groundingFindingCount(report: GroundingReport | null): number {
  if (!report) return 0
  return (
    report.figures.length +
    report.links.length +
    (report.quantities?.length ?? 0) +
    (report.origins?.length ?? 0) +
    (report.contacts?.length ?? 0) +
    (report.addresses?.length ?? 0) +
    (report.toolClaims?.length ?? 0) +
    (report.toolDenials?.length ?? 0) +
    (report.toolDisclosure?.length ?? 0) +
    (report.toolCounts?.length ?? 0) +
    (report.toolArgs?.length ?? 0) +
    (report.toolRetrieval?.length ?? 0) +
    (report.code?.length ?? 0) +
    (report.citations?.length ?? 0) +
    (report.quotes?.length ?? 0) +
    (report.attributions?.length ?? 0)
  )
}

/**
 * Is a revision an improvement, or just a different set of inventions?
 *
 * v1.4.6, and this guard is why the correction pass is safe to run at all.
 * Asked to fix an itinerary with two invented addresses, the model — measured,
 * against the live model — returned the same table with *different* invented
 * addresses ("155 W 52nd St" became "150 W 52nd St") plus a line claiming the
 * rest had been "verified against search results" when nothing had run. The
 * prompt forbids exactly that and the model did it anyway, which is the usual
 * lesson: an instruction is a preference, a check is a guarantee.
 *
 * So a revision is kept only when it strictly reduces what the checker can
 * fault. Anything else and the original stands, flagged — the answer the user
 * gets is never worse than the one the model first produced.
 */
export function revisionIsAnImprovement(
  before: GroundingReport,
  after: GroundingReport | null
): boolean {
  return groundingFindingCount(after) < groundingFindingCount(before)
}

/** Beyond this many, the revision line names the first few and counts the rest. */
const MAX_NAMED = 4
/** A single named item longer than this is elided — the line has to stay a line. */
const MAX_LABEL = 48

/**
 * Elide to `max`, but never across the break a quotation excerpt is marked at.
 *
 * v1.17, and the same lesson as the excerpt itself: a label whose only job is to
 * let the reader find the faulted thing on screen must not cut away the part
 * that identifies it. A head-clamp at 48 characters would land inside the
 * run-up to the marker on almost every quotation, so when the marker is there,
 * the window moves with it.
 */
function elideLabel(text: string, max: number): string {
  if (text.length <= max) return text
  const [open, close] = QUOTE_BREAK_MARKS
  const at = text.indexOf(open)
  if (at < 0) return `${text.slice(0, max - 1)}…`
  const shut = text.indexOf(close, at)
  const room = max - 2
  const width = (shut < 0 ? text.length : shut + close.length) - at
  const from = width >= room ? at : Math.max(0, at - Math.floor((room - width) / 2))
  const to = Math.min(text.length, from + room)
  const body = text.slice(from, to)
  return `${from > 0 && !body.startsWith('…') ? '…' : ''}${body}${to < text.length && !body.endsWith('…') ? '…' : ''}`
}

/**
 * Every faulted thing, as the short string a reader can look for on screen.
 *
 * The count and the names must come from the same place. `groundingFindingCount`
 * spans sixteen categories; a line that says "3 unsupported items" and then
 * names two is worse than one that names none, so this walks the same sixteen
 * and the invariant `labels.length === count` is pinned in the tests.
 *
 * A code finding is the one that cannot be quoted — it is a traceback plus an
 * instruction — so it is named by what it is. The 🧪 check line carries the
 * detail directly under this one.
 */
export function groundingFindingLabels(report: GroundingReport | null): string[] {
  if (!report) return []
  return [
    ...(report.code ?? []).map(() => "the answer's Python"),
    ...(report.toolClaims ?? []),
    ...(report.toolDenials ?? []),
    ...(report.toolDisclosure ?? []),
    ...(report.toolCounts ?? []),
    ...(report.toolArgs ?? []),
    ...(report.toolRetrieval ?? []),
    // Elided before it is wrapped, not after: a label ending in a lone `”` is
    // the sort of debris that makes a reader distrust the whole line.
    ...(report.quotes ?? []).map((q) => `“${elideLabel(q, MAX_LABEL - 2)}”`),
    ...(report.attributions ?? []),
    ...(report.addresses ?? []),
    ...(report.contacts ?? []),
    ...report.links,
    ...(report.citations ?? []),
    ...report.figures,
    ...(report.quantities ?? []),
    ...(report.origins ?? [])
  ].map((s) => elideLabel(s, MAX_LABEL))
}

export interface RevisionOutcome {
  /** How many findings went back to the model. */
  sent: number
  /** How many of them the re-check still faults in the answer now on screen. */
  remaining: number
  /** True only when the re-check faults none of them. */
  resolved: boolean
  /** The line, for the reader. Empty when nothing was sent back. */
  text: string
}

export function nameList(labels: string[]): string {
  if (labels.length <= MAX_NAMED) return labels.join(', ')
  return `${labels.slice(0, MAX_NAMED).join(', ')} and ${labels.length - MAX_NAMED} more`
}

/**
 * What the revision pass actually accomplished, in the words it can stand behind.
 *
 * The v1.4.6 line said "N unsupported items were sent back for verification or
 * removal" and stopped there — which is a description of a *request*, not of a
 * result, and it was rendered in green underneath answers where the finding was
 * still standing. Measured, blind, round 4 task V1: the reply stated 165°F/74°C
 * over passages that contain neither string, and the only chrome on screen was
 * "✎ Revised: 1 unsupported item were sent back for verification or removal."
 * A judge chose the older build over it and named that line as the reason.
 *
 * Three things were wrong and all three are the same thing. It asserted a
 * resolution it had not checked; it named nothing, so nobody could check it
 * either; and it agreed a plural verb with "1 item". So the line is now a
 * function of both reports — what went back and what came back still faulted —
 * it names the items, and `resolved` is what the colour keys off. An unresolved
 * finding is not a resolution and must not be painted like one.
 *
 * Note what `resolved` does and does not claim: the re-check no longer faults
 * these items, which is a statement about the check, not about the world. It is
 * the strongest thing this code knows.
 */
export function describeRevisionOutcome(
  before: GroundingReport | null,
  after: GroundingReport | null
): RevisionOutcome {
  const sent = groundingFindingCount(before)
  const remaining = groundingFindingCount(after)
  if (sent === 0) return { sent: 0, remaining, resolved: false, text: '' }
  const head = `Revised: ${sent} unsupported item${sent === 1 ? ' was' : 's were'} sent back`
  if (remaining === 0) {
    return {
      sent,
      remaining,
      resolved: true,
      text: `${head} (${nameList(groundingFindingLabels(before))}); the re-check faults none of them.`
    }
  }
  return {
    sent,
    remaining,
    resolved: false,
    text:
      `${head}; ${remaining} ${remaining === 1 ? 'is' : 'are'} still unsupported in this ` +
      `answer: ${nameList(groundingFindingLabels(after))}.`
  }
}

export /** `a`, `a and b`, `a, b and c` — never `a and b and c`. */
function andList(parts: string[]): string {
  if (parts.length < 2) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * The amber banner's first line: the categories that were faulted, the items in
 * each, and a verb that agrees with the items.
 *
 * v1.17.1, and it is round 6's own generalisation applied to the sentence that
 * carries the whole verifiability claim. `MessageBubble` wrote
 * `parts.length > 1 ? 'are' : 'is'`, and `parts` holds one entry per CATEGORY —
 * figures, links, measurements — not per item. So the app shipped, verbatim,
 * from recorded runs:
 *
 *     ⚠️ 2 measurements (165°F, 74°C) in this reply is not backed by the tool output.
 *     ⚠️ 3 figures ($0.01, $36, $10) in this reply is not backed by the tool output.
 *     ⚠️ 4 links in this reply is not backed by the tool output.
 *
 * Every plural-within-one-category case was ungrammatical, and the two-category
 * case read correctly only by accident — a compound subject is plural however
 * its halves count, so the wrong quantity happened to cross the threshold with
 * the right one. The verb now agrees with the total, which is what the subject
 * denotes.
 *
 * It lives here rather than in the component for the reason the count and the
 * names of `describeRevisionOutcome` do: a sentence with no test is how "1 item
 * were sent back" survived to a blind judge in round 4.
 *
 * v2.4: the count is the census and the naming is what is capped — see `found`.
 * Until now both came off an array already sliced to `MAX_REPORTED`, so the
 * line agreed with itself perfectly and understated the reply. The rule it
 * broke is stated two hundred lines above it, over `groundingFindingLabels`:
 * *the count and the names must come from the same place* — and the place has
 * to be the whole of what was found.
 */
export function describeUnbackedItems(report: GroundingReport): string {
  const parts: string[] = []
  let items = 0
  const add = (named: string[], noun: string, list: boolean, found: number): void => {
    if (found === 0) return
    items += found
    // Named in full where naming is possible: a figure is checked by looking at
    // it. Links carry their own bulleted list under this line, so counting them
    // here and listing them there says each URL once — and the same "and N
    // more" that closes this parenthesis closes that list (see MessageBubble).
    const unnamed = found - named.length
    const names = list
      ? ` (${named.join(', ')}${unnamed > 0 ? ` and ${unnamed} more` : ''})`
      : ''
    parts.push(`${found} ${noun}${found === 1 ? '' : 's'}${names}`)
  }
  const quantities = report.quantities ?? []
  add(report.figures, 'figure', true, report.found?.figures ?? report.figures.length)
  add(report.links, 'link', false, report.found?.links ?? report.links.length)
  add(quantities, 'measurement', true, report.found?.quantities ?? quantities.length)
  if (items === 0) return ''
  return `${andList(parts)} in this reply ${items === 1 ? 'is' : 'are'} not backed by the tool output.`
}

/**
 * How many links the banner's bulleted list leaves unnamed — the `and N more`
 * that belongs to that list rather than to the sentence above it.
 *
 * Links are the one counted category the sentence does not name inline, so the
 * v2.4 disclosure has to land where they *are* named. Here rather than in the
 * component, beside the sentence it has to agree with.
 */
export function unlistedLinks(report: GroundingReport): number {
  return (report.found?.links ?? report.links.length) - report.links.length
}

/**
 * Beyond this many, each clause of the coverage line names the first few and
 * counts the rest. Shared by both clauses because it is one line and one
 * reader's patience, not two budgets.
 */
const MAX_COVERAGE_NAMED = 4

/** `a, b, c and N more`, where N is what the cap left out. */
function namedUpTo(named: string[], total: number): string {
  const shown = named.slice(0, MAX_COVERAGE_NAMED)
  const rest = total - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

/**
 * The one line that says what this pass did *not* do.
 *
 * **Why this and not a ranking.** The obvious reading of the V3 failure is that
 * the checker needs to know which claim the reply is about, and the prompt is
 * right there. It was tried on paper and it does not survive contact with this
 * app's own corpus.
 *
 * `buildSearchQuery` offers nothing: it flattens whitespace, caps at 240
 * characters and optionally prepends the previous user message. It performs no
 * topical analysis, so there is no existing machinery to lean on. Building it
 * means a noun→dimension lexicon — "water" is a volume — and the shipped packs
 * break it immediately. *How much water should I store per person* is a volume;
 * *how much water weight will I lose* is a mass; *how much can my landlord
 * raise the rent* is money or a percentage; *how long do leftovers last* is a
 * duration; and *how much does it cost to fix a dripping faucet* is money —
 * which on this very reply makes `$10`–`$80` the headline and `105 gallons` the
 * incidental. Two questions a hair apart, opposite answers, and the app cannot
 * tell them apart without understanding the sentence.
 *
 * The cost of guessing wrong is not a miss, it is a new way to mislead. A line
 * reading "the figure that answers your question is unsupported" pointing at
 * `$25` asserts that the app understood the question, in the one place a reader
 * has no way to check. Round 4's stricter quote checker was judged *worse* than
 * the gap it closed for exactly this reason, and that finding was at least
 * falsifiable by eye. This one would not be.
 *
 * So the honest smaller thing: report the coverage, name nothing as important,
 * and let the reader see that the number they came for was never looked at.
 *
 * **Its failure mode, stated.** This line can only ever *understate* what the
 * pass knows. If a named measurement turns out to be perfectly correct, "it was
 * compared against nothing" is still true — it is a fact about the check, not a
 * verdict on the answer. It elevates no figure because it names every one the
 * rung skipped, in the order the reply states them. Its real cost is length on
 * a reply full of incidental durations, which is why it is capped, and why it
 * rides an existing badge rather than appearing on its own: a reply the pass
 * faults nowhere makes no coverage claim to correct, and a permanent grey line
 * under every mention of "20 minutes" is round 4's cry-wolf in a quieter ink.
 *
 * **And the noise it would have made.** The first version of this line said
 * "compared against nothing" the moment a dimension was unarmed, which is true
 * and was still wrong to print. Measured while building it: a passage reading
 * "wastes about 2,000 gallons **per year**" against a reply reading "wastes
 * about 2,000 gallons **a year**" produced *Covered 0 of the 1 measurement …
 * Not compared against anything: 2,000 gallons* — because the rate suffix makes
 * `gallon per year` a different unit from `gallon`, deliberately (a pace is not
 * a duration). Every word of that was accurate and a reader looking at the
 * passage would have called the app broken, which is how a disclosure becomes
 * noise. The line is therefore gated on `coverageWorthSaying`: at least one
 * skipped measurement whose number the reader cannot find in what the tools
 * returned. See there for why the gate is on the line and not on the items.
 *
 * **v2.5: the denominator was a claim about the reply, taken from a scan.**
 * Round 12, task V3, both arms, verbatim:
 *
 *     Covered 1 of the 4 measurements in this reply.
 *     Not compared against anything: 1,450 gallons, 2.2 gallons per drop, 30 days.
 *
 * — under a reply that also states `~876 drops per day`. The 4 is correct
 * arithmetic over `measurementsIn`, which returns exactly four spans on those
 * bytes. `drop` is not in the unit vocabulary, so the fifth quantity was never
 * a candidate and nothing on screen said so. *In this reply* is a claim about
 * the reply; the number behind it was a claim about the scan. Every other rung
 * in this file states its own corpus — "not backed by the tool output",
 * "Checked against: …" — and this one silently did not.
 *
 * Two sentences, and both are needed. The first now says whose reading the
 * denominator is, which is true whatever the scan missed. The second, new one
 * names the quantities the vocabulary could not read at all, so the reader can
 * see the provenance rather than take it on trust — and it is deliberately a
 * naming and never a total, because `unreadableQuantitiesIn` is a floor by
 * construction and a second census would be the same overstatement one clause
 * along.
 *
 * That clause is **not** gated the way the line is. `coverageWorthSaying`
 * exists because "compared against nothing" reads as broken when the number is
 * on screen in the passage below it; "this check cannot read this unit" is not
 * contradicted by the passage stating the quantity, because it was never a
 * claim about the quantity's truth.
 */
export function describeCoverage(report: GroundingReport): string {
  const gap = report.coverage
  if (!gap || gap.unchecked === 0) return ''
  const total = gap.checked + gap.unchecked
  // Both halves, deliberately: a clause with a count and nothing to name is a
  // number the reader cannot find on screen, which is the whole failure this
  // line keeps being repaired for.
  const unread = gap.unread ?? 0
  const unreadNamed = gap.unreadNamed ?? []
  return (
    `Covered ${gap.checked} of the ${total} measurement${total === 1 ? '' : 's'} this check ` +
    `can read in this reply. ` +
    `Not compared against anything: ${namedUpTo(gap.uncheckedNamed, gap.unchecked)}.` +
    (unread > 0 && unreadNamed.length > 0
      ? ` Outside what it can read at all, so not in that count: ` +
        `${namedUpTo(unreadNamed, unread)}.`
      : '')
  )
}

/**
 * The companion to `describeCoverage`, and the same rank of statement: about
 * the check, not about the answer.
 *
 * `describeCoverage` reports what the pass never reached. This reports where
 * what it *did* reach was found — and, when a value sits on more than one line
 * of a passage, says so, because that is precisely the situation in which
 * "the passage states this number" is at its weakest as evidence. See
 * `measurementSources` for why this is the line and not a verdict on the row.
 */
export function describeMatchedMeasurements(report: GroundingReport): string {
  const found = report.matched ?? []
  if (found.length === 0) return ''
  const parts = found.slice(0, MAX_REPORTED).map((s) => {
    const shown = s.passages.slice(0, MAX_SOURCE_PASSAGES)
    const rest = s.passages.length - shown.length
    const where = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
    return `${s.raw} — ${where}, ${s.lines} line${s.lines === 1 ? '' : 's'}`
  })
  const ambiguous = found.some((s) => s.lines > 1)
  return (
    `Matched by value, not by row: ${parts.join('; ')}.` +
    (ambiguous
      ? ' Where a value is stated on more than one line, only the passage itself shows which one the answer took it from.'
      : '')
  )
}

export function describeGroundingFindings(report: GroundingReport): string {
  const lines: string[] = []
  if (report.code?.length) lines.push(...report.code)
  if (report.toolClaims?.length) {
    lines.push(
      `- Your answer says you used ${report.toolClaims.join(', ')}; no such call ran this turn. ` +
        'Either make the call, or say what you actually did instead.'
    )
  }
  if (report.toolDenials?.length) {
    lines.push(
      `- Your answer's account of this turn contradicts what ran: ${report.toolDenials.join('; ')}. ` +
        'Say what those calls returned. If you did not use what came back, say that — do not say ' +
        'the calls did not happen, and do not offer to start work this turn has already finished.'
    )
  }
  if (report.toolDisclosure?.length) {
    lines.push(
      `- Your answer lists the tools it used and never names ${report.toolDisclosure.join(', ')}, ` +
        'which is what actually ran. List the calls this turn made, not the documents they returned.'
    )
  }
  if (report.toolCounts?.length) {
    lines.push(
      `- Your answer accounts for more calls than the turn made: ${report.toolCounts.join('; ')}. ` +
        'Give one entry per call that actually ran, and fold what a single call returned into ' +
        'that call rather than splitting it across rows.'
    )
  }
  if (report.toolArgs?.length) {
    lines.push(
      `- Quoted as the argument you passed, but not what the call received: ${report.toolArgs.join('; ')}. ` +
        'Quote the argument the call actually carried, or describe the call in your own words ' +
        'without putting a string in quotation marks.'
    )
  }
  if (report.toolRetrieval?.length) {
    lines.push(
      `- Your answer's account of what the library returned contradicts the passages: ${report.toolRetrieval.join('; ')}. ` +
        'The citation line above each passage names its pack, and the lookup prints a relevance ' +
        'for every one. Read them off, or say you cannot see them — do not estimate.'
    )
  }
  if (report.quotes?.length) {
    lines.push(
      `- Presented as direct quotations but in no tool output: ${report.quotes.map((q) => `“${q}”`).join('; ')}. ` +
        (report.quotes.some(marksABreak)
          ? `${QUOTE_BREAK_MARKS.join('')} marks where the quotation stops matching the source. `
          : '') +
        'Quote the source line exactly, or drop the quotation marks and say you are paraphrasing.'
    )
  }
  if (report.attributions?.length) {
    lines.push(
      `- Attributed to the wrong document: ${report.attributions.join('; ')}. ` +
        'Name the document the numbered passage actually came from.'
    )
  }
  if (report.addresses?.length) {
    lines.push(`- Addresses that appear in no result: ${report.addresses.join('; ')}`)
  }
  if (report.contacts?.length) {
    lines.push(`- Contact details no tool returned: ${report.contacts.join('; ')}`)
  }
  if (report.links.length) {
    lines.push(`- Links that appear in no result: ${report.links.join('; ')}`)
  }
  if (report.citations?.length) {
    lines.push(
      `- Citation markers naming a passage that was never retrieved: ${report.citations.join(', ')}. ` +
        'Cite only the numbered passages you were handed, or drop the marker and say what is uncited.'
    )
  }
  if (report.figures.length) {
    lines.push(`- Figures nothing retrieved or computed supports: ${report.figures.join(', ')}`)
  }
  if (report.quantities?.length) {
    lines.push(
      '- Measurements nothing computed or retrieved supports: ' +
        `${report.quantities.join(', ')}. If a tool computed, or a retrieved passage states, a ` +
        'different number, use that one.'
    )
  }
  if (report.origins?.length) {
    lines.push(
      `- Your answer places the subject in ${report.origins.join(', ')}, which the sources never mention.`
    )
  }
  if (lines.length === 0) return ''

  return (
    // "…returned" alone was true until v1.17 and is not any more: the argument
    // rung reads what the calls were SENT. Round 6's recurring critique is a
    // sentence describing something adjacent to what was measured, and the
    // cheapest way to keep this one honest is to name both corpora it reads.
    'A mechanical check compared your answer against what this turn\'s tools were sent and ' +
    `what they returned (${report.checkedAgainst.join(', ')}). It found specifics nothing ` +
    'supports:\n\n' +
    `${lines.join('\n')}\n\n` +
    'Rewrite the answer. For each item: verify it with a tool, or drop it and say plainly what ' +
    'you could not confirm. Do not restate any of them as fact, and do not replace one ' +
    'unverified specific with another. Everything the sources do support stays — this is a ' +
    'correction, not a shorter answer. Give the full corrected answer, not a description of ' +
    'what you changed.'
  )
}
