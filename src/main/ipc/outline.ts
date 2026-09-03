import { ipcMain } from 'electron'
import { chatComplete, chatCompleteJson } from './llm'

/**
 * v2.6: outline-then-fill for long answers.
 *
 * A 9B asked for a 1,500-word report writes a coherent 600 words and then
 * drifts, restates, or stops. Asked first for the *shape* — a JSON outline of
 * three to eight sections, each with a one-line brief — and then for one
 * section at a time, with the outline and the previous section's tail in
 * front of it, it writes the document the outline promised. Each section is
 * one bounded completion, so a token cap cuts a section, never the document.
 *
 * Disclosed the way plans are: the outline rides the reply, and the reader
 * sees which sections were written and how long each came out.
 */

export interface OutlineSection {
  heading: string
  /** One line: what this section must cover. */
  brief: string
}

export interface Outline {
  title: string
  sections: OutlineSection[]
}

export interface OutlinedDocument {
  outline: Outline
  sections: { heading: string; text: string; truncated: boolean }[]
  /** The document as the reader sees it: a title and one `## heading` per section. */
  text: string
  /** Any section hit its cap. */
  truncated: boolean
}

export const OUTLINE_MIN_SECTIONS = 3
export const OUTLINE_MAX_SECTIONS = 8
/**
 * Per section, derived from the length the request asked for divided by the
 * outline's section count, in tokens with room to spare and a floor and a
 * ceiling. The first build gave every section 900 tokens: a 9B at eight
 * tokens a second took longer than the completion timeout on ten of twelve
 * documents, and the two that finished wrote every section to the cap —
 * 4,000 words for a 1,500-word ask (docs/evals.md). The target is the
 * budget now, and the section is told the number.
 */
export const SECTION_MIN_TOKENS = 220
export const SECTION_MAX_TOKENS = 800
export const DEFAULT_TARGET_WORDS = 1200
/** Long enough for the slowest section at the ceiling on a slow model; a cap, not a plan. */
export const SECTION_TIMEOUT_MS = 240_000
/** The fallback model outline: a reasoning model thinks before it writes JSON, so the budget holds the thinking too. */
export const OUTLINE_MAX_TOKENS = 1_500
export const OUTLINE_TIMEOUT_MS = 180_000
const TAIL_CHARS = 400
const EXPLICIT_WORDS = /\b(\d{1,2}(?:,\d{3})|\d{3,5})[- ]word\b/i

/** The length the request asked for, in words, or the default. */
export function targetWordsOf(request: string): number {
  const m = EXPLICIT_WORDS.exec(request)
  const n = m ? Number(m[1].replace(/,/g, '')) : NaN
  return Number.isFinite(n) && n >= 200 ? n : DEFAULT_TARGET_WORDS
}

export function sectionBudget(targetWords: number, sections: number): { words: number; maxTokens: number } {
  const words = Math.max(80, Math.round(targetWords / Math.max(1, sections)))
  // The target is what the section is told; the cap sits well above it, so a
  // section that runs a little long finishes its sentence instead of being cut.
  const maxTokens = Math.min(SECTION_MAX_TOKENS, Math.max(SECTION_MIN_TOKENS, Math.round(words * 2.2)))
  return { words, maxTokens }
}

const OUTLINE_SCHEMA = {
  name: 'document_outline',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      sections: {
        type: 'array',
        minItems: OUTLINE_MIN_SECTIONS,
        maxItems: OUTLINE_MAX_SECTIONS,
        items: {
          type: 'object',
          properties: { heading: { type: 'string' }, brief: { type: 'string' } },
          required: ['heading', 'brief'],
          additionalProperties: false
        }
      }
    },
    required: ['title', 'sections'],
    additionalProperties: false
  }
}

