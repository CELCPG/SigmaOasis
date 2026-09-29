import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useModels } from '../hooks/useModels'
import { useUpdates } from '../hooks/useUpdates'
import { modalClasses, useModalPresence } from '../hooks/useModalPresence'
import { useApplySettings } from '../hooks/settingsApply'
import type { AppSettings } from '../types'
import { searchRows, segmentedKey, settingsIndex, tabOfRow } from '../lib/settingsKit'
import { targetTab } from '../lib/settingsLinks'
import { SettingsToasts } from './settings/SettingsToasts'
import { DangerRow, FIELD_COMPACT } from './settings/kit'
import { SETTINGS_GROUPS, SETTINGS_TABS, filterTabs, settingsTab, type SettingsTabKey } from './settings/tabs'
import { TabIcon } from './settings/icons'
import { ConnectionTab } from './settings/ConnectionTab'
import { ModelsTab } from './settings/ModelsTab'
import { GeneralTab } from './settings/GeneralTab'
import { GroundingTab } from './settings/GroundingTab'
import { MemoryTab } from './settings/MemoryTab'
import { ToolsTab } from './settings/ToolsTab'
import { AgentTab } from './settings/AgentTab'
import { SearchTab } from './settings/SearchTab'
import { VoiceTab } from './settings/VoiceTab'
import { LibraryTab } from './settings/LibraryTab'
import { SkillsTab } from './settings/SkillsTab'
import { McpTab } from './settings/McpTab'
import { JobsTab } from './settings/JobsTab'
import { PrivacyTab } from './settings/PrivacyTab'
import { ActivityTab } from './settings/ActivityTab'

type Tab = SettingsTabKey

/**
 * Settings (v4.0). The shell: a glass panel with a rail of sixteen tabs under
 * six headers, a search that narrows the rail, a header that says what the
 * open tab governs, and a foot that says what just changed with Undo.
 *
 * There is no draft and no Save. Every control applies as it commits,
 * through `apply` (hooks/settingsApply.ts). Each tab owns whatever transient
 * state it needs — the modal holds only the open tab and the search.
 */
