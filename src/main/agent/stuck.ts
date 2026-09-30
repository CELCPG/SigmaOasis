import type { ToolResult } from './types'

/**
 * A stuck detector (v4.1, A2).
 *
 * The loop catches one kind of going round in circles: the same call with the
 * same arguments, answered from the ledger. A small model's usual circle is
 * not that — it is edit_file on the same file failing five times with five
 * slightly different `old_string`s, a read between each, or the same test run
 * failing with nothing changed. Each call is new, so nothing caught it, and
 * any write cleared the ledger anyway. So failures are counted per tool and
 * the thing it was aimed at (the path, the command, the pattern):
 *
 * - at three in a row the failing result carries a note — you are stuck;
 *   re-read, change approach — and the next round thinks;
 * - at five the task stops and says why, rather than spend its remaining
 *   rounds on the same wall.
 *
 * "In a row" is per target: a read of the file between two failed edits of
 * it does not reset the count (that read is part of the circle), a success
 * on the same target does. A change that lands resets every command's count,
 * because running a check again after changing something is the method, not
 * a circle.
 */

export const STUCK_WARN_AT = 3
export const STUCK_STOP_AT = 5

/** What a failure was aimed at: the tool and its path, command, pattern or address. */
export function stuckKey(name: string, args: Record<string, unknown>): string {
  const target = args.path ?? args.from ?? args.command ?? args.pattern ?? args.url ?? args.query ?? args.id ?? ''
  return `${name} ${String(target).trim().replace(/^\.\//, '')}`
}

export interface StuckState {
  key: string
  name: string
  target: string
  count: number
  error: string
}

export class StuckDetector {
  private readonly failures = new Map<string, number>()
  /** Set once a target reaches STUCK_STOP_AT; the loop pauses on it. */
  stopped: StuckState | null = null
  /** Set when a warning was just given; the engine lets the next round think. */
  warned = false

  /**
   * Count one call's outcome and return the result the model should see —
   * the same one, or with the stuck note appended.
   */
  observe(name: string, args: Record<string, unknown>, result: ToolResult, changesFiles: boolean): ToolResult {
    const key = stuckKey(name, args)
    if (result.ok) {
      this.failures.delete(key)
      if (changesFiles) for (const k of [...this.failures.keys()]) if (k.startsWith('run_command ')) this.failures.delete(k)
      return result
    }
    const count = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, count)
    const target = key.slice(name.length + 1)
    if (count >= STUCK_STOP_AT) {
      this.stopped = { key, name, target, count, error: (result.error ?? '').split('\n')[0]!.slice(0, 300) }
      return { ...result, error: `${result.error ?? ''}\n\n(${count} failures in a row of ${name}${target ? ` on ${target}` : ''}: the task stops here to ask the user.)` }
    }
    if (count < STUCK_WARN_AT) return result
    this.warned = true
    const reread = typeof args.path === 'string' && args.path.trim() ? `Re-read ${args.path.trim()} with read_file as it is now` : 'Look again at what you are working from'
    const note =
      `You are stuck: this is failure ${count} in a row of ${name}${target ? ` on ${target}` : ''}. Do not repeat it. ` +
      `${reread}, think about why it fails, and change approach — a smaller change, a different anchor, another tool. ` +
      `After ${STUCK_STOP_AT - count} more the task stops to ask the user.`
    return { ...result, error: `${result.error ?? ''}\n\n(${note})` }
  }
}
