import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, relative, sep } from 'path'
import { restoreCheckpoints } from './checkpoints'
import { CLAIMS_RULE, claimsSuccess, claimsTestsPass, isFalseClaim, lastCommandRun, type TestRun } from './claims'
import { defaultShell, runCommand } from './command'
import { DEFAULT_ROUND_MAX_TOKENS, runAgentTask } from './engine'
import { fetchTransport } from './stream'
import { fmtMs, median, summarizeLatency, timedTransport, type LatencySummary, type RoundLatency } from './latency'
import type { AgentEvent, AgentExperiments, AgentHost, AgentStatus, ChunkTransport, PermissionMode, ShellSpec, ToolCallRecord } from './types'
import type { EvalSession } from './evalSession'
import type { AgentConnectionSettings } from './connection'
import { isLoopbackBaseUrl } from '../../shared/loopback'

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
 *                  the agent ran did not exit 0, or it ran none — the rule is
 *                  ./claims.ts, which the engine also marks the report with (v4.5);
 *   - collateral   files changed outside the ones the case allows;
 *   - undo         the shared Undo (./checkpoints.ts) leaves the folder byte for
 *                  byte as it began;
 *   - cost         rounds, tool calls, wall time, tokens, elisions;
 *   - latency      v4.1 (M3): per round, TTFT, prefill, prompt and cached
 *                  tokens, decode tok/s — timed at the transport (./latency.ts).
 *
 * Plain Node, no Electron, like the engine. The runner is scripts/eval-agent.ts;
 * the scoring is pinned by test/agentEval.test.ts, including a whole pass
 * against a scripted model.
 */

export const CASE_KINDS = ['fix', 'chain', 'feature', 'refactor', 'read-only', 'needs-you', 'long', 'office', 'tidy'] as const
export type CaseKind = (typeof CASE_KINDS)[number]

/** Kinds scored by the hidden checks; read-only and needs-you are scored by the report. */
export const CHECKED_KINDS: ReadonlySet<CaseKind> = new Set(['fix', 'chain', 'feature', 'refactor', 'long', 'office', 'tidy'])

/**
 * v4.0 (C1, C2): the office and tidy kinds measure the document and chore
 * tools, so those experiments are on for their cases — and only theirs. A
 * case of any other kind runs with every experiment off, as the app ships.
 */
export const KIND_EXPERIMENTS: Partial<Record<CaseKind, Partial<AgentExperiments>>> = {
  office: { documents: true },
  tidy: { chores: true, documents: true }
}

/** Kinds whose task is a document or a folder, with no test command to run. */
const NO_COMMAND_KINDS: ReadonlySet<CaseKind> = new Set(['office', 'tidy'])

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
    if (commands.length === 0 && !NO_COMMAND_KINDS.has(kind)) throw bad(`a ${kind} case names its test command`)
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

// ---- what the report claims (the rule is ./claims.ts, shared with the engine) ----

export { claimsSuccess, claimsTestsPass, type TestRun }

export function missingMentions(text: string, mentions: readonly string[]): string[] {
  const hay = text.replace(/\\/g, '/').toLowerCase()
  return mentions.filter((m) => !hay.includes(m.replace(/\\/g, '/').toLowerCase()))
}

// ---- what the agent ran ----------------------------------------------------

/**
 * The last test command that actually ran, from the tool records. A declined
 * command ran nothing and does not count; neither does one outside the case's
 * test commands (the host would have declined it anyway).
 */
export function lastTestRun(records: readonly ToolCallRecord[], allowed: readonly string[]): TestRun | null {
  return lastCommandRun(records, (command) => commandAllowed(command, allowed))
}

// ---- the folder -------------------------------------------------------------

/** `.sigma` is the folder's own plumbing (a trash, notes, worktrees): never the task's collateral, never Undo's business. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.sigma'])

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
 * unloaded the model, could not be reached, or cut a reply off mid-stream —
 * measured the server, not the agent. It is excluded from the score and named,
 * never counted as a failure (the rule every suite in docs/evals.md follows).
 *
 * A stream cut mid-reply surfaces as Node's fetch error `terminated`, bare: the
 * first baseline's LM Studio died that way inside a case, and the run was
 * scored — solved, as it happened — rather than excluded.
 */
