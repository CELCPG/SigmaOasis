import { useEffect, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useModels } from '../hooks/useModels'
import { useUpdates } from '../hooks/useUpdates'
import { CollaborativeMode } from './CollaborativeMode'
import { ACCENT_KEYS, ACCENT } from '../lib/colors'
import type {
  AppSettings,
  AccentColor,
  ToolToggles,
  SttStatus,
  MemoryStats,
  NetworkActivityEntry,
  ResearchIndexStats
} from '../types'
import { speak } from '../lib/voice'

const TOOL_LABELS: Record<keyof ToolToggles, string> = {
  read_file: 'Read file',
  write_file: 'Write file (confirms when no working directory is set)',
  list_directory: 'List directory',
  run_terminal_command: 'Run terminal command (asks to confirm)',
  web_search: 'Web search (provider chosen in Settings → Search)',
  fetch_webpage: 'Fetch webpage (HTTPS only, private addresses refused)',
  get_current_datetime: 'Get current date/time',
  create_note: 'Create note',
  list_notes: 'List notes',
  read_note: 'Read note',
  memory_save: 'Save to long-term memory',
  memory_search: 'Search long-term memory',
  memory_forget: 'Delete a memory'
}

type Tab = 'connection' | 'models' | 'pipeline' | 'general' | 'tools' | 'search' | 'privacy' | 'voice' | 'memory'

/**
 * The renderer's Content-Security-Policy (index.html) only permits connections
 * to loopback, so a remote LM Studio can't be reached for chat even though the
 * main process could reach it for embeddings. Flag that rather than let the
 * user discover it as a silent half-failure.
 */
function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
  } catch {
    return true // not a parseable URL yet — don't nag while typing
  }
}

