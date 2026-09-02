// Split out of lib/toolGrounding.ts (v2.4): the "pass" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import type { ToolCallRecord } from '../../types'
import { OUTCOME_NOTE, callOutcome, type CallOutcome } from '../grounding'
import { LAUNDERED_OUTPUT_MARKER } from '../workbenchChecks'
import {
  citedIndices,
  danglingCitations,
  retrievedCitations,
  turnLookups,
  type Citation,
  type Lookup
} from '../citations'
import { RetrievalTurns, misdescribedRetrievalLines } from './retrieval'
import { GroundingReport, MAX_REPORTED, MIN_UNPROMPTED_FIGURES, NUMERIC_TOOLS, RETRIEVAL_TOOLS, SOURCE_TOOLS } from './report'
import { coverageWorthSaying, moneyIn, quantityCoverage, unsourcedFigures } from './figures'
import { measurementSources, unsourcedPercentages } from './measurementSources'
import { unsourcedLinks } from './links'
import { contradictedOrigins } from './origin'
import { unsourcedAddresses } from './addresses'
import { unsourcedContacts } from './contacts'
import { undisclosedToolRuns, unrunToolClaims } from './claimedTools'
import { contradictedToolAccountLines } from './deniedWork'
import { overstatedToolCountLines } from './toolCounts'
import { describeMisstatedArgument, statedArgumentsIn } from './arguments'
import { QUOTE_BREAK_MARKS, flattenQuote, misquotedSpans } from './quotations'
import { misattributedCitations } from './attributions'



// ---- the pass ----------------------------------------------------------------

/** Successful output of the records whose names pass `include`. */
/**
 * Tool output as evidence. `errored` widens to records that ended in error:
 * v1.6 — a run_python that printed the totals and then failed at the plot has
 * still computed those totals, and the model that quotes them from that
 * record is quoting real output. Links and addresses keep the stricter rule.
 */
const STDOUT_BEFORE_ERROR = /stdout before the error:\n([\s\S]*?)\n\nerror:/

/** The output an errored run still produced (workbenchFormat's section), or '' when there is none. */
export function producedBeforeError(record: ToolCallRecord): string {
  if (record.status !== 'error') return ''
  const m = (record.result ?? '').match(STDOUT_BEFORE_ERROR)
  return m ? m[1] : ''
}

