import { basename } from 'path'
import { embedTexts, normalizeForChunking, toUnitVector, unitDot } from '../embeddings'
import { Bm25Index, jaccard, mmrSelect, normalizeScores, reciprocalRankFusion, tokenize } from '../retrieval'
import { contentNamespace } from '../zim'
import { chunkDocumentSections, ensureLoaded, headingsOf, sectionAt } from './loading'
import { bm25, packs } from './state'
import { MAX_LOOKUP_PASSAGES } from './types'
import { RERANK_POOL, assistSettings, rerankPassages, stakesDomain } from './modelAssist'
import type { RerankCandidate } from './modelAssist'
import { hypotheticalAnswer } from './hyde'
import type { LibChunk, LibraryPassage, LoadedDoc, LoadedPack, LookupOutcome } from './types'

// v4.2 (L1): retrieval — the ZIM leg, keyword + semantic ranking fused by
// reciprocal rank, the relevance floor, MMR and one-passage-per-section
// selection — split out of library.ts unchanged.

/** Candidate pool for MMR, as a multiple of the requested count. */
const CANDIDATE_MULTIPLIER = 5
const MMR_LAMBDA = 0.72
/**
 * Words too common to signal that a passage is *about* the question. Extends
 * the tokenizer's stopwords, which are tuned for indexing rather than for
 * judging relevance.
 */
const WEAK_TERMS = new Set([
  'do', 'does', 'did', 'get', 'got', 'give', 'gave', 'take', 'took', 'make', 'made', 'use', 'used',
  'using', 'want', 'need', 'know', 'like', 'just', 'also', 'how', 'much', 'many', 'what', 'when',
  'where', 'which', 'who', 'why', 'can', 'could', 'should', 'would', 'may', 'might', 'one', 'ones',
  'way', 'ways', 'thing', 'things', 'please', 'tell', 'say', 'said', 'see', 'look', 'find', 'help',
  'work', 'works', 'working', 'answer', 'question', 'about', 'into', 'over', 'under', 'than', 'then',
  'them', 'they', 'their', 'there', 'here', 'your', 'you', 'our', 'its', 'not', 'any', 'all', 'some',
  'more', 'most', 'very', 'really', 'still', 'even', 'ever', 'yes', 'yeah', 'okay', 'right', 'good',
  'best', 'better', 'new', 'first', 'last', 'next', 'time', 'times', 'day', 'days', 'now', 'today',
  'people', 'person', 'someone', 'something', 'anything', 'everything', 'nothing'
])
/** Distinct strong query terms a passage must share to count as a match (see lookupLibrary). */
const MIN_TERM_OVERLAP = 2
/** Cosine at which a semantic-only match is trusted without term overlap. */
const MIN_COSINE = 0.55
/** v4.2 (L2): passages a re-ranked lookup returns at least, when topK allows. */
const RERANK_MIN_KEEP = 3

/** How many articles one ZIM contributes to a lookup, and how many title prefixes are tried. */
const ZIM_MAX_ARTICLES = 16
const ZIM_TITLE_HITS = 6
const ZIM_MAX_ARTICLE_CHARS = 120_000

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/**
 * v2.8: the ZIM leg of a lookup. The file's own title index is searched for
 * the query's content words (each as a prefix, capitalised and not) and for
 * the whole query; the articles found are opened, stripped, chunked by
 * section and ranked by a BM25 built over just them. Their chunks join the
 * lookup as any pack's would; the opened articles become the pack's `docs`
 * for this lookup so citations and sections resolve. Nothing beyond the few
 * articles opened is read from the file.
 */