export function SettingsModal(): JSX.Element | null {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const availableModels = useAppStore((s) => s.availableModels)
  const connection = useAppStore((s) => s.connection)
  const { refresh } = useModels()
  const { status: updateStatus, check: checkForUpdates, install: installUpdate } = useUpdates()

  const [draft, setDraft] = useState<AppSettings | null>(settings)
  const [tab, setTab] = useState<Tab>('connection')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null)
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null)
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null)
  const [researchStats, setResearchStats] = useState<ResearchIndexStats | null>(null)
  const [searchTest, setSearchTest] = useState<{ ok: boolean; detail: string } | null>(null)
  const [searchTesting, setSearchTesting] = useState(false)
  const [braveKeyInput, setBraveKeyInput] = useState('')
  const [braveKeyInfo, setBraveKeyInfo] = useState<{ set: boolean; encrypted: boolean } | null>(null)
  const [braveKeyNotice, setBraveKeyNotice] = useState<string | null>(null)
  const [netActivity, setNetActivity] = useState<NetworkActivityEntry[]>([])

  useEffect(() => {
    if (open) setDraft(settings)
  }, [open, settings])

  // Load available TTS voices and STT status when the Voice tab opens.
  useEffect(() => {
    if (tab !== 'voice') return
    const loadVoices = (): void => setVoices(window.speechSynthesis?.getVoices() ?? [])
    loadVoices()
    window.speechSynthesis?.addEventListener('voiceschanged', loadVoices)
    void window.api.getSttStatus().then(setSttStatus)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices)
  }, [tab])

  // Load memory stats when the Memory tab opens.
  useEffect(() => {
    if (tab === 'memory') void window.api.memoryStats().then(setMemoryStats)
  }, [tab])

  // Load Brave key status when the Search tab opens; reset transient UI state.
  useEffect(() => {
    if (tab !== 'search') return
    void window.api.braveKeyStatus().then(setBraveKeyInfo)
    setSearchTest(null)
    setBraveKeyNotice(null)
    setBraveKeyInput('')
  }, [tab])

  // Load the network activity log when the Privacy tab opens.
  useEffect(() => {
    if (tab === 'privacy') {
      void window.api.getNetworkActivity().then(setNetActivity)
      void window.api.researchIndexStats().then(setResearchStats)
    }
  }, [tab])

  if (!open || !draft) return null

  const update = (partial: Partial<AppSettings>): void =>
    setDraft((d) => (d ? { ...d, ...partial } : d))

  const updateModel = (id: string, partial: Partial<AppSettings['models'][number]>): void =>
    setDraft((d) =>
      d
        ? { ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...partial } : m)) }
        : d
    )

  const save = async (): Promise<void> => {
    await window.api.setSettings(draft)
    setSettings(draft)
    setOpen(false)
    refresh()
  }

  const reset = async (): Promise<void> => {
    const fresh = (await window.api.resetSettings()) as AppSettings
    setDraft(fresh)
    setSettings(fresh)
  }

  const pickWorkingDir = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) update({ workingDirectory: dir })
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'connection', label: 'Connection' },
    { key: 'models', label: 'Models' },
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'general', label: 'General' },
    { key: 'tools', label: 'Tools' },
    { key: 'search', label: 'Search' },
    { key: 'privacy', label: 'Privacy' },
    { key: 'voice', label: 'Voice' },
    { key: 'memory', label: 'Memory' }
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-panel-light dark:bg-panel-dark shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-black/10 dark:border-white/10 px-5 py-3">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg p-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Tab rail */}
          <div className="w-40 shrink-0 border-r border-black/10 dark:border-white/10 p-2">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`mb-0.5 block w-full rounded-lg px-3 py-2 text-left text-sm ${
                  tab === t.key
                    ? 'bg-accent/15 text-accent font-medium'
                    : 'hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-5">
            {tab === 'connection' && (
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">LM Studio base URL</label>
                  <input
                    value={draft.baseUrl}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                    placeholder="http://127.0.0.1:1234/v1"
                    className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent/40"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    OpenAI-compatible endpoint. Default is{' '}
                    <code>http://127.0.0.1:1234/v1</code>.
                  </p>
                  {!isLoopbackUrl(draft.baseUrl) && (
                    <p className="mt-2 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                      Only servers on this machine are supported. Sigma Oasis&apos;s
                      Content-Security-Policy blocks connections to other hosts, so chat will fail
                      against this URL even if the model list loads.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      connection === 'online'
                        ? 'bg-green-500'
                        : connection === 'connecting'
                          ? 'bg-amber-500'
                          : 'bg-red-500'
                    }`}
                  />
                  <span className="text-sm">
                    {connection === 'online'
                      ? `Connected — ${availableModels.length} model(s) available`
                      : connection === 'connecting'
                        ? 'Connecting…'
                        : 'Offline — is LM Studio running with the server started?'}
                  </span>
                  <button
                    type="button"
                    onClick={refresh}
                    className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    Test / Refresh
                  </button>
                </div>
                {availableModels.length > 0 && (
                  <div className="rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs">
                    <div className="mb-1 font-medium">Detected models:</div>
                    <ul className="list-disc pl-5 space-y-0.5">
                      {availableModels.map((m) => (
                        <li key={m.id} className="font-mono">
                          {m.id}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {tab === 'models' && (
              <div className="space-y-5">
                {draft.models.map((m, idx) => (
                  <div
                    key={m.id}
                    className="rounded-xl border border-black/10 dark:border-white/10 p-4"
                  >
                    <div className="mb-3 flex items-center gap-2">
                      <span className={`h-3 w-3 rounded-full ${ACCENT[m.color].dot}`} />
                      <span className="font-medium">Model slot {idx + 1}</span>
                      <label className="ml-auto flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={m.enabled}
                          onChange={(e) => updateModel(m.id, { enabled: e.target.checked })}
                          className="accent-accent"
                        />
                        Enabled
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-neutral-500">
                          Model (from LM Studio)
                        </label>
                        <select
                          value={m.modelId}
                          onChange={(e) => updateModel(m.id, { modelId: e.target.value })}
                          className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                        >
                          <option value="">— select a model —</option>
                          {availableModels.map((am) => (
                            <option key={am.id} value={am.id}>
                              {am.id}
                            </option>
                          ))}
                          {/* Keep a stale selection visible even if offline */}
                          {m.modelId && !availableModels.some((am) => am.id === m.modelId) && (
                            <option value={m.modelId}>{m.modelId} (not loaded)</option>
                          )}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-neutral-500">
                          Role name
                        </label>
                        <input
                          value={m.roleName}
                          onChange={(e) => updateModel(m.id, { roleName: e.target.value })}
                          className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                        />
                      </div>
                    </div>

                    <div className="mt-3">
                      <label className="mb-1 block text-xs font-medium text-neutral-500">
                        System prompt
                      </label>
                      <textarea
                        value={m.systemPrompt}
                        onChange={(e) => updateModel(m.id, { systemPrompt: e.target.value })}
                        rows={3}
                        className="w-full resize-y rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none font-mono"
                      />
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-xs font-medium text-neutral-500">Accent:</span>
                      {ACCENT_KEYS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => updateModel(m.id, { color: c as AccentColor })}
                          className={`h-6 w-6 rounded-full ${ACCENT[c].dot} ${
                            m.color === c ? 'ring-2 ring-offset-2 ring-offset-transparent ' + ACCENT[c].ring : ''
                          }`}
                          title={c}
                        />
                      ))}
                      <span className="ml-2 text-xs text-neutral-400">
                        Route with <code>@{m.roleName.replace(/\s+/g, '')}</code>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'pipeline' && (
              <CollaborativeMode settings={draft} onChange={(pipeline) => update({ pipeline })} />
            )}

            {tab === 'general' && (
              <div className="space-y-5">
                <div>
                  <label className="mb-1 block text-sm font-medium">Theme</label>
                  <div className="flex rounded-lg bg-black/5 dark:bg-white/10 p-0.5 text-sm w-fit">
                    {(['light', 'dark'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => update({ theme: t })}
                        className={`px-4 py-1.5 rounded-md capitalize ${
                          draft.theme === t ? 'bg-white dark:bg-neutral-700 shadow-sm' : 'text-neutral-500'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Font size: {draft.fontSize}px
                  </label>
                  <input
                    type="range"
                    min={12}
                    max={20}
                    value={draft.fontSize}
                    onChange={(e) => update({ fontSize: Number(e.target.value) })}
                    className="w-64 accent-accent"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Conversation history limit
                  </label>
                  <input
                    type="number"
                    min={10}
                    max={1000}
                    value={draft.historyLimit}
                    onChange={(e) => update({ historyLimit: Number(e.target.value) })}
                    className="w-32 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Maximum number of conversations to keep.
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Chat appearance</label>
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.hideToolCalls}
                      onChange={(e) => update({ hideToolCalls: e.target.checked })}
                      className="h-4 w-4 accent-accent"
                    />
                    Hide tool-call details
                  </label>
                  <p className="mt-1 text-xs text-neutral-500">
                    When on, tool activity collapses to a subtle thinking animation — the chat
                    stays clean. Off by default.
                  </p>
                </div>
                <div className="border-t border-black/10 dark:border-white/10 pt-4">
                  <label className="mb-1 block text-sm font-medium">About</label>
                  <p className="text-sm text-neutral-500">
                    Sigma Oasis v{updateStatus?.currentVersion ?? '…'}
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    <span className="text-xs text-neutral-500">
                      {updateStatus?.state === 'dev'
                        ? 'Development build — updates apply to packaged releases.'
                        : updateStatus?.state === 'checking'
                          ? 'Checking for updates…'
                          : updateStatus?.state === 'available'
                            ? `Update ${updateStatus.version} found — downloading…`
                            : updateStatus?.state === 'downloading'
                              ? `Downloading update… ${updateStatus.percent ?? 0}%`
                              : updateStatus?.state === 'downloaded'
                                ? `Update ${updateStatus.version} is ready to install.`
                                : updateStatus?.state === 'error'
                                  ? `Update check failed: ${updateStatus.error ?? 'unknown error'}`
                                  : 'You’re up to date.'}
                    </span>
                    {updateStatus?.state === 'downloaded' ? (
                      <button
                        type="button"
                        onClick={installUpdate}
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
                      >
                        Restart to update
                      </button>
                    ) : updateStatus?.state !== 'dev' ? (
                      <button
                        type="button"
                        onClick={() => void checkForUpdates()}
                        disabled={updateStatus?.state === 'checking' || updateStatus?.state === 'downloading'}
                        className="rounded-lg border border-black/10 dark:border-white/15 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                      >
                        Check now
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}

            {tab === 'tools' && (
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">Default working directory</label>
                  <div className="flex gap-2">
                    <input
                      value={draft.workingDirectory}
                      onChange={(e) => update({ workingDirectory: e.target.value })}
                      placeholder="Scopes the file tools — leave empty to be asked before each write"
                      className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                    />
                    <button
                      type="button"
                      onClick={pickWorkingDir}
                      className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      Browse…
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    Relative paths resolve here, and the file tools cannot read or write outside
                    it. Leave empty for unrestricted paths — each write is then confirmed.
                  </p>
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium">Enabled tools</div>
                  <div className="space-y-1.5">
                    {(Object.keys(TOOL_LABELS) as (keyof ToolToggles)[]).map((key) => (
                      <label
                        key={key}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        <input
                          type="checkbox"
                          checked={draft.tools[key]}
                          onChange={(e) =>
                            update({ tools: { ...draft.tools, [key]: e.target.checked } })
                          }
                          className="accent-accent"
                        />
                        {TOOL_LABELS[key]}
                        <code className="ml-auto text-xs text-neutral-400">{key}</code>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {tab === 'search' && (
              <div className="space-y-5">
                <p className="rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-neutral-500">
                  Web search is the only feature that sends your words off this machine — and only
                  the query itself, only to the provider you choose below, only when the{' '}
                  <code>web_search</code> / <code>fetch_webpage</code> tools are enabled. Obvious
                  personal data and secrets are redacted from queries before they are sent, and
                  every request appears in the Privacy tab&apos;s activity log.
                </p>

                <div>
                  <label className="mb-1 block text-sm font-medium">Search provider</label>
                  <div className="space-y-1.5">
                    {(
                      [
                        {
                          id: 'searxng',
                          label: 'Self-hosted SearXNG (most private)',
                          hint: 'Metasearch over 70+ engines from a server you run. No keys, no tracking.'
                        },
                        {
                          id: 'brave',
                          label: 'Brave Search API',
                          hint: 'Independent index, no user profiling. Requires a free API key.'
                        },
                        {
                          id: 'duckduckgo',
                          label: 'DuckDuckGo',
                          hint: 'No key needed, no tracking. Rate-limited; best for light use.'
                        }
                      ] as const
                    ).map((p) => (
                      <label
                        key={p.id}
                        className={`block cursor-pointer rounded-lg border px-3 py-2 ${
                          draft.search.provider === p.id
                            ? 'border-accent/50 bg-accent/10'
                            : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5'
                        }`}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <input
                            type="radio"
                            name="search-provider"
                            checked={draft.search.provider === p.id}
                            onChange={() =>
                              update({ search: { ...draft.search, provider: p.id } })
                            }
                            className="accent-accent"
                          />
                          {p.label}
                        </span>
                        <span className="mt-0.5 block pl-6 text-xs text-neutral-500">{p.hint}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {draft.search.provider === 'searxng' && (
                  <div>
                    <label className="mb-1 block text-sm font-medium">SearXNG instance URL</label>
                    <input
                      value={draft.search.searxngUrl}
                      onChange={(e) =>
                        update({ search: { ...draft.search, searxngUrl: e.target.value } })
                      }
                      placeholder="http://127.0.0.1:8888"
                      className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                    />
                    <p className="mt-1 text-xs text-neutral-500">
                      Run one with <code>docker run -p 8888:8080 searxng/searxng</code> and enable
                      JSON output (<code>formats: [html, json]</code>). A loopback instance means
                      only infrastructure you control ever sees your queries.
                    </p>
                  </div>
                )}

                {draft.search.provider === 'brave' && (
                  <div>
                    <label className="mb-1 block text-sm font-medium">Brave Search API key</label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={braveKeyInput}
                        onChange={(e) => setBraveKeyInput(e.target.value)}
                        placeholder={
                          braveKeyInfo?.set
                            ? `Key saved${braveKeyInfo.encrypted ? ' (OS-keychain encrypted)' : ''} — enter a new one to replace`
                            : 'Get a free key at brave.com/search/api'
                        }
                        className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                      />
                      <button
                        type="button"
                        disabled={!braveKeyInput.trim()}
                        onClick={() =>
                          void window.api.setBraveApiKey(braveKeyInput).then((res) => {
                            setBraveKeyInput('')
                            setBraveKeyNotice(res.warning ?? (res.ok ? 'API key saved.' : 'Failed.'))
                            void window.api.braveKeyStatus().then(setBraveKeyInfo)
                          })
                        }
                        className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                      >
                        Save key
                      </button>
                      {braveKeyInfo?.set && (
                        <button
                          type="button"
                          onClick={() =>
                            void window.api.setBraveApiKey('').then(() => {
                              setBraveKeyNotice('API key removed.')
                              void window.api.braveKeyStatus().then(setBraveKeyInfo)
                            })
                          }
                          className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm text-red-500 hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    {braveKeyNotice && (
                      <p className="mt-1 text-xs text-neutral-500">{braveKeyNotice}</p>
                    )}
                    <p className="mt-1 text-xs text-neutral-500">
                      Stored via your OS keychain (Electron safeStorage) — never in the settings
                      file the UI can read back.
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Results per search: {draft.search.maxResults}
                    </label>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={draft.search.maxResults}
                      onChange={(e) =>
                        update({ search: { ...draft.search, maxResults: Number(e.target.value) } })
                      }
                      className="w-full accent-accent"
                    />
                  </div>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.search.confirmBeforeSearch}
                      onChange={(e) =>
                        update({
                          search: { ...draft.search, confirmBeforeSearch: e.target.checked }
                        })
                      }
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Confirm every query
                      <span className="block text-xs text-neutral-500">
                        Show the exact outgoing query for approval before each search.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.search.useHeadlessRenderer}
                      onChange={(e) =>
                        update({
                          search: { ...draft.search, useHeadlessRenderer: e.target.checked }
                        })
                      }
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Read JavaScript-dependent pages
                      <span className="block text-xs text-neutral-500">
                        When a page returns no readable text (documentation sites, single-page apps),
                        re-read it in an offscreen browser. Only the page&apos;s own origin is
                        contacted — every third-party request is blocked and logged — and the session
                        keeps no cookies, cache or storage. Off by default, because unlike a plain
                        fetch this runs the page&apos;s scripts.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="flex items-center gap-3 border-t border-black/10 dark:border-white/10 pt-4">
                  <button
                    type="button"
                    disabled={searchTesting}
                    onClick={async () => {
                      // Test uses the saved provider; save first so the test matches the draft.
                      await window.api.setSettings(draft)
                      setSettings(draft)
                      setSearchTesting(true)
                      setSearchTest(null)
                      try {
                        setSearchTest(await window.api.testSearchProvider())
                      } finally {
                        setSearchTesting(false)
                      }
                    }}
                    className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                  >
                    {searchTesting ? 'Testing…' : 'Test connection'}
                  </button>
                  {searchTest && (
                    <span
                      className={`text-xs ${searchTest.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}
                    >
                      {searchTest.detail}
                    </span>
                  )}
                </div>
              </div>
            )}

            {tab === 'privacy' && (
              <div className="space-y-5">
                <div>
                  <div className="text-sm font-medium">The privacy promise</div>
                  <p className="mt-1 text-sm text-neutral-500">
                    Sigma Oasis runs your models locally and stores everything on this machine.
                    The only outbound connections it can make are: your local LM Studio server, the
                    search provider you chose (only when search tools run), and GitHub — only if
                    you enable update checks below. Anything else is blocked by the egress
                    allowlist before it is sent.
                  </p>
                </div>

                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.updates.autoCheck}
                    onChange={(e) => update({ updates: { autoCheck: e.target.checked } })}
                    className="mt-0.5 h-4 w-4 accent-accent"
                  />
                  <span>
                    Automatically check for updates
                    <span className="block text-xs text-neutral-500">
                      Contacts GitHub Releases periodically. Off by default — the manual
                      &quot;Check now&quot; button (General tab) always works.
                    </span>
                  </span>
                </label>

                <div className="border-t border-black/10 dark:border-white/10 pt-4">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium">Pages read this session</div>
                    <button
                      type="button"
                      onClick={() => void window.api.researchIndexStats().then(setResearchStats)}
                      className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void window.api
                          .clearResearchIndex()
                          .then(() => window.api.researchIndexStats())
                          .then(setResearchStats)
                      }
                      className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs text-red-500 hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      Forget
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    When a model reads a web page, the text is held in memory and split into
                    passages so only the relevant parts are shown to it. This is{' '}
                    <strong>never written to disk</strong> and is discarded when you quit — it is
                    not part of your long-term memory unless you explicitly save it. Keeping it
                    means re-reading a page you already fetched costs no new network request.
                  </p>
                  {researchStats === null ||
                  (researchStats.pages === 0 && researchStats.searchQueries === 0) ? (
                    <p className="mt-3 rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-neutral-500">
                      Nothing held in memory.
                    </p>
                  ) : (
                    <p className="mt-3 rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-neutral-500">
                      <strong className="text-neutral-700 dark:text-neutral-300">
                        {researchStats.pages}
                      </strong>{' '}
                      page{researchStats.pages === 1 ? '' : 's'} ·{' '}
                      <strong className="text-neutral-700 dark:text-neutral-300">
                        {researchStats.chunks}
                      </strong>{' '}
                      passages ({researchStats.embeddedChunks} embedded) ·{' '}
                      {Math.round(researchStats.chars / 1024)} KB of text ·{' '}
                      <strong className="text-neutral-700 dark:text-neutral-300">
                        {researchStats.searchQueries}
                      </strong>{' '}
                      cached search{researchStats.searchQueries === 1 ? '' : 'es'}. In RAM only.
                    </p>
                  )}
                </div>

                <div className="border-t border-black/10 dark:border-white/10 pt-4">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium">Network activity</div>
                    <button
                      type="button"
                      onClick={() => void window.api.getNetworkActivity().then(setNetActivity)}
                      className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void window.api.clearNetworkActivity().then(() => setNetActivity([]))
                      }
                      className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs text-red-500 hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      Clear
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    Every request the app makes, newest first. Only origins are recorded — never
                    full URLs, so your queries stay private even here.
                  </p>
                  {netActivity.length === 0 ? (
                    <p className="mt-3 rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-neutral-500">
                      No network activity yet this session. With search disabled, this list should
                      show nothing but your local LM Studio server.
                    </p>
                  ) : (
                    <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto">
                      {netActivity.map((a, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-2 rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs"
                        >
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              a.blocked ? 'bg-red-500' : a.ok ? 'bg-green-500' : 'bg-amber-500'
                            }`}
                            title={a.blocked ? 'Blocked by egress policy' : a.ok ? 'OK' : 'Failed'}
                          />
                          <span className="shrink-0 rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.5 font-mono">
                            {a.purpose}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono" title={a.origin}>
                            {a.origin}
                          </span>
                          <span className="shrink-0 text-neutral-400">
                            {a.blocked ? 'blocked' : (a.status ?? a.error?.slice(0, 30) ?? '—')}
                          </span>
                          <span className="shrink-0 text-neutral-400">
                            {new Date(a.at).toLocaleTimeString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {tab === 'voice' && (
              <div className="space-y-6">
                {/* ---- Text-to-speech ---- */}
                <div className="space-y-4">
                  <div className="text-sm font-medium">Text-to-speech</div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.voice.autoRead}
                      onChange={(e) =>
                        update({ voice: { ...draft.voice, autoRead: e.target.checked } })
                      }
                      className="accent-accent"
                    />
                    Voice mode — automatically read replies aloud
                  </label>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">Voice</label>
                    <select
                      value={draft.voice.voiceURI}
                      onChange={(e) => update({ voice: { ...draft.voice, voiceURI: e.target.value } })}
                      className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                    >
                      <option value="">System default</option>
                      {voices.map((v) => (
                        <option key={v.voiceURI} value={v.voiceURI}>
                          {v.name} ({v.lang})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">
                      Speed: {draft.voice.rate.toFixed(1)}×
                    </label>
                    <input
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.1}
                      value={draft.voice.rate}
                      onChange={(e) =>
                        update({ voice: { ...draft.voice, rate: Number(e.target.value) } })
                      }
                      className="w-64 accent-accent"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      speak(
                        'Hello! This is how Sigma Oasis will sound when reading replies aloud.',
                        draft.voice.voiceURI,
                        draft.voice.rate
                      )
                    }
                    className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    🔊 Test voice
                  </button>
                  <p className="text-xs text-neutral-500">
                    Uses your operating system&apos;s built-in voices — fully on-device.
                  </p>
                </div>

                {/* ---- Speech-to-text ---- */}
                <div className="space-y-4 border-t border-black/10 dark:border-white/10 pt-4">
                  <div className="text-sm font-medium">Speech-to-text (push-to-talk 🎙️)</div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        sttStatus?.available ? 'bg-green-500' : 'bg-red-500'
                      }`}
                    />
                    <span className="text-sm">
                      {sttStatus === null
                        ? 'Checking…'
                        : sttStatus.available
                          ? 'Ready — transcription runs locally via whisper.cpp'
                          : 'Not set up'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void window.api.getSttStatus().then(setSttStatus)}
                      className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      Re-check
                    </button>
                  </div>
                  {sttStatus && !sttStatus.available && (
                    <p className="rounded-lg bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                      {sttStatus.reason}
                      <br />
                      Then download a model (e.g.{' '}
                      <code>ggml-base.en.bin</code> from the whisper.cpp releases) and point to it
                      below.
                    </p>
                  )}
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">
                      whisper-cli path (empty = auto-detect)
                    </label>
                    <div className="flex gap-2">
                      <input
                        value={draft.stt.whisperCliPath}
                        onChange={(e) =>
                          update({ stt: { ...draft.stt, whisperCliPath: e.target.value } })
                        }
                        placeholder="/opt/homebrew/bin/whisper-cli"
                        className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void window.api.pickFile().then((p) => {
                            if (p) update({ stt: { ...draft.stt, whisperCliPath: p } })
                          })
                        }
                        className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        Browse…
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-500">
                      Model file (.bin, empty = auto-detect in ~/.cache/whisper)
                    </label>
                    <div className="flex gap-2">
                      <input
                        value={draft.stt.whisperModelPath}
                        onChange={(e) =>
                          update({ stt: { ...draft.stt, whisperModelPath: e.target.value } })
                        }
                        placeholder="~/.cache/whisper/ggml-base.en.bin"
                        className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void window.api
                            .pickFile([{ name: 'Whisper model', extensions: ['bin'] }])
                            .then((p) => {
                              if (p) update({ stt: { ...draft.stt, whisperModelPath: p } })
                            })
                        }
                        className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        Browse…
                      </button>
                    </div>
                  </div>
                  {sttStatus?.available && (
                    <p className="rounded-lg bg-black/5 dark:bg-white/5 p-3 font-mono text-xs text-neutral-500">
                      cli: {sttStatus.cliPath}
                      <br />
                      model: {sttStatus.modelPath}
                    </p>
                  )}
                </div>
              </div>
            )}

            {tab === 'memory' && (
              <div className="space-y-5">
                {/* Status */}
                <div className="flex items-center gap-3">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      memoryStats?.available ? 'bg-green-500' : 'bg-red-500'
                    }`}
                  />
                  <span className="text-sm">
                    {memoryStats === null
                      ? 'Checking…'
                      : memoryStats.available
                        ? `Ready — ${memoryStats.totalChunks} chunk(s) indexed`
                        : 'No embedding model detected'}
                  </span>
                  <button
                    type="button"
                    onClick={() => void window.api.memoryStats().then(setMemoryStats)}
                    className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    Refresh
                  </button>
                </div>
                {memoryStats && !memoryStats.available && (
                  <p className="rounded-lg bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                    {memoryStats.reason}
                  </p>
                )}
                {memoryStats?.mixedModels && (
                  <p className="rounded-lg bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                    Some sources were indexed with a different embedding model and can&apos;t be
                    searched by the current one. Remove and re-add them below, or switch back to the
                    model that indexed them.
                  </p>
                )}

                {/* Behavior */}
                <div className="space-y-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.memory.autoContext}
                      onChange={(e) =>
                        update({ memory: { ...draft.memory, autoContext: e.target.checked } })
                      }
                      className="accent-accent"
                    />
                    Automatically recall relevant memories in every conversation
                  </label>
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Memories to recall per turn: {draft.memory.topK}
                    </label>
                    <input
                      type="range"
                      min={1}
                      max={8}
                      value={draft.memory.topK}
                      onChange={(e) =>
                        update({ memory: { ...draft.memory, topK: Number(e.target.value) } })
                      }
                      className="w-64 accent-accent"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Embedding model</label>
                    <input
                      value={draft.memory.embeddingModel}
                      onChange={(e) =>
                        update({ memory: { ...draft.memory, embeddingModel: e.target.value } })
                      }
                      placeholder={
                        memoryStats?.embeddingModel ??
                        'auto-detect (first loaded model containing "embed")'
                      }
                      className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                    />
                    <p className="mt-1 text-xs text-neutral-500">
                      Leave empty to auto-detect from LM Studio. Currently resolved:{' '}
                      <code>{memoryStats?.embeddingModel ?? '—'}</code>
                    </p>
                  </div>
                </div>

                {/* Knowledge base */}
                <div className="space-y-3 border-t border-black/10 dark:border-white/10 pt-4">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium">Knowledge base</div>
                    <button
                      type="button"
                      onClick={() =>
                        void window.api
                          .pickFile()
                          .then(async (p) => {
                            if (!p) return
                            setMemoryNotice('Indexing…')
                            const res = await window.api.memoryAddDocumentFromPath(p)
                            setMemoryNotice(
                              res.ok
                                ? `Indexed "${res.name}" (${res.chunks} chunk(s)${res.truncated ? ', truncated' : ''}).`
                                : (res.error ?? 'Indexing failed.')
                            )
                            void window.api.memoryStats().then(setMemoryStats)
                          })
                      }
                      className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      + Add document
                    </button>
                  </div>
                  {memoryNotice && <p className="text-xs text-neutral-500">{memoryNotice}</p>}
                  {(memoryStats?.sources.length ?? 0) === 0 ? (
                    <p className="text-xs text-neutral-500">
                      Nothing indexed yet. Notes created by models are indexed automatically;
                      models can also save memories with the <code>memory_save</code> tool.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {memoryStats!.sources.map((s) => (
                        <li
                          key={s.source}
                          className="flex items-center gap-2 rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm"
                        >
                          <span className="min-w-0 flex-1 truncate" title={s.source}>
                            {s.source}
                          </span>
                          <span className="shrink-0 text-xs text-neutral-400">
                            {s.chunks} chunk(s)
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              void window.api.memoryDeleteSource(s.source).then(() => {
                                void window.api.memoryStats().then(setMemoryStats)
                              })
                            }
                            className="shrink-0 rounded px-1.5 text-neutral-400 hover:text-red-500"
                            title="Remove from memory"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-black/10 dark:border-white/10 px-5 py-3">
          <button
            type="button"
            onClick={reset}
            className="text-sm text-neutral-500 hover:text-red-500"
          >
            Reset to defaults
          </button>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-black/10 dark:border-white/10 px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
