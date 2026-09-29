/**
 * Hooks (v4.0, A8 — an experiment, off by default).
 *
 * A project's `.sigma/hooks.json` names commands to run at three moments of
 * a task: after an edit lands, before a command the model asked for runs,
 * and when the task ends. Each runs through the same door as any command —
 * the host's approval, the standing grants — and each is a line on the
 * timeline. `{file}` in an after-edit hook is the path just changed;
 * `{command}` in a before-command hook is the command about to run.
 *
 *   { "afterEdit": ["npx prettier --write {file}"],
 *     "beforeCommand": ["git status --short"],
 *     "onEnd": ["npm test"] }
 *
 * Pure reading and shaping here; the engine runs them.
 */
import { promises as fs } from 'fs'
import { join } from 'path'

export const HOOKS_FILE = '.sigma/hooks.json'
export const HOOK_MOMENTS = ['afterEdit', 'beforeCommand', 'onEnd'] as const
export type HookMoment = (typeof HOOK_MOMENTS)[number]
export type Hooks = Record<HookMoment, string[]>
const MAX_PER_MOMENT = 5

/** Read `.sigma/hooks.json`; null when absent, empty or unreadable. */
export async function loadHooks(root: string): Promise<Hooks | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(join(root, HOOKS_FILE), 'utf8'))
  } catch {
    return null
  }
  return parseHooks(raw)
}

/** The file's shape, validated: strings only, at most five a moment, nothing else kept. */
export function parseHooks(raw: unknown): Hooks | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const hooks: Hooks = { afterEdit: [], beforeCommand: [], onEnd: [] }
  let any = false
  for (const moment of HOOK_MOMENTS) {
    const list = (raw as Record<string, unknown>)[moment]
    if (!Array.isArray(list)) continue
    hooks[moment] = list
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      .map((c) => c.trim())
      .slice(0, MAX_PER_MOMENT)
    if (hooks[moment].length > 0) any = true
  }
  return any ? hooks : null
}

/** `{file}` and `{command}` filled in; a placeholder with nothing for it stays as written. */
export function fillHook(command: string, vars: { file?: string; command?: string }): string {
  return command.replace(/\{(file|command)\}/g, (whole, key: 'file' | 'command') => vars[key] ?? whole)
}
