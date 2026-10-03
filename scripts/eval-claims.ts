/**
 * v4.5 (H3, H3b): read recorded agent runs the way the unrun-claim guard does.
 *
 *   npm run eval:claims -- <results.json | folder> [more …] [--before <git-rev>] [--same] [--list]
 *   npm run eval:claims -- <results folders> --rescore <results.json> [more …] [--write [--reformat]]
 *
 * For every agent results file (a folder is walked; identical files and runs
 * are counted once) it re-scores each run with the shared rule in
 * src/main/agent/claims.ts and says:
 *
 *   - what a change of rule moved: with --before, the claim detectors of that
 *     git revision (the claims.ts of a 4.5 revision, or the evalHarness.ts a
 *     4.4 one holds) are run over every recorded report beside the current
 *     ones, and each report they read differently is listed with the clause
 *     that decided it and how it was labelled by hand (test/fixtures/
 *     unrun-claims/labelled.json); the precision and recall of both on that set;
 *     and the false claims and needs-you solved that moved with them. --same
 *     makes any difference an exit 1 (H3's proof that a *move* of the code
 *     changed nothing).
 *   - whether the stored flags still stand: a recorded `claimedPass` and
 *     `falseClaim` against the current rule (a run's report is cut at 4,000
 *     characters in the file; a claim in the cut part cannot be re-read).
 *   - what the guard would mark: `unrunClaim` on the report and the recorded
 *     last test run, against the eval's rule (the same rule: a difference is a
 *     defect in the code, not in the rule).
 *
 * --rescore moves results files to the current rule (claims.ts CLAIMS_RULE):
 * every run's claimedPass, falseClaim and a needs-you case's solved are
 * re-scored from its report, the stored noise is measured again, and the file
 * is stamped (`claimsRule`) so eval:diff can refuse a comparison across rules
 * (src/main/agent/evalRescore.ts). Without --write it only says what would
 * move; a file that is not 2-space JSON is not written (its diff would be the
 * whole file) unless --reformat says so. A committed baseline keeps no report, so its reports are read from the
 * full results in the folders named before --rescore, by the run's own
 * fingerprint (model, case, wall time, tokens, rounds); a run whose report is
 * nowhere is left as it was and counted.
 *
 * Runs recorded without their report are otherwise re-scored from the stored
 * `claimedPass` and `lastTest` alone, and counted apart. No model, no network:
 * it reads files.
 */
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import * as vm from 'vm'
import { CLAIMS_RULE, claimClauses, claimsSuccess, claimsTestsPass, isFalseClaim, reportClauses, unrunClaim, type TestRun } from '../src/main/agent/claims'
import { rescoreAgentFile } from '../src/main/agent/evalRescore'
import { CHECKED_KINDS, type CaseRun } from '../src/main/agent/evalHarness'

type StoredRun = Partial<CaseRun> & { case: string; model: string }

interface Source {
  file: string
  /** The experiments the file was run with, as the arm's name; "default engine" when none. */
  arm: string
  run: StoredRun
}

interface Detectors {
  claimsTestsPass: (t: string) => boolean
  claimsSuccess: (t: string) => boolean
}

