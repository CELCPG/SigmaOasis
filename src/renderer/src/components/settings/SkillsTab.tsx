// v2.7: Settings → Skills — the user's installed skills. A skill is a folder: a method the
// model is handed when a trigger phrase is in the message, and optionally a library pack, an
// MCP server spec (saved switched off) and Python helper files for the sandbox. Installed from
// a folder only, through a confirmation that lists what it carries. Self-fetching, like MCP.
import React, { useCallback, useEffect, useState } from 'react'
import type { InstalledSkill } from '../../types'

const BUTTON = 'rounded-lg border border-black/10 dark:border-white/10 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40'

export function SkillsTab(): JSX.Element {
  const [skills, setSkills] = useState<InstalledSkill[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
    if (r.ok && r.skill) setNotice(`Installed "${r.skill.name}". It fires on: ${r.skill.triggers.join(', ')}.`)
    else if (!r.canceled) setNotice(r.error ?? 'Could not install the skill.')
    await refresh()
  }

  const remove = async (s: InstalledSkill): Promise<void> => {
    const r = await window.api.skillsRemove(s.id)
    setNotice(
      r.ok
        ? `Removed "${s.name}".${r.packLeft ? ` Its library pack "${r.packLeft}" stays installed; remove it under Settings → Library if you want it gone.` : ''}${s.mcpServerId ? ' Its MCP server was removed.' : ''}`
        : (r.error ?? 'Could not remove the skill.')
    )
    await refresh()
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm font-medium">Skills</div>
        <p className="mt-1 text-xs text-ink-secondary">
          A skill is a folder you install: a method the model is handed when one of its trigger phrases is in
          your message — in place of the built-in playbook for that turn — and, optionally, a library pack, an
          MCP server (saved switched off), and Python helper files the sandbox can import. Installed from a folder
          only, through a confirmation that lists everything the folder carries. There is no registry and no
          update channel; what you installed is what runs. <code>docs/skill-format.md</code> is the format.
        </p>
      </div>

      {notice && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-ink-primary" role="status">
          {notice}
        </p>
      )}

      {skills === null ? (
        <p className="text-sm text-ink-tertiary">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No skills installed.</p>
      ) : (
        <ul className="space-y-3">
          {skills.map((s) => (
            <li key={s.id} className="glass-panel rounded-xl p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {s.name} <span className="font-mono text-xs text-ink-tertiary">{s.id}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-secondary">{s.description}</p>
                  <p className="mt-1 text-xs text-ink-tertiary">
                    Fires on: {s.triggers.join(', ')}
                    {s.playbook ? ' · has a method' : ' · no method file'}
                    {s.packId ? ` · pack "${s.packId}"` : ''}
                    {s.mcpServerId ? ` · MCP server "${s.mcpServerId}" (Settings → MCP)` : ''}
                    {s.helpers?.length ? ` · ${s.helpers.length} helper file(s)` : ''}
                  </p>
                </div>
                <button type="button" className={`${BUTTON} text-ink-danger`} onClick={() => void remove(s)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div>
        <button type="button" className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={busy} onClick={() => void install()}>
          {busy ? 'Confirming…' : 'Install from a folder…'}
        </button>
        <p className="mt-2 text-xs text-ink-tertiary">
          A confirmation lists the method, the pack, the server command and environment variable names, and the
          helper files before anything is copied.
        </p>
      </div>
    </div>
  )
}
