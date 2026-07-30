import {
  chunkTextWithOffsets,
  embedTexts,
  normalizeForChunking,
  toUnitVector,
  unitDot
} from './embeddings'
import {
  Bm25Index,
  jaccard,
  mmrSelect,
  normalizeScores,
  reciprocalRankFusion,
  tokenize
} from './retrieval'

/**
 * Ephemeral research index: fetched web pages, chunked and embedded, held in
 * RAM only.
 *
 * Why it exists. Before v0.7 a fetched page was cut at the first 8,000
 * characters and pasted into the conversation — a blind head-of-document
 * truncation that both missed the relevant part of long pages and exhausted the
 * context window after a handful of sources. Here a page is chunked and ranked
 * against what the caller is actually looking for, so only the relevant
 * passages reach the model. Same egress, far more usable sources per turn.
 *
 * Why RAM only. Scraped web content is not something a privacy-first app
 * should silently accumulate on disk: nothing here is ever written to
 * memory.json, and the whole index dies with the process. It also doubles as a
 * re-read cache — asking a second question about a page already fetched costs
 * zero network requests, which is one fewer contact with that host.
 */

/**
 * An outbound link carried alongside a page. Structurally identical to
 * extract.ts's ExtractedLink, declared here so the index does not depend on the
 * HTML extractor (a PDF has no links, and a future renderer will supply its own).
 */
export interface PageLink {
  url: string
  text: string
  sameSite: boolean
}

export interface Passage {
  text: string
  /** Where the passage sits in the page, 0 (start) to 1 (end). */
  position: number
  /** Fused relevance, normalized 0..1 within this result set. */
  score: number
}

export interface PassageOutcome {
  passages: Passage[]
  totalChunks: number
  /** 'hybrid' = semantic + keyword; 'keyword' = BM25 only (no embedding model). */
  mode: 'hybrid' | 'keyword'
  /** Caveats worth surfacing to the model alongside the passages. */
  notes: string[]
}

interface IndexedChunk {
  id: string
  text: string
  offset: number
  termSet: Set<string>
  terms: string[]
  /** L2-normalized embedding, populated lazily and cached across queries. */
  vector?: Float32Array
}

export interface IndexedPage {
  /** Cache key — the URL as requested, before any redirects. */
  key: string
  /** The URL actually served, after redirects. */
  url: string
  title: string
  /** Normalized full text — kept so a caller can still request the whole page. */
  text: string
  truncated: boolean
  /** What the source was. */
  kind: 'html' | 'text' | 'pdf'
  /** True when a main-content container was identified rather than the whole page. */
  mainContentFound: boolean
  /** Outbound links found on the page. */
  links: PageLink[]
  /** Which path produced the text. */
  source: 'static' | 'rendered'
  /** Characters of visually-hidden text dropped (rendered path only). */
  hiddenTextRemoved: number
  /** Third-party origins the renderer refused to contact. */
  blockedOrigins: string[]
  /** Why rendering was or was not used, when it was considered. */
  renderNote?: string
  chunks: IndexedChunk[]
  bm25: Bm25Index
  /** Embedding model the cached vectors belong to; null until anything is embedded. */
  embeddingModel: string | null
  fetchedAt: number
  lastAccess: number
}

/** Pages held at once; oldest-accessed evicted first. */
const MAX_PAGES = 32
/** Total characters of page text held across the index (~4 MB). */
const MAX_INDEX_CHARS = 4_000_000
/** A cached page older than this is refetched rather than reused. */
const TTL_MS = 30 * 60 * 1000
/**
 * Chunks embedded per page. Beyond this, BM25 selects which chunks are worth
 * the embedding calls (see `selectChunksToEmbed`) — embedding a 2 MB page in
 * full would be hundreds of round-trips to LM Studio for one tool call.
 */
const MAX_EMBED_CHUNKS = 300
/** After an embedding failure, fall back to keyword-only for this long. */
const EMBED_RETRY_COOLDOWN_MS = 60_000
/** Candidate pool handed to MMR, as a multiple of the requested passage count. */
const CANDIDATE_MULTIPLIER = 5
/** MMR relevance/diversity balance — favors relevance, still breaks up near-duplicates. */
const MMR_LAMBDA = 0.72

const pages = new Map<string, IndexedPage>()
let embedFailure: { at: number; message: string } | null = null

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function indexedChars(): number {
  let total = 0
  for (const page of pages.values()) total += page.text.length
  return total
}

/** Drop expired pages, then evict least-recently-used until back inside caps. */
function enforceCaps(): void {
  const now = Date.now()
  for (const [url, page] of pages) {
    if (now - page.fetchedAt > TTL_MS) pages.delete(url)
  }
  while (pages.size > MAX_PAGES || indexedChars() > MAX_INDEX_CHARS) {
    let oldestUrl: string | null = null
    let oldestAccess = Infinity
    for (const [url, page] of pages) {
      if (page.lastAccess < oldestAccess) {
        oldestAccess = page.lastAccess
        oldestUrl = url
      }
    }
    if (!oldestUrl) break
    pages.delete(oldestUrl)
  }
}

