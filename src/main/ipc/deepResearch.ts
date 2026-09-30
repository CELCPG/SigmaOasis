import {
  chatCompleteJson,
  chatCompleteStream,
  PartialCompletionError,
  resolveChatModel
} from './llm'
import { getSettings } from './store'
import { readWebpage, runWebSearch } from './search'
import type { SearchResult } from './search'
import { EMPTY_RESULT_LEADS } from '../../shared/tools'
import {
  buildResearchRevision,
  checkResearchGrounding,
  describeResearchGrounding,
  researchGroundingIsClean,
  type ResearchGroundingReport
} from './researchGrounding'
import type { CandidateSource, ProgressFn, ReadSource, ResearchDepth, ResearchOutcome, ResearchPlan } from './deepResearch/types'
import { BudgetTracker, budgetFor } from './deepResearch/budget'
import { makePlan, reformulateQueries } from './deepResearch/plan'
import { canonicalUrl, hostOf, scoreCandidates, searchPacing, selectSources, sleep } from './deepResearch/sources'
import { assessCoverage } from './deepResearch/coverage'
import { buildEvidence, SYNTH_SYSTEM } from './deepResearch/synthesis'

/**
 * Multi-step research, as one tool call.
 *
 * ## Why this is a tool and not a prompt
 *
 * The flat tool loop in useLMStudio.ts caps at 8 consecutive rounds, and every
 * page a model reads lands in conversation history. A search plus a fetch costs
 * two rounds, so an improvising model gets about four sources per turn before it
 * runs out of either rounds or context — and the pages it did read have already
 * crowded out the room needed to reason about them.
 *
 * Running the whole crawl inside a single tool call removes both limits at once:
 * twenty pages can be searched, fetched, ranked and discarded in the main
 * process, and only the synthesized brief plus citations ever enters the
 * conversation. The orchestration is code rather than model improvisation, so it
 * is bounded, auditable, and repeatable.
 *
 * ## Shape
 *
 *   plan → search → select → read → reflect → (one more round) → synthesize
 *
 * Every phase draws from one budget (rounds, searches, fetches, distinct hosts,
 * wall clock). The budget is not advisory: each phase checks it before acting, so
 * a research run has a hard ceiling on how much it can do and how much of the
 * network it can touch.
 *
 * ## Privacy
 *
 * The user's question is never sent anywhere. What leaves the machine are the
 * keyword queries the planner produced, each passed through the same
 * `sanitizeQuery` redaction as any other search, and each visible in the plan the
 * user can be asked to approve before anything is sent. Every domain contacted is
 * reported back with the results.
 *
 * ## Layout
 *
 * v4.2 (R4): this file is the orchestrator and the facade. The phases it
 * calls live beside it in deepResearch/ — types, the budget, planning and
 * re-planning (plan), search pacing and source selection (sources), coverage
 * and synthesis — moved verbatim, and everything they exported is re-exported
 * here, so callers and tests keep importing from this path.
 */

export type {
  SubQuestion,
  ResearchPlan,
  ResearchBudget,
  ResearchDepth,
  CandidateSource,
  ReadSource,
  ResearchLedger,
  ResearchOutcome,
  ProgressFn
} from './deepResearch/types'
export { budgetFor, BudgetTracker } from './deepResearch/budget'
export { parsePlan, keywordQueryFor, reformulateQueries } from './deepResearch/plan'
export { searchPacing, selectSources } from './deepResearch/sources'
export { assessCoverage } from './deepResearch/coverage'

// ---- the orchestrator -------------------------------------------------------

/** Passages pulled from each source read. */
const PASSAGES_PER_SOURCE = 3

