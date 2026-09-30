import { embedTexts, toUnitVector, unitDot } from '../embeddings'
import { Bm25Index, normalizeScores, tokenize } from '../retrieval'
import { isLowProvenance } from '../sourceTiers'
import type { CandidateSource, SubQuestion } from './types'

// ---- search fan-out ----------------------------------------------------------

/**
 * How many searches may be in flight, and how far apart, per provider.
 *
 * A self-hosted SearXNG is the user's own infrastructure and tolerates
 * parallelism. DuckDuckGo's HTML endpoint blocks bursts outright, and Brave's
 * free tier is about one query per second — fanning out naively there turns a
 * research run into a string of failures, so those are serialized and spaced.
 */
export function searchPacing(provider: string): { concurrency: number; spacingMs: number } {
  switch (provider) {
    case 'searxng':
      return { concurrency: 3, spacingMs: 0 }
    case 'brave':
      return { concurrency: 1, spacingMs: 1100 }
    default:
      return { concurrency: 1, spacingMs: 1500 }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Normalize for dedupe: drop the fragment and a trailing slash. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    let s = u.toString()
    if (s.endsWith('/') && u.pathname === '/' && !u.search) s = s.slice(0, -1)
    return s
  } catch {
    return url
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

// ---- source selection -------------------------------------------------------

/** Results kept per domain, so one prolific site cannot fill the whole read list. */
const MAX_PER_DOMAIN = 2

/**
 * Pick which candidates are worth fetching.
 *
 * Ranking happens over snippets *before* anything is fetched, which is a privacy
 * decision as much as an efficiency one: every URL not selected is a host never
 * contacted. The per-domain cap exists because ten pages from one site is a worse
 * evidence base than five pages from five, however well that site ranks.
 *
 * Pure and exported so the selection policy can be tested without a network.
 */
export function selectSources(
  candidates: CandidateSource[],
  relevance: Map<string, number>,
  limit: number
): CandidateSource[] {
  const seen = new Set<string>()
  const perDomain = new Map<string, number>()
  const deduped: CandidateSource[] = []

  const byRelevance = [...candidates].sort(
    (a, b) => (relevance.get(b.url) ?? 0) - (relevance.get(a.url) ?? 0)
  )

  // v1.5: search-bait goes to the back of the queue, not the bin. A page built
  // to rank for the query rather than to answer it is the worst use of a fetch
  // budget — a v1.4 run spent its whole budget on SEO pages about a stock and
  // synthesized a brief from them — but on a thin topic it may be all there is,
  // and reading nothing is worse than reading something labelled. Relevance
  // order is preserved within each group.
  const ranked = [
    ...byRelevance.filter((c) => !isLowProvenance(c.url)),
    ...byRelevance.filter((c) => isLowProvenance(c.url))
  ]

  // First pass honors the per-domain cap.
  for (const candidate of ranked) {
    if (deduped.length >= limit) break
    const key = canonicalUrl(candidate.url)
    if (seen.has(key)) continue
    const host = hostOf(candidate.url)
    if (!host) continue
    const used = perDomain.get(host) ?? 0
    if (used >= MAX_PER_DOMAIN) continue
    seen.add(key)
    perDomain.set(host, used + 1)
    deduped.push(candidate)
  }

  // If the cap left us short of the limit, relax it rather than under-read.
  if (deduped.length < limit) {
    for (const candidate of ranked) {
      if (deduped.length >= limit) break
      const key = canonicalUrl(candidate.url)
      if (seen.has(key)) continue
      if (!hostOf(candidate.url)) continue
      seen.add(key)
      deduped.push(candidate)
    }
  }
  return deduped
}

/**
 * Score candidates against the sub-questions. Embeddings when available, BM25
 * otherwise — the same hybrid-or-degrade policy the passage ranker uses, for the
 * same reason: retrieval must keep working with no embedding model loaded.
 */
export async function scoreCandidates(
  candidates: CandidateSource[],
  subQuestions: SubQuestion[]
): Promise<Map<string, number>> {
  const documents = candidates.map((c) => `${c.title}. ${c.snippet}`)
  if (documents.length === 0) return new Map()

  try {
    const { vectors } = await embedTexts([...subQuestions.map((s) => s.question), ...documents])
    const questionVectors = subQuestions.map((_, i) => toUnitVector(vectors[i]))
    const scored = candidates.map((candidate, i) => {
      const docVector = toUnitVector(vectors[subQuestions.length + i])
      // A candidate is as good as its best match to any sub-question: a source
      // that nails one facet is valuable even if unrelated to the others.
      const best = questionVectors.reduce((max, qv) => Math.max(max, unitDot(qv, docVector)), 0)
      return { id: candidate.url, score: best }
    })
    return normalizeScores(scored)
  } catch {
    const index = new Bm25Index(
      candidates.map((c, i) => ({ id: c.url, terms: tokenize(documents[i]) }))
    )
    const totals = new Map<string, number>()
    for (const sub of subQuestions) {
      for (const hit of index.search(tokenize(sub.question))) {
        totals.set(hit.id, Math.max(totals.get(hit.id) ?? 0, hit.score))
      }
    }
    return normalizeScores([...totals].map(([id, score]) => ({ id, score })))
  }
}
