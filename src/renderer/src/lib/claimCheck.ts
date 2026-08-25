import type { CheckedClaim, ClaimVerdict, ModelConfig, ToolCallRecord } from '../types'
import { wasDeclined } from '../../../shared/tools/outcomes'
import { searchUnreachable, type RemedyControl } from '../../../shared/failure'

/**
 * v1.17.2: the reachability rule moved to `shared/failure.ts`, unchanged.
 *
 * It was always half of a boundary — it classifies a transport failure — and
 * the other half (saying so in words a reader can act on) now lives beside it,
 * so the classification and the sentence cannot drift apart. Re-exported here
 * because this module's call sites and tests have read it from this name since
 * v1.12.3.
 */
export { searchUnreachable }

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
 * What the user is told instead of thirty seconds of silence.
 *
 * A critic called this the app's best failure sentence — it names a cause and a
 * remedy — and had one complaint: *the remedy is prose rather than a control*.
 * So the sentence keeps its wording, and `UNREACHABLE_REMEDY` below names the
 * place it points at, which `ClaimCheckBlock` renders as a button. The prose
 * stays because it has to survive an export, a copy-paste and a screenshot,
 * where no button can go.
 */
export const UNREACHABLE_NOTE =
  'Could not check: no source is reachable — every search this turn failed to connect, so ' +
  'nothing could be checked against anything. Point Settings → Search at a working provider ' +
  'and ask again.'

/** The control the note describes. Offered only where the app has PROVEN it. */
export const UNREACHABLE_REMEDY: RemedyControl = { label: 'Settings → Search', tab: 'search' }

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

// ---- Settlement -----------------------------------------------------------------

/** One tool call's outcome, in the shape `window.api.executeTool` returns. */
export interface SettleToolResult {
  ok: boolean
  output?: string
  error?: string
}

/**
 * Everything the settlement loop does to the outside world, injected. Same
 * arrangement as lib/agentLoop.ts: the loop is the decision, the hook supplies
 * the side effects, and node:test can therefore watch the decision being made
 * (test/claimCheck.test.ts) instead of inferring it from a screenshot.
 */
export interface SettleDeps {
  /** One web_search for this claim. */
  search: (claim: string) => Promise<SettleToolResult>
  /** One fetch_webpage on the top result — null when fetching is switched off. */
  fetchPage: ((url: string, claim: string) => Promise<SettleToolResult>) | null
  /** The critic's single-claim judgment against one retrieved passage. */
  judge: (claim: string, passage: string) => Promise<string>
  /** Each claim as it settles, so the panel can fill in while the pass runs. */
  onClaim: (claim: CheckedClaim) => void
  /** Checked between every await; a true reading ends the pass silently. */
  aborted: () => boolean
}

export interface SettleOutcome {
  /** Every claim, in extraction order — settled ones first, abandoned ones after. */
  claims: CheckedClaim[]
  /** Set when the pass stopped before it had checked them all. */
  budgetNote?: string
  /** The turn was cancelled mid-pass: the caller must not paint anything. */
  aborted: boolean
}

/**
 * Settle the extracted claims: one search, at most one fetch, one judgment
 * each — the budget enforced in code rather than asked for in a prompt.
 *
 * The pass stops at the FIRST search that could not reach a provider. Nothing
 * about the next claim is different: the same provider, the same refusal, one
 * more wait bought with the reader's time. What that failure settles is the
 * whole pass, so it is reported as one fact — the check could not run — and
 * the claims it never reached are marked `unchecked`, not `unverifiable`.
 */
