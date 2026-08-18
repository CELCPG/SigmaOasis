import { isLikelyReasoningModel } from './reasoning'
import type { DeliberationRecord, ModelConfig } from '../types'
import { pickCritic } from './secondOpinion'
import { BREVITY_RULES } from './grounding'

/**
 * v1.5.1 "Think harder": bounded test-time compute for a small model.
 *
 * Draft → review → revise, once. The draft is the reply the turn already
 * produced; a *different* slot reviews it and lists concrete problems (errors,
 * missing steps, unsupported claims); the answerer revises with that list.
 * The revision replaces the draft, and the reply discloses what happened —
 * reviewer, whether it was revised, and the draft and review on demand — so
 * the user sees the process, not a confidence score. No confidence scores,
 * ever, in keeping with second opinions and claim check.
 *
 * When only one slot is enabled the reviewer is the answerer itself. That is
 * weaker — a model grading its own work — so it is labelled as such
 * ("reviewed its own draft") rather than presented as a second opinion, and
 * the user can turn it off. Measured value on 9–30B models comes mostly from
 * the *structure*: reading one's draft as a list of problems catches
 * arithmetic slips and skipped steps that a single pass does not.
 *
 * Bounded: one review, one revision, both capped in length; the revision is
 * refused (draft kept, note shown) when it is empty or when the review found
 * nothing. Never runs on tool-loop turns' intermediate rounds — only on a
 * finished reply.
 */

const MAX_QUESTION_CHARS = 2000
const MAX_DRAFT_CHARS = 8000
const MAX_REVIEW_CHARS = 3000

export const REVIEW_INSTRUCTION =
  'You are reviewing a draft answer to the user\'s question. Do not rewrite it. List the concrete ' +
  'problems, numbered, most serious first: errors of fact or arithmetic (show the correct value if ' +
  'you can), steps that are missing or out of order, claims that are unsupported or overconfident, ' +
  'internal contradictions, and anything that does not answer what was asked. Be specific — quote ' +
  'the phrase you mean. If the draft is sound, write exactly: No substantive problems.'

export const SELF_REVIEW_INSTRUCTION =
  'You wrote a draft answer to the user\'s question. Now read it as a strict reviewer, not as its ' +
  'author. Do not rewrite it. List the concrete problems, numbered, most serious first: errors of ' +
  'fact or arithmetic (show the correct value if you can), steps missing or out of order, claims ' +
  'that are unsupported or overconfident, contradictions, and anything that does not answer what ' +
  'was asked. Quote the phrase you mean. If it is sound, write exactly: No substantive problems.'

export const REVISION_INSTRUCTION =
  'Revise your draft answer using the review below. Fix what the review is right about; keep what ' +
  'it does not challenge; do not add new claims you cannot support; do not mention the review or ' +
  'that this is a revision. Reply with the complete revised answer only.'

/** Who reviews: a different slot when one exists, else the answerer itself (labelled). */
export function pickReviewer(
  models: ModelConfig[],
  answerer: ModelConfig,
  preferredCriticSlotId: string | null
): { slot: ModelConfig; self: boolean } {
  const other = pickCritic(models, { modelId: answerer.modelId, roleName: answerer.roleName }, preferredCriticSlotId)
  return other ? { slot: other, self: false } : { slot: answerer, self: true }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function buildReviewMessages(
  reviewer: ModelConfig,
  question: string,
  draft: string,
  answererRole: string,
  self: boolean
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: `${reviewer.systemPrompt}\n\n${self ? SELF_REVIEW_INSTRUCTION : REVIEW_INSTRUCTION}` },
    {
      role: 'user',
      content:
        `The user asked:\n\n${clip(question, MAX_QUESTION_CHARS)}\n\n` +
        `${self ? 'Your draft answer' : `${answererRole}'s draft answer`}:\n\n${clip(draft, MAX_DRAFT_CHARS)}\n\n` +
        'List the problems, or write "No substantive problems."'
    }
  ]
}

export function buildRevisionMessages(
  answerer: ModelConfig,
  question: string,
  draft: string,
  review: string
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  return [
    { role: 'system', content: `${answerer.systemPrompt}\n\n${BREVITY_RULES}` },
    { role: 'user', content: clip(question, MAX_QUESTION_CHARS) },
    { role: 'assistant', content: clip(draft, MAX_DRAFT_CHARS) },
    { role: 'user', content: `${REVISION_INSTRUCTION}\n\nReview:\n${clip(review, MAX_REVIEW_CHARS)}` }
  ]
}

