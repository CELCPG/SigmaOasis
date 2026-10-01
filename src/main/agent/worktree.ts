/**
 * A worktree per task (v4.0, A9 — an experiment, off by default).
 *
 * In a git repository a task runs in its own worktree on its own branch,
 * `sigma/<slug>`, under `.sigma/worktrees/<slug>` — so the folder the user is
 * looking at is untouched until they merge, and two tasks cannot trip over
 * each other's files. The app does the git; the model is handed the worktree
 * as its workspace and none of the plumbing. A later turn of the same task
 * carries on in the same worktree.
 *
 * Plain Node: child_process and fs, no Electron (the CLI runs this too).
 */
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const WORKTREES_DIR = join('.sigma', 'worktrees')

/**
 * The app's own plumbing under `.sigma/`, which the folder's repository must
 * never see as untracked: task worktrees, the inbox (C6), the trash chores
 * delete to (C2), and the ignore file itself. notes.md and hooks.json are not
 * here — those stay the user's to commit.
 */
export const SIGMA_IGNORED = ['worktrees/', 'inbox/', 'trash/', '.gitignore'] as const

/**
 * v4.3: `.sigma/.gitignore`, written or brought up to date. Through 4.2 it was
 * written once, by the first worktree, with `worktrees/` alone — so a dropped
 * file in `.sigma/inbox/` or a deleted one in `.sigma/trash/` showed in the
 * user's `git status`, and an ignore file an earlier version wrote was never
 * fixed. Lines are only ever added; a line the user wrote stays.
 */
export async function ensureSigmaIgnore(root: string): Promise<void> {
  const dir = join(root, '.sigma')
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, '.gitignore')
  let current = ''
  try {
    current = await fs.readFile(file, 'utf8')
  } catch {
    /* none yet */
  }
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()))
  const missing = SIGMA_IGNORED.filter((line) => !have.has(line))
  if (!missing.length) return
  await fs.writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
}

export interface Worktree {
  /** Absolute path of the worktree, the task's workspace. */
  path: string
  branch: string
}

/** A short, safe branch name from the task's first words and the minute it started. */
export function slugFor(prompt: string, now = new Date()): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 4)
    .join('-')
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  return `${words || 'task'}-${stamp}`.slice(0, 60)
}

function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })
    })
  })
}

/** Is `root` the top of a git repository with at least one commit? */
export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await fs.stat(join(root, '.git'))
  } catch {
    return false
  }
  return (await git(['rev-parse', '--verify', 'HEAD'], root)).ok
}

/**
 * Make the task's worktree, or hand back the one a `previous` turn used when
 * it still exists. Null when `root` is not a repository or git refused — the
 * task then runs in the folder itself, and says so.
 */
export async function ensureWorktree(root: string, prompt: string, previous?: Worktree, now = new Date()): Promise<Worktree | null> {
  if (previous) {
    try {
      await fs.stat(join(previous.path, '.git'))
      return previous
    } catch {
      /* gone — make a fresh one */
    }
  }
  if (!(await isGitRepo(root))) return null
  const slug = slugFor(prompt, now)
  const branch = `sigma/${slug}`
  const path = join(root, WORKTREES_DIR, slug)
  // The outer repository must not see its own worktrees as untracked files.
  await ensureSigmaIgnore(root)
  // v4.3: with no hooks. `git worktree add` checks the tree out, and a checkout
  // runs the repository's post-checkout hook — code from the folder the app
  // was pointed at, run because the app (not the user) asked git for a
  // worktree. Hooks are read from an empty directory made for this call; never
  // one inside the repository, which the repository could fill.
  const noHooks = await fs.mkdtemp(join(tmpdir(), 'sigma-no-hooks-'))
  try {
    const made = await git(['-c', `core.hooksPath=${noHooks}`, 'worktree', 'add', '-b', branch, path, 'HEAD'], root)
    if (!made.ok) return null
  } finally {
    await fs.rm(noHooks, { recursive: true, force: true }).catch(() => undefined)
  }
  return { path, branch }
}
