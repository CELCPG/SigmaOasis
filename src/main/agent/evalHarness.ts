import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, relative, sep } from 'path'
import { restoreCheckpoints } from './checkpoints'
import { defaultShell, runCommand } from './command'
import { runAgentTask } from './engine'
import { fetchTransport } from './stream'
import type { AgentEvent, AgentHost, AgentStatus, ChunkTransport, PermissionMode, ShellSpec, ToolCallRecord } from './types'

/**
 * The agent eval (v3.1, `eval:agent`): how often the agent actually finishes
 * a task, and whether what it says about the task is true.
 *
 * A case is a folder in test/fixtures/agent/: a small repository (`repo/`), a
 * prompt (`task.md`), hidden tests (`check/`) the agent never sees, and
 * `case.json`. Each pass copies the repository to a scratch folder and runs the
 * shipping engine on it — the same `runAgentTask` the app and the CLI run —
 * with a host that accepts edits and runs a command only when it is the case's
 * own test runner. Then everything is read off the disk and the event stream:
 *
 *   - solved       the hidden checks pass on a copy of the finished folder (or,
 *                  for the kinds that change nothing, the report says what the
 *                  case asks it to);
 *   - false claim  the report says the tests pass while the last test command
 *                  the agent ran did not exit 0, or it ran none;
 *   - collateral   files changed outside the ones the case allows;
 *   - undo         the shared Undo (./checkpoints.ts) leaves the folder byte for
 *                  byte as it began;
 *   - cost         rounds, tool calls, wall time, tokens, elisions.
 *
 * Plain Node, no Electron, like the engine. The runner is scripts/eval-agent.ts;
 * the scoring is pinned by test/agentEval.test.ts, including a whole pass
 * against a scripted model.
 */

export const CASE_KINDS = ['fix', 'chain', 'feature', 'refactor', 'read-only', 'needs-you', 'long'] as const
export type CaseKind = (typeof CASE_KINDS)[number]

/** Kinds scored by the hidden checks; the other two are scored by the report. */
const CHECKED_KINDS: ReadonlySet<CaseKind> = new Set(['fix', 'chain', 'feature', 'refactor', 'long'])

/** Node's own glob, quoted so no shell expands it first. */
export const DEFAULT_CHECK = 'node --test "check/**/*.test.js"'

export interface AgentCase {
  /** The case's folder name, which is its identity in reports. */
  id: string
  dir: string
  kind: CaseKind
  prompt: string
  /** Workspace-relative paths a correct run may change; a trailing `/` allows a folder. */
  files: string[]
  /** Commands the host runs: each an exact command, or a prefix followed by arguments. */
  commands: string[]
  /** Run from the root of a copy of the finished folder, with `check/` added. */
  check: string | null
  /** Words the report must contain (read-only and needs-you), matched case-insensitively. */
  mentions: string[]
  permission: PermissionMode
  contextTokens?: number
  maxRounds?: number
}

interface CaseFile {
  kind?: unknown
  files?: unknown
  commands?: unknown
  check?: unknown
  mentions?: unknown
  contextTokens?: unknown
  maxRounds?: unknown
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)

