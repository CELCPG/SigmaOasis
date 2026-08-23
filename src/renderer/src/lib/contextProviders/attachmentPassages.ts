import type { ContextProvider } from './types'
import { estimateTokens } from '../contextBudget'
import {
  ATTACHMENT_PASSAGES_PER_TURN,
  buildAttachmentContext,
  indexedAttachmentRefs,
  toAttachmentContextItems
} from '../attachmentRecall'
import { projectFileRefs } from '../projectContext'

/**
 * v1.4.8: attached documents longer than the inline limit live in the session
 * index; retrieve what this message needs from them. v1.10: files pinned to
 * the project are retrieved exactly like attached documents — indexed from
 * their path the first time a chat needs them. Prefetch phase, like the other
 * embedding calls.
 */
export const attachmentPassagesProvider: ContextProvider = {
  id: 'attachmentPassages',
  phase: 'prefetch',
  enabled: (input) =>
    [...indexedAttachmentRefs(input.convo), ...projectFileRefs(input.project)].length > 0 &&
    !!input.lastUserContent,
  async gather(input, io) {
    const refs = [...indexedAttachmentRefs(input.convo), ...projectFileRefs(input.project)]
    try {
      const recalled = await io.api
        .attachmentPassages(refs, input.lastUserContent!, ATTACHMENT_PASSAGES_PER_TURN)
        .catch(() => null)
      if (!recalled?.ok) return null
      const block = buildAttachmentContext(recalled.passages, recalled.notes)
      const files = recalled.passages
        .filter((p) => p.attachmentId.startsWith('project-file-'))
        .reduce((n, p) => n + estimateTokens(p.text), 0)
      if (recalled.passages.length > 0) {
        io.patch({ attachmentContext: toAttachmentContextItems(recalled.passages) })
      }
      return { blocks: block ? [block] : [], projectTokens: { files } }
    } catch {
      // Retrieval is best effort; the inline head still went through.
      return null
    }
  }
}
