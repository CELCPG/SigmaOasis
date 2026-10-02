/**
 * v4.4 (G1): the same-day control.
 *
 * Every 4.3 verdict was an arm measured on 2026-10-01 against a baseline
 * measured overnight on 9/30. The same engine scores single passes from 14 to
 * 21 of 26 on the 9B, and two runs of unchanged code a day apart differed by
 * four cases in their means — so an arm that reads BETTER against a baseline
 * from another day may have measured the day. A switch turns on only beside a
 * control: the engine with every switch off, run in the same session as the
 * arm, interleaved pass by pass, so the server's state, the machine and the
 * hour are shared by both sides.
 *
 * A runner tags its results file with the session it ran in and the side it
 * was: `control` (every switch off) or `arm`. `EVAL_CONTROL=1` runs both in one
 * process, a pass of each in turn (ABBA: control first on odd passes, the arm
 * first on even ones, so neither side always follows the other); a run sliced
 * over several commands tags each command with `EVAL_SESSION=<id>` and runs the
 * control and the arm as alternating commands. `eval:diff` reads the tags and
 * says which base it compared against (evalDiff.ts).
 */

export type SessionRole = 'control' | 'arm'

/** What a runner writes beside its results. */
export interface EvalSession {
  /** One evening's measurement; every command of it shares the id. */
  id: string
  role: SessionRole
}

/** A merged or joined file's sessions: one role, every id its parts ran in. */
export interface MergedSession {
  ids: string[]
  role: SessionRole
}

/** `EVAL_CONTROL`: unset — no control; `1` or `control-first`; `arm-first`. */
export type ControlOrder = 'control-first' | 'arm-first'

export function controlOrderFrom(spec: string | undefined): ControlOrder | null {
  const s = (spec ?? '').trim().toLowerCase()
  if (!s || s === '0') return null
  if (s === '1' || s === 'control-first') return 'control-first'
  if (s === 'arm-first') return 'arm-first'
  throw new Error(`EVAL_CONTROL is 1, control-first or arm-first, not ${spec}`)
}

/**
 * The sides of pass `pass` (0-based), in the order they run: ABBA, so drift
 * over a session lands on both sides alike.
 */
export function sidesForPass(pass: number, order: ControlOrder): SessionRole[] {
  const controlFirst = (pass % 2 === 0) === (order === 'control-first')
  return controlFirst ? ['control', 'arm'] : ['arm', 'control']
}

/** A session id from the environment, else the run's own stamp. Letters, digits, dot, dash, underscore. */
export function sessionId(env: string | undefined, stamp: string): string {
  const id = (env ?? '').trim()
  if (!id) return stamp
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error(`EVAL_SESSION is letters, digits, '.', '-' and '_' (at most 80), not ${env}`)
  return id
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A file's sessions, whether a runner wrote it (`session.id`) or a merge or join did (`session.ids`). */
export function readSession(file: unknown): MergedSession | null {
  if (!isObj(file) || !isObj(file.session)) return null
  const s = file.session
  const role = s.role === 'control' || s.role === 'arm' ? s.role : null
  if (!role) return null
  const ids = Array.isArray(s.ids) ? s.ids.filter((x): x is string => typeof x === 'string') : typeof s.id === 'string' ? [s.id] : []
  return ids.length ? { ids: [...new Set(ids)].sort(), role } : null
}

/**
 * The sessions of several files that become one (a merge or a join): one role,
 * the union of their ids. Untagged files leave the result untagged — a
 * comparison against it is then not a same-day one. Throws on a control mixed
 * with an arm.
 */
export function combineSessions(files: unknown[], label: (i: number) => string): MergedSession | null {
  const roles = new Set<SessionRole>()
  const ids = new Set<string>()
  let untagged = false
  for (let i = 0; i < files.length; i++) {
    const s = readSession(files[i])
    if (!s) {
      untagged = true
      continue
    }
    if (roles.size && !roles.has(s.role)) throw new Error(`cannot combine ${label(i)} (the session's ${s.role}) with the other side's files: a same-day control and its arm stay apart`)
    roles.add(s.role)
    s.ids.forEach((id) => ids.add(id))
  }
  const [role] = [...roles]
  if (untagged || !role) return null
  return { ids: [...ids].sort(), role }
}