async function zimCandidates(query: string, zimPacks: LoadedPack[], notes: string[]): Promise<{ chunks: LibChunk[]; ranked: string[] }> {
  if (zimPacks.length === 0) return { chunks: [], ranked: [] }
  const terms = tokenize(query)
  const words = [...new Set(terms.filter((t) => t.length >= 3 && !WEAK_TERMS.has(t)))]
  const prefixes = [...new Set([capitalize(query.trim()), ...words.map(capitalize), ...words])].filter(Boolean)
  const chunks: LibChunk[] = []
  const docsForBm25: { id: string; terms: string[] }[] = []
  for (const pack of zimPacks) {
    const zim = pack.zim!
    const ns = contentNamespace(zim.header)
    const opened = new Map<string, LoadedDoc>()
    const seen = new Set<number>()
    try {
      for (const prefix of prefixes) {
        if (opened.size >= ZIM_MAX_ARTICLES) break
        for (const hit of await zim.searchTitles(prefix, ns, ZIM_TITLE_HITS)) {
          if (opened.size >= ZIM_MAX_ARTICLES) break
          const entry = await zim.resolve(hit)
          if (seen.has(entry.index) || !(entry.mimetype ?? '').startsWith('text/')) continue
          seen.add(entry.index)
          const { title, text: raw } = await zim.articleText(entry)
          const text = normalizeForChunking(raw).slice(0, ZIM_MAX_ARTICLE_CHARS)
          if (!text.trim()) continue
          const docId = entry.url
          const doc: LoadedDoc = {
            meta: { id: docId, title, source: `${basename(pack.manifest.zimPath ?? '')}#${entry.url}`, file: '', chars: text.length },
            text,
            headings: headingsOf(text),
            chunks: []
          }
          doc.chunks = chunkDocumentSections(text, doc.headings).map((c, n) => {
            const t = tokenize(c.text)
            return { id: `${pack.manifest.id}/${docId}#${n}`, packId: pack.manifest.id, docId, n, text: c.text, offset: c.offset, terms: t, termSet: new Set(t) }
          })
          opened.set(docId, doc)
          chunks.push(...doc.chunks)
          docsForBm25.push(...doc.chunks.map((c) => ({ id: c.id, terms: c.terms })))
        }
      }
    } catch (err) {
      notes.push(`The ZIM "${pack.manifest.name}" could not be read (${err instanceof Error ? err.message : String(err)}).`)
    }
    pack.docs = opened
  }
  if (chunks.length === 0) return { chunks: [], ranked: [] }
  const ranked = new Bm25Index(docsForBm25).search(terms).map((s) => s.id)
  return { chunks, ranked }
}

/**
 * Retrieve the passages across the library (or one pack) most relevant to
 * `query`. Never throws for retrieval reasons; a missing pack or an unavailable
 * embedding model degrades to `ok: true` with fewer results and a note.
 */
