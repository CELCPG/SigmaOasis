/**
 * v4.1 (M2), v4.3: compare an eval run with a baseline, or save runs as one.
 * The rules live in src/main/agent/evalDiff.ts; this is the shell.
 *
 *   npm run eval:diff -- <baseline.json> <run.json> [<run2.json> …] [--tolerance 0.05] [--min-passes 4]
 *   npm run eval:diff -- --base <a.json> [<b.json> …] --run <c.json> [<d.json> …]
 *   npm run eval:diff -- --save <run.json> [<run2.json> …] [--name agent-qwen3.8-9b]
 *
 * Several files on one side are one arm: their passes merge, and the runs they
 * came from are counted (passes of one run share the server's state).
 *
 * Exit 0: BETTER or SAME-WITHIN-NOISE. 1: WORSE. 2: the files could not be read
 * or compared. 3: TOO-FEW-PASSES — fewer than four passes on a side, so no
 * banded line was called. No model, no network: it reads files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { MIN_PASSES, detectSuite, diffResults, formatDiff, measureNoise, mergeResults, trimForBaseline } from '../src/main/agent/evalDiff'

// Compiled by scripts/eval-diff.sh to .eval-build/diff/scripts/eval-diff.js —
// its own folder, so a diff never clobbers an eval's build mid-run.
const REPO_ROOT = join(__dirname, '..', '..', '..')
// npm runs the script from the repo root; a path is the user's, from where they typed it.
const CWD = process.env.INIT_CWD ?? process.cwd()
const BASELINES = join(REPO_ROOT, 'baselines')
const USAGE = [
  'usage: npm run eval:diff -- <baseline.json> <run.json> [<run2.json> …] [--tolerance 0.05] [--min-passes 4]',
  '       npm run eval:diff -- --base <a.json> [<b.json> …] --run <c.json> [<d.json> …]',
  '       npm run eval:diff -- --save <run.json> [<run2.json> …] [--name <baseline-name>]'
].join('\n')

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

/** One arm from one or more results files. */
function arm(paths: string[]): unknown {
  return mergeResults(paths.map(read), paths.map((p) => basename(p)))
}

/** The paths after `--<marker>`, up to the next `--` flag. */
function after(args: string[], marker: string): string[] {
  const i = args.indexOf(marker)
  if (i === -1) return []
  const rest = args.slice(i + 1)
  const end = rest.findIndex((a) => a.startsWith('--'))
  return end === -1 ? rest : rest.slice(0, end)
}

function main(): number {
  const args = process.argv.slice(2)
  const name = flag(args, '--name')
  const tol = flag(args, '--tolerance')
  const min = flag(args, '--min-passes')

  if (args.includes('--save')) {
    const paths = after(args, '--save')
    if (!paths.length) {
      console.error(USAGE)
      return 2
    }
    const file = arm(paths)
    const suite = detectSuite(file)
    const f = file as { model?: string; experiments?: Record<string, boolean>; arm?: string }
    const x = Object.keys(f.experiments ?? {}).filter((k) => f.experiments![k]).sort().join('+')
    const auto = `${suite}-${String(f.model ?? 'model').replace(/[^a-z0-9._-]+/gi, '_')}${x ? `-x-${x}` : ''}${f.arm && f.arm !== 'full' ? `-${f.arm}` : ''}`
    const out = join(BASELINES, `${(name ?? auto).replace(/\.json$/, '')}.json`)
    mkdirSync(BASELINES, { recursive: true })
    const replacing = existsSync(out)
    const from = paths.map((p) => basename(p))
    writeFileSync(out, JSON.stringify(trimForBaseline(file, from.length === 1 ? from[0]! : from, new Date(), { noise: true }), null, 2) + '\n')
    const noise = measureNoise(file)
    const solved = noise.lines.solved
    const scale = solved ? Math.round(solved.of.reduce((a, b) => a + b, 0) / solved.of.length) : 0
    console.log(`${replacing ? 'replaced' : 'wrote'} ${out}`)
    console.log(
      `  ${noise.passes} passes from ${noise.runs} run${noise.runs === 1 ? '' : 's'}` +
        (solved ? ` · ${suite === 'agent' ? 'solved' : 'clean'} per pass [${solved.perPass.join(', ')}] of ${scale}, σ ${(solved.sd * scale).toFixed(2)}; a ${MIN_PASSES}-pass run's band ±${(solved.band * scale).toFixed(2)}` : '')
    )
    if (noise.passes < MIN_PASSES) console.log(`  fewer than ${MIN_PASSES} passes: every diff against this baseline will say TOO-FEW-PASSES (baselines/README.md)`)
    if (noise.runs < 2) console.log('  one run: the spread between runs is not in the band — merge a second run when you can')
    if (replacing) console.log('  a replaced baseline needs a commit that says why, with the diff table (baselines/README.md)')
    return 0
  }

  const grouped = args.includes('--base') || args.includes('--run')
  const basePaths = grouped ? after(args, '--base') : args.slice(0, 1)
  const runPaths = grouped ? after(args, '--run') : args.slice(1)
  if (!basePaths.length || !runPaths.length || (!grouped && args.some((a) => a.startsWith('--')))) {
    console.error(USAGE)
    return 2
  }
  const tolerance = tol === undefined ? 0 : Number(tol)
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance >= 1) {
    console.error(`--tolerance is a fraction between 0 and 1, not ${tol}`)
    return 2
  }
  const minPasses = min === undefined ? MIN_PASSES : Number(min)
  if (!Number.isInteger(minPasses) || minPasses < 1) {
    console.error(`--min-passes is a whole number of passes, not ${min}`)
    return 2
  }
  const d = diffResults(arm(basePaths), arm(runPaths), { tolerance, minPasses })
  console.log(formatDiff(d))
  return d.verdict === 'WORSE' ? 1 : d.verdict === 'TOO-FEW-PASSES' ? 3 : 0
}

try {
  process.exitCode = main()
} catch (err) {
  console.error(`eval:diff: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 2
}
