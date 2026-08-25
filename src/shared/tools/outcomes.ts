/**
 * What a tool call's failure text says happened — and whether anything did.
 *
 * Round 5 split "worked and found nothing" (∅) out of the success glyph,
 * because a lookup that supplied a passage and one that supplied none read the
 * same. The same conflation survived on the other side: ✗ covers a provider
 * that answered with an error, a host that could not be reached, and a call the
 * app itself declined to make. Three different facts about the world under one
 * mark, and only two of them are failures — a decline is a judgement, nothing
 * broke.
 *
 * Measured (TH2, `.h2h-runs/judge-r5/TH2/run-1`): three rows, every one of them
 * `✗ 🔍 web_search`. The first sits over "That query is a sentence about you,
 * not search terms, so it was not sent"; the other two over the fixture's HTTP
 * 500. A blind reader counted three calls onto the network where two went.
 *
 * Measured (TTU3, `.h2h-runs/judge-r5/TTU3/run-1`): seven rows of bare
 * `✗ 🔍 web_search`, and the one word explaining all seven —
 * `net::ERR_UNSAFE_PORT` — legible only after opening a disclosure.
 *
 * So the handler states the reason, and whether it declined, and the tool block
 * reads both back — through these four functions and nothing else. Neither side
 * matches on the other's prose, so the glyph cannot drift from the text that
 * earned it.
 *
 * Pure data and string work: main writes it, the renderer reads it, and the
 * node:test suite loads it outside Electron.
 */

/** The opening words of an error the app produced by declining the call. */
const DECLINED_LEAD = 'Declined —'

/**
 * Splits the fact from the coaching. Before it is what happened, short enough
 * for a collapsed row; after it is instruction for the model, which the reader
 * needs none of. A paragraph break, because that is what it is on the model's
 * side too.
 */
const GUIDANCE_MARK = '\n\n'

/** A collapsed row is a glance. Past this it stops being one. */
const MAX_REASON_CHARS = 72

/** Compose a tool error: what went wrong, then what the model should do next. */
export function toolFailure(reason: string, guidance = ''): string {
  const fact = reason.trim() || 'The call failed.'
  const advice = guidance.trim()
  return advice ? `${fact}${GUIDANCE_MARK}${advice}` : fact
}

/**
 * Compose the error for a call the app declined to make. Nothing was contacted,
 * so there is no provider error to quote and the app has to say why itself —
 * `reason` is that sentence, in one clause, and it is the whole of what the
 * reader gets at a glance.
 */
export function declinedCall(reason: string, guidance = ''): string {
  return toolFailure(`${DECLINED_LEAD} ${reason.trim()}`, guidance)
}

/** Did the app decline this call? Then nothing ran, and nothing broke. */
export function wasDeclined(errorText: string): boolean {
  return errorText.trimStart().startsWith(DECLINED_LEAD)
}

/**
 * The reason a collapsed row carries beside the glyph.
 *
 * Errors this module did not compose still get an answer — first sentence,
 * capped — because the alternative is the row saying nothing at all, which is
 * the state TTU3 measured. The disclosure still holds the whole text.
 */
export function failureReason(errorText: string): string {
  let text = errorText.trim()
  if (wasDeclined(text)) text = text.slice(DECLINED_LEAD.length).trim()
  text = (text.split(GUIDANCE_MARK)[0] ?? '').replace(/\s+/g, ' ').trim()
  const stop = text.search(/[.!?](?:\s|$)/)
  if (stop > 0) text = text.slice(0, stop + 1)
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…` : text
}
