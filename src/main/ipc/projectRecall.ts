import { chunkTextWithOffsets, embedTexts, toUnitVector, unitDot } from './embeddings'
import {
  Bm25Index,
  jaccard,
  mmrSelect,
  normalizeScores,
  reciprocalRankFusion,
  tokenize
} from './retrieval'

/**
 * v1.10 project-wide recall: a chat in a project can recall what the project's
 * *other* chats established. Measured in v1.11 (docs/evals.md): 7/8 against a
 * bare arm's 1/8, with retrieval scored separately from the answer — which is
 * how the gate below was found to be admitting everything.
 *
 * The first cut indexed each sibling chat as its own page in the research
 * index and merged the per-page results. That could not rank chats against
 * each other: BM25's IDF was per chat, scores were normalized per page, and
 * the merge fell back to raw keyword strength. This is a project-level index
 * instead — one corpus over every sibling transcript, so a term rare across
 * the project is rare, a cosine score means the same thing whichever chat it
 * came from, and the fusion ranks passages globally.
 *
 * Shape:
 * - Each chat is rendered to a transcript and chunked once per `updatedAt`;
 *   chunks (with terms and, once computed, vectors) are cached per chat.
 * - Per query, a BM25 index is built over the union of the requested chats'
 *   chunks — microseconds at this size — so IDF is shared and the set can
 *   differ per requesting chat without re-chunking anything.
 * - Vectors come from the same loopback embedding model as memory and the
 *   research index, within a per-query budget; already-embedded chunks are
 *   free, so the cost amortizes to the new material.
 * - BM25 and cosine are fused by reciprocal rank across the whole corpus,
 *   then MMR trims near-duplicates.
 * - Admission is separate from ranking, and is what keeps a chat with nothing
 *   to say about the message from contributing anyway: a passage rides on two
 *   selective shared terms, or on a cosine that clears this corpus's own mean
 *   by a margin. Both rules exist because the v1.11 eval caught the first
 *   version admitting every passage for every question — see docs/evals.md.
 *
 * The main process reads the sibling conversations from their JSON files
 * itself — the renderer sends ids, not transcripts. Ephemeral chats are never
 * on disk, so they are never recallable: the no-trace promise holds by
 * construction. RAM only; nothing here is written.
 */

/** The slice of a stored conversation this module reads. Kept structural so the pure parts are testable. */
export interface StoredConversationLike {
  id: string
  title: string
  updatedAt: number
  summary?: { text: string } | null
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    roleName?: string
    marker?: string
  }>
}

export interface ProjectRecallItem {
  conversationId: string
  title: string
  text: string
  /** 0 (start) .. 1 (end) of that chat's transcript. */
  position: number
  /** Fused relevance, normalized 0..1 across the whole project corpus. */
  score: number
}

export interface ProjectRecallOutcome {
  ok: boolean
  items: ProjectRecallItem[]
  /** How many sibling chats were consulted (existed on disk). */
  consulted: number
  /** 'hybrid' = keyword + semantic over the project corpus; 'keyword' = BM25 only. */
  mode?: 'hybrid' | 'keyword'
  error?: string
}

/** Characters of one message kept in the transcript; a pasted wall of text is not what a sibling chat "established". */
const MAX_MESSAGE_CHARS = 4000
/** Transcript ceiling per chat — bounds chunking and embedding work. */
const MAX_TRANSCRIPT_CHARS = 400_000
/** Cached chats, LRU; and total cached transcript characters. */
const MAX_CACHED_CHATS = 200
const MAX_CACHED_CHARS = 8_000_000
/** Chunks embedded per query across the corpus (already-vectored chunks are free and not counted). */
const MAX_EMBED_CHUNKS = 300
/** After an embedding failure, stay keyword-only this long rather than paying a timeout per turn. */
const EMBED_RETRY_COOLDOWN_MS = 60_000
/**
 * Semantic admission. An absolute floor alone does not work, and the v1.11
 * eval shows why: with nomic-embed the *baseline* similarity between a query
 * and arbitrary project text is ~0.54, so the 0.35 floor this started with
 * (borrowed from memory.ts) admitted every passage for every question —
 * including "what is 15% of 200?". Measured over the eval fixtures:
 *
 *   control questions   cosine 0.485-0.584   over corpus mean by 0.023-0.047
 *   recall questions    cosine 0.692-0.851   over corpus mean by 0.095-0.196
 *
 * The absolute numbers are model-dependent; the *margin over this corpus's
 * own mean* is far less so, because it cancels whatever baseline the
 * embedding model sits at. A passage is admitted semantically only when it
 * clears both: the floor as a sanity bound, the margin as the real test.
 */