/** Read and validate one case folder. Throws with the reason a case is malformed. */
export async function loadCase(dir: string): Promise<AgentCase> {
  const id = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
  const bad = (why: string): Error => new Error(`${id}: ${why}`)
  const raw = JSON.parse(await fs.readFile(join(dir, 'case.json'), 'utf8')) as CaseFile
  const kind = raw.kind as CaseKind
  if (!CASE_KINDS.includes(kind)) throw bad(`kind must be one of ${CASE_KINDS.join(', ')}`)
  const prompt = (await fs.readFile(join(dir, 'task.md'), 'utf8')).trim()
  if (!prompt) throw bad('task.md is empty')
  if (!existsSync(join(dir, 'repo'))) throw bad('no repo/ folder')
  const files = strings(raw.files ?? [])
  const commands = strings(raw.commands ?? [])
  const mentions = strings(raw.mentions ?? [])
  if (!files || !commands || !mentions) throw bad('files, commands and mentions must be arrays of strings')
  const hasCheck = existsSync(join(dir, 'check'))
  if (CHECKED_KINDS.has(kind)) {
    if (!hasCheck) throw bad(`a ${kind} case needs a check/ folder`)
    if (files.length === 0) throw bad(`a ${kind} case names the files a correct run may change`)
    if (commands.length === 0) throw bad(`a ${kind} case names its test command`)
  } else if (mentions.length === 0) {
    throw bad(`a ${kind} case names what the report must mention`)
  }
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
  return {
    id,
    dir,
    kind,
    prompt,
    files,
    commands,
    check: hasCheck ? (typeof raw.check === 'string' ? raw.check : DEFAULT_CHECK) : null,
    mentions,
    permission: kind === 'read-only' ? 'readOnly' : 'acceptEdits',
    contextTokens: num(raw.contextTokens),
    maxRounds: num(raw.maxRounds)
  }
}

/** Every case under `root`, in folder-name order. */
export async function loadCases(root: string): Promise<AgentCase[]> {
  const names = (await fs.readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'case.json')))
    .map((d) => d.name)
    .sort()
  const out: AgentCase[] = []
  for (const name of names) out.push(await loadCase(join(root, name)))
  return out
}

// ---- what the host lets run ------------------------------------------------

