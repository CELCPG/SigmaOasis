/**
 * Pure ranking primitives for hybrid retrieval. No I/O, no embedding calls —
 * everything here is deterministic and runs in-process.
 *
 * Why hybrid rather than embeddings alone: local embedding models are weak on
 * exact tokens — version numbers, error codes, API names, proper nouns — which
 * is most of what technical research turns on. BM25 nails those and costs
 * nothing, so the two rankings are fused rather than chosen between. BM25 also
 * works with no model loaded at all, which keeps retrieval useful when LM
 * Studio has no embedding model available.
 */

/**
 * Words carrying no retrieval signal. Deliberately short — an aggressive stop
 * list hurts phrase-like queries ("how to" vs "howto") more than it helps.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'this', 'to', 'was', 'were', 'will', 'with'
])

/**
 * Tokenize for keyword matching. Interior dots, dashes, underscores and
 * apostrophes are kept so `node.js`, `1.2.3`, `--no-verify` and `don't` survive
 * as single terms; trailing punctuation is dropped.
 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9](?:[a-z0-9._'+-]*[a-z0-9])?/g) ?? []
  return matches.filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

// ---- BM25 --------------------------------------------------------------------

const BM25_K1 = 1.2
const BM25_B = 0.75

export interface Bm25Document {
  id: string
  terms: string[]
}

/**
 * BM25 over a small in-memory corpus (one document per chunk). Built fresh per
 * page; at a few thousand chunks this is microseconds and not worth persisting.
 */
export class Bm25Index {
  private readonly docs: { id: string; length: number; freqs: Map<string, number> }[] = []
  private readonly docFreq = new Map<string, number>()
  private avgLength = 0

  constructor(documents: Bm25Document[]) {
    for (const doc of documents) {
      const freqs = new Map<string, number>()
      for (const term of doc.terms) freqs.set(term, (freqs.get(term) ?? 0) + 1)
      for (const term of freqs.keys()) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1)
      this.docs.push({ id: doc.id, length: doc.terms.length, freqs })
    }
    const total = this.docs.reduce((n, d) => n + d.length, 0)
    this.avgLength = this.docs.length > 0 ? total / this.docs.length : 0
  }

  /** Scored ids, highest first. Documents matching no query term are omitted. */
  search(queryTerms: string[]): { id: string; score: number }[] {
    if (this.docs.length === 0 || queryTerms.length === 0) return []
    const unique = [...new Set(queryTerms)]
    const scored: { id: string; score: number }[] = []

    for (const doc of this.docs) {
      let score = 0
      for (const term of unique) {
        const freq = doc.freqs.get(term)
        if (!freq) continue
        const n = this.docFreq.get(term) ?? 0
        // Robertson/Sparck-Jones IDF, +1 smoothed so it can never go negative
        // (a term present in every document would otherwise score below zero).
        const idf = Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5))
        const norm = 1 - BM25_B + (BM25_B * doc.length) / (this.avgLength || 1)
        score += idf * ((freq * (BM25_K1 + 1)) / (freq + BM25_K1 * norm))
      }
      if (score > 0) scored.push({ id: doc.id, score })
    }
    return scored.sort((a, b) => b.score - a.score)
  }
}

// ---- Rank fusion -------------------------------------------------------------

/** Standard RRF damping constant — flattens the head so neither list dominates. */
const RRF_K = 60

/**
 * Reciprocal Rank Fusion: combine ranked lists using only rank position, not
 * score. That's the point — BM25 scores are unbounded and cosine scores sit in
 * a narrow band near 1, so their raw values are not comparable, while their
 * rankings are.
 */
export function reciprocalRankFusion(rankedLists: string[][], k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>()
  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return fused
}

/** Min-max scale scores to 0..1 so they're comparable with a similarity metric. */
export function normalizeScores(entries: { id: string; score: number }[]): Map<string, number> {
  const out = new Map<string, number>()
  if (entries.length === 0) return out
  const values = entries.map((e) => e.score)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  for (const e of entries) out.set(e.id, span > 0 ? (e.score - min) / span : 1)
  return out
}

// ---- Diversity ---------------------------------------------------------------

/**
 * Jaccard overlap on token sets — the fallback diversity metric when no
 * embedding model is available.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (large.has(t)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

export interface MmrCandidate {
  id: string
  /** Relevance to the query, normalized to 0..1. */
  relevance: number
}

/**
 * Maximal Marginal Relevance: greedily pick the candidate maximizing
 * `λ·relevance − (1−λ)·maxSimilarityToAlreadyPicked`.
 *
 * Without this, the top-k passages of a page are routinely five overlapping
 * windows of the same paragraph — chunk overlap guarantees near-duplicates.
 * MMR is used instead of a cross-encoder reranker on purpose: a reranker model
 * is a second model load and a per-candidate forward pass, which a local-first
 * app can't assume; this is a few lines over similarities already computed.
 */
export function mmrSelect(
  candidates: MmrCandidate[],
  topK: number,
  lambda: number,
  similarity: (a: string, b: string) => number
): string[] {
  const pool = [...candidates].sort((a, b) => b.relevance - a.relevance)
  const selected: string[] = []

  while (selected.length < topK && pool.length > 0) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (let i = 0; i < pool.length; i++) {
      let maxSim = 0
      for (const chosen of selected) {
        const sim = similarity(pool[i].id, chosen)
        if (sim > maxSim) maxSim = sim
      }
      const score = lambda * pool[i].relevance - (1 - lambda) * maxSim
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }
    selected.push(pool[bestIndex].id)
    pool.splice(bestIndex, 1)
  }
  return selected
}
