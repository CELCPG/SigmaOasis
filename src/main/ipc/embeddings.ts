import { getSettings } from './store'
import { auditedFetch } from './net'

/**
 * Local embedding primitives, shared by long-term memory (memory.ts) and the
 * ephemeral research index (researchIndex.ts).
 *
 * Everything here runs against the user's own LM Studio server over loopback —
 * text is chunked and embedded locally, and vectors never leave the machine.
 * Extracted from memory.ts in v0.7 so retrieval over freshly fetched web pages
 * can reuse the same model and the same vector space.
 */

export const CHUNK_CHARS = 1000
export const CHUNK_OVERLAP = 150
const EMBED_BATCH = 16

export interface TextChunk {
  text: string
  /** Character offset into the normalized source text (see `normalizeForChunking`). */
  offset: number
}

/** Line-ending normalization + trim, applied before chunking so offsets are stable. */
export function normalizeForChunking(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

/**
 * Split text into ~CHUNK_CHARS pieces on paragraph/sentence boundaries,
 * recording each piece's offset in the normalized text. Offsets let a caller
 * report where in a document a passage came from, and re-sort passages back
 * into reading order after relevance ranking.
 */
export function chunkTextWithOffsets(text: string): TextChunk[] {
  const clean = normalizeForChunking(text)
  if (!clean) return []

  const chunks: TextChunk[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_CHARS, clean.length)
    if (end < clean.length) {
      const slice = clean.slice(start, end)
      const cut = Math.max(
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('. '),
        slice.lastIndexOf('\n')
      )
      if (cut > CHUNK_CHARS * 0.5) end = start + cut + 1
    }
    const raw = clean.slice(start, end)
    const piece = raw.trim()
    // Offset points at the first non-whitespace character actually kept.
    if (piece) chunks.push({ text: piece, offset: start + raw.indexOf(piece[0]) })
    // Always make progress, even if overlap would exceed the chunk.
    start = end - CHUNK_OVERLAP > start ? end - CHUNK_OVERLAP : end
  }
  return chunks
}

/** Chunk text into plain strings (long-term memory's original interface). */
export function chunkText(text: string): string[] {
  return chunkTextWithOffsets(text).map((c) => c.text)
}

/** Resolve the embedding model: configured value wins, else auto-detect. */
let cachedDetectedModel: string | null = null

export async function resolveEmbeddingModel(): Promise<string | null> {
  const settings = getSettings()
  const configured = settings.memory.embeddingModel.trim()
  if (configured) return configured
  // Auto-detection costs a /models round-trip; a research crawl embeds dozens
  // of batches, so detect once per session. Only successes are cached — a null
  // may just mean the user has not loaded an embedding model yet.
  if (cachedDetectedModel) return cachedDetectedModel
  try {
    const res = await auditedFetch(
      `${settings.baseUrl.replace(/\/+$/, '')}/models`,
      undefined,
      'lmstudio'
    )
    if (!res.ok) return null
    const data = (await res.json()) as { data?: { id: string }[] }
    const found = data.data?.find((m) => /embed/i.test(m.id))?.id ?? null
    if (found) cachedDetectedModel = found
    return found
  } catch {
    return null
  }
}

export class NoEmbeddingModelError extends Error {
  constructor() {
    super(
      'No embedding model found. Load one in LM Studio (e.g. nomic-embed-text) or set it under Settings → Memory.'
    )
    this.name = 'NoEmbeddingModelError'
  }
}

/** Embed a batch of texts through LM Studio's /v1/embeddings (loopback only). */
/**
 * Identical embedding requests already in flight, keyed by their input.
 *
 * v1.4.5. A turn asks for the same vector twice: memory recall embeds the
 * user's message, and tool ranking embeds it again. v1.4.1 made those two calls
 * concurrent, which turned a wasteful pair into a simultaneous one — the server
 * log shows two `POST /v1/embeddings` with byte-identical input, microseconds
 * apart, on every prompt. Both then race to JIT-load the embedding model.
 *
 * Coalescing is the honest fix rather than caching: nothing is retained after
 * the request settles, so this cannot serve a stale vector, and a caller that
 * asks a second later still gets a fresh round trip.
 */
const inFlight = new Map<string, Promise<{ model: string; vectors: number[][] }>>()

export async function embedTexts(texts: string[]): Promise<{ model: string; vectors: number[][] }> {
  if (texts.length === 0) return { model: '', vectors: [] }
  const key = JSON.stringify(texts)
  const existing = inFlight.get(key)
  if (existing) return existing
  const started = embedTextsUncoalesced(texts)
  inFlight.set(key, started)
  try {
    return await started
  } finally {
    inFlight.delete(key)
  }
}

async function embedTextsUncoalesced(
  texts: string[]
): Promise<{ model: string; vectors: number[][] }> {
  const settings = getSettings()
  const model = await resolveEmbeddingModel()
  if (!model) throw new NoEmbeddingModelError()

  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH)
    const res = await auditedFetch(
      `${settings.baseUrl.replace(/\/+$/, '')}/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch })
      },
      'lmstudio'
    )
    if (!res.ok) {
      // The detected model may be gone (user removed it); re-detect next time.
      cachedDetectedModel = null
      throw new Error(`Embeddings endpoint returned HTTP ${res.status}`)
    }
    const data = (await res.json()) as { data?: { embedding: number[]; index: number }[] }
    const byIndex = (data.data ?? []).sort((a, b) => a.index - b.index)
    for (const item of byIndex) vectors.push(item.embedding)
  }
  if (vectors.length !== texts.length) {
    throw new Error('Embeddings endpoint returned an unexpected number of vectors.')
  }
  return { model, vectors }
}

export function cosine(a: number[], b: number[]): number {
  // Vectors from different embedding models have different lengths; comparing
  // them would read past the end of one and produce NaN scores.
  if (a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * L2-normalize into a Float32Array. Storing unit vectors turns every later
 * cosine into a plain dot product, which matters once a research run holds
 * thousands of chunks and reranks them against several sub-questions.
 */
export function toUnitVector(values: number[]): Float32Array {
  let norm = 0
  for (const v of values) norm += v * v
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = values[i] * scale
  return out
}

/** Cosine similarity for vectors already L2-normalized by `toUnitVector`. */
export function unitDot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}