const COSINE_FLOOR = 0.35
const COSINE_MARGIN = 0.07
/**
 * A query term admits a passage only if it is *selective* in this corpus —
 * present in at most this share of its chunks. "what" and "number" match
 * nearly every transcript, and they were what carried the control questions
 * through the lexical side of the gate. BM25 already scores such terms near
 * zero, but a near-zero score is still a match; this applies the same IDF
 * intuition to admission rather than to weight.
 */
const MAX_TERM_DOC_SHARE = 0.5
/**
 * ...but a share means nothing on a tiny corpus. A two-chunk project makes any
 * term that appears twice look universal, and the first cut of this rule threw
 * out "budget" in a project whose only chat was about the budget. A term is
 * only judged uninformative once there are enough chunks carrying it for the
 * share to be evidence of anything.
 */
const MIN_DF_TO_JUDGE_TERM = 3
/**
 * How many distinct selective terms a passage must share with the question
 * before keyword overlap counts as evidence. One is not enough: "what is 15%
 * of 200?" shares the word "number" with a project about freight, which is a
 * coincidence, not a topic. Two content words agreeing is a claim about what
 * the passage is *about*.
 *
 * Deliberately a rule about evidence rather than a list of words to ignore.
 * The words that leaked here — "number", "terms" — are only uninformative in
 * general English, and a hand-written blocklist of them would be fitted to
 * these fixtures rather than to the problem.
 *
 * A question with exactly one content word ("Which password hash?") is not
 * lost by this: it is admitted by the semantic margin instead, which is the
 * hybrid design covering for the half that cannot see it. Keyword-only runs
 * (no embedding model loaded) do give that case up, and say so via `mode`.
 */
const MIN_SELECTIVE_TERMS = 2
/**
 * Words that carry no topic in *English*, which corpus-relative selectivity
 * structurally cannot detect: rare in this project's transcripts, so they look
 * informative, while saying nothing about what a passage is about. Measured:
 * "what is 15% of 200?" was admitted to a freight project on the pair
 * "what" + "number" — two words that agree about nothing.
 *
 * These are the canonical interrogatives and auxiliaries every standard
 * stopword list carries and the shared tokenizer's minimal list happens to
 * omit; they are not words collected from the eval fixtures. Applied here
 * rather than in tokenize() because tokenize is shared with the research
 * index, the library and attachments, and this is one retrieval path's
 * admission policy, not a change to how the app reads text everywhere.
 * Ranking still sees every term — this governs admission only.
 */
const UNINFORMATIVE_TERMS = new Set([
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'do', 'does', 'did', 'done', 'can', 'could', 'should', 'would', 'shall',
  'may', 'might', 'must', 'have', 'had', 'having', 'been', 'being', 'am',
  'we', 'us', 'our', 'you', 'your', 'they', 'them', 'their', 'my', 'me',
  'again', 'also', 'about', 'above', 'below', 'there', 'here', 'then', 'than',
  'some', 'any', 'anything', 'something', 'thing', 'things', 'one', 'two',
  'please', 'tell', 'give', 'get', 'make', 'just', 'now', 'only', 'very',
  'more', 'most', 'much', 'many', 'other', 'others', 'same', 'each', 'every',
  'if', 'or', 'not', 'no', 'yes', 'so', 'up', 'out', 'over', 'under'
])
const CANDIDATE_MULTIPLIER = 5
const MMR_LAMBDA = 0.72