function outputOf(records: ToolCallRecord[], include: (name: string) => boolean, errored = false): string {
  return records
    .filter((r) => include(r.name))
    .map((r) => (r.status === 'done' ? (r.result ?? '') : errored ? producedBeforeError(r) : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Compare a finished reply against the turn's tool output.
 *
 * Returns null when there is nothing to say — which is the common case, and
 * must stay cheap: no badge unless something in the answer genuinely has no
 * backing.
 *
 * `userText` joins the corpus for figures because the user's own numbers (a
 * budget, a down payment) are theirs to restate, and flagging those would be
 * noise. It is deliberately *not* part of the link corpus: a URL the user
 * pasted is fine to echo, but the app has still not verified it, and the
 * pasted-link case is rare enough not to be worth the false-negative.
 *
 * v1.5: it must be *every* user message, not just the latest one. Passing only
 * the current turn produced the badge's worst false positive — a v1.4 session
 * where the user said "$5,000 to invest, $500 a month" four turns earlier and
 * every figure in the resulting plan was flagged as unsourced, including the
 * app's own arithmetic on those numbers. A badge that cries wolf on the user's
 * own budget is a badge they learn to ignore, which costs exactly the cases it
 * exists for.
 */
export function checkToolGrounding(
  answer: string,
  records: ToolCallRecord[],
  userText: string,
  options: {
    /**
     * The turn was a purchase decision, so prices needed a pricing tool. Set
     * by `looksLikeShopping`, and it makes the figure check run even when no
     * such tool ran — because on a shopping turn that is the *worse* case, not
     * a reason to skip: every price in the reply then came from memory.
     */
    expectPricingTool?: boolean
    /**
     * v2.5: the tool records of the conversation's EARLIER assistant turns, one
     * array per turn, oldest first. Read by exactly one rung — see
     * `RetrievalTurns` for why that rung needs them and why every other rung
     * still sees this turn and nothing else.
     */
    priorTurns?: RetrievalTurns
  } = {}
): GroundingReport | null {
  if (!answer.trim()) return null

  // v1.11.2: a run_python whose output the app itself marked as hardcoded
  // (every printed number is a literal in the code — see workbenchFormat's
  // HARDCODED_NUMBERS_NOTE) neither arms the numeric checks nor supports the
  // reply's figures. Without this, a model could print its invented numbers
  // through the sandbox and this checker would certify them as computed.
  //
  // v1.12.3 generalises it: `checksNothing` is the same verdict reached by a
  // different route — the app has already told the user, in the 🧮 line, that
  // this run re-derived the answer from itself. A run the footer calls circular
  // cannot also be a run the footer says it checked against.
  const verifiedNothing = (r: ToolCallRecord): boolean =>
    (r.result ?? '').includes(LAUNDERED_OUTPUT_MARKER) || r.checksNothing === true
  const honest = records.filter((r) => !verifiedNothing(r))
  const numericRecords = honest.filter(
    (r) => NUMERIC_TOOLS.has(r.name) && (r.status === 'done' || producedBeforeError(r) !== '')
  )
  // Such a run ARMS the checks — a fabrication attempt is the moment for
  // maximum scrutiny — while contributing nothing to the support corpus.
  const verifiedNothingNumeric = records.some((r) => verifiedNothing(r) && NUMERIC_TOOLS.has(r.name))
  const sourceRecords = records.filter((r) => r.status === 'done' && SOURCE_TOOLS.has(r.name))
  // v1.12.1: an errored source tool ARMS the link, origin and address checks
  // instead of disarming them. Gating them on `sourceRecords.length > 0` had it
  // exactly backwards: a turn whose search failed ran no link check at all,
  // which is the turn where the model holds no retrieved URLs and every one it
  // prints came from memory. Attempted retrieval is the signal; what the
  // attempt returned is the corpus, and an empty corpus supports nothing.
  const failedSources = records.filter((r) => r.status === 'error' && SOURCE_TOOLS.has(r.name))
  const triedToRetrieve = sourceRecords.length > 0 || failedSources.length > 0

  // v1.4.5: a reply that states several prices is checked whether or not a
  // pricing tool ran. The gate used to be the shopping heuristic, so a turn it
  // did not recognize as commerce — "email campaign copy", in a measured
  // session — could put a whole table of invented per-bottle prices in front of
  // the user with nothing said about it. What a figure is checked against is
  // unchanged; only whether the check runs at all.
  const computedCorpus = outputOf(honest, (n) => NUMERIC_TOOLS.has(n), true)
  const figureCorpus = `${computedCorpus}\n${userText}`
  const sourceCorpus = outputOf(records, (n) => SOURCE_TOOLS.has(n))
  const retrievedCorpus = outputOf(records, (n) => RETRIEVAL_TOOLS.has(n))
  const stated = unsourcedFigures(answer, figureCorpus, sourceCorpus)
  // v1.16, and it is the measurements rung's v1.12.2 argument applied to money.
  // Measured, task V2: asked where the standard deduction number comes from, the
  // reply opened "For tax year 2026: $34,000" over a passage that states $30,000
  // for 2025 and no 2026 figure at all. `unsourcedFigures` saw it — it returns
  // exactly ["$34,000"], the $30,000 and $800 in the same reply being correctly
  // read off the passage — and this gate then dropped it: `reference_lookup` is
  // not in NUMERIC_TOOLS, so nothing armed the rung, and one figure is under
  // MIN_UNPROMPTED_FIGURES. The link check ran on the same reply and named an
  // invented anchor, so the turn shipped having checked the link and skipped the
  // number.
  //
  // A passage is not a computation, but it is authoritative about the dollar
  // amount it states, and the reply proved it could quote by quoting two of
  // them. The limit is the same one measurements draws: passages that quote no
  // money arm nothing, because there is then nothing to stand outside of and
  // "about $20 a bag" is the `unverified` badge's business. Swept over all 34
  // recorded judge-r5 replies this adds exactly one finding — the $34,000.
  const retrievedMoney = moneyIn(retrievedCorpus).length > 0
  const checkFigures =
    numericRecords.length > 0 ||
    verifiedNothingNumeric ||
    options.expectPricingTool === true ||
    retrievedMoney ||
    stated.length >= MIN_UNPROMPTED_FIGURES
  // Percentages only when something actually computed this turn — that is
  // when a stated share had a source it should have used.
  const percentages =
    numericRecords.length > 0 || verifiedNothingNumeric
      ? unsourcedPercentages(answer, figureCorpus, sourceCorpus)
      : []
  const figures = [...(checkFigures ? stated : []), ...percentages]
  // Nearly the percentages gate, widened in v1.12.2 by what the library
  // returned. With nothing computed AND nothing retrieved there is no corpus,
  // and a reply that says "about 20 minutes" from general knowledge is not
  // making a claim the tools could have backed — that turn is the `unverified`
  // badge's business, not this one. But once passages are in hand, a dose or a
  // temperature they contradict is precisely the claim this rung exists for,
  // and it is the standard the library eval has always scored replies against.
  const quantityRungRan = numericRecords.length > 0 || retrievedCorpus.trim() !== ''
  // The user-text corpus doubles as the passive-support corpus (see the comment
  // in `quantityCoverage`); source-tool text joins it for the same reason it
  // supports figures: a measurement read off a fetched page is sourced, not a
  // disagreement with the app's arithmetic.
  //
  // v2.1: the gate feeds the corpus rather than skipping the call, so the walk
  // happens either way and the turn where the rung does not run is the turn
  // that reports every measurement as unchecked — which is the V3 turn, and
  // was previously indistinguishable on screen from a clean scan. An empty
  // arming corpus arms nothing, so this cannot produce a finding it did not
  // produce before: `flagged` is [] whenever `quantityRungRan` is false.
  const coverage = quantityCoverage(
    answer,
    quantityRungRan ? `${computedCorpus}\n${retrievedCorpus}` : '',
    quantityRungRan ? `${userText}\n${sourceCorpus}` : ''
  )
  const quantities = coverage.flagged

  // On the failure path the user's own words join the link corpus, and only
  // there. A URL they pasted is normally excluded (see the note above — the app
  // has still not verified it), but when the fetch that would have verified it
  // errored, "I could not open https://…" must not be reported as an invented
  // link. Nothing model-written enters the corpus either way.
  const linkCorpus = failedSources.length > 0 ? `${sourceCorpus}\n${userText}` : sourceCorpus
  const links = triedToRetrieve
    ? unsourcedLinks(answer, linkCorpus, failedSources.length > 0)
    : []
  const origins = triedToRetrieve ? contradictedOrigins(answer, sourceCorpus) : []
  // The user's own words join the corpus: an address they gave is theirs.
  const addresses = triedToRetrieve
    ? unsourcedAddresses(answer, `${sourceCorpus}\n${userText}`, failedSources.length > 0)
    : []
  // Every tool's output, plus the user's own words — a number they gave is
  // theirs to repeat. Ungated, unlike links: see `unsourcedContacts`.
  const contacts = unsourcedContacts(answer, `${outputOf(records, () => true)}\n${userText}`)
  // Ungated, like contacts: what the reply says about its own process is always
  // checkable against the records, and a turn with no tools at all is the turn
  // where "I searched for this" is furthest from true.
  const toolClaims = unrunToolClaims(answer, records)
  // …and the same account read in the mirror: the tool that DID run which the
  // reply says did not, or whose finished work it offers to begin. Ungated for
  // the reason above and one more — this is the direction that argues the tool
  // blocks on screen are meaningless, so the turns where it must speak are
  // exactly the turns where something ran.
  const toolDenials = contradictedToolAccountLines(answer, records)
  // The other half of the same question: not a tool it names that never ran,
  // but the tool that ran and its own tools-used section leaves out.
  const toolDisclosure = undisclosedToolRuns(answer, records)
  // …and the third reading of the same account: the call it names did run and
  // is named, and the account gives it more entries than the turn has calls.
  // Ungated for the same reason as the two above — the records hold the true
  // number, so there is never a turn where this cannot be checked.
  const toolCounts = overstatedToolCountLines(answer, records)
  // And the rung past both: the call it names did run, its account of the call
  // is complete, and the argument it quotes is not the one the call carried.
  // Ungated for the same reason as the two above — the records are the whole
  // corpus, so there is never a turn where this cannot be checked.
  const statedArgs = statedArgumentsIn(answer, records)
  const toolArgs = statedArgs
    .filter((a) => !a.matched)
    .map(({ param, stated, passed }) => describeMisstatedArgument({ param, stated, passed }))
  // …and the rung past that: the call it names ran, the argument it quotes is
  // the one that went, and what it says came BACK — the pack, the passage
  // count, the relevance figures — matches nothing this conversation retrieved.
  // The one check here that reads past the current turn, because the question
  // it answers ("which documents did you use just now") is always asked one
  // turn late. See `RetrievalTurns`.
  const toolRetrieval = misdescribedRetrievalLines(answer, [
    ...(options.priorTurns ?? []),
    records
  ])
  // Ungated by design — `danglingCitations` only speaks when passages were
  // actually retrieved, which is the only situation in which a bracketed
  // number is a claim about them.
  const retrieved = retrievedCitations(records)
  const citations = danglingCitations(answer, retrieved)
  // Quotation fidelity, gated on retrieval the same way: with nothing fetched
  // there is no source a quotation could be checked against, and a quoted
  // phrase is just prose. The corpus is what every tool RETURNED plus the
  // user's own words — never the arguments the model chose, or a model could
  // launder an invented line through its own query string.
  const quotedCorpus = triedToRetrieve ? `${outputOf(records, () => true, true)}\n${userText}` : ''
  // One claim earns one finding, and the specific rung wins. A stated argument
  // written in straight quotes is also a quoted span, so both rungs see it —
  // and only one of them is right about what it is. "Quoted as exact but in no
  // tool output" is the wrong accusation against a query string: it was never
  // offered as something a tool returned. It is what the reply says it *sent*,
  // which is the sentence above, with the actual argument beside it.
  //
  // v2.2: **every** stated argument, not only the misstated ones. The filter
  // read `misstatedArgs`, so the sentence above held exactly when the reply got
  // its query wrong — and a reply that quoted the query *correctly* kept the
  // wrong accusation, with no argument finding to replace it. Found while
  // building the count rung, on its own true negative: an honest two-call
  // account whose rows quote the two queries verbatim drew
  // `⚠️ Quoted as exact but in no tool output this turn: "ground beef safe
  // internal temperature"`, which is a fabrication warning on a reply that
  // fabricated nothing. What makes the accusation wrong is the *shape* of the
  // claim, and that does not change with whether the claim is true.
  //
  // The laundering hole the corpus rule exists to close stays closed: a
  // `param: "value"` context beside a call is what makes a span a stated
  // argument, and an invented line the model passed as its query and then
  // blockquoted as a source is not written in that shape.
  //
  // v1.17.1: matched against the excerpt's *content*, not its head. The span a
  // misquote now reports is a window centred on the divergence, carrying the
  // ⟪⟫ break marks and an ellipsis on whichever side was trimmed — so the old
  // `startsWith` test, written when a span was a truncated prefix, stopped
  // recognising the very overlap it exists to catch. Strip the presentation
  // and ask whether either string contains the other.
  const bare = (text: string): string =>
    flattenQuote(text)
      .split(QUOTE_BREAK_MARKS[0])
      .join('')
      .split(QUOTE_BREAK_MARKS[1])
      .join('')
      .replace(/^…/, '')
      .replace(/…$/, '')
      .trim()
  const quotes = misquotedSpans(answer, quotedCorpus).filter((span) => {
    const flat = bare(span)
    if (flat === '') return true
    return !statedArgs.some((arg) => {
      const stated = bare(arg.stated)
      return stated.includes(flat) || flat.includes(stated)
    })
  })
  const attributions = misattributedCitations(answer, retrieved)
  // Every measurement the rung compared and found stated somewhere, with the
  // passage that states it. A flagged one drops out on its own — it was
  // compared against values of the same kind and matched none of them, so
  // there is no line to point at.
  const matched = measurementSources(coverage.checked, retrieved)

  if (
    figures.length === 0 &&
    quantities.length === 0 &&
    links.length === 0 &&
    origins.length === 0 &&
    contacts.length === 0 &&
    addresses.length === 0 &&
    toolClaims.length === 0 &&
    toolDenials.length === 0 &&
    toolDisclosure.length === 0 &&
    toolCounts.length === 0 &&
    toolArgs.length === 0 &&
    toolRetrieval.length === 0 &&
    citations.length === 0 &&
    quotes.length === 0 &&
    attributions.length === 0
  ) {
    // Deliberately unconditional on `coverage`. A gap in what was checked is
    // not a fault in the answer, and a badge that appeared on its own to say
    // "0 of 2 measurements were compared against anything" would land under
    // every reply that mentions twenty minutes. That turn is the `unverified`
    // badge's business — `needsVerification` covers the reference domains,
    // including the leaking faucet — and this line's job is to stop an existing
    // badge from implying a completeness it does not have.
    return null
  }

  // One entry per tool, carrying what became of that tool's calls — in the
  // rows' own vocabulary, decided by the rows' own function (`callOutcome`).
  //
  // Naming the calls that supplied nothing matters most on exactly the turns
  // this arms: the disclosure would otherwise read "nothing ran this turn" when
  // a search did run and came back empty-handed. What it must not do is name
  // them all the same way. Until v2.3 every non-`done` source read `(errored)`
  // and every `done` one read as a source — so `∅ ⚙️ reference_lookup — found
  // nothing` was listed bare as something the answer had been checked against,
  // and `deep_research`, which came back with no usable sources, was reported
  // as a tool that broke (FR3, `.h2h-runs/B10/FR3-20260827-224622`).
  //
  // A name goes bare only when one of its calls actually returned something:
  // that is the state a bare name has always claimed. Anything else is
  // qualified, and a tool whose calls ended differently carries both words
  // rather than the app picking a winner.
  const perTool = new Map<string, Set<CallOutcome>>()
  for (const r of [...numericRecords, ...sourceRecords, ...failedSources]) {
    const seen = perTool.get(r.name) ?? new Set<CallOutcome>()
    seen.add(callOutcome(r))
    perTool.set(r.name, seen)
  }
  const named = [...perTool.entries()]
    .map(([name, states]) => {
      if (states.has('ok')) return name
      const notes = [...new Set([...states].map((s) => OUTCOME_NOTE[s]))].filter(Boolean).sort()
      return notes.length > 0 ? `${name} (${notes.join(', ')})` : name
    })
    .sort()
  // …and when every check that ran is one the app already reported as verifying
  // nothing, say that rather than "nothing ran": something did run, it just
  // settled nothing, and "no tool output" would be its own small lie.
  const checkedAgainst =
    named.length > 0
      ? named
      : records.some(verifiedNothing)
        ? ['nothing — the only checks that ran verified nothing']
        : ['no tool output — nothing ran this turn']

  // v2.4: the totals for the three categories the banner counts, kept only
  // where the slice below really drops something. Recorded per category rather
  // than as one number because the sentence names each category separately, and
  // a "and 3 more" hung on the wrong noun is a new wrong statement.
  const found: NonNullable<GroundingReport['found']> = {}
  if (figures.length > MAX_REPORTED) found.figures = figures.length
  if (links.length > MAX_REPORTED) found.links = links.length
  if (quantities.length > MAX_REPORTED) found.quantities = quantities.length

  return {
    figures: figures.slice(0, MAX_REPORTED),
    links: links.slice(0, MAX_REPORTED),
    ...(quantities.length > 0 ? { quantities: quantities.slice(0, MAX_REPORTED) } : {}),
    ...(origins.length > 0 ? { origins: origins.slice(0, MAX_REPORTED) } : {}),
    ...(contacts.length > 0 ? { contacts: contacts.slice(0, MAX_REPORTED) } : {}),
    ...(addresses.length > 0 ? { addresses: addresses.slice(0, MAX_REPORTED) } : {}),
    ...(toolClaims.length > 0 ? { toolClaims: toolClaims.slice(0, MAX_REPORTED) } : {}),
    ...(toolDenials.length > 0 ? { toolDenials: toolDenials.slice(0, MAX_REPORTED) } : {}),
    ...(toolDisclosure.length > 0
      ? { toolDisclosure: toolDisclosure.slice(0, MAX_REPORTED) }
      : {}),
    ...(toolCounts.length > 0 ? { toolCounts: toolCounts.slice(0, MAX_REPORTED) } : {}),
    ...(toolArgs.length > 0 ? { toolArgs: toolArgs.slice(0, MAX_REPORTED) } : {}),
    ...(toolRetrieval.length > 0
      ? { toolRetrieval: toolRetrieval.slice(0, MAX_REPORTED) }
      : {}),
    ...(citations.length > 0 ? { citations: citations.slice(0, MAX_REPORTED) } : {}),
    ...(quotes.length > 0 ? { quotes: quotes.slice(0, MAX_REPORTED) } : {}),
    ...(attributions.length > 0 ? { attributions: attributions.slice(0, MAX_REPORTED) } : {}),
    // The two counts are of DISTINCT measurements and are not capped, because
    // "N of M" is arithmetic the reader reproduces by looking at the reply.
    // Only the naming is capped, and `describeCoverage` says how many it left
    // out rather than quietly showing fewer.
    //
    // The findable corpus is every tool's output plus the user's own words —
    // wider than what ARMS the rung, and deliberately so: this asks only
    // "could the reader find this number", and a wider corpus can therefore
    // only ever suppress the line, never produce one.
    ...(coverageWorthSaying(coverage.unchecked, `${outputOf(records, () => true, true)}\n${userText}`)
      ? {
          coverage: {
            checked: coverage.checked.length,
            unchecked: coverage.unchecked.length,
            uncheckedNamed: coverage.unchecked.slice(0, MAX_REPORTED),
            // v2.5: written only when there is something to disclose, so a
            // report over a reply whose every quantity the vocabulary read
            // cannot claim a gap it did not find — the rule `found` follows.
            ...(coverage.unread.length > 0
              ? {
                  unread: coverage.unread.length,
                  unreadNamed: coverage.unread.slice(0, MAX_REPORTED)
                }
              : {})
          }
        }
      : {}),
    // v2.2, and the mirror of the line above: not what the rung skipped but
    // where what it checked was found. Passages only — a marker is what the
    // reader can open — and it rides an existing badge exactly as `coverage`
    // does, for the same reason: a permanent provenance line under every reply
    // that mentions a duration is round 4's cry-wolf in a quieter ink.
    ...(matched.length > 0 ? { matched: matched.slice(0, MAX_REPORTED) } : {}),
    ...(Object.keys(found).length > 0 ? { found } : {}),
    checkedAgainst
  }
}
