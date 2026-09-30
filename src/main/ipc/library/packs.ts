import { existsSync, promises as fs } from 'fs'
import { app } from 'electron'
import { createHash } from 'crypto'
import { basename, extname, join, resolve } from 'path'
import { writeFileAtomic } from '../fsAtomic'
import { normalizeForChunking } from '../embeddings'
import { readTextDocument } from '../attachments'
import { ZimFile } from '../zim'
import { ensureLoaded, readJson } from './loading'
import { validateManifest } from './manifest'
import { invalidateBm25, isScanned, libraryDir, loadedChars, packDir, packs } from './state'
import { DOC_ID_RE, MAX_DOC_CHARS, MAX_PACK_CHARS, MAX_PACK_DOCS, PACK_FORMAT_VERSION, PACK_ID_RE } from './types'
import type { IndexFile, PackDocMeta, PackManifest, PackSummary } from './types'

// v4.2 (L1): pack management — install, the app-written pack, folder packs
// and their updates and freshness, the bundled tranche, ZIM registration,
// summaries and stats — split out of library.ts unchanged.

/** Files walked when building a pack from a folder. */
const MAX_FOLDER_FILES = 600
const MAX_FOLDER_DEPTH = 5
const FOLDER_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx'])

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

/**
 * v2.6: a pack the app writes (kind `app`). One document per entry, replaced
 * whole on every write through the same staging-and-rename the installer
 * uses, so a lookup never sees a half-written pack. Keyword retrieval only:
 * the entries are short and name their subjects, and embedding on every
 * write would put a model call between a reply and its ledger.
 */
export interface AppPackDoc {
  id: string
  title: string
  text: string
  source?: string
  date?: string
  checkedAt?: number
  expiresAt?: number | null
  recheckedAt?: number
  recheckFailures?: number
  claim?: { key: string; claimClass: string; value: string }
}

export async function readAppPack(id: string): Promise<{ manifest: PackManifest; docs: AppPackDoc[] } | null> {
  const dir = packDir(id)
  const raw = await readJson<unknown>(join(dir, 'manifest.json'))
  if (!raw) return null
  let manifest: PackManifest
  try {
    manifest = validateManifest(raw)
  } catch {
    return null
  }
  if (manifest.kind !== 'app') return null
  const docs: AppPackDoc[] = []
  for (const meta of manifest.docs) {
    let text: string
    try {
      text = await fs.readFile(join(dir, 'docs', meta.file), 'utf-8')
    } catch {
      continue
    }
    docs.push({
      id: meta.id,
      title: meta.title,
      text,
      source: meta.source,
      date: meta.date,
      checkedAt: meta.checkedAt,
      expiresAt: meta.expiresAt,
      recheckedAt: meta.recheckedAt,
      recheckFailures: meta.recheckFailures,
      claim: meta.claim
    })
  }
  return { manifest, docs }
}