interface CorpusChunk {
  id: string
  conversationId: string
  text: string
  offset: number
  terms: string[]
  termSet: Set<string>
  vector?: Float32Array
}

interface CachedChat {
  id: string
  title: string
  updatedAt: number
  transcriptLength: number
  chunks: CorpusChunk[]
  lastAccess: number
}

const cache = new Map<string, CachedChat>()
/** The model the cached vectors belong to; a change invalidates every vector. */
let cachedEmbeddingModel: string | null = null
let embedFailure: { at: number; message: string } | null = null
let chunkSeq = 0

function uid(): string {
  chunkSeq += 1
  return `pc${chunkSeq.toString(36)}`
}

/**
 * Render a conversation as the text a sibling chat may recall from. Markers
 * (rollback notices) and reasoning never appear; a compaction summary leads,
 * because it is the distilled form of what the chat covered.
 */
export function conversationTranscript(c: StoredConversationLike): string {
  const parts: string[] = []
  if (c.summary?.text) parts.push(`Summary of earlier discussion:\n${c.summary.text}`)
  for (const m of c.messages) {
    if (m.marker) continue
    const body = (m.content ?? '').trim()
    if (!body) continue
    const who = m.role === 'user' ? 'User' : m.roleName ? `Assistant (${m.roleName})` : 'Assistant'
    parts.push(`${who}: ${body.length > MAX_MESSAGE_CHARS ? `${body.slice(0, MAX_MESSAGE_CHARS)}…` : body}`)
  }
  const text = parts.join('\n\n')
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS) : text
}

function cachedChars(): number {
  let n = 0
  for (const c of cache.values()) n += c.transcriptLength
  return n
}

function evict(): void {
  while (cache.size > MAX_CACHED_CHATS || cachedChars() > MAX_CACHED_CHARS) {
    let oldest: CachedChat | null = null
    for (const c of cache.values()) if (!oldest || c.lastAccess < oldest.lastAccess) oldest = c
    if (!oldest) break
    cache.delete(oldest.id)
  }
}

/**
 * Chunk (or re-chunk) one conversation into the corpus cache. Returns false
 * when there is nothing to index. A chat whose `updatedAt` has not moved keeps
 * its chunks — and their vectors.
 */
export function indexConversation(c: StoredConversationLike): boolean {
  const existing = cache.get(c.id)
  if (existing && existing.updatedAt === c.updatedAt) {
    existing.lastAccess = Date.now()
    return existing.chunks.length > 0
  }
  const text = conversationTranscript(c)
  if (!text.trim()) {
    cache.delete(c.id)
    return false
  }
  const chunks: CorpusChunk[] = chunkTextWithOffsets(text).map((ch) => {
    const terms = tokenize(ch.text)
    return {
      id: uid(),
      conversationId: c.id,
      text: ch.text,
      offset: ch.offset,
      terms,
      termSet: new Set(terms)
    }
  })
  cache.set(c.id, {
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    transcriptLength: text.length,
    chunks,
    lastAccess: Date.now()
  })
  evict()
  return chunks.length > 0
}

/** Whether a conversation is currently in the corpus cache (tests, diagnostics). */
export function isConversationIndexed(id: string): boolean {
  return cache.has(id)
}

/** Test/maintenance hook: forget everything chunked and embedded. */
export function resetProjectRecallCache(): void {
  cache.clear()
  cachedEmbeddingModel = null
  embedFailure = null
}

/**
 * Which chunks to embed for this query when the corpus exceeds the budget:
 * everything already embedded (free), then BM25's best, then an evenly
 * spaced sample — the sample matters because a passage sharing no vocabulary
 * with the query is exactly what embeddings are for.
 */
