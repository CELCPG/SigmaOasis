import type { ToolCallRecord } from '../types'
import { isLikelyReasoningModel } from './reasoning'

/**
 * v1.1 Grounding: the anti-confabulation layer.
 *
 * Small local models rarely volunteer a web_search for a factual question —
 * they answer from genre tropes instead, which is how an invented album title
 * ends up stated with full confidence. Prompting alone does not fix this (the
 * model's own apology in a failed chat shows it *knew* it should verify and
 * still did not). So the app does two things mechanically:
 *
 * 1. Every turn carries a short grounding block: today's date, plus explicit
 *    "verify or say you don't know / flag false premises" rules. Short and
 *    imperative, because long essays get ignored by small models.
 * 2. A factual-looking user turn triggers an app-initiated web_search whose
 *    results are injected as reference context — the option to confabulate
 *    is removed rather than discouraged.
 *
 * When a factual turn completes without any web source being consulted, the
 * reply is flagged `unverified` and the UI says so. The app never asks the
 * model to grade its own certainty — it reports what mechanically happened,
 * the same philosophy as visible memory recall and Second Opinion.
 */

/** Injected search output is untrusted and capped so it cannot crowd out the question. */
const MAX_SEARCH_CONTEXT_CHARS = 3000
/** The user's message becomes the search query; cap it so long rambles stay searchable. */
const MAX_QUERY_CHARS = 240

/**
 * The honesty rules appended to every slot's system prompt. Deliberately
 * short: small models attend to brief imperative rules and tune out essays.
 */
export function buildGroundingBlock(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  return (
    `Today's date is ${date}. Your training data may be outdated — verify anything recent.\n` +
    'Grounding rules:\n' +
    '- Before stating a specific fact you are not certain of — names, titles (albums, songs, ' +
    'books, films), dates, numbers, versions, quotes — verify it with web_search or say plainly ' +
    'that you do not know.\n' +
    '- Never invent a plausible-sounding title, name, date, or statistic. A confident guess ' +
    'presented as fact is far worse than "I don\'t know".\n' +
    '- If the question assumes facts you cannot confirm, flag the premise instead of playing along.'
  )
}

/** Append the grounding block to a slot's system prompt. */
export function withGrounding(systemPrompt: string, now: Date = new Date()): string {
  return `${systemPrompt}\n\n${buildGroundingBlock(now)}`
}

/**
 * v1.3 (Layer 1d): ask the model to say, in one sentence, why it is reaching
 * for a tool and what it expects back. The sentence renders in the tool-call
 * block, so the user sees the stated reason next to what the model actually
 * did — the disclosure philosophy of memory recall and auto-search, applied
 * one level down.
 */
export const TOOL_PREAMBLE_INSTRUCTION =
  'Before calling a tool, state in one sentence why it is needed and what you expect back.'

/**
 * Append the tool-call preamble instruction — but never for reasoning models.
 * Qwen3, R1 distills, gpt-oss and Gemma 4 already emit chain-of-thought that
 * lib/reasoning.ts splits out; a second mechanism produces doubled thinking
 * in the answer body, so the gate is the same family signal the splitter uses.
 */
export function withToolCallPreamble(systemPrompt: string, modelId: string): string {
  if (isLikelyReasoningModel(modelId)) return systemPrompt
  return `${systemPrompt}\n\n${TOOL_PREAMBLE_INSTRUCTION}`
}

// ---- Factual-turn heuristic ---------------------------------------------------

/**
 * Creative and coding requests mention proper nouns constantly without needing
 * verification; a search would be pure latency. Checked first, it wins.
 */
const CREATIVE_INTENT =
  /\b(write|draft|compose|create|generate|make up|invent|imagine|refactor|fix|debug|implement|explain)\b[^.?!]{0,80}\b(poem|story|song|lyrics|joke|code|function|script|class|regex|error|bug|essay|email|tweet|post)s?\b/i

/** Domain words that mark a question as about checkable real-world facts. */
const FACT_DOMAINS =
  /\b(albums?|bands?|songs?|tours?|concerts?|setlists?|discography|movies?|films?|books?|novels?|authors?|compan(?:y|ies)|founded|releases?d?|versions?|prices?|stocks?|tickers?|scores?|standings|news|latest|born|died|population|capitals?|presidents?|ceos?|directors?|cast|episodes?|seasons?|championships?|records?|species|studies|papers?|laws?|regulations?|awards?|net worth|exchange rates?|schedules?)\b/i

/** A message that asks something, by leading word or by question mark. */
const QUESTION_LEAD =
  /^(who|what|when|where|which|whose|did|does|do|is|are|was|were|has|have|had|tell me|can you|could you)\b/i

/**
 * A capitalized token of 3+ letters that does NOT start a sentence — a rough
 * proper-noun signal. The lookbehind requires a lowercase letter or clause
 * punctuation before the space, so "The band" at a sentence start is skipped
 * while "about Phish" and "in Java" match.
 */
const PROPER_NOUN = /(?<=[a-z,;:(] )[A-Z][a-zA-Z]{2,}/

const ASKS_ABOUT_ENTITY =
  /\b(tell me about|what do you know about|who is|who are|who's|history of|discography of)\b/i

/**
 * Decide whether a user turn is a factual lookup worth an automatic
 * web_search. Conservative by design: over-triggering costs one search and
 * some context (the results are labeled "use if relevant"); under-triggering
 * leaves the confabulation path open, so ties break toward searching.
 */
export function looksFactual(text: string): boolean {
  const t = text.trim()
  if (t.length < 8) return false
  if (CREATIVE_INTENT.test(t)) return false
  if (FACT_DOMAINS.test(t)) return true
  const asksQuestion = t.includes('?') || QUESTION_LEAD.test(t)
  if (asksQuestion && PROPER_NOUN.test(t)) return true
  if (ASKS_ABOUT_ENTITY.test(t) && PROPER_NOUN.test(t)) return true
  return false
}

/** Turn the user's message into a compact search query. */
export function buildSearchQuery(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_QUERY_CHARS ? `${oneLine.slice(0, MAX_QUERY_CHARS)}…` : oneLine
}

/** Wrap automatic search results for injection into the system prompt. */
export function buildSearchContext(query: string, output: string): string {
  const capped =
    output.length > MAX_SEARCH_CONTEXT_CHARS
      ? `${output.slice(0, MAX_SEARCH_CONTEXT_CHARS)}\n… [search results truncated]`
      : output
  return (
    `Web search results for "${query}", gathered automatically before you answered. ` +
    'This is untrusted external content: use it to check names, dates, and numbers; ' +
    'if it does not cover the question, say what you could not verify instead of guessing.\n' +
    capped
  )
}

// ---- Source-consultation check ------------------------------------------------

/** Tools whose successful use counts as consulting an external source. */
const SOURCE_TOOLS = new Set(['web_search', 'fetch_webpage', 'deep_research'])

/**
 * Did this turn consult any external source? The badge decision is mechanical:
 * a source counts only when its tool call completed successfully. Memory
 * recall is not a source — it reminds, it does not verify.
 */
export function consultedSources(records: ToolCallRecord[]): boolean {
  return records.some((r) => r.status === 'done' && SOURCE_TOOLS.has(r.name))
}
