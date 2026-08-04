import type { ModelConfig } from '../types'

/**
 * v0.9 Second Opinion: a *different* role reviews an answer and names the
 * claims it could not verify, plus the check that would settle each.
 *
 * Deliberately not a confidence score: a model grading its own answer returns
 * "yes" nearly always (the same reason deep research checks coverage
 * mechanically). The critic is another slot with its own persona and no stake
 * in the first answer — the cheapest available independent reviewer.
 */

/** Caps keep the review cheap and leave room in the critic's context window. */
const MAX_QUESTION_CHARS = 4000
const MAX_ANSWER_CHARS = 6000

export const CRITIC_INSTRUCTION =
  'You are reviewing another model\'s answer, not your own. Do not praise it and do not ' +
  'summarize it. List only the specific factual claims in the answer that you cannot verify ' +
  'from the conversation alone (names, dates, numbers, versions, quotes, current events), as ' +
  'a short bulleted list. Under each claim, name the one concrete check that would settle it ' +
  '(for example: "verify against the project README" or "needs a web search for the current ' +
  'version"). If every claim is verifiable from the conversation or is plainly opinion, say ' +
  'exactly: "No unverifiable factual claims found." Never output a confidence score or ' +
  'percentage — state what is unverified, not how sure you feel.'

/**
 * Pick the reviewing slot. An explicit choice (Settings → Models) wins when it
 * is usable; otherwise the first enabled slot that is not the answerer. A slot
 * counts as the answerer when both its model and role name match — the same
 * model under a different persona is a legitimate second pair of eyes.
 * Returns null when no second slot exists: the feature degrades honestly
 * rather than asking the answerer to grade itself.
 */
export function pickCritic(
  models: ModelConfig[],
  answerer: { modelId?: string; roleName?: string },
  preferredSlotId: string | null
): ModelConfig | null {
  const usable = models.filter((m) => m.enabled && m.modelId)
  const isAnswerer = (m: ModelConfig): boolean =>
    m.modelId === answerer.modelId && m.roleName === answerer.roleName

  if (preferredSlotId) {
    const preferred = usable.find((m) => m.id === preferredSlotId)
    if (preferred && !isAnswerer(preferred)) return preferred
  }
  return usable.find((m) => !isAnswerer(m)) ?? null
}

/**
 * The two-message review request: the critic's own persona plus the fixed
 * instruction as system, then the question/answer pair as the user turn.
 * No conversation history and no tools — the critic judges what it can see.
 */
export function buildCriticMessages(
  critic: ModelConfig,
  question: string,
  answer: string,
  answererRole: string
): { role: 'system' | 'user'; content: string }[] {
  const q = question.length > MAX_QUESTION_CHARS ? `${question.slice(0, MAX_QUESTION_CHARS)}…` : question
  const a = answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}…` : answer
  return [
    {
      role: 'system',
      content: `${critic.systemPrompt}\n\n${CRITIC_INSTRUCTION}`
    },
    {
      role: 'user',
      content:
        `The user asked:\n"""\n${q}\n"""\n\n` +
        `${answererRole} answered:\n"""\n${a}\n"""\n\n` +
        'List the unverifiable factual claims and the check that would settle each.'
    }
  ]
}
