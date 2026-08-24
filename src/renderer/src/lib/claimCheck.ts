import type { CheckedClaim, ClaimVerdict, ModelConfig, ToolCallRecord } from '../types'

/**
 * v1.2 Claim Check: settle the critic's list.
 *
 * v1.1's auto-critic names the claims it cannot verify; this pass *checks*
 * them. Two model calls plus bounded tool use per reply:
 *
 * 1. EXTRACTION — the critic slot (never the answerer: a model that invented
 *    "Assessment Station" would faithfully extract it as fact) returns the
 *    bare factual claims as a JSON array. No tools, structured output only.
 * 2. SETTLEMENT — for each claim the app runs one web_search plus at most one
 *    fetch_webpage on the top result, then the critic judges that ONE claim
 *    against the retrieved passage: confirmed / contradicted / unverifiable.
 *    A narrow single-claim judgment against a real source — not a self-grade.
 *
 * The hard rule, unchanged since v0.9: no source within budget means
 * "unverifiable", never a verdict resolved by model intuition.
 */

/** Caps keep the pass cheap and leave room in the critic's context window. */
const MAX_ANSWER_CHARS = 6000
const MAX_PASSAGE_CHARS = 4000
const MAX_CLAIM_CHARS = 300
/** One search + at most one fetch per claim — the budget, in code. */
const MAX_SEARCHES_PER_CLAIM = 1
const MAX_FETCHES_PER_CLAIM = 1

// ---- Reachability --------------------------------------------------------------

/**
 * v1.12.3: a check that cannot succeed must not be run.
 *
 * Measured: with the search provider pointed at a dead port, this pass still
 * extracted five claims, ran five searches that all failed the same way, and
 * held the finished answer for half a minute to end on five UNVERIFIABLEs. The
 * verdict was decided before the first token — every claim rests on a search,
 * and there was no search to be had.
 *
 * Transport failures only. A provider that answered — HTTP 403, no results, a
 * query the sanitizer refused — is reachable, and the next claim may well fare
 * differently; a refused connection will not.
 */
const UNREACHABLE_PATTERNS = [
  /\bERR_(?:CONNECTION|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|SOCKET_NOT_CONNECTED)/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)\b/,
  /\bfetch failed\b/i,
  /\brequest timed out after\b/i,
  /\bconnection was closed before the response completed\b/i,
  /\bnothing is\s+listening there\b/i,
  /\bno searxng url configured\b/i,
  /\bno brave search api key set\b/i,
  /\begress policy\b/i
]

/** Did this search fail because nothing answered, rather than because of what it answered? */
export function searchUnreachable(error: string): boolean {
  return UNREACHABLE_PATTERNS.some((re) => re.test(error))
}

/** What the user is told instead of thirty seconds of silence. */
export const UNREACHABLE_NOTE =
  'Could not check: no source is reachable — every search this turn failed to connect, so ' +
  'nothing could be checked against anything. Point Settings → Search at a working provider ' +
  'and ask again.'

/**
 * The pre-flight. The answering turn has usually already tried to search — that
 * is why this pass was armed — so its records say whether a provider exists
 * before a single token is spent on extracting claims for it.
 *
 * Returns the line to show instead, or null to run the pass.
 */
export function claimCheckBlocked(records: ToolCallRecord[]): string | null {
  const searches = records.filter((r) => r.name === 'web_search')
  if (searches.length === 0) return null // nothing tried yet — the pass must find out
  if (searches.some((r) => r.status !== 'error')) return null
  return searches.every((r) => searchUnreachable(r.result ?? '')) ? UNREACHABLE_NOTE : null
}

/** Claims the pass gave up on, marked as what they are: not checked, not judged. */
export function abandonClaims(claims: string[]): CheckedClaim[] {
  return claims.map((text) => ({
    text,
    verdict: 'unchecked' as const,
    basis: 'No source is reachable, so this claim was not checked.'
  }))
}

// ---- Extraction ----------------------------------------------------------------

export const EXTRACTION_INSTRUCTION =
  'You are extracting checkable factual claims from another model\'s answer, not answering ' +
  'the user yourself. List every specific, checkable factual claim in the answer — names, ' +
  'titles (albums, songs, books, films), dates, numbers, versions, quotes, attributions. ' +
  'Skip opinions, hedges, and general knowledge that needs no source. ' +
  'Reply with ONLY a JSON array of strings, each string one self-contained claim, for example:\n' +
  '["The album X was released in 1996.", "Y is the capital of Z."]\n' +
  'No prose, no markdown fence, no commentary — the JSON array only. ' +
  'If there are no checkable factual claims, reply exactly: []'