/**
 * Cache key for a URL: the fragment is dropped (it never reaches the server, so
 * it cannot change the response) and a trailing slash is normalized away.
 */
export function pageCacheKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    u.hash = ''
    const s = u.toString()
    return s.endsWith('/') && u.pathname === '/' && !u.search ? s.slice(0, -1) : s
  } catch {
    return rawUrl
  }
}

/** A previously fetched page, if it's still fresh. Touches the LRU timestamp. */
export function getIndexedPage(key: string): IndexedPage | null {
  const page = pages.get(key)
  if (!page) return null
  if (Date.now() - page.fetchedAt > TTL_MS) {
    pages.delete(key)
    return null
  }
  page.lastAccess = Date.now()
  return page
}

/** Chunk and store a fetched page, replacing any earlier copy of the same URL. */
export function indexPage(input: {
  key: string
  url: string
  title: string
  text: string
  truncated: boolean
  kind?: 'html' | 'text' | 'pdf'
  mainContentFound?: boolean
  links?: PageLink[]
  source?: 'static' | 'rendered'
  hiddenTextRemoved?: number
  blockedOrigins?: string[]
  renderNote?: string
}): IndexedPage {
  const text = normalizeForChunking(input.text)
  const chunks: IndexedChunk[] = chunkTextWithOffsets(text).map((c) => {
    const terms = tokenize(c.text)
    return { id: uid(), text: c.text, offset: c.offset, terms, termSet: new Set(terms) }
  })

  const page: IndexedPage = {
    key: input.key,
    url: input.url,
    title: input.title,
    text,
    truncated: input.truncated,
    kind: input.kind ?? 'html',
    mainContentFound: input.mainContentFound ?? false,
    links: input.links ?? [],
    source: input.source ?? 'static',
    hiddenTextRemoved: input.hiddenTextRemoved ?? 0,
    blockedOrigins: input.blockedOrigins ?? [],
    renderNote: input.renderNote,
    chunks,
    bm25: new Bm25Index(chunks.map((c) => ({ id: c.id, terms: c.terms }))),
    embeddingModel: null,
    fetchedAt: Date.now(),
    lastAccess: Date.now()
  }
  pages.set(input.key, page)
  enforceCaps()
  return page
}

/**
 * Choose which chunks to embed for this query when a page exceeds
 * MAX_EMBED_CHUNKS. Already-embedded chunks are free, so they always come
 * along. The rest of the budget goes to BM25's best candidates, then to an
 * evenly spaced sample of the document — the sample matters because a chunk
 * that shares no vocabulary with the query is exactly the case embeddings are
 * supposed to catch, and a pure BM25 prefilter would never surface it.
 */
function selectChunksToEmbed(page: IndexedPage, bm25Ranked: string[]): IndexedChunk[] {
  const byId = new Map(page.chunks.map((c) => [c.id, c]))
  const chosen = new Map<string, IndexedChunk>()

  for (const chunk of page.chunks) {
    if (chunk.vector) chosen.set(chunk.id, chunk)
  }
  for (const id of bm25Ranked) {
    if (chosen.size >= MAX_EMBED_CHUNKS) break
    const chunk = byId.get(id)
    if (chunk) chosen.set(id, chunk)
  }
  if (chosen.size < MAX_EMBED_CHUNKS && page.chunks.length > 0) {
    const remaining = MAX_EMBED_CHUNKS - chosen.size
    const stride = Math.max(1, Math.floor(page.chunks.length / remaining))
    for (let i = 0; i < page.chunks.length && chosen.size < MAX_EMBED_CHUNKS; i += stride) {
      chosen.set(page.chunks[i].id, page.chunks[i])
    }
  }
  return [...chosen.values()]
}

/**
 * Embed the query and whichever page chunks still need vectors. Returns null
 * when embeddings are unavailable, which downgrades retrieval to keyword-only
 * rather than failing the tool call.
 */
