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
import { join } from 'path'

export const WORKTREES_DIR = join('.sigma', 'worktrees')

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
  await fs.mkdir(join(root, '.sigma'), { recursive: true })
  const ignore = join(root, '.sigma', '.gitignore')
  try {
    await fs.stat(ignore)
  } catch {
    // The ignore file ignores itself too: notes.md and hooks.json stay the
    // user's to commit; the plumbing never shows in git status.
    await fs.writeFile(ignore, 'worktrees/\n.gitignore\n')
  }
  const made = await git(['worktree', 'add', '-b', branch, path, 'HEAD'], root)
  if (!made.ok) return null
  return { path, branch }
}
