import { promises as fs } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'

/**
 * The workspace boundary and the walk over it (v3.0).
 *
 * A task's folder is a boundary, not a starting point: every path a tool is
 * given resolves against it and is refused if it lands outside — `..`, an
 * absolute path elsewhere, and, for anything that writes, a symlink inside the
 * folder that points out of it. Reads follow what the OS resolves; writes
 * check the real path of the nearest existing ancestor, because a write
 * through a link is a write to wherever the link goes.
 */

export class WorkspaceError extends Error {}

/**
 * Directories a search skips unless it was started inside one: dependency
 * trees, build output, VCS metadata and caches. They are where a naive walk
 * spends its time and a small model spends its context, and they are almost
 * never what "find the function that…" means.
 */
export const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  'dist',
  'out',
  'coverage',
  '.gradle',
  '.idea',
  '.test-build'
])

/** Resolve `p` inside `root`; throw a sentence the model can act on otherwise. */
export function resolveInside(root: string, p: unknown): string {
  const given = typeof p === 'string' && p.trim() ? p.trim() : '.'
  const abs = isAbsolute(given) ? resolve(given) : resolve(root, given)
  const rel = relative(root, abs)
  if (rel === '') return abs
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorkspaceError(`"${given}" is outside the workspace (${root}). Use a path inside it.`)
  }
  return abs
}

/** The workspace-relative form of `abs`, with forward slashes — what the model and the reader see. */
export function relPath(root: string, abs: string): string {
  const rel = relative(root, abs)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

/**
 * Refuse a write whose real destination is outside the workspace. The nearest
 * existing ancestor is resolved through symlinks and compared with the real
 * root; a file that does not exist yet is judged by the folder it will land in.
 */
export async function assertWritableInside(root: string, abs: string): Promise<void> {
  const realRoot = await fs.realpath(root)
  let probe = abs
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      const rel = relative(realRoot, real)
      if (rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) return
      throw new WorkspaceError(`"${abs}" resolves outside the workspace through a link (${real}). Refused.`)
    } catch (err) {
      if (err instanceof WorkspaceError) throw err
      const parent = dirname(probe)
      if (parent === probe) return
      probe = parent
    }
  }
}

/**
 * A glob as a regular expression over forward-slash relative paths.
 *
 * `*` stays within one path segment, `**` crosses them (`**\/` also matches
 * zero directories), `?` is one character, `{a,b}` alternates, `[...]` is a
 * class (`[!…]` negated). A pattern with no slash matches a file's *name* at
 * any depth — `*.ts` finds every TypeScript file — because that is what a
 * model asking for "*.ts" nearly always means, and what .gitignore and
 * ripgrep's `-g` do too.
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  const anyDepth = !pattern.includes('/')
  const body = globSource(pattern)
  return new RegExp(anyDepth ? `^(?:.*/)?${body}$` : `^${body}$`, process.platform === 'win32' ? 'i' : '')
}

function globSource(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) {
        re += '\\{'
        continue
      }
      re += `(?:${glob
        .slice(i + 1, end)
        .split(',')
        .map(globSource)
        .join('|')})`
      i = end
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) {
        re += '\\['
        continue
      }
      const inner = glob.slice(i + 1, end).replace(/\\/g, '\\\\')
      re += `[${inner.startsWith('!') ? `^${inner.slice(1)}` : inner}]`
      i = end
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&')
  }
  return re
}

export interface WalkLimits {
  /** Stop after visiting this many entries. */
  maxEntries: number
  /** Stop after this long. */
  maxMs: number
}

export const DEFAULT_WALK: WalkLimits = { maxEntries: 60_000, maxMs: 8_000 }

/**
 * Every file under `start`, depth-first, skipping ignored directories unless
 * the walk began inside one. Directory symlinks are not followed — a link
 * back up the tree would otherwise walk forever. Reports whether a limit cut
 * the walk short, so a caller can say its answer is partial.
 */
export async function walkFiles(
  start: string,
  onFile: (abs: string) => boolean | void,
  limits: WalkLimits = DEFAULT_WALK
): Promise<{ truncated: boolean }> {
  const startedAt = Date.now()
  let visited = 0
  const stack = [start]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    for (const e of entries) {
      if (++visited > limits.maxEntries || Date.now() - startedAt > limits.maxMs) return { truncated: true }
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(abs)
      } else if (e.isFile()) {
        if (onFile(abs) === false) return { truncated: true }
      }
    }
  }
  return { truncated: false }
}

/** True when the first 8 KB hold a NUL byte — the classic, cheap binary test. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}
