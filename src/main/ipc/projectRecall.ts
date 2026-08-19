import { getIndexedPage, indexPage, lexicalEvidence, retrievePassages } from './researchIndex'
import { tokenize } from './retrieval'

/**
 * v1.10 project-wide recall: a chat in a project can recall what the project's
 * *other* chats established. Each sibling conversation is rendered to a plain
 * transcript and indexed in the same RAM hybrid (BM25 + embedding) index that
 * fetched pages and attached documents use, pinned so it outlives the page
 * TTL; per turn, the passages most relevant to the user's message are handed
 * to the model as app-supplied context, recorded on the reply like memory
 * recall so the user sees exactly what was surfaced.
 *
 * The main process reads the sibling conversations from their JSON files
 * itself — the renderer sends ids, not transcripts — and re-indexes a chat
 * only when its `updatedAt` moved. Ephemeral chats are never on disk, so they
 * are never recallable, which is the no-trace promise holding by construction.
 */

/** The slice of a stored conversation this module reads. Kept structural so the pure parts are testable. */
export interface StoredConversationLike {
  id: string
  title: string
  updatedAt: number
  summary?: { text: string } | null
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    roleName?: string
    marker?: string
  }>
}

export interface ProjectRecallItem {
  conversationId: string
  title: string
  text: string
  /** 0 (start) .. 1 (end) of the transcript. */
  position: number
  score: number
}

export interface ProjectRecallOutcome {
  ok: boolean
  items: ProjectRecallItem[]
  /** How many sibling chats were consulted (existed on disk). */
  consulted: number
  error?: string
}

/** Characters of one message kept in the transcript; a pasted wall of text is not what a sibling chat "established". */
const MAX_MESSAGE_CHARS = 4000
/** Transcript ceiling per chat — the index chunks it; this bounds embedding work. */
const MAX_TRANSCRIPT_CHARS = 400_000
/** Candidates per chat before the cross-chat merge. */
const PER_CHAT_CANDIDATES = 3
/** A chat's second and later passages must score at least this (within-chat, 0..1) to ride along. */
const MIN_SECONDARY_SCORE = 0.1

function keyFor(id: string): string {
  return `conversation:${id}`
}

/**
 * Render a conversation as the text a sibling chat may recall from. Markers
 * (rollback notices) and reasoning never appear; a compaction summary leads,
 * because it is the distilled form of what the chat covered.
 */
export function conversationTranscript(c: StoredConversationLike): string {
  const parts: string[] = []
  if (c.summary?.text) parts.push(`Summary of earlier discussion:\n${c.summary.text}`)
  for (const m of c.messages) {
    if (m.marker) continue
    const body = (m.content ?? '').trim()
    if (!body) continue
    const who = m.role === 'user' ? 'User' : m.roleName ? `Assistant (${m.roleName})` : 'Assistant'
    parts.push(`${who}: ${body.length > MAX_MESSAGE_CHARS ? `${body.slice(0, MAX_MESSAGE_CHARS)}…` : body}`)
  }
  const text = parts.join('\n\n')
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS) : text
}

/** updatedAt of the version currently indexed, per conversation id. */
const indexedVersions = new Map<string, number>()

/** Index (or refresh) one conversation. Returns false when there is nothing to index. */
export function indexConversation(c: StoredConversationLike): boolean {
  const text = conversationTranscript(c)
  if (!text.trim()) {
    indexedVersions.delete(c.id)
    return false
  }
  const existing = getIndexedPage(keyFor(c.id))
  if (existing && indexedVersions.get(c.id) === c.updatedAt) return true
  indexPage({
    key: keyFor(c.id),
    url: `conversation://${c.id}`,
    title: c.title,
    text,
    truncated: false,
    kind: 'text',
    mainContentFound: true,
    pinned: true
  })
  indexedVersions.set(c.id, c.updatedAt)
  return true
}

/** Test/maintenance hook: forget what has been indexed (the index itself is cleared elsewhere). */
export function resetProjectRecallCache(): void {
  indexedVersions.clear()
}

/**
 * Recall from the given sibling conversations. `load` resolves an id to its
 * stored conversation, or null when it is not on disk (deleted, ephemeral).
 */
export async function recallFromConversations(
  load: (id: string) => Promise<StoredConversationLike | null>,
  ids: string[],
  query: string,
  topK: number
): Promise<ProjectRecallOutcome> {
  const trimmed = query.trim()
  const unique = [...new Set(ids.filter((id) => /^[A-Za-z0-9_-]+$/.test(id)))]
  if (!trimmed || unique.length === 0 || topK <= 0) return { ok: true, items: [], consulted: 0 }

  const queryTerms = new Set(tokenize(trimmed))
  // Per chat: its passages and the strength of its lexical evidence.
  const perChat: { id: string; strength: number; items: ProjectRecallItem[] }[] = []
  let consulted = 0
  for (const id of unique) {
    let convo: StoredConversationLike | null = null
    try {
      convo = await load(id)
    } catch {
      convo = null
    }
    if (!convo) continue
    consulted += 1
    if (!indexConversation(convo)) continue
    const page = getIndexedPage(keyFor(id))
    if (!page) continue
    // The gate. retrievePassages always returns something — the head of the
    // page when nothing matches, and in hybrid mode a per-page-normalized
    // ranking of everything — so without this every sibling chat would push
    // a passage into every turn. A chat with no word in common with the
    // message has nothing to recall for it.
    const evidence = lexicalEvidence(page, trimmed)
    if (evidence.length === 0) continue
    const outcome = await retrievePassages(page, trimmed, Math.max(PER_CHAT_CANDIDATES, topK))
    const items: ProjectRecallItem[] = []
    for (const p of outcome.passages) {
      // Same rule per passage: MMR may pick a chunk for diversity that shares
      // no term with the query; it is not evidence of anything.
      if (!tokenize(p.text).some((t) => queryTerms.has(t))) continue
      items.push({ conversationId: id, title: convo.title, text: p.text, position: p.position, score: p.score })
    }
    // Scores are min-max normalized per chat, so the weakest candidate always
    // reads 0.00 — an artifact, not a judgment. Keep the best passage, and
    // any other that scored meaningfully against it.
    items.sort((a, b) => b.score - a.score)
    const kept = items.filter((it, i) => i === 0 || it.score >= MIN_SECONDARY_SCORE)
    if (kept.length > 0) perChat.push({ id, strength: evidence[0]!.score, items: kept })
  }

  // Scores are normalized *within* each chat by retrievePassages, so they do
  // not rank chats against each other. Raw BM25 strength does: the chats with
  // the strongest lexical evidence contribute first, each in reading order,
  // until topK passages are taken.
  perChat.sort((a, b) => b.strength - a.strength)
  const best: ProjectRecallItem[] = []
  for (const chat of perChat) {
    for (const item of chat.items) {
      if (best.length >= topK) break
      best.push(item)
    }
    if (best.length >= topK) break
  }
  const order = new Map(perChat.map((c, i) => [c.id, i]))
  best.sort(
    (a, b) =>
      (order.get(a.conversationId) ?? 0) - (order.get(b.conversationId) ?? 0) ||
      a.position - b.position
  )
  return { ok: true, items: best, consulted }
}

/** The block the model sees. Chat titles are the citations. */
export function formatProjectRecall(items: ProjectRecallItem[]): string {
  return items
    .map((i) => `--- from the chat "${i.title}" · relevance ${i.score} ---\n${i.text}`)
    .join('\n\n')
}
