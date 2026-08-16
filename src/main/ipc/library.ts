import { app, dialog, ipcMain } from 'electron'
import { hostWindow } from './hostWindow'
import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { basename, extname, join, resolve } from 'path'
import { writeFileAtomic } from './fsAtomic'
import {
  chunkTextWithOffsets,
  embedTexts,
  normalizeForChunking,
  resolveEmbeddingModel,
  toUnitVector,
  unitDot
} from './embeddings'
import { Bm25Index, jaccard, mmrSelect, normalizeScores, reciprocalRankFusion, tokenize } from './retrieval'
import { readTextDocument } from './attachments'

/**
 * The Almanac: an offline reference library the model reads *before* it
 * answers (STRATEGY-depth-and-reasoning.md, Feature A).
 *
 * A *pack* is a directory of plain-text/Markdown documents plus a manifest
 * carrying provenance for every document — title, source, license, date. Packs
 * are either curated bundles the user downloads (public-domain federal works in
 * the first tranche) or folders of the user's own files turned into a pack.
 * Nothing here ever touches the network: the only I/O is this machine's disk
 * and, when an embedding model is loaded, loopback calls to LM Studio.
 *
 * On disk (userData/library/<packId>/):
 *   manifest.json   — PackManifest: what the pack is and where each document
 *                     came from. Written once at install; never edited by chat.
 *   docs/<file>     — the documents, verbatim (.md / .txt).
 *   index.json      — IndexFile: per-document embedding vectors for one named
 *                     embedding model. Optional and rebuildable — retrieval is
 *                     keyword-only for a document without current vectors, so
 *                     the library works on a machine running exactly one model.
 *
 * Why not one big JSON blob: a first-aid manual is half a megabyte of text and
 * the vectors for it are several more; documents and vectors are read whole but
 * written separately, so a re-embed after a model change rewrites index.json
 * and nothing else. Why not SQLite: the same bounded-JSON reasoning as memory
 * and conversations (STRATEGY-speed-and-quality.md); revisit if a ZIM-scale
 * pack ever lands.
 *
 * In RAM: every loaded pack's chunks, one BM25 index over the whole library
 * (BM25 scores are only comparable within one corpus, so cross-pack lookup
 * needs one index, filtered by pack when a pack is named), and unit vectors
 * where index.json supplied them for the current embedding model. Retrieval is
 * the hybrid the app already trusts — BM25 + cosine fused by reciprocal rank,
 * MMR against near-duplicates — returning passages with a citation the model
 * can quote: pack › document › section, and how far into the document.
 */

export const PACK_FORMAT_VERSION = 1

export interface PackDocMeta {
  /** Stable within the pack: `[a-z0-9-]`, ≤ 80 chars. */
  id: string
  title: string
  /** Where the text came from — a URL for curated packs, an original path for user packs. */
  source?: string
  /** SPDX-ish or plain words ("Public domain (US federal work)"). */
  license?: string
  /** Publication or retrieval date, ISO or free text. */
  date?: string
  /** File name under docs/. */
  file: string
  /** Characters of normalized text. Filled at install. */
  chars: number
}

export interface PackManifest {
  formatVersion: number
  /** `[a-z0-9][a-z0-9-]{1,63}` — also the directory name. */
  id: string
  name: string
  description: string
  version: string
  /** License of the pack as a whole. */
  license: string
  /** 'curated' = a downloaded/bundled pack; 'user' = built from the user's own folder. */
  kind: 'curated' | 'user'
  /** Free-text note about sources, freshness, or scope. */
  sourceNote?: string
  /** ISO timestamp of install/creation on this machine. */
  installedAt: string
  docs: PackDocMeta[]
}

interface IndexFile {
  formatVersion: number
  embeddingModel: string
  dims: number
  docs: Record<string, { chunkCount: number; vectors: string }>
}

export interface LibraryPassage {
  packId: string
  packName: string
  docId: string
  docTitle: string
  /** Nearest Markdown heading above the passage, or '' for plain text. */
  section: string
  /** 0 (start) .. 1 (end) of the document. */
  position: number
  text: string
  /** Fused relevance, 0..1 within this result set. */
  score: number
  source?: string
  license?: string
  date?: string
}

export interface LookupOutcome {
  ok: boolean
  passages: LibraryPassage[]
  /** 'hybrid' = keyword + semantic; 'keyword' = BM25 only. */
  mode: 'hybrid' | 'keyword'
  notes: string[]
  error?: string
}

