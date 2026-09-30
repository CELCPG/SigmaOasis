import { CHARS_PER_TOKEN } from './context'
import type { ToolSchema } from './types'

/**
 * Capping a tool result (v4.1, A3).
 *
 * `read_file` can hand back 2,000 lines, a test run tens of thousands of
 * characters, a fetched page more, and the four most recent results are never
 * trimmed by context fitting — so one call could fill most of a 16K window on
 * its own and push the task's own instructions out. No single result may now
 * take more than a fixed share of the history's budget. What is cut is the
 * middle: the head says what the output is, the tail how it ended (a test
 * run's totals, an error's last frame), and both are what a small model reads
 * first. The middle is not thrown away — it goes to a spill store for the
 * task, and the note where it was names the `read_spill` call that returns
 * it, so nothing a tool produced is out of reach.
 */

/** The share of the history budget one tool result may take. */
export const RESULT_SHARE = 0.15
/** Below this a cap would cut more than it saves; small windows get it anyway. */
const MIN_CAP_CHARS = 2_000
/** A spilled line longer than this is served in pieces, so a minified file pages too. */
const SPILL_LINE_CHARS = 2_000

/** The most characters one result may hand the model under `budgetTokens`. */
export function resultCapChars(budgetTokens: number, share = RESULT_SHARE): number {
  return Math.max(MIN_CAP_CHARS, Math.floor(budgetTokens * CHARS_PER_TOKEN * share))
}

/** The cut middles of this task's results, by id; a helper shares its parent's. */
export class SpillStore {
  private readonly spills = new Map<string, string[]>()
  private next = 0

  put(text: string): string {
    const id = `spill-${++this.next}`
    const lines: string[] = []
    for (const line of text.split('\n')) {
      if (line.length <= SPILL_LINE_CHARS) lines.push(line)
      else for (let i = 0; i < line.length; i += SPILL_LINE_CHARS) lines.push(line.slice(i, i + SPILL_LINE_CHARS))
    }
    this.spills.set(id, lines)
    return id
  }

  get(id: string): string[] | undefined {
    return this.spills.get(id)
  }

  get size(): number {
    return this.spills.size
  }
}

/**
 * `text` whole if it fits `cap`, else its head and tail with the middle
 * spilled and a note in its place. Whole lines where there are lines; a
 * single enormous line is cut by characters.
 */
export function capResult(text: string, cap: number, spill: SpillStore): string {
  if (text.length <= cap) return text
  // Room for the note itself; the head gets the larger share, as the part read first.
  const room = Math.max(0, cap - 320)
  const headBudget = Math.floor(room * 0.65)
  const tailBudget = room - headBudget
  const lines = text.split('\n')
  let head = 0
  let used = 0
  while (head < lines.length && used + lines[head]!.length + 1 <= headBudget) used += lines[head++]!.length + 1
  let tail = 0
  used = 0
  while (tail < lines.length - head && used + lines[lines.length - 1 - tail]!.length + 1 <= tailBudget) used += lines[lines.length - 1 - tail++]!.length + 1
  if (head === 0 || lines.length - head - tail < 2) {
    // One long line (a minified file, a JSON blob): cut by characters.
    const middle = text.slice(headBudget, text.length - tailBudget)
    const id = spill.put(middle)
    return `${text.slice(0, headBudget)}\n${cutNote(id, middle.length, null, null)}\n${text.slice(text.length - tailBudget)}`
  }
  const cut = lines.slice(head, lines.length - tail)
  const middle = cut.join('\n')
  const id = spill.put(middle)
  // A read_file window numbers its lines: the note can name the offset too.
  const numbered = /^\s*(\d+)\t/.exec(cut[0]!)
  return [...lines.slice(0, head), cutNote(id, middle.length, cut.length, numbered ? Number(numbered[1]) : null), ...lines.slice(lines.length - tail)].join('\n')
}

function cutNote(id: string, chars: number, lines: number | null, fileLine: number | null): string {
  const what = lines !== null ? `${lines.toLocaleString('en-US')} lines, ${chars.toLocaleString('en-US')} characters` : `${chars.toLocaleString('en-US')} characters`
  const file = fileLine !== null ? `, or read_file with offset ${fileLine}` : ''
  return `[… ${what} cut here to keep the context small — read_spill with id "${id}" returns them${file} …]`
}

export const READ_SPILL_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'read_spill',
    description:
      'Read the middle of a tool result that was cut to keep the context small. The cut result names the id; pass offset (the first line, from 1) to read on.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id the cut result named, like "spill-3".' },
        offset: { type: 'number', description: 'First line to return, starting at 1.' }
      },
      required: ['id']
    }
  }
}

/** The read_spill tool: a window of a spilled middle, at most `cap` characters, with the way on. */
export function readSpill(spill: SpillStore, args: Record<string, unknown>, cap: number): { ok: boolean; output?: string; error?: string } {
  const id = String(args.id ?? '').trim()
  const lines = spill.get(id)
  if (!lines) {
    return { ok: false, error: spill.size > 0 ? `No cut output has the id "${id}". Use the id the cut result named.` : 'Nothing has been cut in this task, so there is nothing to read back.' }
  }
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
  if (offset > lines.length) return { ok: false, error: `${id} has only ${lines.length} lines.` }
  const out: string[] = []
  let used = 0
  let end = offset - 1
  while (end < lines.length && (out.length === 0 || used + lines[end]!.length + 1 <= cap - 120)) {
    out.push(lines[end]!)
    used += lines[end]!.length + 1
    end++
  }
  const more = end < lines.length ? `\n(${id}: lines ${offset}–${end} of ${lines.length}; read on with offset ${end + 1})` : `\n(${id}: lines ${offset}–${end} of ${lines.length}, the end)`
  return { ok: true, output: `${out.join('\n')}${more}` }
}
