import { dialog } from 'electron'
import { hostWindow } from '../hostWindow'
import { getSettings } from '../store'
import { runDeepResearch } from '../deepResearch'
import type { ResearchDepth, ResearchOutcome, ResearchPlan } from '../deepResearch'
import { provenanceNote, provenanceOf } from '../sourceTiers'
import { UNTRUSTED_HEADER, truncate } from './types'
import type { ToolHandler, ToolResult } from './types'

/** deep_research: one call runs plan → search → read → reflect → synthesize in the main process. */

/**
 * Research output gets a larger budget than other tools: it replaces what would
 * otherwise be a dozen separate page reads, each of which would have cost this
 * much on its own, and the brief plus its citations is the entire product of the
 * call.
 */
const MAX_RESEARCH_OUTPUT_CHARS = 14_000

/**
 * One approval for a whole research plan.
 *
 * This is the plan-level replacement for `confirmBeforeSearch`'s per-query
 * dialog. Showing every query at once is strictly more informative than six
 * separate prompts: it is the one moment where a user can see the shape of what
 * is about to be disclosed and notice a query carrying conversation context that
 * should not leave the machine.
 */
async function confirmResearchPlan(
  sender: Electron.WebContents,
  plan: ResearchPlan,
  queries: string[]
): Promise<boolean> {
  const win = hostWindow(sender)
  if (!win) return false // window closed — nobody to ask; decline
  const outline = plan.subQuestions
    .map((s, i) => `${i + 1}. ${s.question}\n   → ${s.queries.join('  |  ')}`)
    .join('\n')
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Confirm research plan',
    message: `A model wants to run ${queries.length} web search(es) for this research:`,
    detail:
      `${outline}\n\nOnly the queries after "→" are sent, to your configured provider. ` +
      'Your question itself never leaves this machine.',
    buttons: ['Run research', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  })
  return response === 0
}

/** Render a research outcome for the model: brief, citations, and what it cost. */
export function formatResearch(outcome: ResearchOutcome): ToolResult {
  const ledger = outcome.ledger
  const cost = ledger
    ? `Searched ${ledger.searches}×, read ${ledger.fetches} page(s) across ${ledger.hosts.length} domain(s) in ${Math.round(ledger.elapsedMs / 1000)}s.`
    : ''

  if (!outcome.ok) {
    return {
      ok: false,
      error:
        [outcome.error ?? 'Research failed.', cost].filter(Boolean).join(' ') +
        ' Tell the user exactly what could not be verified — never invent products, prices, ' +
        'or sources to fill the gap.'
    }
  }

  const sources = (outcome.sources ?? [])
    .map((s) => {
      const { kind, why } = provenanceOf(s.url)
      const mark = kind === 'unknown' ? '' : `\n    [${kind}: ${why}]`
      return `[${s.index}] ${s.title || '(untitled)'}\n    ${s.url}${mark}`
    })
    .join('\n')

  const gaps = (outcome.coverage ?? []).filter((c) => !c.covered)
  const notes: string[] = [cost]
  // Sources without a synthesis is a real outcome, not a failure — but the
  // model must not paper over it by writing the brief itself from memory.
  if (outcome.synthesisNote) notes.push(outcome.synthesisNote)
  if (outcome.planned === false) {
    notes.push('Note: planning did not produce sub-questions, so the question was researched as given.')
  }
  if (gaps.length > 0) {
    notes.push(
      `Not covered by the sources found: ${gaps.map((g) => `"${g.question}"`).join(', ')}. ` +
        'Treat the brief as incomplete on those points.'
    )
  }
  if (ledger && ledger.limitsHit.length > 0) {
    notes.push(`Stopped by the research budget (${ledger.limitsHit.join(', ')}).`)
  }
  const shape = provenanceNote((outcome.sources ?? []).map((s) => s.url))
  if (shape) notes.push(shape)
  if (outcome.redactions && outcome.redactions.length > 0) {
    notes.push(`Queries were sanitized before sending — redacted: ${outcome.redactions.join(', ')}.`)
  }
  if (ledger && ledger.hosts.length > 0) {
    notes.push(`Domains contacted: ${ledger.hosts.join(', ')}.`)
  }

  return {
    ok: true,
    output: truncate(
      [
        UNTRUSTED_HEADER,
        '',
        outcome.brief?.trim()
          ? `## Research brief${outcome.synthesized === false ? ' (incomplete)' : ''}\n\n${outcome.brief}`
          : '## Research brief\n\n(none — the sources below were retrieved but not synthesized)',
        '',
        '## Sources',
        sources,
        '',
        notes.filter(Boolean).join('\n')
      ].join('\n'),
      MAX_RESEARCH_OUTPUT_CHARS
    )
  }
}

const deepResearch: ToolHandler = async (args, { sender, modelId }) => {
  const question = String(args.question ?? '').trim()
  if (!question) return { ok: false, error: 'A research question is required.' }
  const depth = ['quick', 'standard', 'thorough'].includes(String(args.depth))
    ? (String(args.depth) as ResearchDepth)
    : undefined

  const outcome = await runDeepResearch({
    question,
    depth,
    modelId,
    onProgress: (phase, detail) => {
      // Streamed so a 90-second call shows what it is doing rather than
      // freezing the UI on a spinner.
      sender.send('research:progress', { phase, detail })
    },
    approvePlan: getSettings().research.confirmPlan
      ? (plan, queries) => confirmResearchPlan(sender, plan, queries)
      : undefined
  })

  return formatResearch(outcome)
}

export const researchHandlers = {
  deep_research: deepResearch
} satisfies Record<string, ToolHandler>