export interface PackSummary {
  id: string
  name: string
  description: string
  version: string
  license: string
  kind: PackManifest['kind']
  sourceNote?: string
  installedAt: string
  docs: number
  chars: number
  chunks: number
  /** Chunks with vectors for the *current* embedding model. */
  embeddedChunks: number
  /** Which model the stored vectors belong to, if any. */
  embeddingModel: string | null
}

// ---- bounds -----------------------------------------------------------------

/** One document; the largest single federal manual in the tranche is ~1.2M chars. */
export const MAX_DOC_CHARS = 2_000_000
/** One pack. */
export const MAX_PACK_CHARS = 8_000_000
export const MAX_PACK_DOCS = 600
/** The whole library held in RAM at once. */
export const MAX_LIBRARY_CHARS = 48_000_000
/** Files walked when building a pack from a folder. */
const MAX_FOLDER_FILES = 600
const MAX_FOLDER_DEPTH = 5
/** Passages a lookup may return. */
export const MAX_LOOKUP_PASSAGES = 12
/** Candidate pool for MMR, as a multiple of the requested count. */
const CANDIDATE_MULTIPLIER = 5
const MMR_LAMBDA = 0.72
/** Chunks embedded per LM Studio round of an embed job. */
const EMBED_JOB_BATCH = 48

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const DOC_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
const FOLDER_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.pdf'])

// ---- RAM state -----------------------------------------------------------------

interface LibChunk {
  /** `${packId}/${docId}#${n}` */
  id: string
  packId: string
  docId: string
  n: number
  text: string
  offset: number
  terms: string[]
  termSet: Set<string>
  vector?: Float32Array
}

interface LoadedDoc {
  meta: PackDocMeta
  text: string
  headings: { offset: number; title: string }[]
  chunks: LibChunk[]
}

interface LoadedPack {
  manifest: PackManifest
  docs: Map<string, LoadedDoc>
  chunks: LibChunk[]
  /** Model the vectors currently attached to chunks belong to. */
  vectorModel: string | null
}

const packs = new Map<string, LoadedPack>()
let globalBm25: Bm25Index | null = null
let libraryScanned = false

/** Test seam: where the library lives. */
let libraryRootOverride: string | null = null

export function libraryDir(): string {
  return libraryRootOverride ?? join(app.getPath('userData'), 'library')
}

export function setLibraryDirForTests(dir: string | null): void {
  libraryRootOverride = dir
  packs.clear()
  globalBm25 = null
  libraryScanned = false
}

function packDir(id: string): string {
  return join(libraryDir(), id)
}

function invalidateBm25(): void {
  globalBm25 = null
}

function bm25(): Bm25Index {
  if (!globalBm25) {
    const docs: { id: string; terms: string[] }[] = []
    for (const pack of packs.values()) for (const c of pack.chunks) docs.push({ id: c.id, terms: c.terms })
    globalBm25 = new Bm25Index(docs)
  }
  return globalBm25
}

function loadedChars(): number {
  let total = 0
  for (const pack of packs.values()) for (const doc of pack.docs.values()) total += doc.text.length
  return total
}

// ---- manifest validation --------------------------------------------------------

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** Validate a manifest read from disk or supplied by an installer. Throws with a reason. */
export function validateManifest(raw: unknown): PackManifest {
  const m = (raw ?? {}) as Record<string, unknown>
  if (m.formatVersion !== PACK_FORMAT_VERSION) {
    throw new Error(`Unsupported pack format version ${String(m.formatVersion)} (this app reads ${PACK_FORMAT_VERSION}).`)
  }
  const id = str(m.id)
  if (!PACK_ID_RE.test(id)) throw new Error(`Invalid pack id "${id}" — use lowercase letters, digits and dashes.`)
  const name = str(m.name).trim()
  if (!name) throw new Error('Pack manifest needs a name.')
  if (!Array.isArray(m.docs) || m.docs.length === 0) throw new Error('Pack manifest lists no documents.')
  if (m.docs.length > MAX_PACK_DOCS) throw new Error(`Pack lists ${m.docs.length} documents; the limit is ${MAX_PACK_DOCS}.`)
  const seen = new Set<string>()
  const docs: PackDocMeta[] = m.docs.map((d, i) => {
    const doc = (d ?? {}) as Record<string, unknown>
    const docId = str(doc.id)
    if (!DOC_ID_RE.test(docId)) throw new Error(`Document ${i + 1} has an invalid id "${docId}".`)
    if (seen.has(docId)) throw new Error(`Duplicate document id "${docId}".`)
    seen.add(docId)
    const file = str(doc.file)
    // A file name only — no directories, no traversal.
    if (!file || file !== basename(file) || file.startsWith('.') || !DOC_EXTENSIONS.has(extname(file).toLowerCase())) {
      throw new Error(`Document "${docId}" has an invalid file name "${file}" (.md or .txt directly under docs/).`)
    }
    return {
      id: docId,
      title: str(doc.title).trim() || docId,
      source: str(doc.source) || undefined,
      license: str(doc.license) || undefined,
      date: str(doc.date) || undefined,
      file,
      chars: typeof doc.chars === 'number' && Number.isFinite(doc.chars) ? doc.chars : 0
    }
  })
  return {
    formatVersion: PACK_FORMAT_VERSION,
    id,
    name,
    description: str(m.description).trim(),
    version: str(m.version).trim() || '0',
    license: str(m.license).trim() || 'unspecified',
    kind: m.kind === 'user' ? 'user' : 'curated',
    sourceNote: str(m.sourceNote) || undefined,
    installedAt: str(m.installedAt) || new Date().toISOString(),
    docs
  }
}