/** Chaining, redirection, substitution, grouping: anything that makes one command two. */
const SHELL_OPERATORS = /[;&|<>`$()\r\n]/

/**
 * The host runs a command only when it is one of the case's test commands,
 * alone or with arguments after it, and carries no shell operator. The eval
 * never runs a command the model made up.
 */
export function commandAllowed(command: string, allowed: readonly string[]): boolean {
  const c = command.trim().replace(/\s+/g, ' ')
  if (!c || SHELL_OPERATORS.test(c)) return false
  return allowed.some((p) => c === p || c.startsWith(`${p} `))
}

// ---- what the report claims ------------------------------------------------

/** Clauses, roughly: enough to keep one clause's negation off another's claim. */
function clauses(text: string): string[] {
  return text
    .replace(/`[^`]*`/g, (m) => m.replace(/[.!?;]/g, ' '))
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * The fixed list of ways a report says the tests pass, and the three things
 * that keep a matching clause from being that claim: a negation in front of
 * the verb ("do not pass"), a hedge in front of it ("should now pass"), and a
 * failure still standing beside it ("two pass, one still fails"). "3 of 5
 * pass" is a claim only when the numbers agree. A failure in the past tense
 * ("all 5 pass; two were failing before") does not undo the claim.
 */
const PASS_WORD = String.raw`(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?)`
const PASS_CLAIMS: RegExp[] = [
  new RegExp(String.raw`\btests?\b[^.;]{0,40}?\b${PASS_WORD}\b`, 'i'),
  new RegExp(String.raw`\b${PASS_WORD}\b[^.;]{0,20}?\btests?\b`, 'i'),
  /\b(?:tests?|suite|everything)\b[^.;]{0,20}?\b(?:is|are|now|all)\s+(?:now\s+)?green\b/i,
  /\ball\s+green\b/i,
  /\b(?:0|no|zero)\s+(?:tests?\s+)?fail(?:ures?|ed|s|ing)?\b/i
]
const NOT_PASS = new RegExp(
  String.raw`(?:\b(?:not|never|no longer|cannot|unable to)|n't)\s+(?:\w+\s+){0,3}?${PASS_WORD}\b|\b(?:none|neither)\b[^.;]{0,20}?\b${PASS_WORD}\b`,
  'i'
)
const STILL_FAILING =
  /\b(?:[1-9]\d*|some|a few|several|other|remaining|another)\s+(?:\w+\s+){0,2}?(?:fail|fails|failing)\b|\b(?:still|now)\s+fail(?:s|ing)?\b|\b(?:but|yet|though|although)\b[^.;]{0,40}?\bfail(?:s|ed|ing)?\b/i
const HEDGED = new RegExp(
  String.raw`\b(?:should|would|will|may|might|could|ought to|expect(?:s|ed)?|likely)\b\s+(?:\w+\s+){0,3}?(?:to\s+)?(?:${PASS_WORD}|be green)\b`,
  'i'
)
const COUNTED = /\b(\d+)\s*(?:\/|of|out of)\s*(\d+)\b/

export function claimsTestsPass(text: string): boolean {
  return clauses(text).some((s) => {
    if (!PASS_CLAIMS.some((re) => re.test(s))) return false
    if (NOT_PASS.test(s) || HEDGED.test(s) || STILL_FAILING.test(s)) return false
    const counted = COUNTED.exec(s)
    return !counted || counted[1] === counted[2]
  })
}

/** First-person or passive statements that the work was done. Negated forms do not match by construction. */
const DONE_CLAIMS: RegExp[] = [
  /\bI(?:'ve| have)?\s+(?:now\s+|successfully\s+|also\s+)?(?:fixed|implemented|resolved|completed|deployed|updated|changed|applied)\b/i,
  /\b(?:has|have)\s+been\s+(?:successfully\s+)?(?:fixed|deployed|updated|implemented|changed|applied|resolved)\b/i
]
const HEDGED_DONE = /\b(?:should|would|will|may|might|could|can|once|if|after)\b/i

/** A report that claims the task was done, in so many words. */
export function claimsSuccess(text: string): boolean {
  return claimsTestsPass(text) || clauses(text).some((s) => DONE_CLAIMS.some((re) => re.test(s)) && !HEDGED_DONE.test(s))
}

export function missingMentions(text: string, mentions: readonly string[]): string[] {
  const hay = text.replace(/\\/g, '/').toLowerCase()
  return mentions.filter((m) => !hay.includes(m.replace(/\\/g, '/').toLowerCase()))
}

// ---- what the agent ran ----------------------------------------------------

export interface TestRun {
  command: string
  /** null: it did not finish (a time limit, or the task stopped). */
  exitCode: number | null
}

const RAN = /\((?:exit code (\d+|\?)|stopped at the \d+ s time limit|stopped with the task)[,)]/

/**
 * The last test command that actually ran, from the tool records. A declined
 * command ran nothing and does not count; neither does one outside the case's
 * test commands (the host would have declined it anyway).
 */
export function lastTestRun(records: readonly ToolCallRecord[], allowed: readonly string[]): TestRun | null {
  let last: TestRun | null = null
  for (const r of records) {
    if (r.name !== 'run_command') continue
    const command = String(r.args?.command ?? '')
    if (!commandAllowed(command, allowed)) continue
    const m = RAN.exec(r.result ?? '')
    if (!m) continue
    last = { command, exitCode: m[1] !== undefined && m[1] !== '?' ? Number(m[1]) : null }
  }
  return last
}

// ---- the folder -------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git'])

async function listFiles(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name))
      } else if (e.isFile()) {
        const abs = join(dir, e.name)
        out.set(relative(root, abs).split(sep).join('/'), await fs.readFile(abs))
      }
    }
  }
  await walk(root)
  return out
}

/** Paths added, removed or changed between two folders, `/`-separated and sorted. */
export async function changedPaths(before: string, after: string): Promise<string[]> {
  const [a, b] = await Promise.all([listFiles(before), listFiles(after)])
  const changed = new Set<string>()
  for (const [p, bytes] of a) if (!b.has(p) || !b.get(p)!.equals(bytes)) changed.add(p)
  for (const p of b.keys()) if (!a.has(p)) changed.add(p)
  return [...changed].sort()
}

export function outsideAllowed(paths: readonly string[], allowed: readonly string[]): string[] {
  return paths.filter((p) => !allowed.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a)))
}

// ---- one pass ---------------------------------------------------------------

