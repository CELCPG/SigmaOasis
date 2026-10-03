/**
 * v4.5 (H3): read recorded agent runs the way the unrun-claim guard does.
 *
 *   npm run eval:claims -- <results.json | folder> [more …] [--before <git-rev>] [--list]
 *
 * For every agent results file (a folder is walked; identical files and runs
 * are counted once) it re-scores each run with the shared rule in
 * src/main/agent/claims.ts and says:
 *
 *   - whether the moved code scores as the code it replaced: with --before, the
 *     claim detectors of that git revision (the evalHarness.ts the move left)
 *     are run over every recorded report beside the shared ones, and any report
 *     they read differently is named. Zero is the claim.
 *   - whether the stored flags still stand: a recorded `claimedPass` and
 *     `falseClaim` against the shared code (a run's report is cut at 4,000
 *     characters in the file; a claim in the cut part cannot be re-read).
 *   - what the guard would mark: `unrunClaim` on the report and the recorded
 *     last test run. A mark on a run the eval scored clean is a defect.
 *
 * Runs recorded without their report (the committed baselines drop it) are
 * re-scored from the stored `claimedPass` and `lastTest` alone, and counted
 * apart. No model, no network: it reads files.
 */
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import * as vm from 'vm'
import { claimsSuccess, claimsTestsPass, isFalseClaim, unrunClaim, type TestRun } from '../src/main/agent/claims'

interface StoredRun {
  case: string
  model: string
  claimedPass?: boolean
  falseClaim?: boolean
  lastTest?: TestRun | null
  finalText?: string
  ms?: number
  rounds?: number
  toolCalls?: number
  completionTokens?: number
  promptTokens?: number
  declined?: string[]
  excluded?: string
}

interface Differ {
  file: string
  case: string
  was: boolean
  now: boolean
  what: string
}

interface Source {
  file: string
  /** The experiments the file was run with, as the arm's name; "default engine" when none. */
  arm: string
  run: StoredRun
}

const REPO_ROOT = join(__dirname, '..', '..', '..')
const CWD = process.env.INIT_CWD ?? process.cwd()
const CUT = 4_000

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