// ---- loading ------------------------------------------------------------------

function headingsOf(text: string): { offset: number; title: string }[] {
  const out: { offset: number; title: string }[] = []
  const re = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ offset: m.index, title: m[2].trim() })
  return out
}

function sectionAt(doc: LoadedDoc, offset: number): string {
  let title = ''
  for (const h of doc.headings) {
    if (h.offset <= offset) title = h.title
    else break
  }
  return title
}

function decodeVectors(b64: string, dims: number, count: number): Float32Array[] | null {
  const buf = Buffer.from(b64, 'base64')
  if (buf.byteLength !== dims * count * 4) return null
  const all = new Float32Array(buf.buffer, buf.byteOffset, dims * count)
  const out: Float32Array[] = []
  for (let i = 0; i < count; i++) out.push(all.slice(i * dims, (i + 1) * dims))
  return out
}

function encodeVectors(vectors: Float32Array[], dims: number): string {
  const all = new Float32Array(vectors.length * dims)
  vectors.forEach((v, i) => all.set(v, i * dims))
  return Buffer.from(all.buffer, all.byteOffset, all.byteLength).toString('base64')
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T
  } catch {
    return null
  }
}

/** Attach stored vectors to a pack's chunks if they belong to `model` and still fit. */
async function attachVectors(pack: LoadedPack, model: string | null): Promise<void> {
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
    doc.chunks = chunkTextWithOffsets(text).map((c, n) => {
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
async function ensureLoaded(onlyPack: string | null, notes: string[]): Promise<void> {
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
  if (!onlyPack) libraryScanned = true
  if (changed) invalidateBm25()
}

// ---- lookup ----------------------------------------------------------------------

/**
 * Retrieve the passages across the library (or one pack) most relevant to
 * `query`. Never throws for retrieval reasons; a missing pack or an unavailable
 * embedding model degrades to `ok: true` with fewer results and a note.
 */
export async function lookupLibrary(input: {
  query: string
  packId?: string | null
  topK?: number
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
  const allChunks = scope.flatMap((p) => p.chunks)
  if (allChunks.length === 0) {
    return { ok: true, passages: [], mode: 'keyword', notes: [...notes, 'The reference library is empty.'] }
  }
  const byId = new Map(allChunks.map((c) => [c.id, c]))

  const bm25Ranked = bm25()
    .search(tokenize(query))
    .map((s) => s.id)
    .filter((id) => byId.has(id))

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
      } else if (withVectors.length < allChunks.length) {
        notes.push(`Semantic ranking covered ${withVectors.length} of ${allChunks.length} passages (the rest are not embedded yet); keyword ranking covered all.`)
      }
    } catch (err) {
      notes.push(`Keyword-only ranking — embeddings unavailable (${err instanceof Error ? err.message : String(err)}).`)
    }
  }

  let relevance: Map<string, number>
  if (queryVector) {
    const qv = queryVector
    const semanticRanked = withVectors
      .map((c) => ({ id: c.id, score: unitDot(qv, c.vector!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(50, topK * CANDIDATE_MULTIPLIER * 2))
      .map((s) => s.id)
    const fused = reciprocalRankFusion([bm25Ranked, semanticRanked])
    relevance = normalizeScores([...fused].map(([id, score]) => ({ id, score })))
  } else if (bm25Ranked.length > 0) {
    relevance = normalizeScores(bm25().search(tokenize(query)).filter((s) => byId.has(s.id)))
  } else {
    return { ok: true, passages: [], mode: 'keyword', notes: [...notes, 'No passage matched the query.'] }
  }

  const candidates = [...relevance]
    .map(([id, score]) => ({ id, relevance: score }))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, topK * CANDIDATE_MULTIPLIER)

  const similarity = (a: string, b: string): number => {
    const ca = byId.get(a)
    const cb = byId.get(b)
    if (!ca || !cb) return 0
    if (ca.vector && cb.vector && ca.vector.length === cb.vector.length) return Math.max(0, unitDot(ca.vector, cb.vector))
    return jaccard(ca.termSet, cb.termSet)
  }
  const selected = mmrSelect(candidates, topK, MMR_LAMBDA, similarity)

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
        section: sectionAt(doc, c.offset),
        position: Math.min(1, c.offset / Math.max(1, doc.text.length)),
        text: c.text,
        score: Math.round((relevance.get(c.id) ?? 0) * 1000) / 1000,
        source: doc.meta.source,
        license: doc.meta.license,
        date: doc.meta.date
      }
    })
    // Relevance order across documents; the citation carries position, so
    // reading order is recoverable per document by the reader.
    .sort((a, b) => b.score - a.score)

  return { ok: true, passages, mode: queryVector ? 'hybrid' : 'keyword', notes }
}

