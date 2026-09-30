import type { ZimFile } from '../zim'

// v4.2 (L1): the library's shapes and bounds, split out of library.ts
// unchanged. Public names are re-exported by ../library.ts; the RAM shapes
// (LibChunk, LoadedDoc, LoadedPack) are shared by the sibling modules only.

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
  /**
   * v4.1 (G5): the year the document's figures are for — a tax year, a limit
   * year. The finance pack states 2025 figures; asked about "this year" in
   * 2026 they answered without the web. Tagged, a lookup names the year beside
   * every passage and warns when it is older than the reader's.
   */
  appliesToYear?: number
  /** File name under docs/. */
  file: string
  /** Characters of normalized text. Filled at install. */
  chars: number
  /**
   * stat of the original file when a user pack was built/updated — what the
   * staleness check compares against, so it never has to read file contents.
   * Absent on curated packs and on user packs built before v1.7.
   */
  sourceMtime?: number
  sourceSize?: number
  /**
   * v2.6: an app-written pack's documents carry the machine-readable check
   * date the free-text `date` never was, and the claim they hold, so the
   * ledger can find an entry by key and the formatter can print `checked:`.
   */
  checkedAt?: number
  /** null = never expires. Absent on documents that are not claims. */
  expiresAt?: number | null
  /**
   * When the ledger job last re-checked this claim against its source, whatever
   * the answer. It orders the job's queue: a claim that no longer holds goes to
   * the back rather than the front of every run.
   */
  recheckedAt?: number
  /**
   * Re-checks in a row that found the source no longer stating this claim. The
   * ledger job drops the claim when it reaches LEDGER_MAX_RECHECK_FAILURES.
   */
  recheckFailures?: number
  claim?: { key: string; claimClass: string; value: string }
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
  /**
   * 'curated' = a downloaded/bundled pack; 'user' = built from the user's own
   * folder; 'app' (v2.6) = written by the app itself — the fact ledger — and
   * offered in the panel with a purge control and nothing else.
   */
  kind: 'curated' | 'user' | 'app' | 'zim'
  /**
   * v2.8: a `zim` pack is a Kiwix ZIM file at this path — offline Wikipedia,
   * WikiMed — retrieved from on demand through its own title index. Nothing
   * is copied; the manifest is a pointer, and `docs` is empty.
   */
  zimPath?: string
  /** Free-text note about sources, freshness, or scope. */
  sourceNote?: string
  /**
   * The folder a `user` pack was built from (resolved path) — what "Update
   * from folder" re-reads and the staleness check walks. Absent on curated
   * packs and on user packs built before v1.7 (those can be updated only by
   * re-adding the folder, which replaces them in place).
   */
  sourceFolder?: string
  /** ISO timestamp of install/creation on this machine. */
  installedAt: string
  docs: PackDocMeta[]
}

export interface IndexFile {
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
  /**
   * Fused relevance, 0..1 within this result set. v4.2: after the wrong-section
   * guard swaps a near-tie the scores stay with the positions; after a model
   * re-rank they are rank-derived (1.0 down to 0.5).
   */
  score: number
  source?: string
  license?: string
  date?: string
  /** v4.1 (G5): the year the document's figures are for, when its pack says. */
  appliesToYear?: number
  /** v2.6: an app-written document's check date, machine-readable. */
  checkedAt?: number
  expiresAt?: number | null
}

export interface LookupOutcome {
  ok: boolean
  passages: LibraryPassage[]
  /** 'hybrid' = keyword + semantic; 'keyword' = BM25 only. */
  mode: 'hybrid' | 'keyword'
  notes: string[]
  error?: string
  /**
   * v4.2 (L2): 'applied' = the answering model re-ranked the candidates;
   * 'fallback' = it was asked and the fused order stood (failure, timeout,
   * nothing usable). Absent when no re-rank was attempted.
   */
  rerank?: 'applied' | 'fallback'
  /** v4.2 (L3): the semantic leg ranked by the question plus a hypothetical answer. */
  expanded?: boolean
}

export interface PackSummary {
  id: string
  name: string
  description: string
  version: string
  license: string
  kind: PackManifest['kind']
  sourceNote?: string
  sourceFolder?: string
  /** v2.8: the ZIM file a `zim` pack reads from; `docs` is then the file's entry count. */
  zimPath?: string
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
/** Passages a lookup may return. */
export const MAX_LOOKUP_PASSAGES = 12

export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
export const DOC_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
export const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])

// ---- RAM shapes ----------------------------------------------------------------

export interface LibChunk {
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

export interface LoadedDoc {
  meta: PackDocMeta
  text: string
  headings: { offset: number; title: string }[]
  chunks: LibChunk[]
}

export interface LoadedPack {
  manifest: PackManifest
  docs: Map<string, LoadedDoc>
  chunks: LibChunk[]
  /** Model the vectors currently attached to chunks belong to. */
  vectorModel: string | null
  /** v2.8: an open ZIM reader. `docs` then holds only the articles the last lookup opened; `chunks` stays empty. */
  zim?: ZimFile
}
