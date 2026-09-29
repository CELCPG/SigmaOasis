// Settings → Skills (v4.0, S4): the installed skills as cards, Remove in two
// clicks, and the install as the section's action. Installed from a folder
// only, through a confirmation that lists what it carries.
import { useCallback, useEffect, useState } from 'react'
import type { InstalledSkill } from '../../types'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { ActionRow, Card, DangerRow, Notice, Row, Section, type ActionResult } from './kit'

export const ROWS = defineRows('skills', {
  installed: { label: 'Installed skills', help: 'A skill is a folder you install: a method the model is handed when one of its trigger phrases is in your message — in place of the built-in playbook for that turn — and, optionally, a library pack, an MCP server (saved switched off), and Python helper files the sandbox can import. There is no registry and no update channel; what you installed is what runs. docs/skill-format.md is the format.', keywords: ['skill', 'playbook', 'triggers', 'install'] }
})
registerRows(ROWS)

export function SkillsTab(): JSX.Element {
  const [skills, setSkills] = useState<InstalledSkill[] | null>(null)
  const [notice, setNotice] = useState<ActionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    setSkills(await window.api.skillsList().catch(() => []))
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const install = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.skillsInstall()
    setBusy(false)
    if (r.ok && r.skill) setNotice({ tone: 'ok', text: `Installed “${r.skill.name}”. It fires on: ${r.skill.triggers.join(', ')}.` })
    else if (!r.canceled) setNotice({ tone: 'danger', text: r.error ?? 'Could not install the skill.' })
    await refresh()
  }

  const remove = async (s: InstalledSkill): Promise<void> => {
    const r = await window.api.skillsRemove(s.id)
    setNotice(
      r.ok
        ? { tone: 'ok', text: `Removed “${s.name}”.${r.packLeft ? ` Its library pack “${r.packLeft}” stays installed; remove it under Library if you want it gone.` : ''}${s.mcpServerId ? ' Its MCP server was removed.' : ''}` }
        : { tone: 'danger', text: r.error ?? 'Could not remove the skill.' }
    )
    await refresh()
  }

  return (
    <div className="space-y-8">
      <Section
        title="Installed skills"
        description={ROWS.installed.help}
        right={<ActionRow action="Install from a folder…" kind="primary" busy={busy ? 'Confirming…' : null} onAction={() => void install()} title="A confirmation lists the method, the pack, the server command and environment variable names, and the helper files before anything is copied." />}
      >
        <Row meta={ROWS.installed} bare>
          <div className="space-y-2">
            {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
            {skills === null ? (
              <p className="text-xs text-ink-tertiary">Loading…</p>
            ) : skills.length === 0 ? (
              <Notice tone="muted">No skills installed.</Notice>
            ) : (
              skills.map((s) => (
                <Card
                  key={s.id}
                  title={
                    <>
                      {s.name} <span className="font-mono text-xs font-normal text-ink-tertiary">{s.id}</span>
                    </>
                  }
                  right={<DangerRow variant="inline" label="" action="Remove" confirm={`Remove “${s.name}”?`} onConfirm={() => remove(s)} />}
                >
                  <p className="text-xs text-ink-secondary">{s.description}</p>
                  <p className="mt-1 text-xs text-ink-tertiary">
                    Fires on: {s.triggers.join(', ')}
                    {s.playbook ? ' · has a method' : ' · no method file'}
                    {s.packId ? ` · pack “${s.packId}”` : ''}
                    {s.mcpServerId ? ` · MCP server “${s.mcpServerId}”` : ''}
                    {s.helpers?.length ? ` · ${s.helpers.length} helper file(s)` : ''}
                  </p>
                </Card>
              ))
            )}
          </div>
        </Row>
      </Section>
    </div>
  )
}
