import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getSettings } from './store'
import { readTextDocument } from './attachments'
import { writeFileAtomic } from './fsAtomic'
import { chunkText, cosine, embedTexts, resolveEmbeddingModel } from './embeddings'

/**
 * Local long-term memory (RAG): text is chunked, embedded with a local
 * embedding model through LM Studio's /v1/embeddings, and stored as JSON in
 * the userData directory. Search is cosine similarity computed in-process —
 * no external vector DB. At the scale of a personal knowledge base (hundreds
 * to low-thousands of chunks) this is instant and keeps every byte local.
 *
 * The chunking and embedding primitives live in embeddings.ts, shared with the
 * ephemeral research index over fetched web pages (researchIndex.ts). This
 * store is the durable half: only what the user explicitly saves lands here.
 */

interface MemoryChunk {
  id: string
  source: string
  text: string
  embedding: number[]
  /** Embedding model that produced this vector. Absent on pre-v0.6 chunks. */
  model?: string
  createdAt: number
}

interface MemoryFile {
  chunks: MemoryChunk[]
}

export interface MemorySearchResult {
  source: string
  text: string
  score: number
}

const MAX_DOCUMENT_CHARS = 500_000

/**
 * Relevance floor for memory recall. Cosine scores below this are the
 * embedding model saying "nothing stored is actually about this query" —
 * without the floor, top-K always returns *something*, and injecting random
 * memories into the system prompt can pull a small model off the user's
 * question entirely (worst on a conversation's first turn, when no history
 * anchors the topic). Callers that want raw ranking can pass minScore: 0.
 */
export const MEMORY_SCORE_FLOOR = 0.35

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function memoryFile(): string {
  return join(app.getPath('userData'), 'memory.json')
}

async function readMemory(): Promise<MemoryFile> {
  try {
    const raw = await fs.readFile(memoryFile(), 'utf-8')
    return JSON.parse(raw) as MemoryFile
  } catch {
    return { chunks: [] }
  }
}

async function writeMemory(data: MemoryFile): Promise<void> {
  await writeFileAtomic(memoryFile(), JSON.stringify(data))
}

/**
 * Serializes read-modify-write cycles on memory.json. Auto-indexing a note
 * (tools.ts) can otherwise overlap a memory_save and silently drop chunks,
 * since each one reads the whole file, mutates, and writes it back.
 */
let memoryQueue: Promise<unknown> = Promise.resolve()

function withMemoryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = memoryQueue.then(fn, fn)
  memoryQueue = run.catch(() => undefined)
  return run
}

/** Add or replace a named source in memory (chunks + embeds + persists). */
export async function addToMemory(
  source: string,
  text: string
): Promise<{ chunks: number }> {
  const pieces = chunkText(text.slice(0, MAX_DOCUMENT_CHARS))
  if (pieces.length === 0) throw new Error('The document has no text to index.')

  const { model, vectors } = await embedTexts(pieces)
  return withMemoryLock(async () => {
    const memory = await readMemory()
    memory.chunks = memory.chunks.filter((c) => c.source !== source)
    const now = Date.now()
    for (let i = 0; i < pieces.length; i++) {
      memory.chunks.push({
        id: uid(),
        source,
        text: pieces[i],
        embedding: vectors[i],
        model,
        createdAt: now
      })
    }
    await writeMemory(memory)
    return { chunks: pieces.length }
  })
}

export async function searchMemory(
  query: string,
  topK: number,
  minScore: number = MEMORY_SCORE_FLOOR,
  sources?: string[] | null
): Promise<MemorySearchResult[]> {
  const memory = await readMemory()
  if (memory.chunks.length === 0) return []

  const { model, vectors } = await embedTexts([query])
  const queryVector = vectors[0]

  // Chunks embedded by a different model live in a different vector space —
  // scoring them against this query is meaningless, so they are excluded.
  let comparable = memory.chunks.filter((c) => c.embedding.length === queryVector.length)
  if (comparable.length === 0) {
    throw new Error(
      `All ${memory.chunks.length} stored memories were embedded with a different model than "${model}". ` +
        'Switch back to the original model, or remove and re-add these sources under Settings → Memory.'
    )
  }

  // Per-conversation scoping (v0.9): when a conversation restricts its sources,
  // everything else simply does not exist for it. `null`/undefined = all
  // sources; `[]` = none, which is a legitimate "no memory for this chat" and
  // returns empty rather than throwing.
  if (sources != null) {
    const allowed = new Set(sources)
    comparable = comparable.filter((c) => allowed.has(c.source))
    if (comparable.length === 0) return []
  }

  return comparable
    .map((c) => ({ source: c.source, text: c.text, score: cosine(queryVector, c.embedding) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK))
    .map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 }))
}

export async function deleteFromMemory(source: string): Promise<{ removed: number }> {
  return withMemoryLock(async () => {
    const memory = await readMemory()
    const before = memory.chunks.length
    memory.chunks = memory.chunks.filter((c) => c.source !== source)
    await writeMemory(memory)
    return { removed: before - memory.chunks.length }
  })
}

async function memoryStats(): Promise<unknown> {
  const memory = await readMemory()
  const model = await resolveEmbeddingModel()
  const bySource = new Map<string, { chunks: number; updatedAt: number }>()
  for (const c of memory.chunks) {
    const entry = bySource.get(c.source) ?? { chunks: 0, updatedAt: 0 }
    entry.chunks += 1
    entry.updatedAt = Math.max(entry.updatedAt, c.createdAt)
    bySource.set(c.source, entry)
  }
  // More than one vector space in the store means some sources can no longer
  // be searched with the current model and need re-indexing.
  const dimensions = new Set(memory.chunks.map((c) => c.embedding.length))

  return {
    available: model !== null,
    embeddingModel: model,
    reason:
      model === null
        ? 'No embedding model found in LM Studio — load one (e.g. nomic-embed-text) or set it below.'
        : undefined,
    mixedModels: dimensions.size > 1,
    totalChunks: memory.chunks.length,
    sources: [...bySource.entries()]
      .map(([source, s]) => ({ source, chunks: s.chunks, updatedAt: s.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
}

export function registerMemoryHandlers(): void {
  ipcMain.handle('memory:stats', () => memoryStats())

  ipcMain.handle(
    'memory:search',
    async (_e, query: string, topK?: number, minScore?: number, sources?: string[] | null) => {
      try {
        return {
          ok: true,
          results: await searchMemory(
            String(query ?? ''),
            topK ?? getSettings().memory.topK,
            typeof minScore === 'number' && Number.isFinite(minScore) ? minScore : undefined,
            Array.isArray(sources) ? sources.map(String) : null
          )
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), results: [] }
      }
    }
  )

  ipcMain.handle('memory:addDocument', async (_e, source: string, text: string) => {
    try {
      return { ok: true, ...(await addToMemory(String(source ?? ''), String(text ?? ''))) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('memory:addDocumentFromPath', async (_e, path: string) => {
    try {
      const doc = await readTextDocument(String(path ?? ''), MAX_DOCUMENT_CHARS)
      const result = await addToMemory(doc.name, doc.text)
      return { ok: true, name: doc.name, truncated: doc.truncated, ...result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('memory:delete', async (_e, source: string) => {
    try {
      return { ok: true, ...(await deleteFromMemory(String(source ?? ''))) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
