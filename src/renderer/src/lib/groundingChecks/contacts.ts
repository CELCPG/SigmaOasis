// Split out of lib/toolGrounding.ts (v2.4): the "contacts" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.



// ---- contact details ----------------------------------------------------------

/**
 * Phone numbers, including vanity spellings, and email addresses.
 *
 * The measured case: member-facing email copy closing with "call Member
 * Services at 1-800-SAM'S-CUB". That number is not Sam's Club's, is not a
 * number at all, and appeared in no tool result — it was assembled from the
 * shape of the brand name. A wrong price is embarrassing; a wrong phone number
 * in a mailshot sends real people somewhere real.
 */
// Case-sensitive, and the groups after the area code are joined by punctuation
// rather than a space, because both relaxations turn ordinary prose into a
// phone number: with neither, "$5,000 down you stay under $400" matched as
// "000 down you". Lowercase vanity numbers exist and are not worth the noise.
const PHONE =
  /(?:\+?\d{1,2}[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]?[A-Z0-9']{2,5}[-.][A-Z0-9']{3,5}\b/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

/** Comparison form: letters and digits only, so punctuation cannot hide a match. */
function normalizeContact(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/**
 * What a phone number is never chained to: another word, another digit group,
 * or the hyphen joining them. Deliberately not `'`, `_`, `*` or a quote — a
 * real number gets wrapped in those ("**1-800-555-0134**", `'212-308-6922'`)
 * and losing a true positive to markdown would be the worse trade.
 */
const CHAINED_TO_CONTACT = /[A-Za-z0-9-]/

/**
 * v1.16. The match is a slice of a longer unbroken token, not a number of its
 * own.
 *
 * Measured, task VC1: the user pasted a 220-character base64 probe out of a
 * server log and asked what it was. The reply decoded it — correctly — and the
 * decoded tail, "…-the-chat-column-0001-0002-0003-0004-…-0013", handed this
 * scanner four phone numbers: 0001-0002-0003, 0004-0005-0006, 0007-0008-0009,
 * 0010-0011-0012, under a badge telling the reader to verify them before
 * sending them anywhere. There were no contact details in that turn at all.
 * Round 4 recorded the lesson for the quote checker and it holds here: findings
 * against honest answers teach the reader to dismiss the badge.
 *
 * A dialable number is its own word. The trailing `\b` in PHONE already stops a
 * match that ends inside one; this is the other end and the other direction —
 * a match that STARTED mid-token, or whose digit chain runs on past it.
 */
function chainedInsideToken(text: string, start: number, end: number): boolean {
  if (start > 0 && CHAINED_TO_CONTACT.test(text[start - 1])) return true
  return /^-[A-Za-z0-9]/.test(text.slice(end, end + 2))
}

/**
 * Contact details the reply states that appear in no tool output and in
 * nothing the user said.
 *
 * Unlike links this is not gated on a source tool having run. A link with no
 * search behind it is often just the model recalling a homepage, but a support
 * line quoted to a customer is a specific, dialable claim, and there is no
 * version of inventing one that is acceptable.
 *
 * The corpus keeps the wider recognizer on purpose: `chainedInsideToken`
 * narrows what the ANSWER may be accused of, and a `known` set that admits more
 * shapes can only ever suppress a finding, never create one.
 */
export function unsourcedContacts(answer: string, corpus: string): string[] {
  const known = new Set(
    [...(corpus.match(PHONE) ?? []), ...(corpus.match(EMAIL) ?? [])].map(normalizeContact)
  )
  const phones: string[] = []
  for (const m of answer.matchAll(PHONE)) {
    const at = m.index ?? 0
    if (chainedInsideToken(answer, at, at + m[0].length)) continue
    phones.push(m[0])
  }
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const raw of [...phones, ...(answer.match(EMAIL) ?? [])]) {
    const key = normalizeContact(raw)
    // A bare year range or "2026-2027" is not a phone number; require enough
    // characters that the match is a real contact rather than punctuation.
    if (key.length < 10) continue
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    flagged.push(raw.trim())
  }
  return flagged
}
