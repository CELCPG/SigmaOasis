import type { ContextProvider } from './types'
import { buildPlaybookContext, selectPlaybook } from '../playbooks'

/**
 * v1.5 playbooks: one short method for the kind of question, chosen by the
 * same domain classifiers, riding the turn notes after any passages so the
 * model reads the material first and the method for using it second — which
 * is why this provider is registered after the search and library providers.
 */
export const playbookProvider: ContextProvider = {
  id: 'playbook',
  phase: 'serial',
  enabled: (input, io) =>
    !!input.lastUserContent && io.settings()?.grounding.playbooks !== false,
  async gather(input, io) {
    const lastUser = [...input.convo.messages].reverse().find((m) => m.role === 'user')
    const playbook = selectPlaybook({
      text: input.lastUserContent!,
      attachmentNames: (lastUser?.attachments ?? []).map((a) => a.name)
    })
    if (!playbook) return null
    io.patch({ playbook: playbook.name })
    return { blocks: [buildPlaybookContext(playbook)] }
  }
}