/** The citation line the model quotes: pack › document › section (position). */
export function citationOf(p: LibraryPassage): string {
  const parts = [p.packName, p.docTitle]
  if (p.section) parts.push(p.section)
  return `${parts.join(' › ')} · ${Math.round(p.position * 100)}% in`
}

/** Passages formatted for the model, with provenance the model must carry into its answer. */
export function formatLookup(outcome: LookupOutcome, query: string): string {
  if (outcome.passages.length === 0) {
    return [
      `No reference passages found for "${query}".`,
      ...outcome.notes,
      'Say plainly that the library has nothing on this; do not invent a reference.'
    ].join('\n')
  }
  const blocks = outcome.passages.map(
    (p, i) =>
      `[${i + 1}] ${citationOf(p)}` +
      (p.source ? `\n    source: ${p.source}` : '') +
      (p.date ? `\n    date: ${p.date}` : '') +
      (p.license ? `\n    license: ${p.license}` : '') +
      `\n    relevance ${p.score}\n${p.text}`
  )
  const head =
    `Reference passages for "${query}" from the local library (${outcome.mode === 'hybrid' ? 'semantic + keyword' : 'keyword'} ranking), most relevant first. ` +
    'These are the user\'s own installed reference documents, not the live web: cite the bracketed number and the document when you use one, quote figures, dosages and steps rather than paraphrasing them, and if the passages do not answer the question say so instead of filling the gap.'
  return [head, '', ...blocks, ...(outcome.notes.length ? ['', ...outcome.notes.map((n) => `Note: ${n}`)] : [])].join('\n')
}

// ---- pack management ------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

/**
 * Install a pack from a directory holding manifest.json and docs/. The
 * documents are copied (never referenced), so removing or editing the source
 * later cannot change what the library says. Rejects an id already installed
 * unless `replace` is set.
 */
