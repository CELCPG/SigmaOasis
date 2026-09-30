import { chatCompleteJson } from '../llm'
import type { ResearchPlan, SubQuestion } from './types'

// ---- planning ----------------------------------------------------------------

const MAX_SUB_QUESTIONS = 5
const MAX_QUERIES_PER_SUB = 2

/**
 * Grammar-enforced plan shape (llama.cpp structured output). The tolerant
 * parsePlan below stays as the safety net for servers without schema support,
 * but with the constraint active the near-miss JSON small models produce —
 * trailing commas, missing keys, prose around the object — cannot be emitted
 * at all.
 */
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    subQuestions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SUB_QUESTIONS,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          queries: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_QUERIES_PER_SUB,
            items: { type: 'string' }
          }
        },
        required: ['question', 'queries'],
        additionalProperties: false
      }
    }
  },
  required: ['subQuestions'],
  additionalProperties: false
} as const

const PLANNER_SYSTEM = `You are a research planner. Break the user's question into independent sub-questions, and for each give web search queries.

Rules:
- 2 to ${MAX_SUB_QUESTIONS} sub-questions. Fewer for simple questions.
- 1 to ${MAX_QUERIES_PER_SUB} queries per sub-question.
- Queries are search-engine keywords, NOT sentences. No personal data, no file paths, no names of people unless the question is about them.
- Respond with JSON only, in exactly this shape:
{"subQuestions":[{"question":"...","queries":["...","..."]}]}`

/**
 * Coerce whatever the model returned into a usable plan.
 *
 * Small local models produce near-misses constantly: a bare array, a `queries`
 * string instead of an array, extra keys, missing keys. Salvaging those is worth
 * more than rejecting them, because the alternative is the whole tool failing on
 * a model that was one comma away from correct. Returns null only when there is
 * genuinely nothing to work with.
 */
export function parsePlan(raw: unknown, fallbackQuestion: string): ResearchPlan | null {
  const container =
    Array.isArray(raw) ? { subQuestions: raw } : (raw as { subQuestions?: unknown } | null)
  const list = container?.subQuestions

  const subQuestions: SubQuestion[] = []
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (subQuestions.length >= MAX_SUB_QUESTIONS) break

      // A bare string is a sub-question that is also its own query.
      if (typeof entry === 'string' && entry.trim()) {
        subQuestions.push({ question: entry.trim(), queries: [entry.trim()] })
        continue
      }
      if (!entry || typeof entry !== 'object') continue

      const record = entry as Record<string, unknown>
      const question = String(record.question ?? record.subQuestion ?? record.q ?? '').trim()
      const rawQueries = record.queries ?? record.query ?? record.searches
      const queries = (Array.isArray(rawQueries) ? rawQueries : [rawQueries])
        .map((q) => String(q ?? '').trim())
        .filter(Boolean)
        .slice(0, MAX_QUERIES_PER_SUB)

      if (!question && queries.length === 0) continue
      subQuestions.push({
        question: question || queries[0],
        // A sub-question with no queries can still be searched by its own text.
        queries: queries.length > 0 ? queries : [question]
      })
    }
  }

  if (subQuestions.length === 0) {
    const question = fallbackQuestion.trim()
    if (!question) return null
    // Planning failed outright. One round on the original question still beats
    // returning nothing, and the caller is told the plan was a fallback.
    return { subQuestions: [{ question, queries: [keywordQueryFor(question)] }] }
  }
  return { subQuestions }
}

/**
 * Search *terms* for a question, when planning did not produce any.
 *
 * Measured (v1.9.1, on a reasoning model): the planner's structured-output
 * call came back with everything in `reasoning_content` and an empty
 * `content`, so parsing failed and the plan fell back to using the raw
 * question as the query. Most questions are first-person ("what ratio should
 * I use…"), and the privacy sanitizer refuses a first-person sentence as a
 * query — correctly; that is a guarantee, not a heuristic. So zero queries
 * were sent, zero sources were found, and the run reported "the search
 * provider may have returned nothing". Every link was individually right and
 * the composite silently failed every first-person question.
 *
 * The fallback now produces what the sanitizer wants in the first place: the
 * question's content words, no first-person framing, no question words,
 * capped at the provider-sane length. "What coffee-to-water ratio and water
 * temperature should I use for pour-over, and how long should it take?"
 * becomes "coffee-to-water ratio water temperature pour-over long take".
 */