function cleanOutline(raw: unknown): Outline | null {
  const o = raw as Partial<Outline> | null
  if (!o || typeof o.title !== 'string' || !Array.isArray(o.sections)) return null
  const sections = o.sections
    .map((s) => ({ heading: String((s as OutlineSection)?.heading ?? '').trim(), brief: String((s as OutlineSection)?.brief ?? '').trim() }))
    .filter((s) => s.heading)
    .slice(0, OUTLINE_MAX_SECTIONS)
  if (sections.length < OUTLINE_MIN_SECTIONS) return null
  return { title: o.title.trim() || 'Document', sections }
}

/** "Sections: A, B" · "section headings titled A, B" · "Use the sections A, B" — the list follows the word. */
const SECTION_LEAD = /\b(?:[Ss]ections?|[Hh]eadings?|[Pp]arts?|[Cc]hapters?)\b(?:[^:\n]{0,20}?(?:[Tt]itled|[Nn]amed|:)\s*|\s+(?=[A-Z]))/

/**
 * The outline a request already contains. Every document-shaped request the
 * app routes here names its sections or its length; when it names sections,
 * asking a model for the outline is asking it to copy a list, and on the
 * model this was measured on the copying cost a hundred seconds of
 * chain-of-thought before any JSON appeared (docs/evals.md). So the list is
 * read off the request, and the model plans only when there is nothing to
 * read.
 */
export function outlineFromRequest(request: string): Outline | null {
  const m = SECTION_LEAD.exec(request)
  if (!m) return null
  const rest = request.slice(m.index + m[0].length)
  const list = rest.split(/(?<=[a-z0-9)])\.\s|\n/i)[0] ?? ''
  // Commas and semicolons separate headings; "and" separates only the last
  // pair of a list, so "Tools and access" in the middle stays one heading.
  const items = list.split(/,\s*|;\s*/).map((h) => h.trim())
  const last = items.pop() ?? ''
  const tailPair = /^(.+?)\s+and\s+(.+)$/.exec(last)
  if (tailPair && items.length > 0) items.push(tailPair[1]!, tailPair[2]!)
  else items.push(last)
  const headings = items
    .map((h) => h.replace(/^and\s+/i, '').replace(/[.:]+$/, '').trim())
    .filter((h) => h.length >= 2 && h.length <= 60)
  if (headings.length < OUTLINE_MIN_SECTIONS || headings.length > OUTLINE_MAX_SECTIONS) return null
  const title =
    request
      .split(/[.!?]\s|\n/)[0]!
      .replace(/^\s*(?:write|draft|produce|prepare|compose)\s+(?:a|an|the|me)?\s*/i, '')
      .replace(/\b\d[\d,]*[- ]word\b\s*/i, '')
      .replace(/\s+(?:with|using|use)\s+(?:the\s+)?(?:following\s+)?(?:sections?|headings?)[^]*$/i, '')
      .trim()
      .replace(/^./, (c) => c.toUpperCase()) || 'Document'
  return { title, sections: headings.map((heading) => ({ heading, brief: `what "${heading}" must cover for this request` })) }
}

export async function generateOutline(input: { model: string; persona: string; request: string; signal?: AbortSignal }): Promise<Outline | null> {
  const given = outlineFromRequest(input.request)
  if (given) return given
  const parsed = await chatCompleteJson<unknown>({
    model: input.model,
    messages: [
      {
        role: 'system',
        content:
          'You plan documents. Given a request for a written piece, return its outline as JSON: a title and ' +
          `${OUTLINE_MIN_SECTIONS} to ${OUTLINE_MAX_SECTIONS} sections in reading order, each with a heading and a brief of at most ` +
          'fifteen words saying what that section must cover and nothing another section covers. If the request names ' +
          'section headings, use exactly those, in that order. Return JSON only, nothing before or after it.'
      },
      { role: 'user', content: input.request }
    ],
    jsonSchema: OUTLINE_SCHEMA,
    temperature: 0.2,
    // The outline is a few hundred tokens; without a cap the first build let
    // a 9B run past the completion timeout on ten of twelve documents.
    maxTokens: OUTLINE_MAX_TOKENS,
    timeoutMs: OUTLINE_TIMEOUT_MS,
    thinking: false,
    signal: input.signal
  })
  return cleanOutline(parsed)
}