/** The claim detectors of a git revision's evalHarness.ts: the block between its two markers, compiled and run. */
function detectorsAt(rev: string): { claimsTestsPass: (t: string) => boolean; claimsSuccess: (t: string) => boolean } {
  const source = execFileSync('git', ['show', `${rev}:src/main/agent/evalHarness.ts`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const a = source.indexOf('// ---- what the report claims')
  const b = source.indexOf('export function missingMentions')
  if (a < 0 || b < 0) throw new Error(`${rev}: evalHarness.ts has no claim block — that revision is already past the move`)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript')
  const js = ts.transpileModule(source.slice(a, b), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const sandbox: { exports: Record<string, unknown> } = { exports: {} }
  vm.runInNewContext(js, { exports: sandbox.exports, RegExp, String }, { filename: `evalHarness@${rev}` })
  return sandbox.exports as { claimsTestsPass: (t: string) => boolean; claimsSuccess: (t: string) => boolean }
}

function main(argv: string[]): number {
  const args = [...argv]
  const take = (name: string): string | undefined => {
    const i = args.indexOf(name)
    if (i === -1) return undefined
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  const before = take('--before')
  const list = args.includes('--list')
  const paths = args.filter((a) => !a.startsWith('--'))
  if (paths.length === 0) {
    process.stderr.write('usage: npm run eval:claims -- <results.json | folder> [more …] [--before <git-rev>] [--list]\n')
    return 2
  }

  // ---- read: files once, runs once (a joined baseline copies the runs of the passes it came from)
  const seenFiles = new Set<string>()
  const byRun = new Map<string, Source>()
  let agentFiles = 0
  let runsRead = 0
  for (const path of paths) {
    for (const f of files(path)) {
      let raw: Buffer
      try {
        raw = readFileSync(f)
      } catch {
        continue
      }
      const h = createHash('md5').update(raw).digest('hex')
      if (seenFiles.has(h)) continue
      seenFiles.add(h)
      let j: { suite?: string; runs?: unknown; experiments?: Record<string, unknown> }
      try {
        j = JSON.parse(raw.toString('utf8')) as typeof j
      } catch {
        continue
      }
      if (j.suite !== 'agent' || !Array.isArray(j.runs)) continue
      agentFiles++
      const arm =
        Object.keys(j.experiments ?? {})
          .filter((k) => j.experiments![k])
          .sort()
          .join('+') || 'default engine'
      for (const r of (j.runs as unknown[]).flat() as StoredRun[]) {
        if (!r || typeof r !== 'object' || typeof r.case !== 'string') continue
        runsRead++
        // The same run, however many files carry it, is one: model, case, wall time and tokens say so.
        const key = [r.model, r.case, r.ms, r.completionTokens, r.promptTokens, r.rounds, r.toolCalls].join('|')
        const have = byRun.get(key)
        if (!have || (!have.run.finalText && r.finalText)) byRun.set(key, { file: f, arm, run: r })
      }
    }
  }
  const all = [...byRun.values()]
  const scored = all.filter((s) => !s.run.excluded)
  const withText = scored.filter((s) => typeof s.run.finalText === 'string' && s.run.finalText.length > 0)
  const noText = scored.length - withText.length

  // ---- the move: the old detectors against the shared ones, over every report
  let moved: { claims: number; success: number; differ: Differ[] } | null = null
  if (before) {
    const old = detectorsAt(before)
    const differ: Differ[] = []
    let claims = 0
    let success = 0
    for (const s of withText) {
      const t = s.run.finalText!
      const [oc, nc, os, ns] = [old.claimsTestsPass(t), claimsTestsPass(t), old.claimsSuccess(t), claimsSuccess(t)]
      if (oc) claims++
      if (os) success++
      if (oc !== nc) differ.push({ file: s.file, case: s.run.case, was: oc, now: nc, what: 'claimsTestsPass' })
      if (os !== ns) differ.push({ file: s.file, case: s.run.case, was: os, now: ns, what: 'claimsSuccess' })
    }
    moved = { claims, success, differ }
  }

  // ---- the stored flags and the mark
  let claimedNow = 0
  let storedClaimed = 0
  let storedFalse = 0
  let marked = 0
  const arms = new Map<string, { runs: number; claimed: number; marked: number; scoredFalse: number }>()
  const flagDrift: string[] = []
  const falseDrift: string[] = []
  const defects: string[] = []
  const misses: string[] = []
  const catches: { run: Source; mark: string }[] = []
  for (const s of scored) {
    const r = s.run
    const text = r.finalText ?? ''
    const readable = text.length > 0
    const cut = text.length > CUT
    const last: TestRun | null = r.lastTest ?? null
    const hasFlags = typeof r.claimedPass === 'boolean' && typeof r.falseClaim === 'boolean'
    if (!hasFlags) continue
    if (r.claimedPass) storedClaimed++
    if (r.falseClaim) storedFalse++
    // What the shared code reads: the report when there is one, the stored claim when there is not.
    const claimed = readable ? claimsTestsPass(text) : r.claimedPass!
    if (claimed) claimedNow++
    if (readable && claimed !== r.claimedPass) flagDrift.push(`${r.case} (${s.file.split(/[\\/]/).slice(-2).join('/')}): stored claimedPass ${r.claimedPass}, shared code ${claimed}${cut ? ' — the report is cut in the file' : ''}`)
    if (isFalseClaim(r.claimedPass!, last) !== r.falseClaim) falseDrift.push(`${r.case}: stored falseClaim ${r.falseClaim}, the shared rule on the stored claim and last test says ${!r.falseClaim}`)
    const mark = readable ? unrunClaim(text, last) : isFalseClaim(r.claimedPass!, last) ? unrunClaim('All tests pass.', last) : null
    const armKey = `${r.model} · ${s.arm}`
    const a = arms.get(armKey) ?? { runs: 0, claimed: 0, marked: 0, scoredFalse: 0 }
    a.runs++
    if (claimed) a.claimed++
    if (mark) a.marked++
    if (r.falseClaim) a.scoredFalse++
    arms.set(armKey, a)
    if (mark) {
      marked++
      if (!r.falseClaim) defects.push(`${r.case} (${s.file.split(/[\\/]/).slice(-2).join('/')}): marked, scored clean — ${mark.text}`)
      else catches.push({ run: s, mark: mark.text })
    } else if (r.falseClaim) misses.push(`${r.case} (${s.file.split(/[\\/]/).slice(-2).join('/')}): scored a false claim, not marked`)
  }

  const out: string[] = []
  const w = (s = ''): number => out.push(s)
  w(`${agentFiles} agent results files (${seenFiles.size} distinct files read), ${runsRead} runs in them, ${all.length} distinct runs (${all.length - scored.length} excluded as server failures).`)
  w(`  with the report text: ${withText.length}; without it (the baselines drop it, or the file predates it): ${noText} — re-scored from the stored claimedPass and lastTest.`)
  if (moved) {
    w()
    w(`The move (${before}): ${withText.length} reports through the old and the shared detectors — claimsTestsPass says yes to ${moved.claims}, claimsSuccess to ${moved.success}.`)
    w(`  reports read differently: ${moved.differ.length}${moved.differ.length ? '\n' + moved.differ.map((d) => `    ${d.what} ${d.case} ${d.file}: was ${d.was}, now ${d.now}`).join('\n') : ''}`)
  }
  w()
  w(`Stored flags against the shared code: claimedPass stored on ${storedClaimed}, read now on ${claimedNow}; falseClaim stored on ${storedFalse}.`)
  w(`  stored claimedPass the shared detector reads differently: ${flagDrift.length}${flagDrift.length ? '\n' + flagDrift.map((d) => `    ${d}`).join('\n') : ''}`)
  w(`  stored falseClaim the shared rule scores differently: ${falseDrift.length}${falseDrift.length ? '\n' + falseDrift.map((d) => `    ${d}`).join('\n') : ''}`)
  w()
  w(`The guard: ${marked} of ${scored.length} runs marked; the eval scored ${storedFalse} a false claim.`)
  w(`  marked and scored clean (defects): ${defects.length}${defects.length ? '\n' + defects.map((d) => `    ${d}`).join('\n') : ''}`)
  w(`  scored a false claim and not marked: ${misses.length}${misses.length ? '\n' + misses.map((d) => `    ${d}`).join('\n') : ''}`)
  w()
  w('By model and arm (distinct runs · said the tests pass · marked · scored a false claim):')
  for (const [k, a] of [...arms.entries()].sort()) w(`  ${k}: ${a.runs} · ${a.claimed} · ${a.marked} · ${a.scoredFalse}`)
  if (list) {
    w()
    w('The marked runs:')
    for (const c of catches) {
      const r = c.run.run
      w(`  ${r.model} · ${r.case} · ${c.run.file.split(/[\\/]/).slice(-3).join('/')}`)
      w(`    ${c.mark}`)
      w(`    last test: ${r.lastTest ? `${r.lastTest.command} → ${r.lastTest.exitCode}` : 'none ran'}${r.declined?.length ? ` · declined: ${r.declined.join('; ')}` : ''}`)
      if (r.finalText) w(`    report: ${r.finalText.replace(/\s+/g, ' ').slice(0, 220)}`)
    }
  }
  process.stdout.write(out.join('\n') + '\n')
  return (moved && moved.differ.length > 0) || defects.length > 0 || misses.length > 0 ? 1 : 0
}

process.exitCode = main(process.argv.slice(2))
