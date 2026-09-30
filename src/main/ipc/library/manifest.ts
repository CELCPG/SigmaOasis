import { basename, extname } from 'path'
import { DOC_EXTENSIONS, DOC_ID_RE, MAX_PACK_DOCS, PACK_FORMAT_VERSION, PACK_ID_RE } from './types'
import type { PackDocMeta, PackManifest } from './types'

// v4.2 (L1): manifest validation, split out of library.ts unchanged.

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** v4.1 (G5): a document's year — a whole number a calendar could hold, or nothing. */
function yearOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1900 && v <= 2200 ? v : undefined
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
  const isZim = m.kind === 'zim'
  if (!Array.isArray(m.docs) || (m.docs.length === 0 && !isZim)) throw new Error('Pack manifest lists no documents.')
  if (isZim && !str(m.zimPath).trim()) throw new Error('A zim pack needs zimPath.')
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
      ...(yearOf(doc.appliesToYear) !== undefined ? { appliesToYear: yearOf(doc.appliesToYear) } : {}),
      file,
      chars: typeof doc.chars === 'number' && Number.isFinite(doc.chars) ? doc.chars : 0,
      sourceMtime: num(doc.sourceMtime),
      sourceSize: num(doc.sourceSize),
      ...(num(doc.checkedAt) !== undefined ? { checkedAt: num(doc.checkedAt) } : {}),
      ...(doc.expiresAt === null ? { expiresAt: null } : num(doc.expiresAt) !== undefined ? { expiresAt: num(doc.expiresAt) } : {}),
      ...(num(doc.recheckedAt) !== undefined ? { recheckedAt: num(doc.recheckedAt) } : {}),
      ...(num(doc.recheckFailures) !== undefined ? { recheckFailures: num(doc.recheckFailures) } : {}),
      ...(doc.claim && typeof doc.claim === 'object'
        ? {
            claim: {
              key: str((doc.claim as Record<string, unknown>).key),
              claimClass: str((doc.claim as Record<string, unknown>).claimClass),
              value: str((doc.claim as Record<string, unknown>).value)
            }
          }
        : {})
    }
  })
  return {
    formatVersion: PACK_FORMAT_VERSION,
    id,
    name,
    description: str(m.description).trim(),
    version: str(m.version).trim() || '0',
    license: str(m.license).trim() || 'unspecified',
    kind: m.kind === 'user' ? 'user' : m.kind === 'app' ? 'app' : m.kind === 'zim' ? 'zim' : 'curated',
    ...(isZim ? { zimPath: str(m.zimPath).trim() } : {}),
    sourceNote: str(m.sourceNote) || undefined,
    sourceFolder: str(m.sourceFolder) || undefined,
    installedAt: str(m.installedAt) || new Date().toISOString(),
    docs
  }
}