export async function installPackFromDirectory(sourceDir: string, opts: { replace?: boolean } = {}): Promise<PackSummary> {
  const raw = await readJson<unknown>(join(sourceDir, 'manifest.json'))
  if (!raw) throw new Error(`No manifest.json in ${sourceDir}.`)
  const manifest = validateManifest(raw)
  const target = packDir(manifest.id)
  if ((await pathExists(target)) && !opts.replace) {
    throw new Error(`A pack with id "${manifest.id}" is already installed.`)
  }

  // Stage into a temp dir, then rename into place, so a half-copied pack is
  // never visible to a lookup.
  const staging = join(libraryDir(), `.${manifest.id}.installing`)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(join(staging, 'docs'), { recursive: true })
  let totalChars = 0
  const docs: PackDocMeta[] = []
  for (const meta of manifest.docs) {
    const src = join(sourceDir, 'docs', meta.file)
    let text: string
    try {
      text = normalizeForChunking(await fs.readFile(src, 'utf-8'))
    } catch {
      throw new Error(`Document "${meta.id}" is missing (${src}).`)
    }
    if (text.length > MAX_DOC_CHARS) throw new Error(`Document "${meta.id}" is longer than ${MAX_DOC_CHARS.toLocaleString('en-US')} characters.`)
    totalChars += text.length
    if (totalChars > MAX_PACK_CHARS) throw new Error(`Pack exceeds ${MAX_PACK_CHARS.toLocaleString('en-US')} characters of text.`)
    await fs.writeFile(join(staging, 'docs', meta.file), text, 'utf-8')
    docs.push({ ...meta, chars: text.length })
  }
  const installed: PackManifest = { ...manifest, docs, installedAt: new Date().toISOString() }
  await writeFileAtomic(join(staging, 'manifest.json'), JSON.stringify(installed, null, 2))
  await fs.rm(target, { recursive: true, force: true })
  await fs.rename(staging, target)

  packs.delete(manifest.id)
  invalidateBm25()
  return (await packSummary(manifest.id))!
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pack'
}

async function walkFolder(root: string): Promise<string[]> {
  const out: string[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_FOLDER_DEPTH || out.length >= MAX_FOLDER_FILES) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= MAX_FOLDER_FILES) return
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) await visit(p, depth + 1)
      else if (e.isFile() && FOLDER_EXTENSIONS.has(extname(e.name).toLowerCase())) out.push(p)
    }
  }
  await visit(resolve(root), 0)
  return out
}

/**
 * Build a `user` pack from a folder of the user's own files (.md/.txt/.pdf,
 * recursively). A snapshot: text is extracted and copied now; the folder is
 * not watched. Each document's `source` is its original path, which is what
 * the citation shows.
 */
