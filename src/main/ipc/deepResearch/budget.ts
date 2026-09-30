import type { ResearchBudget, ResearchDepth, ResearchLedger } from './types'

// ---- budget ------------------------------------------------------------------

export function budgetFor(depth: ResearchDepth): ResearchBudget {
  switch (depth) {
    case 'quick':
      return {
        maxRounds: 1,
        maxSearches: 3,
        maxFetches: 4,
        maxHosts: 4,
        maxWallClockMs: 60_000,
        synthesisReserveMs: 20_000
      }
    case 'thorough':
      return {
        maxRounds: 4,
        maxSearches: 12,
        maxFetches: 16,
        maxHosts: 12,
        maxWallClockMs: 300_000,
        synthesisReserveMs: 60_000
      }
    case 'standard':
    default:
      // Rounds are coverage-driven: the loop stops as soon as every
      // sub-question is answered, so a higher ceiling costs nothing on easy
      // questions and buys persistence on hard ones.
      return {
        maxRounds: 3,
        maxSearches: 8,
        maxFetches: 10,
        maxHosts: 8,
        maxWallClockMs: 150_000,
        synthesisReserveMs: 45_000
      }
  }
}

/**
 * Mutable spend tracker. Every phase asks before acting, which is what makes the
 * ceiling real rather than nominal.
 */
export class BudgetTracker {
  readonly startedAt = Date.now()
  rounds = 0
  searches = 0
  fetches = 0
  readonly hosts = new Set<string>()
  readonly limitsHit: string[] = []

  constructor(private readonly budget: ResearchBudget) {}

  private hit(limit: string): false {
    if (!this.limitsHit.includes(limit)) this.limitsHit.push(limit)
    return false
  }

  /**
   * True once retrieval must stop. This is the *retrieval* deadline, which is
   * deliberately earlier than the run's overall wall clock: whatever is left
   * belongs to synthesis, which cannot borrow time it does not have.
   */
  get expired(): boolean {
    const deadline = Math.max(0, this.budget.maxWallClockMs - this.budget.synthesisReserveMs)
    // `>=`, not `>`: a reserve that consumes the whole wall clock leaves
    // retrieval no time at all, and that has to read as expired immediately
    // rather than granting one free round.
    return Date.now() - this.startedAt >= deadline
  }

  /** Milliseconds left for synthesis, never less than the stated reserve. */
  get synthesisBudgetMs(): number {
    const spent = Date.now() - this.startedAt
    return Math.max(this.budget.synthesisReserveMs, this.budget.maxWallClockMs - spent)
  }

  canSearch(): boolean {
    if (this.expired) return this.hit('time limit')
    if (this.searches >= this.budget.maxSearches) return this.hit('search limit')
    return true
  }

  canFetch(host: string): boolean {
    if (this.expired) return this.hit('time limit')
    if (this.fetches >= this.budget.maxFetches) return this.hit('fetch limit')
    // A new host is the privacy-relevant cost, so it is capped separately from
    // the number of fetches: ten pages from two domains is cheaper, in what it
    // discloses, than ten pages from ten.
    if (!this.hosts.has(host) && this.hosts.size >= this.budget.maxHosts) {
      return this.hit('distinct-host limit')
    }
    return true
  }

  canStartRound(): boolean {
    if (this.expired) return this.hit('time limit')
    if (this.rounds >= this.budget.maxRounds) return this.hit('round limit')
    return true
  }

  recordSearch(): void {
    this.searches += 1
  }

  recordFetch(host: string): void {
    this.fetches += 1
    this.hosts.add(host)
  }

  ledger(): ResearchLedger {
    return {
      rounds: this.rounds,
      searches: this.searches,
      fetches: this.fetches,
      hosts: [...this.hosts],
      elapsedMs: Date.now() - this.startedAt,
      limitsHit: [...this.limitsHit]
    }
  }
}
