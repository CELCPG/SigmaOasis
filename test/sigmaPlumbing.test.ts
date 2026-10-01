import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIGMA_IGNORED, ensureSigmaIgnore, ensureWorktree } from '../src/main/agent/worktree'
import { copyToInbox } from '../src/main/agent/inbox'

/**
 * v4.3: the two gaps 4.1's notes documented rather than fixed — `.sigma/`'s
 * plumbing showing in the user's git status, and `git worktree add` running
 * the folder's own post-checkout hook.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), 'sigma-plumbing-'))
const hasGit = (): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('.sigma/.gitignore', () => {
  test('written with every piece of plumbing — worktrees, inbox, trash, itself — and nothing the user commits', async () => {
    const dir = scratch()
    try {
      await ensureSigmaIgnore(dir)
      assert.equal(readFileSync(join(dir, '.sigma', '.gitignore'), 'utf8'), 'worktrees/\ninbox/\ntrash/\n.gitignore\n')
      assert.deepEqual([...SIGMA_IGNORED], ['worktrees/', 'inbox/', 'trash/', '.gitignore'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an older one (4.0–4.2 wrote worktrees/ alone) is brought up to date; the user's lines stay; a second call changes nothing", async () => {
    const dir = scratch()
    try {
      mkdirSync(join(dir, '.sigma'))
      writeFileSync(join(dir, '.sigma', '.gitignore'), 'worktrees/\n.gitignore\nscratch.txt')
      await ensureSigmaIgnore(dir)
      const once = readFileSync(join(dir, '.sigma', '.gitignore'), 'utf8')
      assert.equal(once, 'worktrees/\n.gitignore\nscratch.txt\ninbox/\ntrash/\n')
      await ensureSigmaIgnore(dir)
      assert.equal(readFileSync(join(dir, '.sigma', '.gitignore'), 'utf8'), once)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a file dropped into the inbox brings the ignore file with it', async () => {
    const dir = scratch()
    try {
      const src = join(dir, 'outside.txt')
      writeFileSync(src, 'hello')
      const ws = join(dir, 'ws')
      mkdirSync(ws)
      const r = await copyToInbox(ws, [src])
      assert.deepEqual(r.copied, ['.sigma/inbox/outside.txt'])
      assert.match(readFileSync(join(ws, '.sigma', '.gitignore'), 'utf8'), /^inbox\/$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("in a repository, the inbox and the trash never show in git status", async (t) => {
    if (!hasGit()) return t.skip('git is not on this machine')
    const dir = scratch()
    try {
      const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim()
      git('init', '-q')
      writeFileSync(join(dir, 'a.txt'), 'a')
      git('add', '-A')
      git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init')
      mkdirSync(join(dir, '.sigma', 'inbox'), { recursive: true })
      mkdirSync(join(dir, '.sigma', 'trash'), { recursive: true })
      writeFileSync(join(dir, '.sigma', 'inbox', 'dropped.pdf'), 'x')
      writeFileSync(join(dir, '.sigma', 'trash', '123-old.txt'), 'x')
      assert.match(git('status', '--short', '--untracked-files=all'), /\.sigma\//, 'without it, both show')
      await ensureSigmaIgnore(dir)
      assert.equal(git('status', '--short', '--untracked-files=all'), '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('git worktree add, without the folder\'s hooks', () => {
  test("the repository's post-checkout hook fires on its own checkout, and not on the app's worktree", async (t) => {
    if (!hasGit()) return t.skip('git is not on this machine')
    const dir = scratch()
    const marker = join(dir, 'hook-ran')
    try {
      const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim()
      git('init', '-q')
      writeFileSync(join(dir, 'a.txt'), 'a')
      git('add', '-A')
      git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init')
      writeFileSync(join(dir, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
      // The control: an ordinary checkout runs it, so the test can see a hook.
      git('checkout', '-q', '-b', 'probe')
      assert.ok(existsSync(marker), 'the hook runs on an ordinary checkout')
      rmSync(marker)
      const wt = await ensureWorktree(dir, 'Fix the thing', undefined, new Date(2026, 9, 1, 8, 0))
      assert.ok(wt, 'the worktree was made')
      assert.ok(existsSync(join(wt!.path, 'a.txt')), 'and checked out')
      assert.equal(existsSync(marker), false, "the folder's post-checkout hook did not run")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
