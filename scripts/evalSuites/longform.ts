/**
 * v2.6: the `longform` suite — does a 9B write a 1,500-word document that
 * holds together?
 *
 * Twelve document-shaped requests, each with an explicit length and a list
 * of section headings. The rubric is mechanical: every required section
 * present as a heading; the length reached; the token cap not hit; and no
 * two sections restating one another — measured as the highest pairwise
 * cosine between section texts, embedded by the same loopback model the app
 * uses for everything else. No tools ride, so there are no figures to trace.
 *
 * Two arms: `bare` (one completion, the v2.5 app) and `outline` (a JSON
 * outline first, then one completion per section — the v2.6 feature). The
 * outline arm's module is required lazily so the bare arm runs on a tree
 * that has no outline yet, which is how the baseline was measured.
 */
import { join } from 'node:path'
import type { LongformArm, LongformArmResult, LongformCaseResult } from '../../src/renderer/src/lib/answerEval'

export interface LongformFixture {
  file: string
  prompt: string
  sections: string[]
  minWords: number
}

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: unknown; tool_call_id?: string }

export interface LongformDeps {
  repoRoot: string
  persona: string
  arms: LongformArm[]
  slice<T>(items: T[]): T[]
  loadJson<T>(dir: string): (T & { file: string })[]
  complete(model: string, messages: Msg[], tools?: unknown[]): Promise<{ content: string; finishReason?: string }>
}

export async function runLongformSuite(model: string, deps: LongformDeps): Promise<LongformCaseResult[]> {
  const { sectionsOf, wordCount, requiredSectionsPresent } = require('../../src/renderer/src/lib/answerEval') as typeof import('../../src/renderer/src/lib/answerEval')
  const { withGrounding } = require('../../src/renderer/src/lib/grounding') as typeof import('../../src/renderer/src/lib/grounding')
  const { embedTexts, toUnitVector, unitDot } = require('../../src/main/ipc/embeddings') as typeof import('../../src/main/ipc/embeddings')

  type OutlineMod = typeof import('../../src/main/ipc/outline')
  let outline: OutlineMod | null = null
  if (deps.arms.includes('outline')) outline = require('../../src/main/ipc/outline') as OutlineMod

  const redundancyOf = async (sections: { text: string }[]): Promise<number | null> => {
    const texts = sections.map((s) => s.text.trim()).filter((t) => t.length > 40)
    if (texts.length < 2) return null
    const { vectors } = await embedTexts(texts)
    const units = vectors.map(toUnitVector)
    let max = -1
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) max = Math.max(max, unitDot(units[i]!, units[j]!))
    }
    return Math.round(max * 1000) / 1000
  }

  const score = async (fx: LongformFixture, reply: string, truncated: boolean, ms: number): Promise<LongformArmResult> => {
    const sections = sectionsOf(reply)
    const { found, missing } = requiredSectionsPresent(fx.sections, sections.map((s) => s.heading))
    return {
      words: wordCount(reply),
      sectionsFound: found.length,
      sectionsOf: fx.sections.length,
      missing,
      redundancy: await redundancyOf(sections),
      truncated,
      ms,
      reply: reply.slice(0, 2500)
    }
  }

  const fixtures = deps.slice(deps.loadJson<LongformFixture>(join(deps.repoRoot, 'test', 'fixtures', 'longform')))
  const results: LongformCaseResult[] = []
  for (const [i, fx] of fixtures.entries()) {
    const caseOut: LongformCaseResult = { file: fx.file, prompt: fx.prompt, minWords: fx.minWords, arms: {} }
    for (const arm of deps.arms) {
      const t0 = Date.now()
      try {
        if (arm === 'bare') {
          const r = await deps.complete(model, [
            { role: 'system', content: withGrounding(deps.persona) },
            { role: 'user', content: fx.prompt }
          ])
          caseOut.arms.bare = await score(fx, r.content, r.finishReason === 'length', Date.now() - t0)
        } else {
          const r = await outline!.writeOutlined({ model, persona: withGrounding(deps.persona), request: fx.prompt })
          caseOut.arms.outline = await score(fx, r.text, r.truncated, Date.now() - t0)
        }
      } catch (err) {
        caseOut.arms[arm] = { words: 0, sectionsFound: 0, sectionsOf: fx.sections.length, missing: fx.sections, redundancy: null, truncated: false, ms: Date.now() - t0, reply: '', error: err instanceof Error ? err.message : String(err) }
      }
      const a = caseOut.arms[arm]!
      process.stdout.write(
        `  ${fx.file.padEnd(26)} [${arm.padEnd(7)}] ${a.error ? `! ${a.error.slice(0, 70)}` : `${a.sectionsFound}/${a.sectionsOf} sections${a.missing.length ? ` (missing ${a.missing.join(', ')})` : ''} · ${a.words} words${a.words < fx.minWords ? ' (short)' : ''} · redundancy ${a.redundancy ?? '—'}${a.truncated ? ' · TRUNCATED' : ''} · ${(a.ms / 1000).toFixed(0)}s`}  [${i + 1}/${fixtures.length}]\n`
      )
    }
    results.push(caseOut)
  }
  return results
}