async function ensureVectors(
  page: IndexedPage,
  query: string,
  bm25Ranked: string[],
  notes: string[]
): Promise<Float32Array | null> {
  if (embedFailure && Date.now() - embedFailure.at < EMBED_RETRY_COOLDOWN_MS) {
    notes.push(`Keyword-only ranking — embeddings unavailable (${embedFailure.message})`)
    return null
  }

  const wanted = selectChunksToEmbed(page, bm25Ranked)
  const missing = wanted.filter((c) => !c.vector)

  try {
    // The query goes first so a single call covers both, and so the model name
    // is known even when every chunk is already cached.
    const { model, vectors } = await embedTexts([query, ...missing.map((c) => c.text)])

    // A different embedding model means a different vector space: cached
    // vectors are meaningless against this query, so they're discarded.
    if (page.embeddingModel && page.embeddingModel !== model) {
      for (const chunk of page.chunks) chunk.vector = undefined
      notes.push(
        `Embedding model changed to "${model}" — cached vectors for this page were rebuilt.`
      )
    }
    page.embeddingModel = model

    const queryVector = toUnitVector(vectors[0])
    for (let i = 0; i < missing.length; i++) {
      missing[i].vector = toUnitVector(vectors[i + 1])
    }
    embedFailure = null

    if (page.chunks.length > MAX_EMBED_CHUNKS) {
      notes.push(
        `Page is large (${page.chunks.length} passages): semantic ranking covered ${wanted.length} of them, keyword ranking covered all.`
      )
    }
    return queryVector
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    embedFailure = { at: Date.now(), message }
    notes.push(`Keyword-only ranking — embeddings unavailable (${message})`)
    return null
  }
}

/**
 * Rank a page's passages against `query` and return the most relevant ones.
 *
 * BM25 and cosine are fused with Reciprocal Rank Fusion, then MMR trims
 * near-duplicates (chunk overlap makes those routine), and the survivors are
 * restored to reading order so the model sees the page's own sequence.
 */
export async function retrievePassages(
  page: IndexedPage,
  query: string,
  topK: number
): Promise<PassageOutcome> {
  const notes: string[] = []
  page.lastAccess = Date.now()

  if (page.chunks.length === 0) {
    return { passages: [], totalChunks: 0, mode: 'keyword', notes }
  }

  const queryTerms = tokenize(query)
  const bm25Scored = page.bm25.search(queryTerms)
  const bm25Ranked = bm25Scored.map((s) => s.id)

  const queryVector = await ensureVectors(page, query, bm25Ranked, notes)
  const mode: 'hybrid' | 'keyword' = queryVector ? 'hybrid' : 'keyword'

  const byId = new Map(page.chunks.map((c) => [c.id, c]))
  let relevance: Map<string, number>

  if (queryVector) {
    const semanticScored = page.chunks
      .filter((c) => c.vector && c.vector.length === queryVector.length)
      .map((c) => ({ id: c.id, score: unitDot(queryVector, c.vector!) }))
      .sort((a, b) => b.score - a.score)

    // RRF fuses by rank, not score — BM25 is unbounded while cosine sits in a
    // narrow band near 1, so raw values are not comparable but ranks are.
    const fused = reciprocalRankFusion([
      bm25Ranked,
      semanticScored.map((s) => s.id)
    ])
    relevance = normalizeScores([...fused].map(([id, score]) => ({ id, score })))
  } else if (bm25Scored.length > 0) {
    relevance = normalizeScores(bm25Scored)
  } else {
    // Nothing matched lexically and there are no vectors — fall back to the
    // head of the document, which is at least the old behavior.
    notes.push('No passage matched the query; showing the start of the page instead.')
    relevance = new Map(page.chunks.slice(0, topK).map((c, i) => [c.id, 1 - i / topK]))
  }

  const candidates = [...relevance]
    .map(([id, score]) => ({ id, relevance: score }))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, Math.max(topK, topK * CANDIDATE_MULTIPLIER))

  const similarity = (a: string, b: string): number => {
    const ca = byId.get(a)
    const cb = byId.get(b)
    if (!ca || !cb) return 0
    if (ca.vector && cb.vector && ca.vector.length === cb.vector.length) {
      return Math.max(0, unitDot(ca.vector, cb.vector))
    }
    return jaccard(ca.termSet, cb.termSet)
  }

  const selected = mmrSelect(candidates, topK, MMR_LAMBDA, similarity)
  const span = Math.max(1, page.text.length)

  const passages = selected
    .map((id) => byId.get(id))
    .filter((c): c is IndexedChunk => Boolean(c))
    // Reading order, not relevance order: a page's own sequence carries meaning
    // (setup before conclusion), and the score is reported per passage anyway.
    .sort((a, b) => a.offset - b.offset)
    .map((c) => ({
      text: c.text,
      position: Math.min(1, c.offset / span),
      score: Math.round((relevance.get(c.id) ?? 0) * 1000) / 1000
    }))

  return { passages, totalChunks: page.chunks.length, mode, notes }
}

/** Settings → Privacy: how much scraped content is currently held in RAM. */
export function researchIndexStats(): {
  pages: number
  chunks: number
  chars: number
  embeddedChunks: number
} {
  let chunks = 0
  let embeddedChunks = 0
  for (const page of pages.values()) {
    chunks += page.chunks.length
    embeddedChunks += page.chunks.filter((c) => c.vector).length
  }
  return { pages: pages.size, chunks, chars: indexedChars(), embeddedChunks }
}

/** Drop every cached page. Exposed so the user can clear it on demand. */
export function clearResearchIndex(): { pages: number } {
  const cleared = pages.size
  pages.clear()
  embedFailure = null
  return { pages: cleared }
}