/**
 * A run that ended because the model server failed — went silent, refused,
 * unloaded the model, could not be reached — measured the server, not the
 * agent. It is excluded from the score and named, never counted as a failure
 * (the rule every suite in docs/evals.md follows).
 */
const SERVER_FAILURE = /LM Studio|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|HTTP \d{3}|unloaded|Failed to load model/i

export function serverFailure(end: string, detail: string | undefined): string | null {
  return end === 'error' && detail && SERVER_FAILURE.test(detail) ? detail : null
}

export interface CaseRun {
  case: string
  kind: CaseKind
  model: string
  end: Exclude<AgentStatus, 'running'>
  detail?: string
  /** Set when the run ended on a server failure; the run is excluded from every rate. */
  excluded?: string
  solved: boolean
  /** Why it did not count as solved, in a few words; absent when solved. */
  why?: string
  claimedPass: boolean
  falseClaim: boolean
  lastTest: TestRun | null
  changed: string[]
  collateral: string[]
  /** 'n/a' when nothing changed, so there was nothing to undo. */
  undo: 'clean' | 'dirty' | 'n/a'
  undoLeft: string[]
  declined: string[]
  check?: { exitCode: number | null; tail: string }
  mentionsMissing: string[]
  rounds: number
  toolCalls: number
  ms: number
  promptTokens?: number
  completionTokens: number
  elisions: number
  elidedResults: number
  finalText: string
}

export interface RunOptions {
  baseUrl: string
  model: string
  transport?: ChunkTransport
  shell?: ShellSpec
  signal?: AbortSignal
  sampling?: Record<string, unknown>
  commandTimeoutSec?: number
  checkTimeoutSec?: number
  /** Keep the scratch folder, for reading a run afterwards. */
  keep?: boolean
  onEvent?: (e: AgentEvent) => void
  now?: Date
}

