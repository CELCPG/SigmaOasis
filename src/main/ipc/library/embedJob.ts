import { join } from 'path'
import { writeFileAtomic } from '../fsAtomic'
import { embedTexts, resolveEmbeddingModel, toUnitVector } from '../embeddings'
import { attachVectors, encodeVectors, ensureLoaded } from './loading'
import { packDir, packs } from './state'
import { PACK_FORMAT_VERSION } from './types'
import type { IndexFile, LoadedPack } from './types'

// v4.2 (L1): the embedding job, split out of library.ts unchanged.

/** Chunks embedded per LM Studio round of an embed job. */
const EMBED_JOB_BATCH = 48

/**
 * Embed every chunk of a pack that lacks a vector for the current model and
 * persist the vectors to index.json. Progress is reported per batch; an
 * embedding failure mid-way keeps what was done (written at the end and on
 * failure), so a retry only pays for the remainder. Keyword retrieval works
 * throughout.
 */
export async function embedPack(
  id: string,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<{ ok: boolean; embedded: number; total: number; model: string | null; error?: string }> {
  const notes: string[] = []
  await ensureLoaded(id, notes)
  const pack = packs.get(id)
  if (!pack) return { ok: false, embedded: 0, total: 0, model: null, error: `No pack "${id}" is installed.` }
  const model = await resolveEmbeddingModel().catch(() => null)
  if (!model) {
    return { ok: false, embedded: 0, total: pack.chunks.length, model: null, error: 'No embedding model is available in LM Studio.' }
  }
  if (pack.vectorModel !== model) await attachVectors(pack, model)

  const total = pack.chunks.length
  const missing = pack.chunks.filter((c) => !c.vector)
  let done = total - missing.length
  onProgress?.(done, total)
  let error: string | undefined
  try {
    for (let i = 0; i < missing.length; i += EMBED_JOB_BATCH) {
      if (signal?.aborted) {
        error = 'Cancelled.'
        break
      }
      const batch = missing.slice(i, i + EMBED_JOB_BATCH)
      const { model: usedModel, vectors } = await embedTexts(batch.map((c) => c.text))
      if (usedModel !== model) throw new Error(`Embedding model changed to "${usedModel}" mid-job; run again.`)
      batch.forEach((c, j) => (c.vector = toUnitVector(vectors[j])))
      done += batch.length
      onProgress?.(done, total)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const persisted = await persistVectors(pack, model)
  if (persisted > 0) pack.vectorModel = model
  return { ok: !error, embedded: pack.chunks.filter((c) => c.vector).length, total, model, error }
}

/** Write index.json for a pack from the vectors currently attached. Returns chunks written. */
async function persistVectors(pack: LoadedPack, model: string): Promise<number> {
  const docs: IndexFile['docs'] = {}
  let dims = 0
  let written = 0
  for (const doc of pack.docs.values()) {
    // Only fully embedded documents are stored: a partial document would
    // misalign chunk n ↔ vector n the moment the text is re-chunked.
    if (doc.chunks.length === 0 || doc.chunks.some((c) => !c.vector)) continue
    dims = doc.chunks[0].vector!.length
    docs[doc.meta.id] = { chunkCount: doc.chunks.length, vectors: encodeVectors(doc.chunks.map((c) => c.vector!), dims) }
    written += doc.chunks.length
  }
  const file: IndexFile = { formatVersion: PACK_FORMAT_VERSION, embeddingModel: model, dims, docs }
  await writeFileAtomic(join(packDir(pack.manifest.id), 'index.json'), JSON.stringify(file))
  return written
}