export async function settleClaims(claims: string[], deps: SettleDeps): Promise<SettleOutcome> {
  const emitted: CheckedClaim[] = []
  const emit = (claim: CheckedClaim): void => {
    emitted.push(claim)
    deps.onClaim(claim)
  }

  for (const [i, claim] of claims.entries()) {
    if (deps.aborted()) return { claims: emitted, aborted: true }
    const checked: CheckedClaim = { text: claim, verdict: 'unverifiable' }
    const search = await deps.search(claim)
    // One refused connection settles the whole pass: the remaining claims
    // would each buy the same failure at the cost of another wait.
    if (!search.ok && searchUnreachable(search.error ?? '')) {
      for (const abandoned of abandonClaims(claims.slice(i))) emit(abandoned)
      return { claims: emitted, budgetNote: UNREACHABLE_NOTE, aborted: false }
    }
    const url = search.ok && search.output ? firstResultUrl(search.output) : null
    let passage = ''
    if (url && deps.fetchPage) {
      const page = await deps.fetchPage(url, claim)
      if (page.ok && page.output) {
        passage = page.output
        checked.source = url
      }
    }
    if (passage) {
      if (deps.aborted()) return { claims: emitted, aborted: true }
      const judged = await deps.judge(claim, passage)
      if (deps.aborted()) return { claims: emitted, aborted: true }
      const { verdict, basis } = parseVerdict(judged)
      checked.verdict = verdict
      if (basis) checked.basis = basis
    } else if (!search.ok) {
      // Disclosed, never guessed — and which of the two it was, because they
      // are different facts about the claim. Measured (TTU3 run-1): five
      // "Unverifiable — Search was declined or failed." over a turn where
      // nothing was ever declined; all five were net::ERR_UNSAFE_PORT.
      checked.basis = wasDeclined(search.error ?? '')
        ? 'The app declined the search, so nothing was checked.'
        : 'The search failed, so nothing was checked.'
    }
    emit(checked)
  }
  return { claims: emitted, aborted: false }
}

// ---- What the panel says --------------------------------------------------------

/**
 * The claim-check block's one-line header.
 *
 * A claim count in this line reads as a result — "5 claims" says five were put
 * to a source — so it is spent only on claims that reached one. A pass that
 * reached none shows its reason instead of a tally of nothing (measured: "Claim
 * check: 5 claims — 0 confirmed, 0 contradicted" over five claims no search had
 * touched), and a pass that stopped partway says how far it got rather than how
 * many the critic extracted.
 */
export function claimCheckSummary(
  check: { claims: CheckedClaim[]; budgetNote?: string },
  isStreaming: boolean
): string {
  if (check.claims.length === 0) {
    return isStreaming ? 'Extracting claims…' : (check.budgetNote ?? 'Claim check')
  }
  const checked = check.claims.filter((c) => c.verdict !== 'unchecked')
  if (checked.length === 0) return check.budgetNote ?? 'Claim check could not run.'
  const confirmed = checked.filter((c) => c.verdict === 'confirmed').length
  const contradicted = checked.filter((c) => c.verdict === 'contradicted').length
  const scope =
    checked.length === check.claims.length
      ? `${check.claims.length} claim${check.claims.length === 1 ? '' : 's'}`
      : `${checked.length} of ${check.claims.length} claims checked`
  return (
    `Claim check: ${scope}` +
    (isStreaming ? ' (running…)' : ` — ${confirmed} confirmed, ${contradicted} contradicted`)
  )
}

/**
 * The footer under the verdicts, or null when there is nothing true to say.
 *
 * The sentence promises the reader a source to open, so it may not appear over
 * verdicts that name none — measured (TTU3 run-2): five "Unverifiable — Search
 * was declined or failed." verdicts, not a URL among them, and underneath them
 * "Each verdict rests on the one source shown." A mixed pass is the same fault
 * one step down, so the caveat names the verdicts it covers instead of all of
 * them.
 */
export function sourceCaveat(claims: CheckedClaim[]): string | null {
  const sourced = claims.filter((c) => c.source).length
  if (sourced === 0) return null
  const scope =
    sourced === claims.length
      ? 'Each verdict rests on the one source shown.'
      : 'Where a verdict names a source, it rests on that one source alone.'
  return `${scope} A confirmation is only as good as that source — open it before relying on the claim.`
}
