import type { ReadSource, SubQuestion } from './types'

// ---- coverage ---------------------------------------------------------------

/** A passage this weak is not evidence; it is the ranker returning its best of a bad set. */
const COVERAGE_SCORE_FLOOR = 0.25
/** And a sub-question needs at least this much text behind it to count as answered. */
const COVERAGE_CHAR_FLOOR = 200

/**
 * Which sub-questions actually got answered.
 *
 * This drives the reflect step, so it is deliberately mechanical rather than
 * asking the model to grade itself: a model asked "did you answer this?" says yes
 * almost always, which would make the second round never happen.
 */
export function assessCoverage(
  subQuestions: SubQuestion[],
  sources: ReadSource[]
): { question: string; covered: boolean }[] {
  return subQuestions.map((sub, index) => {
    const relevant = sources.filter((s) => s.subQuestion === index)
    const chars = relevant.reduce(
      (total, source) =>
        total +
        source.passages
          .filter((p) => p.score >= COVERAGE_SCORE_FLOOR)
          .reduce((n, p) => n + p.text.length, 0),
      0
    )
    return { question: sub.question, covered: chars >= COVERAGE_CHAR_FLOOR }
  })
}