export async function lookupLibrary(input: {
  query: string
  packId?: string | null
  topK?: number
  /**
   * v4.2 (L2): the model the user is talking to — the one the re-rank asks.
   * Absent, the first chat model LM Studio lists is used.
   */
  modelId?: string
}): Promise<LookupOutcome> {
  const notes: string[] = []
  const query = input.query.trim()
  const topK = Math.min(MAX_LOOKUP_PASSAGES, Math.max(1, Math.round(input.topK ?? 6)))
  if (!query) return { ok: false, passages: [], mode: 'keyword', notes, error: 'A query is required.' }

  const packId = input.packId?.trim() || null
  await ensureLoaded(packId, notes)
  if (packId && !packs.has(packId)) {
    return { ok: false, passages: [], mode: 'keyword', notes, error: `No pack "${packId}" is installed.` }
  }
  const scope = packId ? [packs.get(packId)!] : [...packs.values()]
  // v2.8: ZIM packs contribute the articles their title index finds for this
  // query, opened and chunked now, ranked by a BM25 of their own.
  const zimHits = await zimCandidates(query, scope.filter((p) => p.zim), notes)
  const allChunks = [...scope.flatMap((p) => p.chunks), ...zimHits.chunks]
  if (allChunks.length === 0) {
    return { ok: true, passages: [], mode: 'keyword', notes: [...notes, 'The reference library is empty.'] }
  }
  const byId = new Map(allChunks.map((c) => [c.id, c]))

  const bm25Ranked = bm25()
    .search(tokenize(query))
    .map((s) => s.id)
    .filter((id) => byId.has(id))
  const keywordFused = zimHits.ranked.length > 0 ? reciprocalRankFusion([bm25Ranked, zimHits.ranked]) : null
  const keywordRanked = keywordFused ? [...keywordFused].sort((a, b) => b[1] - a[1]).map(([id]) => id) : bm25Ranked

  // Semantic leg: only if some chunk in scope has a vector for the current model.
  let queryVector: Float32Array | null = null
  const withVectors = allChunks.filter((c) => c.vector)
  if (withVectors.length > 0) {
    try {
      const { vectors } = await embedTexts([query])
      queryVector = toUnitVector(vectors[0])
      if (queryVector.length !== withVectors[0].vector!.length) {
        queryVector = null
        notes.push('Stored vectors do not match the current embedding model — keyword-only ranking. Re-embed the library under Settings → Library.')
      } else {
        // v2.8: the sections a ZIM lookup opened are embedded now — semantic
        // only over what was opened, never over the file.
        if (zimHits.chunks.length > 0) {
          try {
            const { vectors: zv } = await embedTexts(zimHits.chunks.map((c) => c.text))
            zimHits.chunks.forEach((c, i) => {
              const v = zv[i]
              if (v && v.length === queryVector!.length) {
                c.vector = toUnitVector(v)
                withVectors.push(c)
              }
            })
          } catch {
            notes.push('The ZIM passages were ranked by keyword only (their embedding failed).')
          }
        }
        if (withVectors.length < allChunks.length) {
          notes.push(`Semantic ranking covered ${withVectors.length} of ${allChunks.length} passages (the rest are not embedded yet); keyword ranking covered all.`)
        }
      }
    } catch (err) {
      notes.push(`Keyword-only ranking — embeddings unavailable (${err instanceof Error ? err.message : String(err)}).`)
    }
  }

  // v4.2 (L3): in the high-stakes domains, when the user turned it on, the
  // semantic leg ranks by the question averaged with a hypothetical answer
  // the model wrote (hyde.ts) — the answer's words reach the passage the
  // question's miss. Only the ranking vector changes: BM25 and the relevance
  // floor still read the question alone, and the answer text goes nowhere
  // but the loopback embedder.
  const ledgerOnly = packId !== null && packs.get(packId)?.manifest.kind === 'app'
  const assist = ledgerOnly || !stakesDomain(query) ? { rerank: false, hyde: false } : assistSettings()
  let expanded = false
  let rankVector = queryVector
  if (queryVector && assist.hyde) {
    const hypothesis = await hypotheticalAnswer(query, input.modelId)
    if (hypothesis) {
      try {
        const { vectors } = await embedTexts([hypothesis])
        const hv = toUnitVector(vectors[0])
        if (hv.length === queryVector.length) {
          const sum = new Float32Array(hv.length)
          for (let i = 0; i < hv.length; i++) sum[i] = queryVector[i] + hv[i]
          rankVector = toUnitVector(Array.from(sum))
          expanded = true
        }
      } catch {
        // The question's own vector stands.
      }
    }
  }

  let relevance: Map<string, number>
  if (queryVector) {
    const qv = rankVector!
    const semanticRanked = withVectors
      .map((c) => ({ id: c.id, score: unitDot(qv, c.vector!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(50, topK * CANDIDATE_MULTIPLIER * 2))
      .map((s) => s.id)
    const fused = reciprocalRankFusion([keywordRanked, semanticRanked])
    relevance = normalizeScores([...fused].map(([id, score]) => ({ id, score })))
  } else if (keywordRanked.length > 0) {
    relevance = keywordFused
      ? normalizeScores([...keywordFused].map(([id, score]) => ({ id, score })))
      : normalizeScores(bm25().search(tokenize(query)).filter((s) => byId.has(s.id)))
  } else {
    return { ok: true, passages: [], mode: 'keyword', notes: [...notes, 'No passage matched the query.'] }
  }

  // Relevance floor. Scores are normalized within the result set, so a lone
  // weak hit reads as 1.00 — and a first-aid passage answered a tax question
  // that way in testing. Keyword-only: a passage must share at least
  // MIN_TERM_OVERLAP distinct query terms (or all of them for a short query).
  // Hybrid: the same, unless its cosine alone clears MIN_COSINE.
  // Only *strong* query terms count toward the floor: "do" and "give" both
  // survive the tokenizer's stopwords and were exactly the two shared with an
  // unrelated passage in testing.
  const queryTerms = new Set(tokenize(query).filter((t) => t.length >= 3 && !WEAK_TERMS.has(t)))
  const needed = Math.min(MIN_TERM_OVERLAP, queryTerms.size)
  const overlapOf = (c: LibChunk): number => {
    let n = 0
    for (const t of queryTerms) if (c.termSet.has(t)) n += 1
    return n
  }
  const passesFloor = (id: string): boolean => {
    const c = byId.get(id)
    if (!c) return false
    if (overlapOf(c) >= needed) return true
    return Boolean(queryVector && c.vector && unitDot(queryVector, c.vector) >= MIN_COSINE)
  }

  let candidates = [...relevance]
    .filter(([id]) => passesFloor(id))
    .map(([id, score]) => ({ id, relevance: score }))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, topK * CANDIDATE_MULTIPLIER)
  if (candidates.length === 0) {
    return { ok: true, passages: [], mode: queryVector ? 'hybrid' : 'keyword', notes: [...notes, 'No passage matched the query closely enough.'] }
  }

  const sectionKeyOf = (id: string): string => {
    const c = byId.get(id)!
    const doc = packs.get(c.packId)!.docs.get(c.docId)!
    return `${c.packId}/${c.docId}#${sectionAt(doc, c.offset, c.offset + c.text.length)}`
  }

  // v4.2 (L2): in the high-stakes domains, and only when the user turned it
  // on, the answering model reads the top candidates — one per section, the
  // way the lookup will return them — and says which answer the question.
  // Its picks lead in its order and the rest are dropped, topped up from the
  // fused order to RERANK_MIN_KEEP so a model that under-picks cannot leave
  // the answer with one passage. Relevance becomes rank-derived (1.0 down to
  // 0.5) so MMR and the final sort keep the model's order. The app's own
  // ledger pack is never re-ranked: its lookups are internal, not a reply's.
  let rerank: LookupOutcome['rerank']
  if (assist.rerank) {
    const seen = new Set<string>()
    const pool: RerankCandidate[] = []
    for (const { id } of candidates) {
      if (pool.length >= RERANK_POOL) break
      const key = sectionKeyOf(id)
      if (seen.has(key)) continue
      seen.add(key)
      const c = byId.get(id)!
      const doc = packs.get(c.packId)!.docs.get(c.docId)!
      const section = sectionAt(doc, c.offset, c.offset + c.text.length)
      pool.push({ id, label: section ? `${doc.meta.title} › ${section}` : doc.meta.title, text: c.text })
    }
    const picks = pool.length >= 2 ? await rerankPassages(query, pool, input.modelId) : null
    if (picks) {
      const ordered = [...picks]
      for (const { id } of pool) {
        if (ordered.length >= Math.min(RERANK_MIN_KEEP, topK)) break
        if (!ordered.includes(id)) ordered.push(id)
      }
      candidates = ordered.map((id, i) => ({ id, relevance: 1 - (0.5 * i) / Math.max(1, ordered.length - 1) }))
      relevance = new Map(candidates.map((c) => [c.id, c.relevance]))
      rerank = 'applied'
    } else if (pool.length >= 2) {
      rerank = 'fallback'
    }
  }

  const similarity = (a: string, b: string): number => {
    const ca = byId.get(a)
    const cb = byId.get(b)
    if (!ca || !cb) return 0
    if (ca.vector && cb.vector && ca.vector.length === cb.vector.length) return Math.max(0, unitDot(ca.vector, cb.vector))
    return jaccard(ca.termSet, cb.termSet)
  }
  const preliminary = mmrSelect(candidates, topK, MMR_LAMBDA, similarity)

  // v1.7: at most one passage per (document, section). Section-aware chunking
  // makes adjacent chunks of one section near-twins, and MMR's pairwise
  // similarity lets a highly relevant section place two of them — which
  // crowded "Call 999 if" out of a poisoning lookup in the eval. A reader
  // wants the five most relevant *sections*, so extra same-section picks are
  // swapped for the best remaining candidates from unseen sections; if the
  // corpus genuinely has too few sections, the extras return.
  const seenSections = new Set<string>()
  const selected: string[] = []
  const displaced: string[] = []
  for (const id of preliminary) {
    const key = sectionKeyOf(id)
    if (seenSections.has(key)) displaced.push(id)
    else {
      seenSections.add(key)
      selected.push(id)
    }
  }
  for (const { id } of candidates) {
    if (selected.length >= topK) break
    if (preliminary.includes(id)) continue
    const key = sectionKeyOf(id)
    if (seenSections.has(key)) continue
    seenSections.add(key)
    selected.push(id)
  }
  for (const id of displaced) {
    if (selected.length >= topK) break
    selected.push(id)
  }

  const passages: LibraryPassage[] = selected
    .map((id) => byId.get(id))
    .filter((c): c is LibChunk => Boolean(c))
    .map((c) => {
      const pack = packs.get(c.packId)!
      const doc = pack.docs.get(c.docId)!
      return {
        packId: c.packId,
        packName: pack.manifest.name,
        docId: c.docId,
        docTitle: doc.meta.title,
        section: sectionAt(doc, c.offset, c.offset + c.text.length),
        position: Math.min(1, c.offset / Math.max(1, doc.text.length)),
        text: c.text,
        score: Math.round((relevance.get(c.id) ?? 0) * 1000) / 1000,
        source: doc.meta.source,
        license: doc.meta.license,
        date: doc.meta.date,
        ...(doc.meta.appliesToYear !== undefined ? { appliesToYear: doc.meta.appliesToYear } : {}),
        ...(typeof doc.meta.checkedAt === 'number' ? { checkedAt: doc.meta.checkedAt } : {}),
        ...(doc.meta.expiresAt !== undefined ? { expiresAt: doc.meta.expiresAt } : {})
      }
    })
    // Relevance order across documents; the citation carries position, so
    // reading order is recoverable per document by the reader.
    .sort((a, b) => b.score - a.score)

  return { ok: true, passages, mode: queryVector ? 'hybrid' : 'keyword', notes, ...(rerank ? { rerank } : {}), ...(expanded ? { expanded } : {}) }
}
