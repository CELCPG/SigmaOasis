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
 *
 * v4.2 (L1): this file is the facade. At 1,750 lines it held six jobs, and
 * the ranking work of 4.2 would have landed in the middle of all of them, so
 * it is split along its own seams under ./library/ with behaviour unchanged:
 *   types.ts     — the shapes and bounds
 *   state.ts     — the RAM singletons (loaded packs, the BM25 index)
 *   manifest.ts  — manifest validation
 *   loading.ts   — disk → RAM: headings, section chunks, stored vectors
 *   lookup.ts    — retrieval: ranking, fusion, floor, passage selection
 *   format.ts    — what the model reads: citations and the formatted lookup
 *   packs.ts     — install, folder packs, the app pack, bundled packs, ZIM
 *   embedJob.ts  — the embedding job
 *   ipc.ts       — the IPC handlers
 * Callers and tests import from here, so the public API is exactly what it was.
 */

export {
  PACK_FORMAT_VERSION,
  MAX_DOC_CHARS,
  MAX_PACK_CHARS,
  MAX_PACK_DOCS,
  MAX_LIBRARY_CHARS,
  MAX_LOOKUP_PASSAGES
} from './library/types'
export type { PackDocMeta, PackManifest, LibraryPassage, LookupOutcome, PackSummary } from './library/types'
export { libraryDir, setLibraryDirForTests } from './library/state'
export { validateManifest } from './library/manifest'
export { chunkDocumentSections } from './library/loading'
export { lookupLibrary } from './library/lookup'
export { citationOf, staleYearNote, formatLookup } from './library/format'
export {
  installPackFromDirectory,
  readAppPack,
  writeAppPack,
  createPackFromFolder,
  updatePackFromFolder,
  checkPackFreshness,
  setBundledPacksDirForTests,
  bundledPacksDir,
  listBundledPacks,
  installBundledPack,
  removePack,
  registerZimPack,
  listPacks,
  libraryStats
} from './library/packs'
export type { AppPackDoc, UpdateOutcome, FreshnessReport, BundledPackInfo } from './library/packs'
export { embedPack } from './library/embedJob'
export { registerLibraryHandlers } from './library/ipc'
