import { promises as fs } from 'fs'
import { join } from 'path'
import { chunkTextWithOffsets, normalizeForChunking, resolveEmbeddingModel } from '../embeddings'
import { tokenize } from '../retrieval'
import { ZimFile } from '../zim'
import { validateManifest } from './manifest'
import { invalidateBm25, loadedChars, markScanned, packDir, packs, libraryDir } from './state'
import { MAX_DOC_CHARS, MAX_LIBRARY_CHARS, MAX_PACK_CHARS, PACK_FORMAT_VERSION, PACK_ID_RE } from './types'
import type { IndexFile, LibChunk, LoadedDoc, LoadedPack } from './types'

// v4.2 (L1): reading packs off disk into RAM — headings, section-aware
// chunks, stored vectors — split out of library.ts unchanged.

export function headingsOf(text: string): { offset: number; title: string }[] {
  const out: { offset: number; title: string }[] = []
  const re = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ offset: m.index, title: m[2].trim() })
  return out
}

/**
 * The section a passage belongs to: the nearest heading at or above its start.
 * When that heading is the document's own title (the H1 a chunk at offset 0
 * always sits under) and the chunk contains a heading of its own, the first
 * heading inside the chunk is the better label — "Burns", not the title twice.
 */
export function sectionAt(doc: LoadedDoc, offset: number, end: number): string {
  let above = ''
  let aboveIsFirst = false
  for (let i = 0; i < doc.headings.length; i++) {
    const h = doc.headings[i]
    if (h.offset <= offset) {
      above = h.title
      aboveIsFirst = i === 0
    } else break
  }
  const isTitle = aboveIsFirst || above.toLowerCase() === doc.meta.title.toLowerCase()
  if (isTitle) {
    const inside = doc.headings.find((h) => h.offset > offset && h.offset < end)
    if (inside) return inside.title
  }
  return above.toLowerCase() === doc.meta.title.toLowerCase() ? '' : above
}

/**
 * v1.7: chunk a document section by section — no chunk ever spans a heading
 * boundary. The library eval caught why this matters: "### Boiling" is a
 * 200-character section, chunks were ~1,000 characters, so the chunk covering
 * it blended boiling with the chlorination section next door. The blended
 * embedding matched a water-safety question no better than its neighbors, the
 * lookup surfaced the wrong slice, and the model quoted chlorination's
 * "30 minutes" for a boiling question. Chunking inside heading bounds keeps
 * each chunk about one thing: its embedding is crisp, and the passage the
 * model sees starts with its own heading. A long section still splits into
 * ~1,000-character pieces within itself; a document with no headings chunks
 * exactly as before.
 *
 * Changing chunk geometry orphans vectors embedded under the old geometry
 * (attachVectors checks chunkCount and falls back to keyword ranking), so
 * packs embedded before v1.7 show "Embed" again in Settings → Library.
 */
export function chunkDocumentSections(
  text: string,
  headings: { offset: number; title: string }[]
): { text: string; offset: number }[] {
  const bounds: number[] = [0]
  for (const h of headings) if (h.offset > bounds[bounds.length - 1]) bounds.push(h.offset)
  if (text.length > bounds[bounds.length - 1]) bounds.push(text.length)
  const out: { text: string; offset: number }[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const segment = text.slice(bounds[i], bounds[i + 1])
    // Segments start at a heading's '#' (or the document start), so the
    // chunker's inner normalize cannot shift offsets by trimming the front.
    for (const c of chunkTextWithOffsets(segment)) out.push({ text: c.text, offset: bounds[i] + c.offset })
  }
  return out
}

export function decodeVectors(b64: string, dims: number, count: number): Float32Array[] | null {
  const buf = Buffer.from(b64, 'base64')
  if (buf.byteLength !== dims * count * 4) return null
  const all = new Float32Array(buf.buffer, buf.byteOffset, dims * count)
  const out: Float32Array[] = []
  for (let i = 0; i < count; i++) out.push(all.slice(i * dims, (i + 1) * dims))
  return out
}

export function encodeVectors(vectors: Float32Array[], dims: number): string {
  const all = new Float32Array(vectors.length * dims)
  vectors.forEach((v, i) => all.set(v, i * dims))
  return Buffer.from(all.buffer, all.byteOffset, all.byteLength).toString('base64')
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T
  } catch {
    return null
  }
}

