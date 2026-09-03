import type { ContextProvider } from './types'
import { buildSkillContext, selectSkill } from '../../../../shared/skills'

/**
 * v2.7: a user-installed skill takes the method slot when one of its trigger
 * phrases is in the message. It rides where the playbook rides and stands
 * the playbook down for the turn — one method per turn, as always. Its
 * helper files, when it has any, are handed back for the Workbench to stage.
 */
export const skillProvider: ContextProvider = {
  id: 'skill',
  phase: 'serial',
  enabled: (input, io) =>
    !!input.lastUserContent && typeof io.api.skillsList === 'function' && io.settings()?.grounding?.playbooks !== false,
  async gather(input, io) {
    const skills = await io.api.skillsList!().catch(() => [])
    if (skills.length === 0) return null
    const hit = selectSkill(input.lastUserContent!, skills)
    if (!hit) return null
    io.patch({ skill: hit.skill.name })
    const helpers = hit.skill.helpers?.length ? await io.api.skillHelpers!(hit.skill.id).catch(() => []) : []
    return {
      blocks: [buildSkillContext(hit.skill)],
      suppress: ['playbook'],
      ...(helpers.length > 0 ? { attachments: helpers } : {})
    }
  }
}
