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
/** Per section. A 1,500-word document over six sections is ~350 tokens each; this leaves room. */
export const SECTION_MAX_TOKENS = 900
const TAIL_CHARS = 400

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

export async function generateOutline(input: { model: string; persona: string; request: string; signal?: AbortSignal }): Promise<Outline | null> {
  const parsed = await chatCompleteJson<unknown>({
    model: input.model,
    messages: [
      {
        role: 'system',
        content:
          'You plan documents. Given a request for a written piece, return its outline as JSON: a title and ' +
          `${OUTLINE_MIN_SECTIONS} to ${OUTLINE_MAX_SECTIONS} sections in reading order, each with a heading and a one-line brief ` +
          'of what that section must cover and nothing another section covers. If the request names section ' +
          'headings, use exactly those, in that order. Return JSON only.'
      },
      { role: 'user', content: input.request }
    ],
    jsonSchema: OUTLINE_SCHEMA,
    temperature: 0.2,
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
  for (const [i, section] of outline.sections.entries()) {
    const previous = written[i - 1]
    const tail = previous ? previous.text.trim().slice(-TAIL_CHARS) : ''
    const text = await chatComplete({
      model: input.model,
      messages: [
        { role: 'system', content: input.persona },
        {
          role: 'user',
          content:
            `${input.request}\n\n` +
            `The document is titled "${outline.title}" and has these sections, in order:\n${plan}\n\n` +
            `Write section ${i + 1} only: "${section.heading}". Cover: ${section.brief}. ` +
            'Do not write the heading, a title, an introduction to the whole document, or any other section; ' +
            'do not restate what other sections cover. Prose, with lists only where the content is a list.' +
            (tail ? `\n\nThe previous section ended:\n…${tail}` : '')
        }
      ],
      temperature: 0.4,
      maxTokens: SECTION_MAX_TOKENS,
      thinking: false,
      signal: input.signal
    })
    const cleaned = text.replace(new RegExp(`^\\s*#{0,6}\\s*${escapeRe(section.heading)}\\s*\\n`, 'i'), '').trim()
    // A section that used every token it was allowed was cut, not finished.
    const truncated = cleaned.split(/\s+/).length >= SECTION_MAX_TOKENS * 0.72
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