export async function writeAppPack(input: { id: string; name: string; description: string; docs: AppPackDoc[] }): Promise<void> {
  if (!PACK_ID_RE.test(input.id)) throw new Error(`Invalid pack id "${input.id}".`)
  if (input.docs.length > MAX_PACK_DOCS) throw new Error(`Pack lists ${input.docs.length} documents; the limit is ${MAX_PACK_DOCS}.`)
  const target = packDir(input.id)
  const staging = join(libraryDir(), `.${input.id}.writing`)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(join(staging, 'docs'), { recursive: true })
  const docs: PackDocMeta[] = []
  for (const d of input.docs) {
    if (!DOC_ID_RE.test(d.id)) throw new Error(`Invalid document id "${d.id}".`)
    const text = normalizeForChunking(d.text)
    const file = `${d.id}.md`
    await fs.writeFile(join(staging, 'docs', file), text, 'utf-8')
    docs.push({
      id: d.id,
      title: d.title,
      source: d.source,
      date: d.date,
      file,
      chars: text.length,
      ...(typeof d.checkedAt === 'number' ? { checkedAt: d.checkedAt } : {}),
      ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}),
      ...(typeof d.recheckedAt === 'number' ? { recheckedAt: d.recheckedAt } : {}),
      ...(typeof d.recheckFailures === 'number' && d.recheckFailures > 0 ? { recheckFailures: d.recheckFailures } : {}),
      ...(d.claim ? { claim: d.claim } : {})
    })
  }
  const manifest: PackManifest = {
    formatVersion: PACK_FORMAT_VERSION,
    id: input.id,
    name: input.name,
    description: input.description,
    version: String(Date.now()),
    license: 'written by this app on this machine',
    kind: 'app',
    installedAt: new Date().toISOString(),
    docs
  }
  await writeFileAtomic(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await fs.rm(target, { recursive: true, force: true })
  await fs.rename(staging, target)
  packs.delete(input.id)
  invalidateBm25()
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

function textHash(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * Walk `folder` and stage its documents under `staging/docs`, returning the
 * doc metadata and each staged document's text hash. Shared by "add folder"
 * and "update from folder" so the two can never disagree about what a folder
 * turns into. Extracted text is normalized before hashing, so the hash is
 * stable across runs and is what vector carry-over keys on.
 */
async function stageFolderDocs(
  folder: string,
  staging: string
): Promise<{ docs: PackDocMeta[]; hashes: Map<string, string>; fileCount: number; skipped: string[] }> {
  const files = await walkFolder(folder)
  if (files.length === 0) throw new Error('No .md, .txt, .pdf or .docx files were found in that folder.')
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(join(staging, 'docs'), { recursive: true })
  const docs: PackDocMeta[] = []
  const hashes = new Map<string, string>()
  const skipped: string[] = []
  const usedIds = new Set<string>()
  let totalChars = 0
  for (const file of files) {
    let text: string
    let stat: import('fs').Stats | null = null
    try {
      text = normalizeForChunking((await readTextDocument(file, MAX_DOC_CHARS)).text)
      stat = await fs.stat(file)
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
    docs.push({
      id: docId,
      title: basename(file, extname(file)),
      source: file,
      file: outFile,
      chars: text.length,
      sourceMtime: stat ? Math.round(stat.mtimeMs) : undefined,
      sourceSize: stat ? stat.size : undefined
    })
    hashes.set(docId, textHash(text))
  }
  if (docs.length === 0) {
    await fs.rm(staging, { recursive: true, force: true })
    throw new Error(`No readable documents in that folder.${skipped.length ? ` (${skipped.slice(0, 3).join('; ')})` : ''}`)
  }
  return { docs, hashes, fileCount: files.length, skipped }
}

function folderSourceNote(fileCount: number, folder: string, skipped: string[]): string {
  return `Snapshot of ${fileCount} file(s) under ${resolve(folder)}${skipped.length ? `; ${skipped.length} skipped` : ''}.`
}

/**
 * Build a `user` pack from a folder of the user's own files (.md/.txt/.pdf,
 * recursively). A snapshot: text is extracted and copied now; the folder is
 * not watched, but it is remembered (manifest.sourceFolder), so the pack can
 * be brought up to date later with updatePackFromFolder. Each document's
 * `source` is its original path, which is what the citation shows.
 */
export async function createPackFromFolder(
  folder: string,
  opts: { name?: string; description?: string } = {}
): Promise<PackSummary> {
  const name = (opts.name ?? basename(resolve(folder))).trim() || 'My documents'
  const hash = createHash('sha1').update(resolve(folder)).digest('hex').slice(0, 6)
  const id = `${slugify(name)}-${hash}`

  const staging = join(libraryDir(), `.${id}.installing`)
  const { docs, fileCount, skipped } = await stageFolderDocs(folder, staging)
  const manifest: PackManifest = {
    formatVersion: PACK_FORMAT_VERSION,
    id,
    name,
    description: opts.description?.trim() || `Your own documents from the folder “${basename(resolve(folder))}”.`,
    version: new Date().toISOString().slice(0, 10),
    license: 'private — the user\'s own files',
    kind: 'user',
    sourceNote: folderSourceNote(fileCount, folder, skipped),
    sourceFolder: resolve(folder),
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

export interface UpdateOutcome {
  pack: PackSummary
  /** Chunks whose vectors were carried over because their document's text is unchanged. */
  carriedChunks: number
  /** Chunks that still need embedding after the update. */
  missingChunks: number
}

/**
 * Re-read a user pack's source folder and rebuild the pack from what is there
 * now — the "Update from folder" behind a stale pack. The expensive part of a
 * pack is its embedding vectors, so they are not thrown away wholesale:
 * documents whose extracted text is byte-identical to last time (matched by
 * content hash, *not* by id or filename — a renamed file keeps its vectors)
 * carry their index.json entry over. That is sound because chunking is
 * deterministic from the text, so identical text means identical chunks. Only
 * changed and new documents are left for the embedder, which is what makes
 * updating a 500-document pack after editing three files cost three files.
 */
export async function updatePackFromFolder(id: string): Promise<UpdateOutcome> {
  const dir = packDir(id)
  const raw = await readJson<unknown>(join(dir, 'manifest.json'))
  if (!raw) throw new Error(`No pack "${id}" is installed.`)
  const existing = validateManifest(raw)
  if (existing.kind !== 'user') throw new Error(`"${existing.name}" is a curated pack — reinstall it instead of updating from a folder.`)
  if (!existing.sourceFolder) {
    throw new Error(`"${existing.name}" was built before folder tracking existed. Remove it and add its folder again once; updates work from then on.`)
  }
  if (!(await pathExists(existing.sourceFolder))) {
    throw new Error(`The source folder no longer exists (${existing.sourceFolder}).`)
  }

  // Hash the *stored* documents (already normalized at install) so unchanged
  // text is recognized however the file was renamed or moved within the folder.
  const oldHashes = new Map<string, string>() // hash -> old docId
  for (const meta of existing.docs) {
    try {
      const text = await fs.readFile(join(dir, 'docs', meta.file), 'utf-8')
      oldHashes.set(textHash(text), meta.id)
    } catch {
      // an unreadable old doc simply cannot donate vectors
    }
  }
  const oldIndex = await readJson<IndexFile>(join(dir, 'index.json'))

  const staging = join(libraryDir(), `.${id}.installing`)
  const { docs, hashes, fileCount, skipped } = await stageFolderDocs(existing.sourceFolder, staging)
  const manifest: PackManifest = {
    ...existing,
    version: new Date().toISOString().slice(0, 10),
    sourceNote: folderSourceNote(fileCount, existing.sourceFolder, skipped),
    installedAt: new Date().toISOString(),
    docs
  }
  await writeFileAtomic(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // Carry vectors: new doc → same-hash old doc → its index entry, verbatim.
  let carriedChunks = 0
  if (oldIndex && oldIndex.formatVersion === PACK_FORMAT_VERSION && oldIndex.dims > 0) {
    const carried: IndexFile = { ...oldIndex, docs: {} }
    for (const doc of docs) {
      const oldDocId = oldHashes.get(hashes.get(doc.id) ?? '')
      const entry = oldDocId ? oldIndex.docs[oldDocId] : undefined
      if (entry) {
        carried.docs[doc.id] = entry
        carriedChunks += entry.chunkCount
      }
    }
    if (carriedChunks > 0) await writeFileAtomic(join(staging, 'index.json'), JSON.stringify(carried))
  }

  await fs.rm(dir, { recursive: true, force: true })
  await fs.rename(staging, dir)
  packs.delete(id)
  invalidateBm25()
  const pack = (await packSummary(id))!
  // Against the carried index, not the summary's embeddedChunks: the latter
  // counts vectors *for the currently resolvable model* and reads 0 whenever
  // LM Studio is unreachable, which would misreport a fully-carried update.
  return { pack, carriedChunks, missingChunks: Math.max(0, pack.chunks - carriedChunks) }
}

export interface FreshnessReport {
  /** Whether this pack can be checked at all (user pack with a tracked folder that still exists). */
  supported: boolean
  /** True when nothing observable changed. Meaningless when !supported. */
  fresh: boolean
  missingFolder: boolean
  /** Files in the folder now that the pack has no document for. */
  added: number
  /** Documents whose original file is gone. */
  removed: number
  /** Documents whose original file has a different size or mtime. */
  changed: number
  /** A few example file names, for the UI line. */
  examples: string[]
}

/**
 * Has a user pack's source folder drifted from the snapshot? stat-only — file
 * list plus size/mtime against what stageFolderDocs recorded — so it is cheap
 * enough to run when the Library tab opens. mtime is a hint, not proof: a
 * touched-but-identical file reads as changed, and the update that follows
 * resolves it properly by content hash (its vectors carry over regardless).
 * Documents from packs built before v1.7 have no recorded stat and compare by
 * existence only.
 */
export async function checkPackFreshness(id: string): Promise<FreshnessReport> {
  const none: FreshnessReport = { supported: false, fresh: true, missingFolder: false, added: 0, removed: 0, changed: 0, examples: [] }
  const raw = await readJson<unknown>(join(packDir(id), 'manifest.json'))
  if (!raw) return none
  let manifest: PackManifest
  try {
    manifest = validateManifest(raw)
  } catch {
    return none
  }
  if (manifest.kind !== 'user' || !manifest.sourceFolder) return none
  if (!(await pathExists(manifest.sourceFolder))) {
    return { supported: true, fresh: false, missingFolder: true, added: 0, removed: manifest.docs.length, changed: 0, examples: [] }
  }

  const current = new Set(await walkFolder(manifest.sourceFolder))
  const known = new Set(manifest.docs.map((d) => d.source).filter((s): s is string => Boolean(s)))
  const examples: string[] = []
  const note = (file: string): void => {
    if (examples.length < 3) examples.push(basename(file))
  }

  let added = 0
  for (const file of current) {
    if (!known.has(file)) {
      added += 1
      note(file)
    }
  }
  let removed = 0
  let changed = 0
  for (const doc of manifest.docs) {
    if (!doc.source) continue
    if (!current.has(doc.source)) {
      removed += 1
      note(doc.source)
      continue
    }
    if (doc.sourceMtime === undefined && doc.sourceSize === undefined) continue // pre-v1.7 doc: existence is all we can compare
    try {
      const stat = await fs.stat(doc.source)
      if ((doc.sourceSize !== undefined && stat.size !== doc.sourceSize) ||
          (doc.sourceMtime !== undefined && Math.round(stat.mtimeMs) !== doc.sourceMtime)) {
        changed += 1
        note(doc.source)
      }
    } catch {
      removed += 1
      note(doc.source)
    }
  }
  return { supported: true, fresh: added + removed + changed === 0, missingFolder: false, added, removed, changed, examples }
}

// ---- bundled curated packs (v1.7.1) ---------------------------------------------

/** A curated pack shipped inside the app, not yet necessarily installed. */
export interface BundledPackInfo {
  id: string
  name: string
  description: string
  version: string
  license: string
  docs: number
  /** Is a pack with this id currently installed in the library? */
  installed: boolean
  /** The installed copy's version, when it differs it shows as updatable. */
  installedVersion: string | null
}

let bundledDirOverride: string | null = null

export function setBundledPacksDirForTests(dir: string | null): void {
  bundledDirOverride = dir
}

/**
 * Where the curated packs shipped with the app live. Same resolution story as
 * the Pyodide runtime (workbench.ts): resourcesPath when packaged, and a
 * candidate list in dev — app.getAppPath() is not the repo when the built
 * main is loaded by a wrapper, which is exactly how the CDP verification
 * harness runs it, so __dirname/../.. (out/main → repo root) is the fallback.
 * Before v1.7.1 the curated tranche existed only in the repo — an installed
 * app had an empty Almanac and no offline way to fill it.
 */
export function bundledPacksDir(): string {
  if (bundledDirOverride) return bundledDirOverride
  if (app.isPackaged) return join(process.resourcesPath, 'packs')
  const candidates = [join(app.getAppPath(), 'packs'), join(__dirname, '..', '..', 'packs')]
  for (const c of candidates) if (existsSync(join(c, 'first-aid', 'manifest.json'))) return c
  return candidates[0]
}

export async function listBundledPacks(): Promise<BundledPackInfo[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(bundledPacksDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const out: BundledPackInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !PACK_ID_RE.test(e.name)) continue
    const raw = await readJson<unknown>(join(bundledPacksDir(), e.name, 'manifest.json'))
    if (!raw) continue
    let manifest: PackManifest
    try {
      manifest = validateManifest(raw)
    } catch {
      continue
    }
    const installedManifest = await readJson<unknown>(join(packDir(manifest.id), 'manifest.json'))
    let installedVersion: string | null = null
    if (installedManifest) {
      try {
        installedVersion = validateManifest(installedManifest).version
      } catch {
        installedVersion = 'unknown'
      }
    }
    out.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      license: manifest.license,
      docs: manifest.docs.length,
      installed: installedManifest !== null,
      installedVersion
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Install (or update) one bundled pack into the library. Local disk to local disk. */
export async function installBundledPack(id: string): Promise<PackSummary> {
  if (!PACK_ID_RE.test(id)) throw new Error(`Invalid pack id "${id}".`)
  const dir = join(bundledPacksDir(), id)
  if (!(await pathExists(join(dir, 'manifest.json')))) {
    throw new Error(`No bundled pack "${id}" in this build.`)
  }
  return installPackFromDirectory(dir, { replace: true })
}

export async function removePack(id: string): Promise<{ removed: boolean }> {
  if (!PACK_ID_RE.test(id)) return { removed: false }
  const dir = packDir(id)
  const existed = await pathExists(dir)
  await fs.rm(dir, { recursive: true, force: true })
  // v2.8: a ZIM pack's file is the user's; only the pointer goes, and the reader closes.
  await packs.get(id)?.zim?.close()
  packs.delete(id)
  invalidateBm25()
  return { removed: existed }
}

/**
 * v2.8: register a ZIM file as a pack. Nothing is copied — the file stays
 * where it is and the manifest points at it; the pack's name and description
 * come from the file's own metadata.
 */
export async function registerZimPack(path: string): Promise<PackSummary> {
  const zimPath = resolve(path)
  const zim = await ZimFile.open(zimPath)
  let title: string | null
  let description: string | null
  let date: string | null
  try {
    title = await zim.metadata('Title')
    description = await zim.metadata('Description')
    date = await zim.metadata('Date')
  } finally {
    await zim.close()
  }
  const base = basename(zimPath).replace(/\.zim$/i, '')
  const id = `zim-${slugify(base)}`.slice(0, 64)
  const manifest: PackManifest = {
    formatVersion: PACK_FORMAT_VERSION,
    id,
    name: (title ?? base).trim() || base,
    description: (description ?? '').trim(),
    version: (date ?? '').trim() || '0',
    license: 'as stated inside the ZIM file',
    kind: 'zim',
    zimPath,
    sourceNote: `Read on demand from ${zimPath}; ${zim.header.entryCount.toLocaleString('en-US')} entries.`,
    installedAt: new Date().toISOString(),
    docs: []
  }
  const dir = packDir(id)
  await fs.mkdir(dir, { recursive: true })
  await writeFileAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await packs.get(id)?.zim?.close()
  packs.delete(id)
  invalidateBm25()
  return (await packSummary(id))!
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
    sourceFolder: pack.manifest.sourceFolder,
    ...(pack.manifest.zimPath ? { zimPath: pack.manifest.zimPath } : {}),
    installedAt: pack.manifest.installedAt,
    docs: pack.zim ? pack.zim.header.entryCount : pack.docs.size,
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
  return { packs: packs.size, docs, chunks, chars: loadedChars(), embeddedChunks, scanned: isScanned() }
}