interface Labelled {
  items: { text: string; label: 'claim' | 'not-claim'; set: string }[]
  falseClaimReports: { run: string; label: 'claim' | 'not-claim'; clauses: string[] }[]
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

/** A run's own fingerprint: the same run, however many files carry it, is one — model, case, wall time and tokens say so. */
const keyOf = (r: StoredRun): string => [r.model, r.case, r.ms, r.completionTokens, r.promptTokens, r.rounds, r.toolCalls].join('|')

const short = (f: string): string => f.split(/[\\/]/).slice(-2).join('/')
const one = (s: string, n = 200): string => s.replace(/\s+/g, ' ').slice(0, n)

function compile(source: string, name: string, shim: (m: string) => unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const sandbox = { exports: {} as Record<string, unknown> }
  vm.runInNewContext(js, { exports: sandbox.exports, require: shim, RegExp, String }, { filename: name })
  return sandbox.exports
}

const gitShow = (rev: string, path: string): string => execFileSync('git', ['show', `${rev}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })

/** The claim detectors of a git revision: its claims.ts (4.5 on), or the block of its evalHarness.ts (4.4). */
function detectorsAt(rev: string): Detectors {
  let own: string | null = null
  try {
    own = gitShow(rev, 'src/main/agent/claims.ts')
  } catch {
    own = null
  }
  if (own) return compile(own, `claims@${rev}`, () => ({ ELIDED_PREFIX: '' })) as unknown as Detectors
  const source = gitShow(rev, 'src/main/agent/evalHarness.ts')
  const a = source.indexOf('// ---- what the report claims')
  const b = source.indexOf('export function missingMentions')
  if (a < 0 || b < 0) throw new Error(`${rev}: neither claims.ts nor a claim block in evalHarness.ts`)
  return compile(source.slice(a, b), `evalHarness@${rev}`, () => ({})) as unknown as Detectors
}

function scoreOn(labelled: Labelled, det: (t: string) => boolean): { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number } {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  for (const i of labelled.items) {
    const got = det(i.text)
    if (got && i.label === 'claim') tp++
    else if (got) fp++
    else if (i.label === 'claim') fn++
    else tn++
  }
  return { tp, fp, fn, tn, precision: tp / (tp + fp), recall: tp / (tp + fn) }
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

function main(argv: string[]): number {
  const args = [...argv]
  const take = (name: string): string | undefined => {
    const i = args.indexOf(name)
    if (i === -1) return undefined
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  const takeMany = (name: string): string[] => {
    const i = args.indexOf(name)
    if (i === -1) return []
    let j = i + 1
    const out: string[] = []
    while (j < args.length && !args[j]!.startsWith('--')) out.push(args[j++]!)
    args.splice(i, j - i)
    return out
  }
  const before = take('--before')
  const rescore = takeMany('--rescore')
  const list = args.includes('--list')
  const same = args.includes('--same')
  const write = args.includes('--write')
  const reformat = args.includes('--reformat')
  const paths = args.filter((a) => !a.startsWith('--'))
  if (paths.length === 0 && rescore.length === 0) {
    process.stderr.write('usage: npm run eval:claims -- <results.json | folder> [more …] [--before <git-rev>] [--same] [--list]\n       npm run eval:claims -- <results folders> --rescore <results.json> [more …] [--write]\n')
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
        const key = keyOf(r)
        const have = byRun.get(key)
        if (!have || (!have.run.finalText && r.finalText)) byRun.set(key, { file: f, arm, run: r })
      }
    }
  }
  const all = [...byRun.values()]
  const scored = all.filter((s) => !s.run.excluded)
  const withText = scored.filter((s) => typeof s.run.finalText === 'string' && s.run.finalText.length > 0)
  const noText = scored.length - withText.length

  const out: string[] = []
  const w = (s = ''): number => out.push(s)

  // ---- --rescore: move results files to the current rule
  if (rescore.length > 0) {
    const textOf = (r: CaseRun): string | undefined => byRun.get(keyOf(r))?.run.finalText
    let moved = 0
    let refused = 0
    w(`Re-scoring under claims rule ${CLAIMS_RULE}${write ? ' (writing)' : ' (dry run — add --write to write)'}; reports read from ${all.length} distinct recorded runs (${withText.length} with their text).`)
    for (const p of rescore) {
      for (const f of files(p)) {
        const raw = readFileSync(f, 'utf8')
        let j: Record<string, unknown>
        try {
          j = JSON.parse(raw) as Record<string, unknown>
        } catch {
          continue
        }
        if (j.suite !== 'agent' || !Array.isArray(j.runs)) continue
        const res = rescoreAgentFile(j, textOf)
        w()
        w(`${f}`)
        w(`  runs read from a report: ${res.read}; left as they were — no report anywhere: ${res.unread.runs} (of them stored as claiming a pass: ${res.unread.storedClaims}); excluded: ${res.excluded}`)
        const byField = (field: string): typeof res.changes => res.changes.filter((c) => c.field === field)
        w(`  flags moved: claimedPass ${byField('claimedPass').length}, falseClaim ${byField('falseClaim').length}, solved ${byField('solved').length}`)
        for (const c of res.changes) w(`    pass ${c.pass} ${c.case} (${c.model}): ${c.field} ${c.was} → ${c.now}`)
        if (write) {
          if (!reformat && JSON.stringify(j, null, 2) + '\n' !== raw) {
            w('  NOT written: the file is not 2-space JSON with a final newline, and writing would reformat all of it (--reformat to write it anyway)')
            refused++
            continue
          }
          writeFileSync(f, JSON.stringify(res.file, null, 2) + '\n')
          w('  written')
        }
        moved++
      }
    }
    w()
    w(`${moved} file${moved === 1 ? '' : 's'} read${write ? ' and written' : ''}${refused ? `, ${refused} refused` : ''}.`)
    process.stdout.write(out.join('\n') + '\n')
    return refused > 0 ? 2 : 0
  }

  const labelled = JSON.parse(readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'unrun-claims', 'labelled.json'), 'utf8')) as Labelled
  const labelOf = new Map(labelled.items.map((i) => [i.text, i.label]))
  const labelFor = (sentence: string): string => labelOf.get(sentence) ?? 'unlabelled'

  // ---- the change of rule: the old detectors against the current ones, over every report
  let moved: { claims: number; success: number; differ: number } | null = null
  if (before) {
    const old = detectorsAt(before)
    let claims = 0
    let success = 0
    const claimFlips: string[] = []
    const falseFlips: string[] = []
    const solvedFlips: string[] = []
    let differ = 0
    for (const s of withText) {
      const r = s.run
      const t = r.finalText!
      const last: TestRun | null = r.lastTest ?? null
      const [oc, nc, os, ns] = [old.claimsTestsPass(t), claimsTestsPass(t), old.claimsSuccess(t), claimsSuccess(t)]
      if (oc) claims++
      if (os) success++
      const where = `${r.model} · ${r.case} · ${s.arm} · ${short(s.file)}`
      const deciding = (): string[] => {
        const was = oc ? reportClauses(t).filter((c) => old.claimsTestsPass(c)) : []
        const now = nc ? claimClauses(t) : []
        return [...was.map((c) => `      was a claim: ${one(c)}  [labelled: ${labelFor(c)}]`), ...now.map((c) => `      is a claim:  ${one(c)}  [labelled: ${labelFor(c)}]`)]
      }
      if (oc !== nc) {
        differ++
        claimFlips.push(`  ${where}: claimedPass ${oc} → ${nc}`, ...deciding())
      }
      if (isFalseClaim(oc, last) !== isFalseClaim(nc, last)) falseFlips.push(`  ${where}: falseClaim ${isFalseClaim(oc, last)} → ${isFalseClaim(nc, last)} (last test: ${last ? `${last.command} → ${last.exitCode}` : 'none ran'})`, ...deciding())
      // a needs-you case's solved reads the claim only when nothing earlier decided it
      if (r.kind === 'needs-you' && !CHECKED_KINDS.has(r.kind) && (r.changed ?? []).length === 0 && (r.mentionsMissing ?? []).length === 0 && os !== ns) {
        solvedFlips.push(`  ${where}: solved ${!os} → ${!ns} (stored: ${r.solved}${r.why ? `, ${r.why}` : ''})`)
      }
      if (os !== ns && oc === nc) differ++
    }
    moved = { claims, success, differ }
    w(`agent results: ${agentFiles} files · ${all.length} distinct runs (${all.length - scored.length} excluded as server failures) · ${withText.length} with the report text, ${noText} without it.`)
    w()
    w(`What the change of rule moved (${before} → claims rule ${CLAIMS_RULE}): ${withText.length} reports — claimsTestsPass says yes to ${claims} before, ${withText.filter((s) => claimsTestsPass(s.run.finalText!)).length} now; claimsSuccess to ${success} before, ${withText.filter((s) => claimsSuccess(s.run.finalText!)).length} now.`)
    w(`  reports whose claimedPass flips: ${claimFlips.filter((l) => l.startsWith('  ') && !l.startsWith('      ')).length}${claimFlips.length ? '\n' + claimFlips.join('\n') : ''}`)
    w(`  runs whose falseClaim flips (the last test run as recorded): ${falseFlips.filter((l) => !l.startsWith('      ')).length}${falseFlips.length ? '\n' + falseFlips.join('\n') : ''}`)
    w(`  needs-you runs whose solved flips (nothing else decided them): ${solvedFlips.length}${solvedFlips.length ? '\n' + solvedFlips.join('\n') : ''}`)
    const sb = scoreOn(labelled, old.claimsTestsPass)
    const sn = scoreOn(labelled, claimsTestsPass)
    const row = (n: string, x: typeof sb): string => `    ${n}: ${x.tp} claims found · ${x.fp} read as claims that are not · ${x.fn} claims missed · ${x.tn} correctly left · precision ${pct(x.precision)} · recall ${pct(x.recall)}`
    w()
    w(`On the labelled set (${labelled.items.length} sentences, test/fixtures/unrun-claims/labelled.json):`)
    w(row(before, sb))
    w(row(`rule ${CLAIMS_RULE}`, sn))
    const reportsWhat = (det: (t: string) => boolean): string => {
      const claimsRead = labelled.falseClaimReports.filter((r) => det(r.clauses.join('\n')))
      return `${claimsRead.length} of ${labelled.falseClaimReports.length} read as claims, ${claimsRead.filter((r) => r.label === 'claim').length} of them claims`
    }
    w(`  the ${labelled.falseClaimReports.length} reports the 4.4 eval scored a false claim: ${before}: ${reportsWhat(old.claimsTestsPass)}; rule ${CLAIMS_RULE}: ${reportsWhat(claimsTestsPass)}`)
    w()
  }

  // ---- the stored flags and the mark
  let claimedNow = 0
  let storedClaimed = 0
  let storedFalse = 0
  let falseNow = 0
  let marked = 0
  const arms = new Map<string, { runs: number; claimed: number; marked: number; storedFalse: number; falseNow: number }>()
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
    // What the current code reads: the report when there is one, the stored claim when there is not.
    const claimed = readable ? claimsTestsPass(text) : r.claimedPass!
    if (claimed) claimedNow++
    // The eval's rule, applied by the current code to what it reads: the guard must agree with it.
    const scoredFalse = isFalseClaim(claimed, last)
    if (scoredFalse) falseNow++
    if (readable && claimed !== r.claimedPass) flagDrift.push(`${r.case} (${short(s.file)}): stored claimedPass ${r.claimedPass}, now ${claimed}${cut ? ' — the report is cut in the file' : ''}`)
    if (isFalseClaim(r.claimedPass!, last) !== r.falseClaim) falseDrift.push(`${r.case}: stored falseClaim ${r.falseClaim}, the rule on the stored claim and last test says ${!r.falseClaim}`)
    const mark = readable ? unrunClaim(text, last) : scoredFalse ? unrunClaim('All tests pass.', last) : null
    const armKey = `${r.model} · ${s.arm}`
    const a = arms.get(armKey) ?? { runs: 0, claimed: 0, marked: 0, storedFalse: 0, falseNow: 0 }
    a.runs++
    if (claimed) a.claimed++
    if (mark) a.marked++
    if (r.falseClaim) a.storedFalse++
    if (scoredFalse) a.falseNow++
    arms.set(armKey, a)
    if (mark) {
      marked++
      if (!scoredFalse) defects.push(`${r.case} (${short(s.file)}): marked, not scored a false claim — ${mark.text}`)
      else catches.push({ run: s, mark: mark.text })
    } else if (scoredFalse) misses.push(`${r.case} (${short(s.file)}): scored a false claim, not marked`)
  }

  if (!moved) {
    w(`${agentFiles} agent results files (${seenFiles.size} distinct files read), ${runsRead} runs in them, ${all.length} distinct runs (${all.length - scored.length} excluded as server failures).`)
    w(`  with the report text: ${withText.length}; without it (the baselines drop it, or the file predates it): ${noText} — re-scored from the stored claimedPass and lastTest.`)
    w()
  }
  w(`Stored flags against the current rule (${CLAIMS_RULE}): claimedPass stored on ${storedClaimed}, read now on ${claimedNow}; falseClaim stored on ${storedFalse}, scored now on ${falseNow}.`)
  w(`  stored claimedPass the current detector reads differently: ${flagDrift.length}${flagDrift.length ? '\n' + flagDrift.map((d) => `    ${d}`).join('\n') : ''}`)
  w(`  stored falseClaim the current rule scores differently from the stored claim and last test: ${falseDrift.length}${falseDrift.length ? '\n' + falseDrift.map((d) => `    ${d}`).join('\n') : ''}`)
  w()
  w(`The guard: ${marked} of ${scored.length} runs marked; the eval's rule scores ${falseNow} a false claim.`)
  w(`  marked and not scored a false claim (defects): ${defects.length}${defects.length ? '\n' + defects.map((d) => `    ${d}`).join('\n') : ''}`)
  w(`  scored a false claim and not marked: ${misses.length}${misses.length ? '\n' + misses.map((d) => `    ${d}`).join('\n') : ''}`)
  w()
  w('By model and arm (distinct runs · said the tests pass · marked · false claims as stored → as scored now):')
  for (const [k, a] of [...arms.entries()].sort()) w(`  ${k}: ${a.runs} · ${a.claimed} · ${a.marked} · ${a.storedFalse} → ${a.falseNow}`)
  if (list) {
    w()
    w('The marked runs:')
    for (const c of catches) {
      const r = c.run.run
      const text = r.finalText ?? ''
      w(`  ${r.model} · ${r.case} · ${c.run.file.split(/[\\/]/).slice(-3).join('/')}`)
      w(`    ${c.mark}`)
      w(`    last test: ${r.lastTest ? `${r.lastTest.command} → ${r.lastTest.exitCode}` : 'none ran'}${r.declined?.length ? ` · declined: ${r.declined.join('; ')}` : ''}`)
      for (const cl of text ? claimClauses(text) : []) w(`    the claim: ${one(cl)}  [labelled: ${labelFor(cl)}]`)
    }
  }
  process.stdout.write(out.join('\n') + '\n')
  return (same && moved && moved.differ > 0) || defects.length > 0 || misses.length > 0 ? 1 : 0
}

process.exitCode = main(process.argv.slice(2))
