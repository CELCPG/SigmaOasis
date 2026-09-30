import type { ResearchGroundingReport } from '../researchGrounding'

// ---- types -------------------------------------------------------------------

export interface SubQuestion {
  question: string
  queries: string[]
}

export interface ResearchPlan {
  subQuestions: SubQuestion[]
}

export interface ResearchBudget {
  maxRounds: number
  maxSearches: number
  maxFetches: number
  /** Distinct hosts contacted. The privacy-relevant one. */
  maxHosts: number
  maxWallClockMs: number
  /**
   * Wall clock held back from retrieval so synthesis has room to run.
   *
   * Retrieval will happily consume every second available and then leave the
   * model no time to write the brief, which is how a run that successfully
   * read eight pages returns nothing at all. The reserve makes gathering stop
   * early on purpose: fewer sources, but an actual answer.
   */
  synthesisReserveMs: number
}

export type ResearchDepth = 'quick' | 'standard' | 'thorough'

export interface CandidateSource {
  url: string
  title: string
  snippet: string
  /** Index of the sub-question this result was found for. */
  subQuestion: number
}

export interface ReadSource {
  index: number
  url: string
  title: string
  subQuestion: number
  passages: { text: string; score: number }[]
  /** 'static' or 'rendered'. */
  via: string
}

export interface ResearchLedger {
  rounds: number
  searches: number
  fetches: number
  hosts: string[]
  elapsedMs: number
  /** Budget limits that stopped a phase early. */
  limitsHit: string[]
}

export interface ResearchOutcome {
  ok: boolean
  brief?: string
  /**
   * False when sources were gathered but the brief is missing or truncated.
   * The run still succeeded — citations exist — but nothing may be presented
   * as a synthesis that was not actually synthesized.
   */
  synthesized?: boolean
  /** What went wrong with the write-up, when something did. */
  synthesisNote?: string
  plan?: ResearchPlan
  /** False when the planner failed and the original question was used as-is. */
  planned?: boolean
  sources?: ReadSource[]
  coverage?: { question: string; covered: boolean }[]
  ledger?: ResearchLedger
  /** Queries actually sent, after redaction. */
  sentQueries?: string[]
  redactions?: string[]
  /**
   * v1.9: the brief checked against its own evidence — what was flagged,
   * whether a revision was kept, what still stands. Rendered by the handler
   * into the tool result so the outer model carries the disclosure.
   */
  grounding?: { before: ResearchGroundingReport; after: ResearchGroundingReport | null; revised: boolean; note: string }
  error?: string
  /**
   * v2.3: which kind of "no brief" this is — the distinction round 8 built for
   * the tool rows, which this tool never learned to make. 'empty' is a campaign
   * that ran and found nothing usable; 'declined' is one where nothing was
   * contacted at all, because the user cancelled the plan or the privacy filter
   * refused every query. Both used to arrive as `ok: false` with prose, so the
   * row said `✗` and the footer said `(errored)` about a search that worked and
   * a search that never happened alike. Absent means what it says: broken.
   */
  kind?: 'empty' | 'declined'
}

export type ProgressFn = (phase: string, detail: string) => void
