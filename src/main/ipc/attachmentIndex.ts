import { getIndexedPage, indexPage, retrievePassages } from './researchIndex'
import { readTextDocument } from './attachments'

/**
 * Attached documents, retrieved by relevance instead of truncated.
 *
 * Through v1.4.7 a text or PDF attachment was cut at 20,000 characters and the
 * rest silently dropped — a 60-page PDF lost nine tenths of itself and the
 * model answered from the table of contents. Now a long attachment keeps a
 * short head inline (so the model knows what the document *is*) and the whole
 * text goes into the same hybrid BM25 + embedding index fetched web pages use
 * (researchIndex.ts), pinned so it outlives the 30-minute page TTL. Every later
 * turn retrieves the passages most relevant to what the user just asked and
 * hands them to the model as app-supplied context, alongside memory recall.
 *
 * RAM only, like the rest of the index: the file's text is never written to
 * disk by the app. After a restart the index is empty, so a retrieval miss
 * re-reads the file from its original path — the user's own file, on the
 * user's own machine — and re-indexes it. If the file has moved, the model
 * gets the inline head plus a note saying the rest is unavailable, which is
 * still strictly more than it had before.
 */

export interface AttachmentRef {
  id: string
  name: string
  /** Absolute path the attachment was loaded from; used to re-index after a restart. */
  sourcePath?: string
}

export interface AttachmentPassage {
  attachmentId: string
  name: string
  text: string
  /** 0 (start) .. 1 (end) of the document. */
  position: number
  /** Fused relevance, 0..1 within this result set. */
  score: number
}

export interface AttachmentPassagesOutcome {
  ok: boolean
  passages: AttachmentPassage[]
  notes: string[]
}

/** Characters read back when re-indexing from disk. Matches readTextDocument's callers' ceiling. */
const REINDEX_MAX_CHARS = 8_000_000
/** Passages considered per document before the cross-document merge. */
const PER_DOC_CANDIDATES = 4

function keyFor(id: string): string {
  return `attachment:${id}`
}

/** Index (or re-index) an attachment's full text. Returns chunk count. */
export function indexAttachment(input: {
  id: string
  name: string
  text: string
  kind: 'text' | 'pdf'
}): { chunks: number } {
  const page = indexPage({
    key: keyFor(input.id),
    url: `attachment://${input.id}`,
    title: input.name,
    text: input.text,
    truncated: false,
    kind: input.kind,
    mainContentFound: true,
    pinned: true
  })
  return { chunks: page.chunks.length }
}

export function isAttachmentIndexed(id: string): boolean {
  return getIndexedPage(keyFor(id)) !== null
}

/**
 * Retrieve the passages across the given attachments most relevant to
 * `query`. Documents missing from the index are re-read from `sourcePath` when
 * possible; those that cannot be recovered are reported in `notes`.
 */
export async function retrieveAttachmentPassages(
  refs: AttachmentRef[],
  query: string,
  topK: number
): Promise<AttachmentPassagesOutcome> {
  const notes: string[] = []
  const collected: AttachmentPassage[] = []
  const trimmedQuery = query.trim()
  if (!trimmedQuery || refs.length === 0) return { ok: true, passages: [], notes }

  for (const ref of refs) {
    let page = getIndexedPage(keyFor(ref.id))
    if (!page && ref.sourcePath) {
      try {
        const doc = await readTextDocument(ref.sourcePath, REINDEX_MAX_CHARS)
        indexAttachment({
          id: ref.id,
          name: ref.name,
          text: doc.text,
          kind: ref.sourcePath.toLowerCase().endsWith('.pdf') ? 'pdf' : 'text'
        })
        page = getIndexedPage(keyFor(ref.id))
      } catch (err) {
        notes.push(
          `"${ref.name}" could not be re-read from ${ref.sourcePath} (${err instanceof Error ? err.message : String(err)}); only its opening is available.`
        )
        continue
      }
    }
    if (!page) {
      notes.push(`"${ref.name}" is not indexed in this session; only its opening is available.`)
      continue
    }
    const outcome = await retrievePassages(page, trimmedQuery, Math.max(PER_DOC_CANDIDATES, topK))
    for (const note of outcome.notes) if (!notes.includes(note)) notes.push(note)
    for (const p of outcome.passages) {
      collected.push({
        attachmentId: ref.id,
        name: ref.name,
        text: p.text,
        position: p.position,
        score: p.score
      })
    }
  }

  // Merge across documents by fused score, keep the best topK, then restore
  // reading order within each document so a passage sequence still reads as
  // the document wrote it.
  const best = collected.sort((a, b) => b.score - a.score).slice(0, topK)
  const order = new Map(refs.map((r, i) => [r.id, i]))
  best.sort(
    (a, b) =>
      (order.get(a.attachmentId) ?? 0) - (order.get(b.attachmentId) ?? 0) || a.position - b.position
  )
  return { ok: true, passages: best, notes }
}

/**
 * Format retrieved passages as the model sees them. Position is given as a
 * percentage so a citation like "about 40% in" is possible without page
 * numbers, which extracted text does not reliably carry.
 */
export function formatAttachmentPassages(passages: AttachmentPassage[]): string {
  return passages
    .map(
      (p) =>
        `--- ${p.name} · ${Math.round(p.position * 100)}% into the document · relevance ${p.score} ---\n${p.text}`
    )
    .join('\n\n')
}
