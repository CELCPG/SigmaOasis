import { app } from 'electron'
import { join } from 'path'
import { Bm25Index } from '../retrieval'
import type { LoadedPack } from './types'

// v4.2 (L1): the library's RAM state, split out of library.ts unchanged. One
// module owns the mutable singletons so every sibling reads the same packs and
// the same BM25 index; the two `let`s become accessors because an ES import
// binding cannot be assigned from another module.

export const packs = new Map<string, LoadedPack>()
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

export function packDir(id: string): string {
  return join(libraryDir(), id)
}

export function invalidateBm25(): void {
  globalBm25 = null
}

export function bm25(): Bm25Index {
  if (!globalBm25) {
    const docs: { id: string; terms: string[] }[] = []
    for (const pack of packs.values()) for (const c of pack.chunks) docs.push({ id: c.id, terms: c.terms })
    globalBm25 = new Bm25Index(docs)
  }
  return globalBm25
}

export function loadedChars(): number {
  let total = 0
  for (const pack of packs.values()) for (const doc of pack.docs.values()) total += doc.text.length
  return total
}

/** Whether a whole-library load has run (libraryStats reports it). */
export function markScanned(): void {
  libraryScanned = true
}

export function isScanned(): boolean {
  return libraryScanned
}
