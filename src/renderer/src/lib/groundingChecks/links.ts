// Split out of lib/toolGrounding.ts (v2.4): the "links" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.



// ---- links -------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g

/**
 * Trailing punctuation from prose is not part of the URL.
 *
 * v4.0.1: nor is the markdown around it, nor the spelling of a byte. Measured:
 * a reply wrote `https://finance.yahoo.com/quote/ES=F/**` — a real result,
 * closing a bold span — and the search had returned it as `/quote/ES%3DF/`.
 * Both differences are the writer's, neither names another page, and the
 * reply was flagged for a link it had copied. An escape that does not decode
 * is left as written, so a malformed URL still only matches itself.
 */
function normalizeUrl(url: string): string {
  const bare = url.replace(/[.,;:!?*_`~]+$/, '').replace(/\/+$/, '').replace(/[.,;:!?*_`~]+$/, '')
  return bare
    .replace(/(?:%[0-9a-f]{2})+/gi, (escaped) => {
      try {
        return decodeURIComponent(escaped)
      } catch {
        return escaped
      }
    })
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Links in `answer` that appear in no tool output.
 *
 * Exact match after normalization, on purpose: a model that takes a real
 * collection URL and appends a plausible-looking path has invented a page, and
 * treating "same origin" as good enough would let exactly that through.
 */
export function unsourcedLinks(answer: string, corpus: string, retrievalRan = false): string[] {
  const known = new Set((corpus.match(URL_PATTERN) ?? []).map(normalizeUrl))
  // An empty corpus normally means nothing was retrieved, so nothing is being
  // contradicted. `retrievalRan` says the opposite happened: retrieval was
  // attempted and came back with nothing, which is precisely when every URL in
  // the reply was written from memory. See checkToolGrounding.
  if (known.size === 0 && !corpus.trim() && !retrievalRan) return []
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const raw of answer.match(URL_PATTERN) ?? []) {
    const url = normalizeUrl(raw)
    if (known.has(url) || seen.has(url)) continue
    seen.add(url)
    flagged.push(url)
  }
  return flagged
}
