import type { GroundingReport } from '../types'
import { describeCoverage, describeMatchedMeasurements, describeUnbackedItems, marksABreak, QUOTE_BREAK_MARKS, unlistedLinks } from '../lib/toolGrounding'

/**
 * v1.3: figures or links the reply asserted that its own tools did not
 * support. Distinct from the `unverified` badge, which means "no source was
 * consulted at all" — this one fires when sources *were* consulted and the
 * answer went past them, which is the harder failure to notice by eye.
 */
export function GroundingWarning({ report }: { report: GroundingReport }): JSX.Element {
  // v1.9.2: figures and measurements are named in full rather than counted. A
  // quantity is only ever flagged when something computed or retrieved this
  // turn, so the reply is stating a distance, a duration or a dose against
  // arithmetic the app itself did or a passage it just read — and which of them
  // disagrees is the only thing worth reading.
  //
  // v1.17.1: the sentence is built in lib/toolGrounding.ts, where it has a
  // test. Its verb used to agree with the number of categories in this array
  // rather than the number of items in them — see `describeUnbackedItems`.
  const unbacked = describeUnbackedItems(report)
  const hasUnbacked = unbacked !== ''
  // v2.4: how many links that sentence counts and the list below does not name.
  const unlisted = unlistedLinks(report)
  // v2.1: what this pass did NOT reach. It sits at the provenance rank, with
  // the "Checked against" footer, because it is the same kind of statement —
  // about the check, not about the answer — and it must not be read as a
  // thirteenth accusation. See `describeCoverage` for why this is a coverage
  // line and not a guess at which figure the question was about.
  const coverage = describeCoverage(report)
  // v2.2: the other half of that disclosure — where the measurements it DID
  // check were found, and how many lines of the passage state the same value.
  // Same rank, same reason, and see `measurementSources` for why this is a
  // location rather than a verdict on which row the answer took.
  const matched = describeMatchedMeasurements(report)
  const origins = report.origins ?? []
  const contacts = report.contacts ?? []
  const addresses = report.addresses ?? []
  const toolClaims = report.toolClaims ?? []
  const toolDenials = report.toolDenials ?? []
  const toolDisclosure = report.toolDisclosure ?? []
  const toolCounts = report.toolCounts ?? []
  const toolArgs = report.toolArgs ?? []
  const toolRetrieval = report.toolRetrieval ?? []
  const citations = report.citations ?? []
  const quotes = report.quotes ?? []
  const attributions = report.attributions ?? []
  const sourceMismatches = report.sourceMismatches ?? []
  // v1.17.1 contrast: amber-900 over amber-800 in light, amber-300 over amber-400
  // in dark, and no `opacity` anywhere inside. This banner is the one place the
  // app says its own answer is unsupported, and measured over its own amber wash
  // (#fcf7f0, not the bare panel) it held the three thinnest inks in the app:
  // 4.71:1 for the warning, 3.99:1 for the link list at `opacity-90`, and 3.10:1
  // for the "Checked against" footer at `opacity-75` — a critic reading a
  // screenshot of it got 3.06:1. `opacity` composites the ink against whatever
  // happens to be behind it, so the tone chosen is not the tone rendered, and
  // both dimmed pieces were under AA while the suite read them as 4.78:1. The
  // ranks are ink tokens now, each measured over the surface actually beneath
  // it. Pinned in test/chromeContrastCheck.ts.
  return (
    <div
      className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-ink-warn"
      title={
        'These came from the model, not from the tools this turn actually ran ' +
        `(${report.checkedAgainst.join(', ')}). Numbers a calculator did not return, and links ` +
        'that appeared in no search result, are the two things most worth re-checking yourself.'
      }
    >
      {hasUnbacked && <div>⚠️ {unbacked}</div>}
      {/*
        v1.12.1: the reply's account of its own process. First, because a
        reader who believes "I searched the web for this" reads everything
        under it as sourced.
      */}
      {toolClaims.length > 0 && (
        <div className={hasUnbacked ? 'mt-1' : undefined}>
          ⚠️ This reply says it used {toolClaims.join(', ')}, which did not run this turn.
        </div>
      )}
      {/*
        v2.3: the same account in the mirror, and it sits second because it is
        the worse of the two. A reader who doubts "I searched the web for this"
        can look at the tool blocks. A reader told the search never happened has
        been told those blocks mean nothing, and nothing on screen contradicts
        that — so the line has to.
      */}
      {toolDenials.length > 0 && (
        <div className={hasUnbacked || toolClaims.length > 0 ? 'mt-1' : undefined}>
          ⚠️ This reply's account of this turn contradicts what ran:{' '}
          {toolDenials.join('; ')}.
        </div>
      )}
      {/*
        v1.14: the same disclosure read the other way round. A "Tools used"
        section that names documents instead of calls answers the reader's
        question with something that is not a tool, and no name in it is wrong
        — so only the omission gives it away.
      */}
      {toolDisclosure.length > 0 && (
        <div
          className={
            hasUnbacked || toolClaims.length > 0 || toolDenials.length > 0 ? 'mt-1' : undefined
          }
        >
          ⚠️ This reply lists the tools it used without naming{' '}
          {toolDisclosure.join(', ')}, which {toolDisclosure.length === 1 ? 'is' : 'are'} what
          actually ran this turn.
        </div>
      )}
      {/*
        v2.2: the same account read for its arithmetic. Measured, round 9, task
        TH1 — a table giving `reference_lookup` two rows against an audit
        holding one call. Two rows read as two retrievals, so the second row's
        passages read as evidence the first did not have. It sits with the two
        lines above because it is the same claim — what this turn did — and
        under them because a name that is wrong is worse than a number that is.
      */}
      {toolCounts.length > 0 && (
        <div
          className={
            hasUnbacked ||
            toolClaims.length > 0 ||
            toolDenials.length > 0 ||
            toolDisclosure.length > 0
              ? 'mt-1'
              : undefined
          }
        >
          ⚠️ This reply's account of its own tool use claims more calls than the turn made:{' '}
          {toolCounts.join('; ')}.
        </div>
      )}
      {/*
        v1.17: the same account read one rung further down. The tool named is
        the tool that ran and the account is complete — and the argument it
        quotes is not the one the call carried. A reader told the query was
        narrow reads the passages under it as responsive to that query, so this
        sits beside the two lines above rather than under the figures.

        `break-words` because a stated argument can be a URL, which has no space
        to wrap at; the 72-character cap bounds it but does not break it.
      */}
      {toolArgs.length > 0 && (
        <div
          className={
            hasUnbacked ||
            toolClaims.length > 0 ||
            toolDenials.length > 0 ||
            toolDisclosure.length > 0 ||
            toolCounts.length > 0
              ? 'mt-1 break-words'
              : 'break-words'
          }
        >
          ⚠️ This reply states {toolArgs.length === 1 ? 'an argument' : 'arguments'} the{' '}
          {toolArgs.length === 1 ? 'call' : 'calls'} never received: {toolArgs.join('; ')}.
        </div>
      )}
      {/*
        v2.5: the same account one rung further in. `toolArgs` above says what
        the call was sent; this says what it brought back — the pack, the count,
        the relevance figures. It sits directly under that line because the two
        are halves of one sentence, and above the quotation rung because a
        reader who believes the wrong pack was searched mistrusts every passage
        under it. The provenance strip listing the real citations is on screen
        one message up, which is what makes this checkable by eye.
      */}
      {toolRetrieval.length > 0 && (
        <div
          className={
            hasUnbacked ||
            toolClaims.length > 0 ||
            toolDenials.length > 0 ||
            toolDisclosure.length > 0 ||
            toolCounts.length > 0 ||
            toolArgs.length > 0
              ? 'mt-1'
              : undefined
          }
        >
          ⚠️ This reply's account of what the library returned contradicts the passages:{' '}
          {toolRetrieval.join('; ')}.
        </div>
      )}
      {/*
        v1.14: quotation fidelity. The user asked for a verbatim line and the
        app held the passage it came from; a quotation that is not in it is an
        invented source in the notation the reader trusts most.
      */}
      {quotes.length > 0 && (
        <div className="mt-1">
          ⚠️ Quoted as exact but in no tool output this turn:{' '}
          {quotes.map((q) => `“${q}”`).join('; ')}.
          {/*
            v1.17: the excerpt is a window centred on the break, not the first
            72 characters — twice in round 6 the clamp cut the sentence off
            before the words being complained about, which is a warning the
            reader cannot check. The legend rides along only when a marker is
            actually there.
          */}
          {quotes.some(marksABreak) &&
            ` ${QUOTE_BREAK_MARKS.join('')} marks where it stops matching the source.`}
        </div>
      )}
      {attributions.length > 0 && (
        <div className="mt-1">
          ⚠️ {attributions.join('; ')} — that passage came from a different document than the one
          named here.
        </div>
      )}
      {/* v4.1 (G4): the model source check, sentence by sentence (lib/sourceCheck.ts). */}
      {sourceMismatches.length > 0 && (
        <div className="mt-1">⚠️ Checked against this turn's sources: {sourceMismatches.join('; ')}.</div>
      )}
      {/*
        Called out separately from figures and links because it is a different
        kind of wrong: not an unsupported number but a contradicted fact, and
        the one most likely to be repeated out loud to someone else.
      */}
      {origins.length > 0 && (
        <div className={hasUnbacked || toolClaims.length > 0 ? 'mt-1' : undefined}>
          ⚠️ This reply places the subject in {origins.join(', ')}, which the sources it consulted
          never mention.
        </div>
      )}
      {/*
        Listed in full rather than counted: a phone number is checked by
        looking at it, and this is the one item here that a reader may be
        about to put in front of customers.
      */}
      {contacts.length > 0 && (
        <div
          className={
            hasUnbacked || toolClaims.length > 0 || origins.length > 0 ? 'mt-1' : undefined
          }
        >
          ⚠️ Contact details no tool returned: {contacts.join(', ')}. Verify before sending these
          anywhere.
        </div>
      )}
      {/* Listed in full for the same reason as contacts: someone drives there. */}
      {addresses.length > 0 && (
        <div className="mt-1">
          ⚠️ Addresses no tool returned: {addresses.join('; ')}. Check these before travelling.
        </div>
      )}
      {/* Named in full: a marker pointing at a passage that was never
          retrieved is a source the reader cannot open, however plainly it is
          written — and the numbered passages that WERE retrieved are listed
          under this reply, so the mismatch is checkable by eye. */}
      {citations.length > 0 && (
        <div className="mt-1">
          ⚠️ {citations.join(', ')} {citations.length === 1 ? 'cites' : 'cite'} no library passage or
          web source this turn returned — that citation points at nothing.
        </div>
      )}
      {report.links.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {report.links.map((link) => (
            <li key={link} className="break-all">
              {link}
            </li>
          ))}
          {/* v2.4: the sentence above counts every unbacked link and this list
              names the first few, so the list is where the rest have to be
              admitted — the same "and N more" the coverage line has always
              used. Without it, raising the count to the true one would only
              have moved the silent truncation from the sentence to the list. */}
          {unlisted > 0 && <li>and {unlisted} more</li>}
        </ul>
      )}
      {/* The other half of the provenance: not what it was measured against but
          what it never measured. Measured, round 8, task V3 — four repair costs
          named above a headline water figure the two arms disagreed about
          threefold, with nothing on screen to say the volumes had not been
          looked at. */}
      {/* v2.2: the provenance rank is `text-ink-tertiary`, not an amber step.
          This line was written to sit WITH the "Checked against" footer and said
          so in its own comment, but carried warm ink — so once the ink ranks
          became tokens it read as a finding, the one thing it is documented not
          to be. Caught by the rank assertion, not by eye. */}
      {coverage !== '' && <div className="mt-1 text-ink-tertiary">{coverage}</div>}
      {/* v2.2: the same rank again, and the same kind of statement — where the
          checked measurements were found, and on how many lines of the passage
          the same value is stated. Round 9 asked for a check that a figure came
          from the RIGHT row of a cited table; `measurementSources` sets out why
          that cannot be measured here and why this is what can. */}
      {matched !== '' && <div className="mt-1 text-ink-tertiary">{matched}</div>}
      {/* One rank quieter than the warnings above it, and quieter by ink rather
          than by opacity — this is the line that says what the answer was
          measured against, and it was the least legible thing in the app.
          v2.2: the quiet rank is the neutral tertiary token, not a paler amber.
          Two amber steps could only be told apart by lightness, which is the
          axis AA has already spent; a neutral reads as the quieter rank in both
          themes AND leaves the warm ink meaning exactly one thing — warning.
          5.24:1 light / 6.15:1 dark over this banner's own amber wash. */}
      <div className="mt-1 text-ink-tertiary">
        Checked against: {report.checkedAgainst.join(', ')}.
      </div>
    </div>
  )
}