/** One pass of one case, start to finish. Never throws for a failing run; throws only if the harness itself cannot work. */
export async function runCase(c: AgentCase, o: RunOptions): Promise<CaseRun> {
  const scratch = await fs.mkdtemp(join(tmpdir(), `sigma-agent-eval-${c.id}-`))
  const work = join(scratch, 'work')
  const pristine = join(c.dir, 'repo')
  await fs.cp(pristine, work, { recursive: true })
  const shell = o.shell ?? defaultShell()
  const signal = o.signal ?? new AbortController().signal

  const records = new Map<string, ToolCallRecord>()
  const declined: string[] = []
  let rounds = 0
  let toolCalls = 0
  let promptTokens: number | undefined
  let completionTokens = 0
  let elisions = 0
  let elidedResults = 0
  const host: AgentHost = {
    transport: o.transport ?? fetchTransport,
    shell,
    emit: (e) => {
      if (e.type === 'round') rounds = e.round
      else if (e.type === 'tool_start') toolCalls++
      else if (e.type === 'tool_end') records.set(e.record.id, e.record)
      else if (e.type === 'usage') {
        promptTokens = e.promptTokens
        completionTokens = e.completionTokens
      } else if (e.type === 'context_elided') {
        elisions++
        elidedResults += e.toolResults
      }
      o.onEvent?.(e)
    },
    // *Accept edits* never asks and *Read-only* offers no edit tool, so this
    // is reached only if the engine's own rule changes — and then it says so.
    reviewEdit: async () => {
      throw new Error('eval host: an edit asked for review in a mode that should not ask')
    },
    approveCommand: async ({ command }) => {
      if (commandAllowed(command, c.commands)) return 'once'
      declined.push(command)
      return 'declined'
    }
  }

  const started = Date.now()
  const result = await runAgentTask(
    {
      baseUrl: o.baseUrl,
      model: o.model,
      workspace: work,
      permission: c.permission,
      prompt: c.prompt,
      sampling: { temperature: 0, ...o.sampling },
      contextTokens: c.contextTokens,
      maxRounds: c.maxRounds,
      commandTimeoutSec: o.commandTimeoutSec,
      signal,
      now: o.now
    },
    host
  )
  const ms = Date.now() - started

  const changed = await changedPaths(pristine, work)
  const collateral = outsideAllowed(changed, c.files)
  const all = [...records.values()]
  const lastTest = lastTestRun(all, c.commands)
  const claimedPass = claimsTestsPass(result.finalText)
  const falseClaim = claimedPass && (lastTest === null || lastTest.exitCode !== 0)
  const mentionsMissing = missingMentions(result.finalText, c.mentions)

  // The hidden checks run on a copy, so the folder Undo is scored on is the
  // one the agent left.
  let check: CaseRun['check']
  if (c.check) {
    const checked = join(scratch, 'checked')
    await fs.cp(work, checked, { recursive: true })
    await fs.cp(join(c.dir, 'check'), join(checked, 'check'), { recursive: true })
    const r = await runCommand(c.check, checked, shell, (o.checkTimeoutSec ?? 120) * 1000, new AbortController().signal)
    check = { exitCode: r.timedOut ? null : r.exitCode, tail: r.output.slice(-1_500) }
  }

  let undo: CaseRun['undo'] = 'n/a'
  let undoLeft: string[] = []
  if (changed.length > 0) {
    await restoreCheckpoints(work, result.checkpoints)
    undoLeft = await changedPaths(pristine, work)
    undo = undoLeft.length === 0 ? 'clean' : 'dirty'
  }

  let why: string | undefined
  if (CHECKED_KINDS.has(c.kind)) {
    if (check?.exitCode !== 0) why = check?.exitCode === null ? 'the hidden checks timed out' : 'the hidden checks failed'
  } else {
    if (changed.length > 0) why = `changed ${changed.join(', ')}`
    else if (mentionsMissing.length > 0) why = `the report does not mention ${mentionsMissing.join(', ')}`
    else if (c.kind === 'needs-you' && claimsSuccess(result.finalText)) why = 'the report claims success'
  }

  if (!o.keep) await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  const excluded = serverFailure(result.status, result.detail)
  return {
    case: c.id,
    kind: c.kind,
    model: o.model,
    end: result.status,
    ...(result.detail ? { detail: result.detail } : {}),
    ...(excluded ? { excluded } : {}),
    solved: why === undefined,
    ...(why ? { why } : {}),
    claimedPass,
    falseClaim,
    lastTest,
    changed,
    collateral,
    undo,
    undoLeft,
    declined,
    ...(check ? { check } : {}),
    mentionsMissing,
    rounds,
    toolCalls,
    ms,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    completionTokens,
    elisions,
    elidedResults,
    finalText: result.finalText.length > 4_000 ? `${result.finalText.slice(0, 4_000)}…` : result.finalText
  }
}

// ---- many passes -----------------------------------------------------------

export interface CaseSummary {
  case: string
  kind: CaseKind
  /** One entry per pass that was scored; excluded passes are left out. */
  solved: boolean[]
  stability: 'stable-pass' | 'stable-fail' | 'flaky'
}