/** Write the document the outline promised, one section at a time. */
export async function writeOutlined(input: {
  model: string
  persona: string
  request: string
  outline?: Outline | null
  signal?: AbortSignal
  onSection?: (index: number, section: { heading: string; text: string; truncated: boolean }) => void
}): Promise<OutlinedDocument> {
  const outline = input.outline ?? (await generateOutline(input))
  if (!outline) throw new Error('No outline could be produced for this request.')
  const written: OutlinedDocument['sections'] = []
  const plan = outline.sections.map((s, i) => `${i + 1}. ${s.heading} — ${s.brief}`).join('\n')
  const budget = sectionBudget(targetWordsOf(input.request), outline.sections.length)
  for (const [i, section] of outline.sections.entries()) {
    const previous = written[i - 1]
    const tail = previous ? previous.text.trim().slice(-TAIL_CHARS) : ''
    const messages = [
      { role: 'system' as const, content: input.persona },
      {
        role: 'user' as const,
        content:
          `${input.request}\n\n` +
          `The document is titled "${outline.title}" and has these sections, in order:\n${plan}\n\n` +
          `Write section ${i + 1} only: "${section.heading}", in about ${budget.words} words. Cover: ${section.brief}. ` +
          'Do not write the heading, a title, an introduction to the whole document, or any other section; ' +
          'do not restate what other sections cover. Prose, with lists only where the content is a list. ' +
          'Finish the section within the length; end on a complete sentence.' +
          (tail ? `\n\nThe previous section ended:\n…${tail}` : '')
      }
    ]
    const ask = (maxTokens: number): Promise<string> =>
      chatComplete({ model: input.model, messages, temperature: 0.4, maxTokens, timeoutMs: SECTION_TIMEOUT_MS, thinking: false, signal: input.signal })
    let text: string
    try {
      text = await ask(budget.maxTokens)
    } catch (err) {
      // A reasoning model that reopened its thinking despite the closed
      // prefill spent the section's budget on it (measured on four of twelve
      // documents). Once more, with room for the thinking and the section.
      if (!(err instanceof Error && err.name === 'ReasoningOnlyError')) throw err
      text = await ask(budget.maxTokens * 2 + 1_000)
    }
    const cleaned = text.replace(new RegExp(`^\\s*#{0,6}\\s*${escapeRe(section.heading)}\\s*\\n`, 'i'), '').trim()
    // A section that used every token it was allowed was cut, not finished:
    // a word is about 1.3 tokens, so the cap in words is the cap over that.
    const truncated = cleaned.split(/\s+/).filter(Boolean).length >= budget.maxTokens / 1.35
    const out = { heading: section.heading, text: cleaned, truncated }
    written.push(out)
    input.onSection?.(i, out)
    if (input.signal?.aborted) break
  }
  const text = `# ${outline.title}\n\n${written.map((s) => `## ${s.heading}\n\n${s.text}`).join('\n\n')}\n`
  return { outline, sections: written, text, truncated: written.some((s) => s.truncated) }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function registerOutlineHandlers(): void {
  ipcMain.handle(
    'outline:write',
    async (event, input: { model: string; persona: string; request: string; messageId: string }) => {
      try {
        const doc = await writeOutlined({
          model: String(input?.model ?? ''),
          persona: String(input?.persona ?? ''),
          request: String(input?.request ?? ''),
          onSection: (index, section) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('outline:section', { messageId: input.messageId, index, heading: section.heading, words: section.text.split(/\s+/).filter(Boolean).length, text: section.text })
            }
          }
        })
        return { ok: true, ...doc }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
