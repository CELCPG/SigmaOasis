/**
 * v4.1 (M2): compare an eval run with a baseline, or save a run as one.
 * The rules live in src/main/agent/evalDiff.ts; this is the shell.
 *
 *   npm run eval:diff -- <baseline.json> <run.json> [--tolerance 0.05]
 *   npm run eval:diff -- --save <run.json> [--name agent-qwen3.8-9b]
 *
 * Exit 0: the run holds. 1: a gated line got worse. 2: the files could not be
 * read or compared. No model, no network: it reads two files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { detectSuite, diffResults, formatDiff, trimForBaseline } from '../src/main/agent/evalDiff'

// Compiled by scripts/eval-diff.sh to .eval-build/diff/scripts/eval-diff.js —
// its own folder, so a diff never clobbers an eval's build mid-run.
const REPO_ROOT = join(__dirname, '..', '..', '..')
// npm runs the script from the repo root; a path is the user's, from where they typed it.
const CWD = process.env.INIT_CWD ?? process.cwd()
const BASELINES = join(REPO_ROOT, 'baselines')
const USAGE = 'usage: npm run eval:diff -- <baseline.json> <run.json> [--tolerance 0.05]\n       npm run eval:diff -- --save <run.json> [--name <baseline-name>]'

function read(path: string): unknown {
  return JSON.parse(readFileSync(resolve(CWD, path), 'utf8')) as unknown
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

function main(): number {
  const args = process.argv.slice(2)
  const save = flag(args, '--save')
  const name = flag(args, '--name')
  const tol = flag(args, '--tolerance')
  if (save) {
    const file = read(save)
    const suite = detectSuite(file)
    const f = file as { model?: string; experiments?: Record<string, boolean>; arm?: string }
    const arm = Object.keys(f.experiments ?? {}).filter((k) => f.experiments![k]).sort().join('+')
    const auto = `${suite}-${String(f.model ?? 'model').replace(/[^a-z0-9._-]+/gi, '_')}${arm ? `-x-${arm}` : ''}${f.arm && f.arm !== 'full' ? `-${f.arm}` : ''}`
    const out = join(BASELINES, `${(name ?? auto).replace(/\.json$/, '')}.json`)
    mkdirSync(BASELINES, { recursive: true })
    const replacing = existsSync(out)
    writeFileSync(out, JSON.stringify(trimForBaseline(file, basename(save)), null, 2) + '\n')
    console.log(`${replacing ? 'replaced' : 'wrote'} ${out}${replacing ? '\n  a replaced baseline needs a commit that says why, with the diff table (baselines/README.md)' : ''}`)
    return 0
  }
  if (args.length !== 2) {
    console.error(USAGE)
    return 2
  }
  const tolerance = tol === undefined ? 0 : Number(tol)
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance >= 1) {
    console.error(`--tolerance is a fraction between 0 and 1, not ${tol}`)
    return 2
  }
  const d = diffResults(read(args[0]!), read(args[1]!), { tolerance })
  console.log(formatDiff(d))
  return d.regressions.length ? 1 : 0
}

try {
  process.exitCode = main()
} catch (err) {
  console.error(`eval:diff: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 2
}