export function SettingsModal(): JSX.Element | null {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const { mounted, leaving, surfaceRef, dialogProps } = useModalPresence(open, {
    onDismiss: () => setOpen(false)
  })
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const apply = useApplySettings()
  const availableModels = useAppStore((s) => s.availableModels)
  const connection = useAppStore((s) => s.connection)
  const { refresh } = useModels()
  const { status: updateStatus, check: checkForUpdates, install: installUpdate } = useUpdates()

  const [defaults, setDefaults] = useState<AppSettings | null>(null)
  const [tab, setTab] = useState<Tab>('connection')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const railRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  // The defaults, for a section's Reset; read once per opening.
  useEffect(() => {
    if (open) void window.api.defaultSettings().then(setDefaults).catch(() => setDefaults(null))
  }, [open])

  // v1.17.2: a remedy control asked for a specific tab. Honour it once, then
  // clear it, so the next manual open lands where the reader left off.
  // v4.0: the target may be a row (`tab.row`): the tab opens, every fold on
  // it is opened so the row is in the tree, and the row is scrolled to and
  // lit once.
  const requestedTab = useAppStore((s) => s.settingsTab)
  const clearSettingsTab = useAppStore((s) => s.clearSettingsTab)
  const [pendingRow, setPendingRow] = useState<string | null>(null)
  useEffect(() => {
    if (!requestedTab) return
    const target = targetTab(requestedTab)
    if (target) setTab(target)
    setPendingRow(requestedTab.includes('.') ? requestedTab : null)
    clearSettingsTab()
  }, [requestedTab, clearSettingsTab])
  useEffect(() => {
    if (!pendingRow || !mounted) return
    let tries = 0
    const find = (): void => {
      const face = document.querySelector('.tab-face')
      if (!face) return
      const row = face.querySelector<HTMLElement>(`[data-row="${CSS.escape(pendingRow)}"]`)
      if (!row) {
        face.querySelectorAll<HTMLButtonElement>('[data-kit="fold"][aria-expanded="false"]').forEach((b) => b.click())
        if (tries++ < 6) window.setTimeout(find, 120)
        else setPendingRow(null)
        return
      }
      row.scrollIntoView({ block: 'center' })
      row.classList.add('kit-row-flash')
      window.setTimeout(() => row.classList.remove('kit-row-flash'), 1500)
      setPendingRow(null)
    }
    const t = window.setTimeout(find, 60)
    return () => window.clearTimeout(t)
  }, [pendingRow, mounted, tab])

  if (!mounted || !settings) return null

  const close = (): void => setOpen(false)

  /** Everything back to the defaults — two clicks, through DangerRow, as Reset always was. */
  const reset = async (): Promise<void> => {
    const fresh = (await window.api.resetSettings()) as AppSettings
    setSettings(fresh)
    void refresh()
  }

  // The rail (S1): the registry's order, grouped under headers, narrowed by
  // the search field. Arrow keys move along it. S5: the search reads every
  // tab's rows too — a tab whose rows match stays in the rail with those
  // rows listed under it, each a jump to that row.
  const matchedRows = query.trim() ? searchRows(settingsIndex(), query) : []
  const tabsWithRows = new Set(matchedRows.map((r) => tabOfRow(r.id)))
  const shown = SETTINGS_TABS.filter((t) => filterTabs(query).includes(t) || tabsWithRows.has(t.key))
  const current = settingsTab(tab)
  const onRailKey = (e: React.KeyboardEvent, index: number): void => {
    const next = segmentedKey(e.key, index, shown.length)
    if (next === null) return
    e.preventDefault()
    const target = shown[next]
    if (!target) return
    setTab(target.key)
    railRefs.current[target.key]?.focus()
  }

  const common = { settings, apply, defaults }

  return (
    <div
      ref={surfaceRef}
      className={`${modalClasses(leaving).backdrop} fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4`}
      onClick={close}
    >
      <div
        {...dialogProps}
        aria-labelledby="settings-modal-title"
        className={`${modalClasses(leaving).panel} glass-panel glass-popover flex h-[90vh] w-full max-w-[1100px] flex-col`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // ⌘F / Ctrl+F inside Settings goes to the settings search, not the page's.
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            searchRef.current?.focus()
          }
        }}
      >
        <div className="flex min-h-0 flex-1">
          <nav data-settings-rail aria-label="Settings sections" className="flex w-56 shrink-0 flex-col border-r border-black/10 dark:border-white/10">
            <div className="px-4 pb-2 pt-4">
              <h2 id="settings-modal-title" className="text-[15px] font-semibold tracking-[-0.3px] text-ink-primary">
                Settings
              </h2>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                data-kit="field"
                className={`${FIELD_COMPACT} mt-2 w-full`}
              />
            </div>
            <div role="tablist" aria-orientation="vertical" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {SETTINGS_GROUPS.map((group) => {
                const items = shown.filter((t) => t.group === group)
                if (items.length === 0) return null
                return (
                  <div key={group} className="mt-2 first:mt-0">
                    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-tertiary">{group}</div>
                    {items.map((t) => {
                      const index = shown.indexOf(t)
                      const active = tab === t.key
                      return (
                        <button
                          key={t.key}
                          ref={(el) => {
                            railRefs.current[t.key] = el
                          }}
                          type="button"
                          role="tab"
                          data-tab={t.key}
                          aria-selected={active}
                          tabIndex={active ? 0 : -1}
                          title={t.description}
                          onClick={() => setTab(t.key)}
                          onKeyDown={(e) => onRailKey(e, index)}
                          className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                            active ? 'bg-accent/15 font-medium text-accent-ink' : 'text-ink-secondary hover:bg-black/5 hover:text-ink-primary dark:hover:bg-white/5'
                          }`}
                        >
                          <TabIcon name={t.icon} className={active ? 'text-accent-ink' : 'text-ink-tertiary'} />
                          <span className="min-w-0 truncate">{t.label}</span>
                        </button>
                      )
                    })}
                    {query.trim() &&
                      items.map((t) => {
                        const rows = matchedRows.filter((r) => tabOfRow(r.id) === t.key).slice(0, 6)
                        if (rows.length === 0) return null
                        return (
                          <div key={`${t.key}-rows`} className="mb-1 ml-8 mr-1" data-search-rows={t.key}>
                            {rows.map((r) => (
                              <button
                                key={r.id}
                                type="button"
                                onClick={() => {
                                  setTab(t.key)
                                  setPendingRow(r.id)
                                }}
                                className="block w-full truncate rounded px-2 py-0.5 text-left text-xs text-ink-secondary hover:bg-black/5 hover:text-ink-primary dark:hover:bg-white/5"
                              >
                                {r.label}
                              </button>
                            ))}
                          </div>
                        )
                      })}
                  </div>
                )
              })}
              {shown.length === 0 && <p className="px-3 py-2 text-xs text-ink-tertiary">Nothing matches “{query}”.</p>}
            </div>
          </nav>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start gap-3 border-b border-black/10 px-6 py-3 dark:border-white/10">
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold text-ink-primary">{current.label}</div>
                <p className="text-xs text-ink-secondary">{current.description}</p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close settings"
                className="rounded-lg p-1.5 text-ink-secondary hover:bg-black/5 hover:text-ink-primary dark:hover:bg-white/10"
              >
                ✕
              </button>
            </div>

            {/*
              Tab content. Keyed on the tab so the body remounts and fades up
              (.tab-face) rather than being swapped under the cursor — and so
              each tab opens at its own top, instead of inheriting however far
              down the previous one was scrolled.
            */}
            <div key={tab} className="tab-face min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {tab === 'connection' && <ConnectionTab settings={settings} apply={apply} availableModels={availableModels} connection={connection} refresh={refresh} />}
              {tab === 'models' && <ModelsTab settings={settings} apply={apply} availableModels={availableModels} />}
              {tab === 'general' && <GeneralTab {...common} checkForUpdates={checkForUpdates} installUpdate={installUpdate} updateStatus={updateStatus} />}
              {tab === 'grounding' && <GroundingTab {...common} />}
              {tab === 'memory' && <MemoryTab {...common} />}
              {tab === 'tools' && <ToolsTab {...common} />}
              {tab === 'agent' && <AgentTab {...common} />}
              {tab === 'search' && <SearchTab {...common} />}
              {tab === 'voice' && <VoiceTab {...common} />}
              {tab === 'library' && <LibraryTab />}
              {tab === 'skills' && <SkillsTab />}
              {tab === 'mcp' && <McpTab />}
              {tab === 'jobs' && <JobsTab />}
              {tab === 'privacy' && <PrivacyTab {...common} />}
              {tab === 'activity' && <ActivityTab settings={settings} />}
            </div>
          </div>
        </div>

        {/* Footer: what just changed, with Undo; and the one reset that takes everything. */}
        <div className="flex min-h-[3.25rem] items-center gap-3 border-t border-black/10 px-6 py-2 dark:border-white/10">
          <SettingsToasts />
          <div className="ml-auto shrink-0">
            <DangerRow variant="inline" label="" action="Reset to defaults" confirm="Reset everything?" onConfirm={reset} />
          </div>
        </div>
      </div>
    </div>
  )
}
