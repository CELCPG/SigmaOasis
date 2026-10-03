/**
 * v4.6 (J3): move recorded library results to the current library scorer.
 *
 *   npm run eval:library-rescore -- <results.json | folder> [more …] [--skip <text> …] [--write [--reformat]]
 *
 * For every `eval:answers` results file with a library block (a folder is
 * walked) it re-reads each run's reply against the case's patterns
 * (test/fixtures/library/*.json, test/fixtures/library-aids/cases/*.json — a
 * run with a `kind` is a library-aids case, any other is a library one) with
 * the scorer in src/renderer/src/lib/answerEval.ts (`scoreLibrary`, rule
 * LIBRARY_SCORER_RULE: Unicode spaces, dashes and quotes read as plain ones),
 * and says which flags would move and why: the normalisation, or an older
 * scorer (src/main/agent/evalLibraryRescore.ts). Without --write it only says;
 * with it, each file is rewritten with the flags moved, its summaries
 * recomputed and `libraryScorerRule` stamped beside the library block, so
 * eval:diff can refuse a comparison across scorers. A file that is not 2-space
 * JSON with a final newline is not written (its diff would be the whole file)
 * unless --reformat says so. --skip leaves out any file whose path contains the
 * text (the sensitivity copies a person made by hand, say).
 *
 * `cited` and `unsupported` are not re-read (the file does not keep the passages);
 * the tool counts the replies whose measurements the normalisation would change,
 * which is what `unsupported` could move on. No model, no network: it reads files.
 */
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { LIBRARY_SCORER_RULE, type LibraryCaseResult } from '../src/renderer/src/lib/answerEval'
import { detectSuite, libraryScorerRuleOf } from '../src/main/agent/evalDiff'
import { rescoreLibraryFile, type LibraryFixtureLike } from '../src/main/agent/evalLibraryRescore'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const CWD = process.env.INIT_CWD ?? process.cwd()

function files(path: string, out: string[] = []): string[] {
  const p = resolve(CWD, path)
  if (!existsSync(p)) throw new Error(`no such file or folder: ${path}`)
  if (statSync(p).isDirectory()) {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory() && (e.name === 'node_modules' || e.name === '.git')) continue
      files(join(p, e.name), out)
    }
  } else if (p.endsWith('.json')) out.push(p)
  return out
}

const fixtureCache = new Map<string, LibraryFixtureLike | null>()
function fixture(dir: string, name: string): LibraryFixtureLike | undefined {
  const p = join(REPO_ROOT, dir, name)
  if (!fixtureCache.has(p)) fixtureCache.set(p, existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as LibraryFixtureLike) : null)
  return fixtureCache.get(p) ?? undefined
}
const LIBRARY = 'test/fixtures/library'
const AIDS = 'test/fixtures/library-aids/cases'
/** A library-aids run has a `kind`; the fixture of the other suite is the fall-back. */
const fixtureOf = (run: LibraryCaseResult): LibraryFixtureLike | undefined => (run.kind ? (fixture(AIDS, run.file) ?? fixture(LIBRARY, run.file)) : (fixture(LIBRARY, run.file) ?? fixture(AIDS, run.file)))

