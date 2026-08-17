import type { Attachment, AttachmentPassage, AttachmentRef, Conversation, MemoryContextItem } from '../types'

/**
 * v1.4.8: per-turn retrieval over long attachments — the renderer half.
 *
 * A text or PDF attachment longer than the inline limit keeps its opening in
 * the message and its whole text in the main process's session index
 * (main/ipc/attachmentIndex.ts). Each turn, the passages most relevant to the
 * user's latest message are retrieved and ride the turn's context notes, the
 * same slot memory recall uses. Headless so the labelling and the block the
 * model sees are pinned by tests.
 */

/** Passages retrieved per turn across all indexed attachments. */
export const ATTACHMENT_PASSAGES_PER_TURN = 6

/**
 * v1.6: every file attachment with a known path, latest first wins on a name
 * clash — what the Workbench stages under /work for run_python/analyze_file.
 */
export function attachmentFileRefs(convo: Pick<Conversation, 'messages'>): { name: string; sourcePath: string }[] {
  const byName = new Map<string, string>()
  for (const m of convo.messages) {
    for (const a of m.attachments ?? []) {
      if (a.kind === 'file' && a.sourcePath) byName.set(a.name, a.sourcePath)
    }
  }
  return [...byName].map(([name, sourcePath]) => ({ name, sourcePath }))
}

/** Attachments the app profiles automatically on the turn they arrive. */
/**
 * The one test for "this attachment is data, not prose". Shared by staging
 * (/work), by playbook selection and by the pre-flight router — it had drifted
 * into two slightly different copies, which is how a file routes one way and
 * gets profiled another.
 */
export const TABULAR_FILE = /\.(csv|tsv|xlsx|xlsm|json|jsonl|parquet)$/i

/** Tabular attachments on the latest user message, for the automatic analyze_file. */
export function tabularAttachmentsOnTurn(convo: Pick<Conversation, 'messages'>): string[] {
  const last = [...convo.messages].reverse().find((m) => m.role === 'user')
  return (last?.attachments ?? []).filter((a) => a.kind === 'file' && a.sourcePath && TABULAR_FILE.test(a.name)).map((a) => a.name)
}

/** Every indexed attachment in the conversation, in message order, deduplicated by id. */
export function indexedAttachmentRefs(convo: Pick<Conversation, 'messages'>): AttachmentRef[] {
  const seen = new Set<string>()
  const refs: AttachmentRef[] = []
  for (const m of convo.messages) {
    for (const a of m.attachments ?? []) {
      if (a.kind !== 'file' || !a.indexed || seen.has(a.id)) continue
      seen.add(a.id)
      refs.push({ id: a.id, name: a.name, sourcePath: a.sourcePath })
    }
  }
  return refs
}

/**
 * How an inlined text attachment is labelled for the model. An indexed
 * document says exactly what is and is not in front of the model, and where
 * the rest comes from — a small model that reads "truncated" alone tends to
 * either apologize for missing content it was given, or invent it.
 */
export function attachmentInlineNote(f: Pick<Attachment, 'truncated' | 'indexed' | 'totalChars'> & Partial<Pick<Attachment, 'dataFile' | 'tabular' | 'name'>>): string {
  if (f.tabular) {
    return (
      ` — a data file of ${(f.totalChars ?? 0).toLocaleString('en-US')} characters; only its first lines are shown here so you can see the columns. ` +
      `The whole file is at /work/${f.name} for run_python and analyze_file — compute on it there; never total or count from these lines`
    )
  }
  if (f.dataFile) {
    return (
      ` — a data file (${f.name}); its contents are not shown here. It is available to run_python ` +
      `and analyze_file at /work/${f.name}; the app has profiled it if it was just attached`
    )
  }
  if (!f.truncated) return TABULAR_FILE.test(f.name ?? '') ? ` — also available to run_python and analyze_file at /work/${f.name}` : ''
  if (f.indexed && f.totalChars) {
    return (
      ` — ${f.totalChars.toLocaleString('en-US')} characters in total; only the opening is shown here. ` +
      'The passages of this document most relevant to each question are supplied in the notes the ' +
      'app appends to the latest message — use those, and never guess at parts of the document ' +
      'you were not given'
    )
  }
  return ' — truncated'
}

/** The turn-context block carrying retrieved passages (and any retrieval notes). */
export function buildAttachmentContext(passages: AttachmentPassage[], notes: string[]): string | null {
  const blocks: string[] = []
  if (passages.length > 0) {
    blocks.push(
      'Passages from the document(s) the user attached, chosen for their relevance to this ' +
        'message (position is how far into the document the passage sits). Quote or cite these ' +
        'when answering about the document; if what is needed is not here, say the passages you ' +
        'were given do not cover it — do not invent document content:\n' +
        passages
          .map(
            (p) =>
              `--- ${p.name} · ${Math.round(p.position * 100)}% in · relevance ${p.score} ---\n${p.text}`
          )
          .join('\n\n')
    )
  }
  for (const note of notes) blocks.push(`Note: ${note}`)
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

/** What the bubble shows under the reply — mechanical, exactly what was sent. */
export function toAttachmentContextItems(passages: AttachmentPassage[]): MemoryContextItem[] {
  return passages.map((p) => ({
    source: `${p.name} · ${Math.round(p.position * 100)}% in`,
    score: p.score,
    text: p.text
  }))
}
