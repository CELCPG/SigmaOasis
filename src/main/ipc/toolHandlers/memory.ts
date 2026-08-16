import { getSettings } from '../store'
import { addToMemory, deleteFromMemory, searchMemory } from '../memory'
import { truncate } from './types'
import type { ToolHandler } from './types'

/** Durable local vector memory: memory_save, memory_search, memory_forget. */

const memorySave: ToolHandler = async (args) => {
  const title = String(args.title ?? '').trim()
  if (!title) return { ok: false, error: 'Memory title is required.' }
  const { chunks } = await addToMemory(title, String(args.text ?? ''))
  return { ok: true, output: `Saved "${title}" to long-term memory (${chunks} chunk(s)).` }
}

const memorySearch: ToolHandler = async (args) => {
  const topK = typeof args.topK === 'number' ? args.topK : getSettings().memory.topK
  const results = await searchMemory(String(args.query ?? ''), topK)
  if (results.length === 0) {
    return { ok: true, output: 'No relevant memories found.' }
  }
  return {
    ok: true,
    output: truncate(
      results.map((r, i) => `${i + 1}. [${r.source}] (score ${r.score})\n${r.text}`).join('\n\n')
    )
  }
}

const memoryForget: ToolHandler = async (args) => {
  const title = String(args.title ?? '')
  const { removed } = await deleteFromMemory(title)
  return removed > 0
    ? { ok: true, output: `Forgot "${title}" (${removed} chunk(s) removed).` }
    : { ok: false, error: `No memory titled "${title}".` }
}

export const memoryHandlers = {
  memory_save: memorySave,
  memory_search: memorySearch,
  memory_forget: memoryForget
} satisfies Record<string, ToolHandler>