export async function runDeepResearch(options: {
  question: string
  modelId?: string
  depth?: ResearchDepth
  signal?: AbortSignal
  onProgress?: ProgressFn
  /** Called once with the full plan before any query is sent. */
  approvePlan?: (plan: ResearchPlan, queries: string[]) => Promise<boolean>
}): Promise<ResearchOutcome> {
  const question = options.question.trim()
  if (!question) return { ok: false, error: 'No research question was given.' }

  const progress = options.onProgress ?? ((): void => undefined)
  const settings = getSettings()
  const depth = options.depth ?? settings.research.depth
  const tracker = new BudgetTracker(budgetFor(depth))

  const model = await resolveChatModel(options.modelId)
  if (!model) {
    return {
      ok: false,
      error: 'No chat model available in LM Studio to plan and synthesize the research.'
    }
  }

  // --- plan ---
  progress('planning', 'Breaking the question into sub-questions')
  const { plan, planned } = await makePlan(question, model, options.signal)
  const allQueries = plan.subQuestions.flatMap((s) => s.queries)

  // --- approval: one gate for the whole plan ---
  // The user sees every query at once rather than N separate dialogs. That is
  // strictly more informative: it is the moment to notice a query that carries
  // conversation context it should not.
  if (options.approvePlan && !(await options.approvePlan(plan, allQueries))) {
    return { ok: false, kind: 'declined', plan, error: 'The user declined this research plan.' }
  }

  const sentQueries: string[] = []
  const refusedQueries: string[] = []
  const redactions = new Set<string>()
  const sources: ReadSource[] = []
  const readUrls = new Set<string>()
  let sourceIndex = 1
  let coverage = assessCoverage(plan.subQuestions, sources)

  for (let round = 0; ; round++) {
    if (!tracker.canStartRound()) break
    tracker.rounds += 1

    // Later rounds only revisit what earlier rounds failed to answer, and
    // they attack those with fresh queries rather than re-running the ones
    // that just failed (which would mostly re-hit the search cache).
    let targets =
      round === 0
        ? plan.subQuestions.map((sub, index) => ({ sub, index }))
        : plan.subQuestions
            .map((sub, index) => ({ sub, index }))
            .filter(({ index }) => !coverage[index]?.covered)

    if (targets.length === 0) break

    if (round > 0) {
      progress('replanning', `New angle for ${targets.length} open sub-question(s)`)
      const freshQueries = await reformulateQueries(
        targets.map((t) => t.sub),
        model,
        options.signal
      )
      targets = targets.map((t, i) => ({
        ...t,
        sub: { ...t.sub, queries: freshQueries[i] ?? t.sub.queries }
      }))
    }
    if (options.signal?.aborted) return { ok: false, error: 'Research was cancelled.' }

    // --- search ---
    const provider = getSettings().search.provider
    const { concurrency, spacingMs } = searchPacing(provider)
    const candidates: CandidateSource[] = []

    progress('searching', `Round ${round + 1}: ${targets.length} sub-question(s)`)

    const jobs: { query: string; subQuestion: number }[] = []
    for (const { sub, index } of targets) {
      for (const query of sub.queries) jobs.push({ query, subQuestion: index })
    }

    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const job = jobs[cursor++]
        if (!job) return
        if (!tracker.canSearch()) return
        if (options.signal?.aborted) return
        tracker.recordSearch()

        const outcome = await runWebSearch(job.query)
        if (outcome.sentQuery) sentQueries.push(outcome.sentQuery)
        for (const r of outcome.redactions) redactions.add(r)
        // A query the privacy filter refused never reached a provider. Keep it
        // so the run can say that, instead of blaming the provider for our own
        // refusal (v1.9.1).
        if (!outcome.ok && outcome.error && /not sent|subject only/i.test(outcome.error)) refusedQueries.push(job.query)
        if (outcome.ok) {
          for (const result of outcome.results as SearchResult[]) {
            candidates.push({
              url: result.url,
              title: result.title,
              snippet: result.snippet,
              subQuestion: job.subQuestion
            })
          }
        }
        // Cached responses cost no request, so no need to pace after one.
        if (spacingMs > 0 && !outcome.cached) await sleep(spacingMs)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))

    if (options.signal?.aborted) return { ok: false, error: 'Research was cancelled.' }

    // --- select ---
    const fresh = candidates.filter((c) => !readUrls.has(canonicalUrl(c.url)))
    progress('selecting', `Ranking ${fresh.length} candidate source(s)`)
    const relevance = await scoreCandidates(fresh, plan.subQuestions)
    const remainingFetches = Math.max(0, budgetFor(depth).maxFetches - tracker.fetches)
    const chosen = selectSources(fresh, relevance, remainingFetches)

    // --- read ---
    // Pages are fetched through a small worker pool rather than one at a
    // time: a multi-page crawl is the longest phase of a run, and the
    // per-domain cap in selectSources already keeps any single host from
    // bearing the burst. Budget check and fetch recording happen
    // synchronously inside the worker, so the ceiling holds under
    // concurrency exactly as it did serially.
    const READ_CONCURRENCY = 3
    let readCursor = 0
    const readWorker = async (): Promise<void> => {
      for (;;) {
        const candidate = chosen[readCursor++]
        if (!candidate) return
        if (options.signal?.aborted) return
        const host = hostOf(candidate.url)
        if (!host || !tracker.canFetch(host)) continue

        const subQuestion = plan.subQuestions[candidate.subQuestion]
        progress('reading', `${sources.length + 1}. ${candidate.title || candidate.url}`)
        readUrls.add(canonicalUrl(candidate.url))
        tracker.recordFetch(host)

        const page = await readWebpage(
          candidate.url,
          subQuestion?.question ?? question,
          PASSAGES_PER_SOURCE
        )
        if (!page.ok || !page.retrieval || page.retrieval.passages.length === 0) continue

        sources.push({
          index: sourceIndex++,
          url: page.url,
          title: page.title,
          subQuestion: candidate.subQuestion,
          passages: page.retrieval.passages.map((p) => ({ text: p.text, score: p.score })),
          via: page.source
        })
      }
    }
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, readWorker))

    // --- reflect ---
    coverage = assessCoverage(plan.subQuestions, sources)
    if (coverage.every((c) => c.covered)) break
    // v1.9: a round that surfaced no fresh candidate at all means the
    // provider is exhausted for these sub-questions — another replan re-asks
    // a question that has already been answered "nothing", and each replan
    // is a model call (~25 s on a 9B) taken straight out of the synthesis
    // budget. Measured against a fixed corpus: two empty replan rounds spent
    // 50 s to find zero pages and left synthesis crammed into what remained.
    // On the live web an empty round is rare; when it happens, the same
    // logic holds. Stop and write the brief from what exists.
    if (fresh.length === 0) {
      tracker.limitsHit.push('no new sources')
      progress('reflecting', 'No new sources found this round — synthesizing from what was read')
      break
    }
    progress('reflecting', `${coverage.filter((c) => !c.covered).length} sub-question(s) still open`)
  }

  if (sources.length === 0) {
    // Nothing went out at all, versus everything went out and nothing came
    // back. Two different facts about the world, and the `kind` is what carries
    // the difference past this function — the prose below is for the model.
    const nothingSent = refusedQueries.length > 0 && sentQueries.length === 0
    return {
      ok: false,
      kind: nothingSent ? 'declined' : 'empty',
      plan,
      sentQueries,
      redactions: [...redactions],
      ledger: tracker.ledger(),
      error: nothingSent
        ? 'No search was sent: every query this run built was refused by the privacy filter for ' +
          `reading as a sentence about you rather than search terms (${refusedQueries.length} ` +
          'refused). Nothing was contacted. Ask again with the subject terms, or rephrase the ' +
          'question without first-person framing.'
        : `${EMPTY_RESULT_LEADS.get('deep_research')!}. The search provider may have returned ` +
          'nothing, or every candidate page failed to yield readable text.'
    }
  }

  // --- synthesize ---
  progress('synthesizing', `Writing a brief from ${sources.length} source(s)`)
  let brief: string
  let synthesisNote: string | undefined
  try {
    brief = await chatCompleteStream({
      model,
      messages: [
        { role: 'system', content: SYNTH_SYSTEM },
        {
          role: 'user',
          content: `Question: ${question}\n\nSources:\n\n${buildEvidence(sources)}`
        }
      ],
      temperature: 0.2,
      maxTokens: 1400,
      // The brief is written from evidence that is already in front of the
      // model, cited passage by passage. Deliberating first produces the same
      // brief for twice the tokens — and on a 9B reasoning model those 1400
      // tokens were being spent entirely on the thinking, so the brief came
      // back empty after the whole crawl had been paid for.
      thinking: false,
      // Whatever retrieval did not spend. Retrieval stopped early to leave
      // this, so the brief is not racing a deadline the fetches already ate.
      timeoutMs: tracker.synthesisBudgetMs,
      signal: options.signal
    })
  } catch (err) {
    // Sources were read, ranked and cited; only the write-up fell over. The
    // run's whole cost is already paid, and handing back an error string
    // throws away every page of it — so keep what exists and say what is
    // missing. A partial brief beats nothing; a source list beats a partial.
    if (err instanceof PartialCompletionError && err.partial.trim().length > 200) {
      brief = err.partial
      synthesisNote =
        'The brief was cut off before it finished (' +
        `${err.message}). It stops mid-thought — treat the end as incomplete, and read the ` +
        'sources below for anything it did not reach.'
    } else {
      brief = ''
      synthesisNote =
        `The model could not write the brief (${err instanceof Error ? err.message : String(err)}). ` +
        'The sources below were retrieved and ranked successfully — they are listed unread ' +
        'rather than summarized. Nothing here has been synthesized, so state that plainly ' +
        'rather than presenting a summary you did not receive.'
    }
  }

  // v1.9: the brief under the grounding ladder. The synthesizer wrote it from
  // `sources[].passages`; check every figure, measurement and citation in it
  // against exactly those passages, hand the findings back for one revision,
  // re-check, and disclose. Before this, an invented figure in the brief
  // became tool output — the corpus every downstream check trusts — and
  // reached the user wearing a citation. See researchGrounding.ts.
  let grounding: { before: ResearchGroundingReport; after: ResearchGroundingReport | null; revised: boolean } | undefined
  // SIGMA_RESEARCH_GROUNDING=0 is the eval's baseline arm — the brief as it
  // was before this rung existed. Unset (every real run) means on.
  if (brief.trim() && sources.length > 0 && process.env.SIGMA_RESEARCH_GROUNDING !== '0') {
    const before = checkResearchGrounding(brief, sources)
    grounding = { before, after: null, revised: false }
    if (!researchGroundingIsClean(before) && !options.signal?.aborted) {
      progress('checking', `Brief states specifics its sources do not contain — asking for one revision`)
      try {
        const revised = await chatCompleteStream({
          model,
          messages: [
            { role: 'system', content: SYNTH_SYSTEM },
            { role: 'user', content: `Question: ${question}\n\nSources:\n\n${buildEvidence(sources)}` },
            { role: 'assistant', content: brief },
            { role: 'user', content: buildResearchRevision(before) }
          ],
          temperature: 0.2,
          maxTokens: 1400,
          thinking: false,
          timeoutMs: Math.max(20_000, Math.floor(tracker.synthesisBudgetMs / 2)),
          signal: options.signal
        })
        const after = checkResearchGrounding(revised, sources)
        // Keep the revision only if it is strictly better on what was flagged
        // and did not become a non-answer — the same rule as every other rung.
        const better =
          after.figures.length + after.measurements.length + after.badCitations.length <
            before.figures.length + before.measurements.length + before.badCitations.length &&
          revised.trim().length > Math.min(200, brief.trim().length * 0.4)
        if (better) {
          brief = revised
          grounding = { before, after, revised: true }
        } else {
          grounding = { before, after: null, revised: false }
        }
      } catch {
        // A failed revision leaves the original standing, flagged.
        grounding = { before, after: null, revised: false }
      }
    }
  }

  // An empty brief with sources in hand is still a usable result — the caller
  // reports it as retrieved-but-unsynthesized rather than as a failed run.
  if (!brief.trim() && !synthesisNote) {
    synthesisNote =
      'The model returned an empty brief. The sources below were retrieved and ranked ' +
      'successfully but nothing was synthesized from them; say so rather than summarizing ' +
      'them yourself from memory.'
  }

  return {
    ok: true,
    brief: brief.trim(),
    synthesized: brief.trim().length > 0 && !synthesisNote,
    synthesisNote,
    plan,
    planned,
    sources,
    coverage,
    sentQueries,
    redactions: [...redactions],
    grounding: grounding ? { ...grounding, note: describeResearchGrounding(grounding) } : undefined,
    ledger: tracker.ledger()
  }
}
