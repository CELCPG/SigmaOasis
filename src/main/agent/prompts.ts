import { promises as fs } from 'fs'
import { join } from 'path'
import { localDateLine } from '../../renderer/src/lib/grounding'
import { IGNORED_DIRS } from './workspace'
import type { PermissionMode, ShellSpec, SubagentType } from './types'

/**
 * What the agent is told (v3.0).
 *
 * Deliberately short. A 9–35B model follows a handful of numbered rules and
 * loses an essay, and every token of system prompt is a token of window the
 * task does not get. The rules are the method the agentic CLIs converged on —
 * plan with a checklist, look before touching, small exact edits, verify by
 * running, delegate broad searches, report only what was checked — written
 * as imperatives.
 */

/** Project instructions, in the order they are looked for at the workspace root. */
export const PROJECT_NOTE_FILES = ['SIGMA.md', 'AGENTS.md', 'CLAUDE.md'] as const
const PROJECT_NOTE_MAX_CHARS = 12_000

export interface ProjectNotes {
  file: string
  text: string
  truncated: boolean
}

/**
 * SIGMA.md — a project's standing instructions for the agent, kept in the
 * repository beside the code they describe. AGENTS.md and CLAUDE.md are read
 * when there is no SIGMA.md, so a project already set up for another agent
 * works here unchanged. Only the first found is used.
 */
export async function loadProjectNotes(root: string): Promise<ProjectNotes | null> {
  for (const file of PROJECT_NOTE_FILES) {
    try {
      const text = await fs.readFile(join(root, file), 'utf8')
      if (!text.trim()) continue
      const truncated = text.length > PROJECT_NOTE_MAX_CHARS
      return { file, text: truncated ? `${text.slice(0, PROJECT_NOTE_MAX_CHARS)}\n…` : text, truncated }
    } catch {
      /* not there — try the next */
    }
  }
  return null
}

/** The workspace's top level, folders first — a map the model starts from. */
export async function topLevel(root: string, max = 60): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
      .map((e) => `${e.name}/`)
      .sort()
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort()
    const all = [...dirs, ...files]
    return all.length > max ? [...all.slice(0, max), `… ${all.length - max} more`] : all
  } catch {
    return []
  }
}

/** The checked-out branch, read from .git/HEAD — no command runs for it. */
export async function gitBranch(root: string): Promise<string | null> {
  try {
    const head = (await fs.readFile(join(root, '.git', 'HEAD'), 'utf8')).trim()
    const m = /^ref: refs\/heads\/(.+)$/.exec(head)
    return m ? m[1]! : head.slice(0, 12)
  } catch {
    return null
  }
}

export interface PromptEnv {
  workspace: string | null
  permission: PermissionMode
  shell: ShellSpec
  platform: string
  now: Date
  notes: ProjectNotes | null
  listing: string[]
  branch: string | null
  /** Tool names offered this task, so the rules never name one that is absent. */
  tools: string[]
  /** The slot's standing rules (v2.7), which ride every turn. */
  rules?: string
}

const PERMISSION_LINE: Record<PermissionMode, string> = {
  ask: 'Every edit and every command is shown to the user for approval. A declined change or command is final: do not retry it — adapt, or ask.',
  acceptEdits:
    'Your edits are applied without asking (the user sees each diff and can undo the whole task). Commands still need the user’s approval; a declined one is final.',
  readOnly:
    'READ-ONLY: you cannot change files or run commands in this task. Investigate and answer — or, if asked for a change, lay out the plan: which files, which lines, what to change and how to test it.'
}

export function agentSystemPrompt(env: PromptEnv): string {
  const has = (t: string): boolean => env.tools.includes(t)
  const lines: string[] = []
  lines.push(
    'You are Sigma, an autonomous agent working on the user’s own computer through a local model. ' +
      'Carry the task through to the end: investigate, plan, act, verify, then report.'
  )
  lines.push('', '## Environment')
  if (env.workspace) lines.push(`- Workspace folder: ${env.workspace} — every path is relative to it, and you cannot leave it.`)
  else lines.push('- There is no workspace folder for this task: no file or command tools. Work with the tools you have.')
  if (has('run_command')) lines.push(`- run_command uses ${env.shell.name} on ${env.platform}.`)
  if (env.branch) lines.push(`- Git branch: ${env.branch}.`)
  lines.push(`- Today is ${localDateLine(env.now)}.`)
  lines.push(`- ${PERMISSION_LINE[env.permission]}`)

  const rules: string[] = []
  if (has('todo_write')) rules.push('For anything with three or more steps, start with todo_write; keep one item in_progress and tick items off as you finish them.')
  if (has('read_file')) rules.push('Look before you change anything: glob and grep to find, read_file to read. Only edit a file you have read in this task.')
  if (has('edit_file')) rules.push('Make small, exact edits with edit_file — copy old_string from read_file output without the line numbers. Use write_file for new files.')
  if (has('run_command')) rules.push('Verify: run the project’s tests, build or linter with run_command when it has them; read failures, fix, and run again.')
  if (has('task')) rules.push('For a broad search or an independent review, use task: the helper starts fresh and returns a summary, which keeps your context small.')
  if (has('read_file')) rules.push('Keep tool output small: grep before reading big files, read only the lines you need (offset/limit), and do not re-read a file you already have.')
  rules.push('Finish with a short report: what you changed (files), how you checked it, and anything left undone. Never claim a check you did not run.')
  lines.push('', '## How to work', ...rules.map((r, i) => `${i + 1}. ${r}`))

  if (env.rules?.trim()) lines.push('', '## The user’s standing rules', env.rules.trim())
  if (env.notes) {
    lines.push('', `## Project instructions (${env.notes.file})`, env.notes.text.trim())
  }
  if (env.listing.length > 0) lines.push('', '## Workspace top level', env.listing.join('  '))
  return lines.join('\n')
}

const SUBAGENT_ROLE: Record<SubagentType, string> = {
  explore:
    'You are a read-only research helper for a coding agent. Investigate what the prompt asks with glob, grep, list_directory and read_file, then reply with a concise report: the answer, the relevant files with line numbers, and short excerpts only where they matter. You cannot change anything. Search first; read only what you need.',
  review:
    'You are a careful reviewer helping a coding agent. Read the files or changes the prompt points you to and report concrete problems — bugs, missed cases, inconsistencies with the surrounding code, missing tests — each with file:line and why it matters. If it looks right, say so in a sentence. You cannot change anything.',
  general:
    'You are a helper agent doing one self-contained sub-task for a coding agent. Do the task with your tools, verify it where you can, and reply with a short report: what you did, which files you changed, and how you checked it.'
}

export function subagentSystemPrompt(type: SubagentType, env: PromptEnv): string {
  const lines = [SUBAGENT_ROLE[type], '', 'Your final message is the only thing the parent agent sees, so make it complete and brief.', '']
  if (env.workspace) lines.push(`Workspace folder: ${env.workspace} (paths are relative to it).`)
  if (env.tools.includes('run_command')) lines.push(`run_command uses ${env.shell.name}.`)
  lines.push(`Today is ${localDateLine(env.now)}.`)
  if (env.notes) lines.push('', `Project instructions (${env.notes.file}):`, env.notes.text.trim())
  return lines.join('\n')
}