/** Attach stored vectors to a pack's chunks if they belong to `model` and still fit. */
export async function attachVectors(pack: LoadedPack, model: string | null): Promise<void> {
  for (const c of pack.chunks) c.vector = undefined
  pack.vectorModel = null
  if (!model) return
  const index = await readJson<IndexFile>(join(packDir(pack.manifest.id), 'index.json'))
  if (!index || index.formatVersion !== PACK_FORMAT_VERSION || index.embeddingModel !== model) return
  let attached = 0
  for (const doc of pack.docs.values()) {
    const entry = index.docs[doc.meta.id]
    if (!entry || entry.chunkCount !== doc.chunks.length) continue
    const vectors = decodeVectors(entry.vectors, index.dims, entry.chunkCount)
    if (!vectors) continue
    doc.chunks.forEach((c, i) => (c.vector = vectors[i]))
    attached += vectors.length
  }
  if (attached > 0) pack.vectorModel = model
}

async function loadPack(id: string, model: string | null): Promise<LoadedPack> {
  const dir = packDir(id)
  const rawManifest = await readJson<unknown>(join(dir, 'manifest.json'))
  if (!rawManifest) throw new Error(`Pack "${id}" has no readable manifest.`)
  const manifest = validateManifest(rawManifest)
  if (manifest.id !== id) throw new Error(`Pack directory "${id}" holds a manifest for "${manifest.id}".`)

  // v2.8: a ZIM pack is opened, not loaded. Its articles are read on demand.
  if (manifest.kind === 'zim') {
    const zim = await ZimFile.open(manifest.zimPath!)
    return { manifest, docs: new Map(), chunks: [], vectorModel: null, zim }
  }

  const docs = new Map<string, LoadedDoc>()
  const chunks: LibChunk[] = []
  let chars = 0
  for (const meta of manifest.docs) {
    let text: string
    try {
      text = normalizeForChunking(await fs.readFile(join(dir, 'docs', meta.file), 'utf-8'))
    } catch {
      continue // a missing document is skipped, not fatal — the manifest still says it should exist
    }
    if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS)
    chars += text.length
    if (chars > MAX_PACK_CHARS) break
    const doc: LoadedDoc = { meta, text, headings: headingsOf(text), chunks: [] }
    doc.chunks = chunkDocumentSections(text, doc.headings).map((c, n) => {
      const terms = tokenize(c.text)
      return { id: `${id}/${meta.id}#${n}`, packId: id, docId: meta.id, n, text: c.text, offset: c.offset, terms, termSet: new Set(terms) }
    })
    docs.set(meta.id, doc)
    chunks.push(...doc.chunks)
  }
  const pack: LoadedPack = { manifest, docs, chunks, vectorModel: null }
  await attachVectors(pack, model)
  return pack
}

/** Directory names under the library root that look like packs. */
async function packIdsOnDisk(): Promise<string[]> {
  try {
    const entries = await fs.readdir(libraryDir(), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && PACK_ID_RE.test(e.name)).map((e) => e.name).sort()
  } catch {
    return []
  }
}

/**
 * Make sure every pack on disk is loaded (or the one named). Loading is lazy —
 * the first lookup of a session pays for it — and bounded by MAX_LIBRARY_CHARS,
 * beyond which later packs are left unloaded and reported in `notes`.
 */
export async function ensureLoaded(onlyPack: string | null, notes: string[]): Promise<void> {
  const model = await resolveEmbeddingModel().catch(() => null)
  const ids = onlyPack ? [onlyPack] : await packIdsOnDisk()
  let changed = false
  for (const id of ids) {
    const existing = packs.get(id)
    if (existing) {
      // Vectors are per model: a model change swaps them out (or off).
      if (existing.vectorModel !== model && model !== null) await attachVectors(existing, model)
      else if (model === null && existing.vectorModel !== null) await attachVectors(existing, null)
      continue
    }
    if (loadedChars() >= MAX_LIBRARY_CHARS) {
      notes.push(`Pack "${id}" was not loaded: the library's memory cap is reached.`)
      continue
    }
    try {
      packs.set(id, await loadPack(id, model))
      changed = true
    } catch (err) {
      notes.push(`Pack "${id}" could not be loaded (${err instanceof Error ? err.message : String(err)}).`)
    }
  }
  if (!onlyPack) markScanned()
  if (changed) invalidateBm25()
}