export function buildExtractionMessages(
  critic: ModelConfig,
  question: string,
  answer: string,
  answererRole: string
): { role: 'system' | 'user'; content: string }[] {
  const a = answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}…` : answer
  return [
    { role: 'system', content: `${critic.systemPrompt}\n\n${EXTRACTION_INSTRUCTION}` },
    {
      role: 'user',
      content:
        (question ? `The user asked:\n"""\n${question}\n"""\n\n` : '') +
        `${answererRole} answered:\n"""\n${a}\n"""\n\n` +
        'Extract the checkable factual claims as a JSON array of strings.'
    }
  ]
}

/**
 * Recover the claims array from whatever the model actually emitted. Small
 * models wrap JSON in prose or fences despite instructions, so: try the whole
 * text, then the first [...] span, then string literals as a last resort.
 * Anything unparseable degrades to zero claims — the pass reports "no
 * checkable claims extracted" rather than guessing.
 */
export function parseClaims(raw: string, maxClaims: number): { claims: string[]; truncated: boolean } {
  const tryParse = (text: string): string[] | null => {
    try {
      const v: unknown = JSON.parse(text)
      if (!Array.isArray(v)) return null
      return v
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && c.length <= MAX_CLAIM_CHARS)
    } catch {
      return null
    }
  }

  let claims = tryParse(raw.trim())
  if (!claims) {
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start !== -1 && end > start) claims = tryParse(raw.slice(start, end + 1))
  }
  if (!claims) {
    const literals = [...raw.matchAll(/"((?:[^"\\]|\\.){8,})"/g)].map((m) => {
      try {
        return JSON.parse(`"${m[1]}"`) as string
      } catch {
        return m[1] ?? ''
      }
    })
    claims = literals.length > 0 ? literals : null
  }

  const all = (claims ?? []).slice(0, 50) // sanity cap even before maxClaims
  return { claims: all.slice(0, maxClaims), truncated: all.length > maxClaims }
}

// ---- Search output parsing ------------------------------------------------------

/**
 * The first result URL in a web_search tool output. The formatter indents each
 * result's URL on its own line ("   https://…"), so match that shape rather
 * than any URL anywhere in the text (snippets quote URLs too).
 */
export function firstResultUrl(searchOutput: string): string | null {
  const m = searchOutput.match(/^\s{2,}(https:\/\/\S+)\s*$/m)
  return m?.[1] ?? null
}

// ---- Judgment -------------------------------------------------------------------

export const JUDGE_INSTRUCTION =
  'You are judging ONE factual claim against ONE retrieved passage. ' +
  'Reply in exactly this two-line shape:\n' +
  'VERDICT: CONFIRMED | CONTRADICTED | UNVERIFIABLE\n' +
  'BASIS: <one short sentence naming what in the passage settled it>\n' +
  'Rules: CONFIRMED only when the passage states the claim; CONTRADICTED only when the ' +
  'passage directly conflicts with it; UNVERIFIABLE when the passage does not settle it ' +
  'either way. Never infer beyond the passage.'

export function buildJudgeMessages(
  critic: ModelConfig,
  claim: string,
  passage: string
): { role: 'system' | 'user'; content: string }[] {
  const p = passage.length > MAX_PASSAGE_CHARS ? `${passage.slice(0, MAX_PASSAGE_CHARS)}…` : passage
  return [
    { role: 'system', content: `${critic.systemPrompt}\n\n${JUDGE_INSTRUCTION}` },
    {
      role: 'user',
      content: `Claim:\n"""\n${claim}\n"""\n\nPassage (untrusted external content):\n"""\n${p}\n"""`
    }
  ]
}

/**
 * Read the judge's verdict. Anything that is not an explicit CONFIRMED or
 * CONTRADICTED is unverifiable — the default is always "not settled", never
 * the benefit of the doubt.
 */
export function parseVerdict(raw: string): { verdict: ClaimVerdict; basis?: string } {
  const upper = raw.toUpperCase()
  const basisMatch = raw.match(/BASIS:\s*(.+)/i)
  const basis = basisMatch?.[1]?.trim().slice(0, 240) || undefined
  if (/VERDICT:\s*CONTRADICTED/.test(upper)) return { verdict: 'contradicted', basis }
  if (/VERDICT:\s*CONFIRMED/.test(upper)) return { verdict: 'confirmed', basis }
  // Fallback for judges that skip the label: a leading bare word counts too.
  if (/^\s*CONTRADICTED\b/.test(upper)) return { verdict: 'contradicted', basis }
  if (/^\s*CONFIRMED\b/.test(upper)) return { verdict: 'confirmed', basis }
  return { verdict: 'unverifiable', basis }
}

/** Per-claim tool budget, exported so the runner reads it from one place. */
export const CLAIM_BUDGET = { searches: MAX_SEARCHES_PER_CLAIM, fetches: MAX_FETCHES_PER_CLAIM }