const QUESTION_WORDS = new Set([
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'is', 'are', 'was', 'were',
  'do', 'does', 'did', 'can', 'could', 'would', 'will', 'shall', 'should', 'may', 'might', 'must',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'into',
  'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those', 'it', 'its',
  'be', 'been', 'being', 'have', 'has', 'had', 'get', 'use', 'expect', 'need', 'want', 'please',
  'tell', 'show', 'give', 'find', 'look', 'search'
])

export function keywordQueryFor(question: string): string {
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./%-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !QUESTION_WORDS.has(w))
  // Capped below the sanitizer's own limit so the fallback is never the thing
  // that trips it. Empty (a question made only of stopwords) keeps the
  // original: a refused query is better than no query at all, and the refusal
  // is now reported rather than swallowed.
  const kept = words.slice(0, 12)
  return kept.length > 0 ? kept.join(' ') : question.trim()
}

export async function makePlan(
  question: string,
  model: string,
  signal?: AbortSignal
): Promise<{ plan: ResearchPlan; planned: boolean }> {
  try {
    const raw = await chatCompleteJson<unknown>({
      model,
      messages: [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: question }
      ],
      temperature: 0.1,
      maxTokens: 700,
      // The schema already constrains the output; thinking in front of it only
      // spends the budget that has to reach the JSON.
      thinking: false,
      jsonSchema: { name: 'research_plan', schema: PLAN_SCHEMA },
      signal
    })
    const plan = parsePlan(raw, question)
    if (plan) {
      // Distinguish a real plan from the single-sub-question fallback.
      const planned = !(plan.subQuestions.length === 1 && plan.subQuestions[0].question === question.trim())
      return { plan, planned }
    }
  } catch {
    // Fall through to the unplanned path.
  }
  return { plan: { subQuestions: [{ question, queries: [keywordQueryFor(question)] }] }, planned: false }
}

// ---- adaptive re-planning ----------------------------------------------------

/**
 * Schema for the reformulation step: one new query set per open sub-question,
 * aligned by array order with the input.
 */
const REFORMULATE_SCHEMA = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_QUERIES_PER_SUB,
            items: { type: 'string' }
          }
        },
        required: ['queries'],
        additionalProperties: false
      }
    }
  },
  required: ['queries'],
  additionalProperties: false
} as const

const REFORMULATE_SYSTEM = `You are a research planner. A round of web research failed to answer the sub-questions listed below.

For each, propose DIFFERENT keyword search queries that attack the question from another angle: narrower or broader terms, synonyms, a specific aspect, a likely source type (documentation, news, paper). Do not repeat the failed queries.

Respond with JSON only, one entry per sub-question in the same order:
{"queries":[{"queries":["...","..."]}]}`

/**
 * New queries for the sub-questions a round failed to cover.
 *
 * Re-running the same queries in round two would mostly re-hit the search
 * cache and return the same results that just failed. Asking for a different
 * angle is what makes later rounds worth their budget. Falls back to the
 * original queries per sub-question when the model produces nothing usable,
 * so a weak model degrades to the old behavior rather than losing the round.
 */
export async function reformulateQueries(
  open: SubQuestion[],
  model: string,
  signal?: AbortSignal
): Promise<string[][]> {
  const fallback = open.map((sub) => sub.queries)
  try {
    const listed = open
      .map((sub, i) => `${i + 1}. ${sub.question}\n   failed queries: ${sub.queries.join(' | ')}`)
      .join('\n')
    const raw = await chatCompleteJson<{ queries?: { queries?: unknown }[] }>({
      model,
      messages: [
        { role: 'system', content: REFORMULATE_SYSTEM },
        { role: 'user', content: listed }
      ],
      temperature: 0.3,
      maxTokens: 400,
      thinking: false,
      jsonSchema: { name: 'research_reformulate', schema: REFORMULATE_SCHEMA },
      signal
    })
    if (!raw || !Array.isArray(raw.queries)) return fallback
    return open.map((sub, i) => {
      const entry = raw.queries?.[i]
      const queries = (Array.isArray(entry?.queries) ? entry.queries : [])
        .map((q) => String(q ?? '').trim())
        .filter(Boolean)
        .slice(0, MAX_QUERIES_PER_SUB)
      return queries.length > 0 ? queries : sub.queries
    })
  } catch {
    return fallback
  }
}
