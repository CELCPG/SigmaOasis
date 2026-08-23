import type { ContextProvider } from './types'
import { estimateTokens } from '../contextBudget'
import {
  PROJECT_RECALL_PER_TURN,
  buildProjectRecallContext,
  siblingConversationIds,
  toProjectContextItems
} from '../projectContext'

/**
 * v1.10 project-wide recall: what the project's other chats established,
 * retrieved by relevance to this message. Main reads the sibling files
 * itself; ephemeral chats are never on disk and so never surface. Prefetch
 * phase so it overlaps the other embedding work.
 */
export const projectRecallProvider: ContextProvider = {
  id: 'projectRecall',
  phase: 'prefetch',
  enabled: (input) =>
    input.project?.recall === true &&
    !!input.lastUserContent &&
    siblingConversationIds(input.conversations, input.convo).length > 0,
  async gather(input, io) {
    const siblingIds = siblingConversationIds(input.conversations, input.convo)
    try {
      const recalled = await io.api
        .projectRecall(siblingIds, input.lastUserContent!, PROJECT_RECALL_PER_TURN)
        .catch(() => null)
      if (!(recalled?.ok && recalled.items.length > 0)) return null
      const block = buildProjectRecallContext(input.project!.name, recalled.items)
      io.patch({ projectContext: toProjectContextItems(recalled.items) })
      return { blocks: [block], projectTokens: { recall: estimateTokens(block) } }
    } catch {
      // Recall is a nicety, never a blocker.
      return null
    }
  }
}