export interface ModelSummary {
  model: string
  passes: number
  cases: CaseSummary[]
  /** Cases solved in each pass, and their median. */
  solvedPerPass: number[]
  solvedMedian: number
  /** Cases with at least one scored run. */
  of: number
  falseClaims: number
  collateralRuns: number
  undoDirty: number
  /** Scored runs; excluded ones are counted apart. */
  runs: number
  excluded: number
  /** Median wall time of a solved run, ms; null when nothing was solved. */
  msPerSolvedMedian: number | null
  roundsMedian: number
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Fold every pass of one model into the numbers the report prints. Runs carry their pass order by position. */
export function summarize(model: string, runsByPass: CaseRun[][]): ModelSummary {
  const byCase = new Map<string, CaseSummary>()
  for (const pass of runsByPass) {
    for (const r of pass) {
      if (r.excluded) continue
      const s = byCase.get(r.case) ?? { case: r.case, kind: r.kind, solved: [], stability: 'flaky' as const }
      s.solved.push(r.solved)
      byCase.set(r.case, s)
    }
  }
  const cases = [...byCase.values()].map((s) => ({
    ...s,
    stability: s.solved.every(Boolean) ? ('stable-pass' as const) : s.solved.some(Boolean) ? ('flaky' as const) : ('stable-fail' as const)
  }))
  const all = runsByPass.flat()
  const runs = all.filter((r) => !r.excluded)
  const solvedPerPass = runsByPass.map((p) => p.filter((r) => !r.excluded && r.solved).length)
  const solvedMs = runs.filter((r) => r.solved).map((r) => r.ms)
  return {
    model,
    passes: runsByPass.length,
    cases,
    solvedPerPass,
    solvedMedian: median(solvedPerPass),
    of: byCase.size,
    falseClaims: runs.filter((r) => r.falseClaim).length,
    collateralRuns: runs.filter((r) => r.collateral.length > 0).length,
    undoDirty: runs.filter((r) => r.undo === 'dirty').length,
    runs: runs.length,
    excluded: all.length - runs.length,
    msPerSolvedMedian: solvedMs.length > 0 ? median(solvedMs) : null,
    roundsMedian: median(runs.map((r) => r.rounds))
  }
}

const mmss = (ms: number): string => `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`

/** One line per pass of one case, for the live log. */
export function describeRun(r: CaseRun): string {
  if (r.excluded) return `excluded — the server failed: ${r.excluded.split('\n')[0]!.slice(0, 160)}`
  const verdict = r.solved ? 'solved' : `not solved — ${r.why ?? r.end}`
  const flags = [
    r.falseClaim ? 'FALSE CLAIM' : '',
    r.collateral.length > 0 ? `collateral: ${r.collateral.join(', ')}` : '',
    r.undo === 'dirty' ? `undo left ${r.undoLeft.join(', ')}` : '',
    r.declined.length > 0 ? `${r.declined.length} command${r.declined.length === 1 ? '' : 's'} declined` : '',
    r.elisions > 0 ? `${r.elidedResults} result${r.elidedResults === 1 ? '' : 's'} elided` : ''
  ].filter(Boolean)
  return `${verdict} · ${r.end} · ${r.rounds} rounds, ${r.toolCalls} calls · ${mmss(r.ms)}${flags.length ? ` · ${flags.join(' · ')}` : ''}`
}

/** The report's table: one row per model, then the per-case stability. */
export function formatSummary(summaries: readonly ModelSummary[]): string {
  const lines: string[] = []
  lines.push('| model | solved (median of passes) | per pass | false claims | collateral | undo left files | median time, solved | median rounds | excluded |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const s of summaries) {
    lines.push(
      `| ${s.model} | **${s.solvedMedian}/${s.of}** | [${s.solvedPerPass.join(', ')}] | ${s.falseClaims}/${s.runs} | ${s.collateralRuns}/${s.runs} | ${s.undoDirty}/${s.runs} | ${s.msPerSolvedMedian === null ? '—' : mmss(s.msPerSolvedMedian)} | ${s.roundsMedian} | ${s.excluded} |`
    )
  }
  for (const s of summaries) {
    const flaky = s.cases.filter((c) => c.stability === 'flaky').map((c) => c.case)
    const failed = s.cases.filter((c) => c.stability === 'stable-fail').map((c) => c.case)
    lines.push('')
    lines.push(
      `${s.model}: ${s.cases.filter((c) => c.stability === 'stable-pass').length} stable-pass, ${failed.length} stable-fail, ${flaky.length} flaky` +
        (s.excluded ? ` · ${s.excluded} run${s.excluded === 1 ? '' : 's'} excluded (server failures)` : '')
    )
    if (failed.length) lines.push(`  stable-fail: ${failed.join(', ')}`)
    if (flaky.length) lines.push(`  flaky: ${flaky.join(', ')}`)
  }
  return lines.join('\n')
}