function main(argv: string[]): number {
  const args = [...argv]
  const skip: string[] = []
  for (let i = args.indexOf('--skip'); i !== -1; i = args.indexOf('--skip')) {
    skip.push(args[i + 1] ?? '')
    args.splice(i, 2)
  }
  const write = args.includes('--write')
  const reformat = args.includes('--reformat')
  const paths = args.filter((a) => !a.startsWith('--'))
  if (paths.length === 0) {
    process.stderr.write('usage: npm run eval:library-rescore -- <results.json | folder> [more …] [--skip <text> …] [--write [--reformat]]\n')
    return 2
  }
  const out: string[] = []
  const w = (s = ''): number => out.push(s)
  w(`Re-scoring library results under library scorer rule ${LIBRARY_SCORER_RULE}${write ? ' (writing)' : ' (dry run — add --write to write)'}.`)
  const tally = { files: 0, runs: 0, normalisation: 0, older: 0, measurements: 0, refused: 0, inexactSummaries: 0, copies: 0, suiteStamped: 0 }
  const byField: Record<string, number> = {}
  const seen = new Set<string>()
  for (const p of paths) {
    for (const f of files(p)) {
      if (skip.some((s) => s && f.includes(s))) continue
      const raw = readFileSync(f, 'utf8')
      let j: Record<string, unknown>
      try {
        j = JSON.parse(raw) as Record<string, unknown>
      } catch {
        continue
      }
      try {
        if (detectSuite(j) !== 'library') continue
      } catch {
        continue
      }
      // The same file in several folders (a worktree's copy of a results folder) is one file: it is counted and written once, where it was first met.
      const hash = createHash('md5').update(raw).digest('hex')
      if (seen.has(hash)) {
        tally.copies++
        continue
      }
      seen.add(hash)
      w()
      w(f)
      let res: ReturnType<typeof rescoreLibraryFile>
      try {
        res = rescoreLibraryFile(j, fixtureOf)
      } catch (err) {
        w(`  skipped: ${(err as Error).message}`)
        continue
      }
      tally.files++
      tally.runs += res.read
      tally.measurements += res.measurementsMoved
      if (!res.summariesExact) tally.inexactSummaries++
      w(`  was scorer rule ${libraryScorerRuleOf(j)}; runs read from a reply and a case: ${res.read}; left as they were — errored ${res.left.errored}, no reply ${res.left.noReply}, no case fixture ${res.left.noFixture.length}${res.left.noFixture.length ? ` (${[...new Set(res.left.noFixture)].slice(0, 4).join(', ')}${new Set(res.left.noFixture).size > 4 ? ', …' : ''})` : ''}`)
      w(`  replies whose measurements the normalisation would change: ${res.measurementsMoved}${res.summariesExact ? '' : ' · the stored summaries are not what the stored flags give (recomputed on write)'}`)
      const n = res.changes.filter((c) => c.because === 'normalisation').length
      const o = res.changes.length - n
      tally.normalisation += n
      tally.older += o
      if (res.suiteStamped) {
        tally.suiteStamped++
        w('  holds library-aids runs and does not say so: librarySuite library-aids is stamped')
      }
      w(`  flags moved: ${res.changes.length} (the normalisation ${n}, an older scorer ${o})`)
      for (const c of res.changes) {
        byField[`${c.field} ${c.was}→${c.now} (${c.because})`] = (byField[`${c.field} ${c.was}→${c.now} (${c.because})`] ?? 0) + 1
        w(`    pass ${c.pass} ${c.case}: ${c.field} ${c.was} → ${c.now} — ${c.because}${c.patterns.length ? ` [${c.patterns.join(' ; ').slice(0, 90)}]` : ''}`)
      }
      if (write) {
        if (!reformat && JSON.stringify(j, null, 2) + '\n' !== raw && JSON.stringify(j, null, 2) !== raw) {
          w('  NOT written: the file is not 2-space JSON, and writing would reformat all of it (--reformat to write it anyway)')
          tally.refused++
          continue
        }
        // keep the file's own ending: with a final newline or without
        writeFileSync(f, JSON.stringify(res.file, null, 2) + (raw.endsWith('\n') ? '\n' : ''))
        w('  written')
      }
    }
  }
  w()
  w(`${tally.files} library file${tally.files === 1 ? '' : 's'} read${write ? ' and written' : ''}${tally.refused ? `, ${tally.refused} refused` : ''} (${tally.copies} byte-identical cop${tally.copies === 1 ? 'y' : 'ies'} skipped); ${tally.runs} runs re-scored.`)
  w(`flags moved — by the normalisation: ${tally.normalisation}; by an older scorer: ${tally.older}. ${JSON.stringify(byField)}`)
  w(`files stamped librarySuite library-aids (they held library-aids runs and did not say so): ${tally.suiteStamped}.`)
  w(`replies whose measurements (so: unsupported) the normalisation would change: ${tally.measurements}. Files whose stored summaries were not exact: ${tally.inexactSummaries}.`)
  process.stdout.write(out.join('\n') + '\n')
  return tally.refused > 0 ? 2 : 0
}

process.exitCode = main(process.argv.slice(2))