const SERVER_FAILURE = /LM Studio|fetch failed|^terminated$|other side closed|ECONNREFUSED|ECONNRESET|socket hang up|HTTP \d{3}|unloaded|Failed to load model/i

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
  /**
   * v4.0 (E9): set when the GPU's error counter moved during the run. v4.1
   * (decision 1): the replays are *corrected* — the link resent the packet — so
   * they cost time and change no token. The run is scored; only its time is
   * left out of the medians.
   */
  machine?: string
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
  /**
   * Completion tokens of the run's longest round — what a lower per-round cap
   * would have cut (ROADMAP-v3.1.md M2). Read as the largest step between two
   * usage events, so a helper's rounds count toward the round that follows
   * them: never an undercount.
   */
  longestRound: number
  elisions: number
  elidedResults: number
  finalText: string
  /** v4.1 (M3): one entry per request the run sent, helpers' included, in order. */
  latency?: RoundLatency[]
  /** v4.1 (M3): median and max over this run's completed rounds. */
  latencySummary?: LatencySummary
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
  /** v4.1 (M1): experiments on for every case, over the kind's own — the A/B arm of a run. */
  experiments?: Partial<AgentExperiments>
  /** v4.1 (M3): the clock rounds are timed by; the tests drive their own. */
  clock?: () => number
  /** v4.2 (A3): the round output cap for every case — the 8K and 4K arms the roadmap asks for. */
  roundMaxTokens?: number
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
  let longestRound = 0
  let elisions = 0
  let elidedResults = 0
  // v4.1 (M3): timed at the transport, so the engine is measured as it ships.
  const latency: RoundLatency[] = []
  const host: AgentHost = {
    transport: timedTransport(o.transport ?? fetchTransport, (r) => latency.push(r), o.clock),
    shell,
    emit: (e) => {
      if (e.type === 'round') rounds = e.round
      else if (e.type === 'tool_start') toolCalls++
      else if (e.type === 'tool_end') records.set(e.record.id, e.record)
      else if (e.type === 'usage') {
        promptTokens = e.promptTokens
        longestRound = Math.max(longestRound, e.completionTokens - completionTokens)
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
      ...(o.roundMaxTokens ? { roundMaxTokens: o.roundMaxTokens } : {}),
      commandTimeoutSec: o.commandTimeoutSec,
      experiments: { ...KIND_EXPERIMENTS[c.kind], ...o.experiments },
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
  const falseClaim = isFalseClaim(claimedPass, lastTest)
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
  const latencySummary = summarizeLatency(latency)
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
    longestRound,
    elisions,
    elidedResults,
    finalText: result.finalText.length > 4_000 ? `${result.finalText.slice(0, 4_000)}…` : result.finalText,
    latency,
    ...(latencySummary ? { latencySummary } : {})
  }
}

// ---- the results file ------------------------------------------------------

/** What `eval:agent` writes to .eval-results/, and what baselines/ and `eval:diff` read. */
export interface AgentResultsFile {
  suite: 'agent'
  model: string
  experiments: Partial<AgentExperiments>
  baseUrl: string
  shell: string
  startedAt: string
  passes: number
  cases: string[]
  runs: CaseRun[][]
  /** v4.4 (G1): the session this run was measured in, and its side — a same-day control or the arm (evalSession.ts). */
  session?: EvalSession
  /**
   * v4.5 (H3b): the version of the claim rule (claims.ts `CLAIMS_RULE`) the
   * runs' `claimedPass`, `falseClaim` and needs-you `solved` were scored under.
   * A file without it was scored under rule 1. `eval:diff` refuses to compare
   * two sides scored under different rules; `eval:claims --rescore` moves a file.
   */
  claimsRule?: number
  /**
   * 4.6 (J1): set when the run went through the agent connection
   * (EVAL_AGENT_BASE_URL): the route the app would take — `baseUrl` above is
   * that server, `mainBaseUrl` the main connection beside it. Absent, the run
   * was on the main connection, as every file before 4.6.
   */
  connection?: EvalConnection
}

/** 4.6 (J1): which connection an agent eval ran on (./connection.ts `routeAgent`). */
export interface EvalConnection {
  via: 'agent'
  baseUrl: string
  model: string
  mainBaseUrl: string
}

/** v4.1 (M6): built in one place, so the offline replay gate writes the runner's schema, not a copy of it. */
export function agentResultsFile(o: Omit<AgentResultsFile, 'suite' | 'claimsRule'>): AgentResultsFile {
  return { suite: 'agent', claimsRule: CLAIMS_RULE, model: o.model, experiments: o.experiments, baseUrl: o.baseUrl, shell: o.shell, startedAt: o.startedAt, passes: o.passes, cases: o.cases, runs: o.runs, ...(o.session ? { session: o.session } : {}), ...(o.connection ? { connection: o.connection } : {}) }
}

/**
 * 4.6 (J1): the agent connection `eval:agent` is pointed through, from its
 * environment — `EVAL_AGENT_BASE_URL` (and `EVAL_AGENT_MODEL`, or the server's
 * own model) — built as the app builds it, so the run takes the app's route.
 * An address off this machine is refused here, not replaced: an eval asked
 * for a server it cannot use should not quietly measure another one.
 */
export function evalAgentConnection(env: Record<string, string | undefined>): { ok: true; connection?: AgentConnectionSettings } | { ok: false; error: string } {
  const baseUrl = env.EVAL_AGENT_BASE_URL?.trim()
  if (!baseUrl) {
    return env.EVAL_AGENT_MODEL ? { ok: false, error: 'EVAL_AGENT_MODEL names the agent connection\'s model: set EVAL_AGENT_BASE_URL too.' } : { ok: true }
  }
  if (!isLoopbackBaseUrl(baseUrl)) return { ok: false, error: `Refusing EVAL_AGENT_BASE_URL=${baseUrl}: the agent connection is a server on this machine, as in the app.` }
  return { ok: true, connection: { enabled: true, baseUrl, model: env.EVAL_AGENT_MODEL?.trim() ?? '' } }
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
  /** The longest single round in any scored run, and its case; null when no run reported usage. */
  longestRound: { tokens: number; case: string } | null
  /**
   * v4.1 (M3): over every completed round of the scored runs whose time
   * counts (a run the GPU's counter moved in is left out, as for wall time);
   * null when no round was timed — a results file from before 4.1.
   */
  latency: LatencySummary | null
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
  const solvedMs = runs.filter((r) => r.solved && !r.machine).map((r) => r.ms)
  const longest = runs.reduce<CaseRun | null>((a, r) => (r.longestRound > (a?.longestRound ?? 0) ? r : a), null)
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
    roundsMedian: median(runs.map((r) => r.rounds)),
    longestRound: longest ? { tokens: longest.longestRound, case: longest.case } : null,
    latency: summarizeLatency(runs.filter((r) => !r.machine).flatMap((r) => r.latency ?? []))
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
  const l = r.latencySummary
  const timing = l ? ` · TTFT ${fmtMs(l.ttftMedianMs)} median, ${fmtMs(l.ttftMaxMs)} max${l.decodeTokPerSecMedian !== null ? ` · ${l.decodeTokPerSecMedian} tok/s` : ''}` : ''
  return `${verdict} · ${r.end} · ${r.rounds} rounds, ${r.toolCalls} calls · ${mmss(r.ms)}${timing}${flags.length ? ` · ${flags.join(' · ')}` : ''}`
}

/** The report's table: one row per model, then the per-case stability. */
export function formatSummary(summaries: readonly ModelSummary[]): string {
  const lines: string[] = []
  lines.push('| model | solved (median of passes) | per pass | false claims | collateral | undo left files | median time, solved | median rounds | TTFT median · max | decode tok/s | excluded |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const s of summaries) {
    const l = s.latency
    lines.push(
      `| ${s.model} | **${s.solvedMedian}/${s.of}** | [${s.solvedPerPass.join(', ')}] | ${s.falseClaims}/${s.runs} | ${s.collateralRuns}/${s.runs} | ${s.undoDirty}/${s.runs} | ${s.msPerSolvedMedian === null ? '—' : mmss(s.msPerSolvedMedian)} | ${s.roundsMedian} | ${l ? `${fmtMs(l.ttftMedianMs)} · ${fmtMs(l.ttftMaxMs)}` : '—'} | ${l?.decodeTokPerSecMedian ?? '—'} | ${s.excluded} |`
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
    if (s.longestRound) {
      lines.push(
        `  longest round: ${s.longestRound.tokens.toLocaleString('en-US')} completion tokens (${s.longestRound.case}); the cap is ${DEFAULT_ROUND_MAX_TOKENS.toLocaleString('en-US')}`
      )
    }
    if (s.latency) {
      const l = s.latency
      lines.push(
        `  latency over ${l.rounds} rounds: prefill ${fmtMs(l.prefillMedianMs)} median, ${fmtMs(l.prefillMaxMs)} max (${l.prefillFrom === 'server' ? "the server's figure" : 'TTFT; the server reports no prefill of its own'})` +
          ` · largest prompt ${l.promptTokensMax?.toLocaleString('en-US') ?? '—'} tokens · cached ${l.cachedShare === null ? 'not reported by the server' : `${Math.round(l.cachedShare * 100)}% of prompt tokens`}`
      )
    }
  }
  return lines.join('\n')
}