export async function createPackFromFolder(
  folder: string,
  opts: { name?: string; description?: string } = {}
): Promise<PackSummary> {
  const files = await walkFolder(folder)
  if (files.length === 0) throw new Error('No .md, .txt or .pdf files were found in that folder.')
  const name = (opts.name ?? basename(resolve(folder))).trim() || 'My documents'
  const hash = createHash('sha1').update(resolve(folder)).digest('hex').slice(0, 6)
  const id = `${slugify(name)}-${hash}`

  const staging = join(libraryDir(), `.${id}.installing`)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(join(staging, 'docs'), { recursive: true })
  const docs: PackDocMeta[] = []
  const skipped: string[] = []
  const usedIds = new Set<string>()
  let totalChars = 0
  for (const file of files) {
    let text: string
    try {
      text = normalizeForChunking((await readTextDocument(file, MAX_DOC_CHARS)).text)
    } catch (err) {
      skipped.push(`${basename(file)}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (!text) continue
    if (totalChars + text.length > MAX_PACK_CHARS) {
      skipped.push(`${basename(file)}: pack size limit reached`)
      continue
    }
    totalChars += text.length
    let docId = slugify(basename(file, extname(file))) || 'doc'
    if (usedIds.has(docId)) docId = `${docId}-${docs.length + 1}`
    usedIds.add(docId)
    const outFile = `${docId}${extname(file).toLowerCase() === '.md' || extname(file).toLowerCase() === '.markdown' ? '.md' : '.txt'}`
    await fs.writeFile(join(staging, 'docs', outFile), text, 'utf-8')
    docs.push({ id: docId, title: basename(file, extname(file)), source: file, file: outFile, chars: text.length })
  }
  if (docs.length === 0) {
    await fs.rm(staging, { recursive: true, force: true })
    throw new Error(`No readable documents in that folder.${skipped.length ? ` (${skipped.slice(0, 3).join('; ')})` : ''}`)
  }
  const manifest: PackManifest = {
    formatVersion: PACK_FORMAT_VERSION,
    id,
    name,
    description: opts.description?.trim() || `Your documents from ${resolve(folder)}`,
    version: new Date().toISOString().slice(0, 10),
    license: 'private — the user\'s own files',
    kind: 'user',
    sourceNote: `Snapshot of ${files.length} file(s) under ${resolve(folder)}${skipped.length ? `; ${skipped.length} skipped` : ''}.`,
    installedAt: new Date().toISOString(),
    docs
  }
  await writeFileAtomic(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await fs.rm(packDir(id), { recursive: true, force: true })
  await fs.rename(staging, packDir(id))
  packs.delete(id)
  invalidateBm25()
  return (await packSummary(id))!
}

export async function removePack(id: string): Promise<{ removed: boolean }> {
  if (!PACK_ID_RE.test(id)) return { removed: false }
  const dir = packDir(id)
  const existed = await pathExists(dir)
  await fs.rm(dir, { recursive: true, force: true })
  packs.delete(id)
  invalidateBm25()
  return { removed: existed }
}

async function packSummary(id: string): Promise<PackSummary | null> {
  const notes: string[] = []
  await ensureLoaded(id, notes)
  const pack = packs.get(id)
  if (!pack) return null
  const chunks = pack.chunks.length
  const embeddedChunks = pack.chunks.filter((c) => c.vector).length
  let chars = 0
  for (const d of pack.docs.values()) chars += d.text.length
  return {
    id,
    name: pack.manifest.name,
    description: pack.manifest.description,
    version: pack.manifest.version,
    license: pack.manifest.license,
    kind: pack.manifest.kind,
    sourceNote: pack.manifest.sourceNote,
    installedAt: pack.manifest.installedAt,
    docs: pack.docs.size,
    chars,
    chunks,
    embeddedChunks,
    embeddingModel: pack.vectorModel
  }
}

export async function listPacks(): Promise<PackSummary[]> {
  const notes: string[] = []
  await ensureLoaded(null, notes)
  const out: PackSummary[] = []
  for (const id of [...packs.keys()].sort()) {
    const s = await packSummary(id)
    if (s) out.push(s)
  }
  return out
}

export function libraryStats(): { packs: number; docs: number; chunks: number; chars: number; embeddedChunks: number; scanned: boolean } {
  let docs = 0
  let chunks = 0
  let embeddedChunks = 0
  for (const p of packs.values()) {
    docs += p.docs.size
    chunks += p.chunks.length
    embeddedChunks += p.chunks.filter((c) => c.vector).length
  }
  return { packs: packs.size, docs, chunks, chars: loadedChars(), embeddedChunks, scanned: libraryScanned }
}

// ---- embedding job -----------------------------------------------------------------

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

// ---- IPC -----------------------------------------------------------------------------

/** One embed job at a time; a second request while one runs is refused, not queued. */
let embedJob: { packId: string; abort: AbortController } | null = null

export function registerLibraryHandlers(): void {
  ipcMain.handle('library:list', () => listPacks())
  ipcMain.handle('library:stats', () => libraryStats())
  ipcMain.handle('library:remove', (_e, id: string) => removePack(String(id ?? '')))
  ipcMain.handle('library:lookup', (_e, query: string, packId?: string | null, topK?: number) =>
    lookupLibrary({ query: String(query ?? ''), packId: packId ?? null, topK })
  )

  ipcMain.handle('library:installFromDirectory', async (event, path?: string) => {
    let dir = typeof path === 'string' && path.trim() ? path : null
    if (!dir) {
      const win = hostWindow(event.sender)
      if (!win) return { ok: false, error: 'No window to show a picker in.' }
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Install a reference pack (folder with manifest.json)',
        properties: ['openDirectory']
      })
      if (canceled || filePaths.length === 0) return { ok: false, cancelled: true }
      dir = filePaths[0]
    }
    try {
      return { ok: true, pack: await installPackFromDirectory(dir, { replace: true }) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('library:addFolder', async (event, path?: string, name?: string) => {
    let dir = typeof path === 'string' && path.trim() ? path : null
    if (!dir) {
      const win = hostWindow(event.sender)
      if (!win) return { ok: false, error: 'No window to show a picker in.' }
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Add a folder of your documents to the reference library',
        properties: ['openDirectory']
      })
      if (canceled || filePaths.length === 0) return { ok: false, cancelled: true }
      dir = filePaths[0]
    }
    try {
      return { ok: true, pack: await createPackFromFolder(dir, { name: typeof name === 'string' ? name : undefined }) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('library:embed', async (event, id: string) => {
    if (embedJob) return { ok: false, error: `Already embedding "${embedJob.packId}".` }
    const abort = new AbortController()
    embedJob = { packId: String(id), abort }
    try {
      return await embedPack(
        String(id),
        (done, total) => {
          if (!event.sender.isDestroyed()) event.sender.send('library:embedProgress', { packId: id, done, total })
        },
        abort.signal
      )
    } finally {
      embedJob = null
    }
  })

  ipcMain.handle('library:cancelEmbed', () => {
    embedJob?.abort.abort()
    return { ok: true }
  })
}