/** Did the review find anything worth a revision? Mechanical, on the review's text. */
export function reviewFoundProblems(review: string): boolean {
  const t = review.trim()
  if (!t) return false
  if (/^no substantive problems\.?$/i.test(t)) return false
  // A one-line "looks fine" in other words.
  if (t.length < 60 && /\b(no (?:substantive|real|significant|major)? ?(?:problems|issues|errors)|looks (?:good|fine|correct)|is (?:sound|correct))\b/i.test(t)) return false
  return true
}

/** Numbers as written (with separators and decimals), for spotting a changed figure. */
export function numbersIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.match(/(?<![\w.])\d[\d,]*(?:\.\d+)?%?/g) ?? []) out.add(m.replace(/,/g, ''))
  return [...out]
}

/**
 * Figures the revision states that the draft did not, and vice versa. Shown
 * as a note ("figures changed: 12.5 → 12.7") so a corrected number is
 * visible as a correction rather than silently different.
 */
export function figuresChanged(draft: string, revision: string): { added: string[]; removed: string[] } {
  const a = new Set(numbersIn(draft))
  const b = new Set(numbersIn(revision))
  const added = [...b].filter((n) => !a.has(n))
  const removed = [...a].filter((n) => !b.has(n))
  return { added, removed }
}

/** One line for the bubble. */
/**
 * v1.9.1: what the reasoning suite actually measured, said where the feature
 * is offered.
 *
 * The pass was measured twice. On arithmetic (v1.6) it was a null result at
 * 2.6x the latency. On its own ground — 14 multi-step reasoning problems with
 * one checkable answer, including two whose correct answer is IMPOSSIBLE —
 * a reasoning model got 14/14 right first time, no revision broke a correct
 * answer, and the pass changed nothing at 1.6-1.9x the latency. The mechanism
 * is plain: a reasoning model spends its own tokens deliberating before it
 * answers (124 of 128 on a one-word reply, measured), so the internal
 * deliberation IS this pass.
 *
 * The affordance stays — one model and fourteen cases is evidence, not a law,
 * and the review is still visible and still catches nothing harmful. What
 * changes is that it stops implying a benefit that was looked for and not
 * found. Non-reasoning models get the original wording, because for them the
 * question is genuinely open (docs/evals.md records that gap too).
 */
export function thinkHarderNote(modelId: string): string | null {
  // An unrecognised name is not evidence of anything. The classifier is a name
  // heuristic whose documented failure direction is "unknown reads as
  // non-reasoning", which is safe for an additive prompt but not for a claim
  // about what was measured — so say nothing rather than something unearned.
  if (!modelId.trim()) return null
  if (isLikelyReasoningModel(modelId)) {
    return (
      'Measured on this kind of model: it already reasons before answering, and a review pass ' +
      'changed no answer across 14 reasoning problems while costing about 1.7x the time. It is ' +
      'still here, and the review stays visible — but expect no change more often than not.'
    )
  }
  return (
    'Measured on this kind of model: it answers without deliberating first, and a review pass ' +
    'fixed about a quarter of wrong answers (9 of 36 across three runs) while breaking none of ' +
    'the correct ones — for roughly 5x the time. Worth it on a hard question.'
  )
}

export function describeDeliberation(d: DeliberationRecord): string {
  const who = d.self ? 'reviewed its own draft' : `reviewed by ${d.reviewerRole}`
  if (d.status === 'reviewing') return `🧠 Thinking harder — ${d.self ? 'self-review' : `review by ${d.reviewerRole}`} in progress…`
  if (d.status === 'revising') return `🧠 Thinking harder — revising after ${d.self ? 'self-review' : `review by ${d.reviewerRole}`}…`
  if (d.status === 'error') return `🧠 Think harder failed: ${d.note ?? 'unknown error'}`
  if (!d.revised) return `🧠 Deliberated — ${who}: no substantive problems found; draft kept.`
  return `🧠 Deliberated — ${who}, revised.${d.note ? ` ${d.note}` : ''}`
}