function selectChunksToEmbed(corpus: CorpusChunk[], bm25Ranked: string[]): CorpusChunk[] {
  const byId = new Map(corpus.map((c) => [c.id, c]))
  const chosen = new Map<string, CorpusChunk>()
  let budget = MAX_EMBED_CHUNKS
  for (const c of corpus) if (c.vector) chosen.set(c.id, c)
  for (const id of bm25Ranked) {
    if (budget <= 0) break
    const c = byId.get(id)
    if (c && !chosen.has(id)) {
      chosen.set(id, c)
      budget -= 1
    }
  }
  if (budget > 0 && corpus.length > 0) {
    const stride = Math.max(1, Math.floor(corpus.length / budget))
    for (let i = 0; i < corpus.length && budget > 0; i += stride) {
      const c = corpus[i]!
      if (!chosen.has(c.id)) {
        chosen.set(c.id, c)
        budget -= 1
      }
    }
  }
  return [...chosen.values()]
}

/** Embed the query and whatever chosen chunks still lack vectors. Null = keyword-only this turn. */
async function ensureVectors(
  corpus: CorpusChunk[],
  query: string,
  bm25Ranked: string[]
): Promise<Float32Array | null> {
  if (embedFailure && Date.now() - embedFailure.at < EMBED_RETRY_COOLDOWN_MS) return null
  const wanted = selectChunksToEmbed(corpus, bm25Ranked)
  const missing = wanted.filter((c) => !c.vector)
  try {
    const { model, vectors } = await embedTexts([query, ...missing.map((c) => c.text)])
    if (cachedEmbeddingModel && cachedEmbeddingModel !== model) {
      // A different model is a different vector space; every cached vector is
      // meaningless against this query. Drop them all; they rebuild on use.
      for (const chat of cache.values()) for (const c of chat.chunks) c.vector = undefined
      // This turn's freshly embedded chunks are valid for the new model.
      for (let i = 0; i < missing.length; i++) missing[i]!.vector = toUnitVector(vectors[i + 1]!)
    } else {
      for (let i = 0; i < missing.length; i++) missing[i]!.vector = toUnitVector(vectors[i + 1]!)
    }
    cachedEmbeddingModel = model
    embedFailure = null
    return toUnitVector(vectors[0]!)
  } catch (err) {
    embedFailure = { at: Date.now(), message: err instanceof Error ? err.message : String(err) }
    return null
  }
}

/**
 * Recall from the given sibling conversations. `load` resolves an id to its
 * stored conversation, or null when it is not on disk (deleted, ephemeral).
 */
