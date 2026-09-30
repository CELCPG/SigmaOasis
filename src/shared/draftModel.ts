/**
 * v4.2 (S8): draft-model (speculative) decoding, the parts both processes share.
 *
 * LM Studio's `/v1/chat/completions` takes a `draft_model` field: a small
 * model of the same family proposes tokens and the main model verifies them
 * in one pass. It helps a dense model with a much smaller sibling. It does not
 * help the 9B distill, which already drafts through MTP set in LM Studio's own
 * per-model config — so the setting is per role, absent by default, and
 * nothing here turns it on.
 *
 * What the server does with the field is not pinned down anywhere we can
 * read: an older build may ignore it, a mismatched pair (different
 * tokenizers) is refused, and the acceptance figures ride different keys on
 * different builds. Everything below reads defensively and degrades to "no
 * draft", never to a failed turn.
 *
 * Pure: no fetch, no store. Both processes import it.
 */

/** A role's draft model as stored: a trimmed id, never the role's own model. */
export function normalizeDraftModel(value: unknown, modelId: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim().slice(0, 256)
  // Drafting a model with itself costs a second copy and buys nothing.
  return id && id !== modelId.trim() ? id : undefined
}

/**
 * The draft model for requests to `modelId`: the first enabled role on that
 * model that names one. Keyed by model, as the keep-loaded pin is, because
 * every call to the model (the answer, the critic, the claim check) benefits
 * alike and none of them carries its role.
 */
export function draftModelFor(
  modelId: string,
  slots: readonly { modelId: string; enabled: boolean; draftModel?: string }[] | undefined
): string | undefined {
  const hit = (slots ?? []).find((s) => s.enabled && s.modelId === modelId && s.draftModel)
  return hit ? normalizeDraftModel(hit.draftModel, modelId) : undefined
}

/** Does this server error read as a refusal of the draft model? Only asked when one was sent. */
export function isDraftRejection(text: string | null | undefined): boolean {
  return typeof text === 'string' && /draft|speculative/i.test(text)
}

/** The request body again without `draft_model`; null when it had none (nothing to retry). */
export function withoutDraft(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || !('draft_model' in parsed)) return null
    delete parsed.draft_model
    return JSON.stringify(parsed)
  } catch {
    return null
  }
}

export interface DraftAcceptance {
  /** Draft tokens the main model kept. */
  accepted: number
  /** Draft tokens proposed (accepted + rejected, or the server's own total). */
  drafted: number
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/**
 * Acceptance figures from one parsed stream frame, wherever this server put
 * them; null when it reported none. Read, in order:
 *
 *   - LM Studio's own stats block (`stats.accepted_draft_tokens_count`,
 *     `rejected_…`, `total_draft_tokens_count`), top level or under `usage`;
 *   - OpenAI's predicted-output shape
 *     (`usage.completion_tokens_details.accepted_prediction_tokens` / `rejected_…`).
 *
 * A frame that names none of them says nothing — not zero acceptance.
 */
export function draftAcceptance(frame: unknown): DraftAcceptance | null {
  if (!frame || typeof frame !== 'object') return null
  const f = frame as { stats?: Record<string, unknown>; usage?: Record<string, unknown> & { completion_tokens_details?: Record<string, unknown> } }
  for (const block of [f.stats, f.usage]) {
    if (!block || typeof block !== 'object') continue
    const accepted = count(block.accepted_draft_tokens_count)
    if (accepted === undefined) continue
    const total = count(block.total_draft_tokens_count)
    const rejected = count(block.rejected_draft_tokens_count)
    const drafted = total ?? (rejected !== undefined ? accepted + rejected : undefined)
    if (drafted !== undefined && drafted >= accepted) return { accepted, drafted }
  }
  const details = f.usage?.completion_tokens_details
  if (details && typeof details === 'object') {
    const accepted = count(details.accepted_prediction_tokens)
    const rejected = count(details.rejected_prediction_tokens)
    // Both zero is what a server without drafting fills in; it is not a measurement.
    if (accepted !== undefined && rejected !== undefined && accepted + rejected > 0) return { accepted, drafted: accepted + rejected }
  }
  return null
}

/** Two rounds' figures as one turn's. */
export function addAcceptance(a: DraftAcceptance | undefined, b: DraftAcceptance | null | undefined): DraftAcceptance | undefined {
  if (!b) return a
  return a ? { accepted: a.accepted + b.accepted, drafted: a.drafted + b.drafted } : { ...b }
}

/** "62% of 480 drafted accepted"; empty when nothing was drafted. */
export function formatAcceptance(d: DraftAcceptance | undefined): string {
  if (!d || d.drafted <= 0) return ''
  return `${Math.round((d.accepted / d.drafted) * 100)}% of ${d.drafted.toLocaleString('en-US')} drafted accepted`
}