export async function recallFromConversations(
  load: (id: string) => Promise<StoredConversationLike | null>,
  ids: string[],
  query: string,
  topK: number
): Promise<ProjectRecallOutcome> {
  const trimmed = query.trim()
  const unique = [...new Set(ids.filter((id) => /^[A-Za-z0-9_-]+$/.test(id)))]
  if (!trimmed || unique.length === 0 || topK <= 0) return { ok: true, items: [], consulted: 0 }

  // 1. Bring every requested chat into the corpus cache.
  const chats: CachedChat[] = []
  let consulted = 0
  for (const id of unique) {
    let convo: StoredConversationLike | null = null
    try {
      convo = await load(id)
    } catch {
      convo = null
    }
    if (!convo) continue
    consulted += 1
    if (!indexConversation(convo)) continue
    const cached = cache.get(id)
    if (cached) chats.push(cached)
  }
  const corpus = chats.flatMap((c) => c.chunks)
  if (corpus.length === 0) return { ok: true, items: [], consulted, mode: 'keyword' }
  const byId = new Map(corpus.map((c) => [c.id, c]))
  const chatById = new Map(chats.map((c) => [c.id, c]))

  // 2. Keyword ranking over the whole project — one IDF for all chats.
  const queryTerms = tokenize(trimmed)
  const bm25 = new Bm25Index(corpus.map((c) => ({ id: c.id, terms: c.terms })))
  const bm25Scored = bm25.search(queryTerms)
  const bm25Ranked = bm25Scored.map((s) => s.id)

  // Admission rests on *selective* terms only (see MAX_TERM_DOC_SHARE):
  // ranking may use every term, but a passage cannot earn its way onto the
  // turn by sharing the word "what" with the question.
  const selectiveTerms = new Set(
    [...new Set(queryTerms)].filter((term) => {
      if (UNINFORMATIVE_TERMS.has(term)) return false
      let n = 0
      for (const c of corpus) if (c.termSet.has(term)) n += 1
      if (n === 0) return false
      const uninformative = n / corpus.length > MAX_TERM_DOC_SHARE && n >= MIN_DF_TO_JUDGE_TERM
      return !uninformative
    })
  )
  const lexical = new Set(
    corpus
      .filter((c) => {
        let matched = 0
        for (const t of selectiveTerms) if (c.termSet.has(t)) matched += 1
        return matched >= MIN_SELECTIVE_TERMS
      })
      .map((c) => c.id)
  )

  // 3. Semantic ranking, when the embedding model is reachable.
  const queryVector = await ensureVectors(corpus, trimmed, bm25Ranked)
  const mode: 'hybrid' | 'keyword' = queryVector ? 'hybrid' : 'keyword'

  // 4. Gate, then fuse. The gate is what keeps an unrelated chat quiet: a
  // passage rides on a shared term, or on a cosine the embedding model would
  // call "about this" — never merely on being the best of a bad page.
  let relevance: Map<string, number>
  if (queryVector) {
    const cosine = new Map<string, number>()
    for (const c of corpus) {
      if (c.vector && c.vector.length === queryVector.length) cosine.set(c.id, unitDot(queryVector, c.vector))
    }
    const scores = [...cosine.values()]
    const corpusMean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    const semanticFloor = Math.max(COSINE_FLOOR, corpusMean + COSINE_MARGIN)
    const semanticRanked = [...cosine.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
    const fused = reciprocalRankFusion([bm25Ranked, semanticRanked])
    const gated = [...fused]
      .filter(([id]) => lexical.has(id) || (cosine.get(id) ?? 0) >= semanticFloor)
      .map(([id, score]) => ({ id, score }))
    relevance = normalizeScores(gated)
  } else {
    // Keyword-only: the same selectivity rule decides admission.
    relevance = normalizeScores(bm25Scored.filter((sc) => lexical.has(sc.id)))
  }
  if (relevance.size === 0) return { ok: true, items: [], consulted, mode }

  // 5. Diversity: MMR over the top candidates, so four passages are not four
  // overlapping windows on the same exchange.
  const candidates = [...relevance]
    .map(([id, score]) => ({ id, relevance: score }))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, Math.max(topK, topK * CANDIDATE_MULTIPLIER))
  const similarity = (a: string, b: string): number => {
    const ca = byId.get(a)
    const cb = byId.get(b)
    if (!ca || !cb) return 0
    if (ca.vector && cb.vector && ca.vector.length === cb.vector.length) return Math.max(0, unitDot(ca.vector, cb.vector))
    return jaccard(ca.termSet, cb.termSet)
  }
  const selected = mmrSelect(candidates, topK, MMR_LAMBDA, similarity)

  // 6. Group by chat (best chat first), reading order within a chat, so a run
  // of passages from one conversation still reads the way it happened.
  const items = selected
    .map((id) => byId.get(id))
    .filter((c): c is CorpusChunk => Boolean(c))
    .map((c) => {
      const chat = chatById.get(c.conversationId)!
      return {
        conversationId: c.conversationId,
        title: chat.title,
        text: c.text,
        position: Math.min(1, c.offset / Math.max(1, chat.transcriptLength)),
        score: Math.round((relevance.get(c.id) ?? 0) * 1000) / 1000
      }
    })
  const chatBest = new Map<string, number>()
  for (const it of items) chatBest.set(it.conversationId, Math.max(chatBest.get(it.conversationId) ?? 0, it.score))
  items.sort(
    (a, b) =>
      (chatBest.get(b.conversationId) ?? 0) - (chatBest.get(a.conversationId) ?? 0) ||
      a.conversationId.localeCompare(b.conversationId) ||
      a.position - b.position
  )
  return { ok: true, items, consulted, mode }
}

/** The block the model sees. Chat titles are the citations. */
export function formatProjectRecall(items: ProjectRecallItem[]): string {
  return items
    .map((i) => `--- from the chat "${i.title}" · relevance ${i.score} ---\n${i.text}`)
    .join('\n\n')
}
