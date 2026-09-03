import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useModels } from '../hooks/useModels'
import { useUpdates } from '../hooks/useUpdates'
import { modalClasses, useModalPresence } from '../hooks/useModalPresence'
import { CollaborativeMode } from './CollaborativeMode'
import { ACCENT_KEYS, ACCENT } from '../lib/colors'
import { describeModel, describeEvalScore, modelLabel } from '../lib/modelInfo'
import { runToolChoiceEval, parseCompletionMessage } from '../lib/evalRunner'
import { withGrounding, withToolCallPreamble } from '../lib/grounding'
import { LibraryTab } from './settings/LibraryTab'
import { McpTab } from './settings/McpTab'
import { JobsTab } from './settings/JobsTab'
import { describeProfile, profileFor } from '../lib/modelProfiles'
import type { ApiMessage, ApiToolCall } from '../lib/agentLoop'
import type { ToolSchema } from '../types'
import {
  LENGTH_PRESETS,
  TEMPERATURE_PRESETS,
  activeLengthPreset,
  activePreset,
  recommendedSampling
} from '../lib/sampling'
import type {
  AppSettings,
  AccentColor,
  AuditStatus,
  EvalScoreSummary,
  ModelConfig,
  ToolToggles,
  SttStatus,
  MemoryStats,
  NetworkActivityEntry,
  ResearchIndexStats,
  SamplingSettings,
  WorkbenchStatus
} from '../types'
import { speak } from '../lib/voice'

// Labels derive from the tool table (each ToolMeta's `label`), listed in wire
// order — so the Settings list and the model's tool list agree on membership
// by construction. (One visible change from the hand-kept map: finance_calculator
// now sits with the other calculators instead of after analyze_file.)
import { TOOL_LABELS } from '../../../shared/tools'
import { ConnectionTab } from './settings/ConnectionTab'
import { GeneralTab } from './settings/GeneralTab'
import { MemoryTab } from './settings/MemoryTab'
import { ModelsTab } from './settings/ModelsTab'
import { PrivacyTab } from './settings/PrivacyTab'
import { SearchTab } from './settings/SearchTab'
import { ToolsTab } from './settings/ToolsTab'
import { VoiceTab } from './settings/VoiceTab'
import { EvalScoreLine, ProfileLine, isLoopbackUrl } from './settings/helpers'

type Tab = 'connection' | 'models' | 'pipeline' | 'general' | 'tools' | 'search' | 'privacy' | 'voice' | 'memory' | 'library' | 'mcp' | 'jobs'

export function SettingsModal(): JSX.Element | null {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  // `attemptClose` is defined further down (it needs the draft), so Escape is
  // routed through a holder rather than reordering the component around it.
  const dismiss = useRef<() => void>(() => {})
  const { mounted, leaving, surfaceRef, dialogProps } = useModalPresence(open, {
    onDismiss: () => dismiss.current()
  })
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
  const [evalScores, setEvalScores] = useState<EvalScoreSummary[]>([])
  const [workbench, setWorkbench] = useState<WorkbenchStatus | null>(null)
  const [warming, setWarming] = useState(false)
  const [evalRun, setEvalRun] = useState<{
    model: string
    modelIndex: number
    modelCount: number
    fixtureIndex: number
    fixtureCount: number
    last: string
  } | null>(null)
  const [evalNotice, setEvalNotice] = useState<string | null>(null)
  const evalCancelRef = useRef(false)
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null)
  const [researchStats, setResearchStats] = useState<ResearchIndexStats | null>(null)
  const [searchTest, setSearchTest] = useState<{ ok: boolean; detail: string } | null>(null)
  const [searchTesting, setSearchTesting] = useState(false)
  const [proxyTest, setProxyTest] = useState<{ ok: boolean; detail: string } | null>(null)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [braveKeyInput, setBraveKeyInput] = useState('')
  const [braveKeyInfo, setBraveKeyInfo] = useState<{ set: boolean; encrypted: boolean } | null>(null)
  const [braveKeyNotice, setBraveKeyNotice] = useState<string | null>(null)
  const [netActivity, setNetActivity] = useState<NetworkActivityEntry[]>([])
  const [auditInfo, setAuditInfo] = useState<AuditStatus | null>(null)
  const [auditNotice, setAuditNotice] = useState<string | null>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)

  useEffect(() => {
    if (open) setDraft(settings)
  }, [open, settings])

  // Live appearance preview: theme and font size follow the draft while the
  // modal is open, so Save is never a leap of faith. Closing without saving
  // reverts to the saved values (see attemptClose).
  useEffect(() => {
    if (!open || !draft) return
    document.documentElement.classList.toggle('dark', draft.theme === 'dark')
    document.documentElement.style.fontSize = `${draft.fontSize}px`
  }, [open, draft, draft?.theme, draft?.fontSize])

  const dirty = Boolean(draft && settings && JSON.stringify(draft) !== JSON.stringify(settings))

  /** Restore the saved appearance after a preview that was not saved. */
  const revertAppearance = (): void => {
    if (!settings) return
    document.documentElement.classList.toggle('dark', settings.theme === 'dark')
    document.documentElement.style.fontSize = `${settings.fontSize}px`
  }

  /** Closing discards the draft; guard that when there is something to lose. */
  const attemptClose = (): void => {
    if (dirty && !window.confirm('You have unsaved changes. Discard them?')) return
    revertAppearance()
    setConfirmingReset(false)
    setOpen(false)
  }
  dismiss.current = attemptClose

  // Load available TTS voices and STT status when the Voice tab opens.
  useEffect(() => {
    if (tab !== 'voice') return
    const loadVoices = (): void => setVoices(window.speechSynthesis?.getVoices() ?? [])
    loadVoices()
    window.speechSynthesis?.addEventListener('voiceschanged', loadVoices)
    void window.api.getSttStatus().then(setSttStatus)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices)
  }, [tab])

  // v1.17.2: a remedy control asked for a specific tab. Honour it once, then
  // clear it, so the next manual open lands where the reader left off.
  const requestedTab = useAppStore((s) => s.settingsTab)
  const clearSettingsTab = useAppStore((s) => s.clearSettingsTab)
  useEffect(() => {
    if (!requestedTab) return
    setTab(requestedTab)
    clearSettingsTab()
  }, [requestedTab, clearSettingsTab])

  // Load memory stats when the Memory tab opens.
  useEffect(() => {
    if (tab === 'memory') void window.api.memoryStats().then(setMemoryStats)
  }, [tab])

  // Load measured tool-choice scores when the Models tab opens (Layer 0c).
  useEffect(() => {
    if (tab === 'models') void window.api.evalScores().then(setEvalScores).catch(() => {})
    if (tab === 'tools') void window.api.workbenchStatus().then(setWorkbench).catch(() => setWorkbench(null))
  }, [tab])

  // Load Brave key status when the Search tab opens; reset transient UI state.
  useEffect(() => {
    if (tab !== 'search') return
    void window.api.braveKeyStatus().then(setBraveKeyInfo)
    setSearchTest(null)
    setBraveKeyNotice(null)
    setBraveKeyInput('')
  }, [tab])

  // Load the network activity log and audit-log status when the Privacy tab opens.
  useEffect(() => {
    if (tab === 'privacy') {
      void window.api.getNetworkActivity().then(setNetActivity)
      void window.api.researchIndexStats().then(setResearchStats)
      void window.api.auditStatus().then(setAuditInfo)
      setAuditNotice(null)
    }
  }, [tab])

  // `draft` is local state and outlives `open`, so the panel still has
  // something to render while it animates out.
  if (!mounted || !draft) return null

  const update = (partial: Partial<AppSettings>): void =>
    setDraft((d) => (d ? { ...d, ...partial } : d))

  /**
   * Layer 0c: run the tool-choice eval against every loaded model, from the
   * Models tab. The shared runner (lib/evalRunner.ts) is the same code the
   * CLI shells; here the transport is a loopback fetch and progress renders
   * under the button. A cancelled run still saves what it measured.
   */
  const runEval = async (): Promise<void> => {
    if (!draft || evalRun) return
    const models = availableModels.filter((m) => m.loaded).map((m) => m.id)
    if (models.length === 0) {
      setEvalNotice('No loaded models to evaluate — load one in LM Studio first.')
      return
    }
    setEvalNotice(null)
    evalCancelRef.current = false

    let fixtures, tools
    try {
      ;({ fixtures, tools } = await window.api.evalFixtures())
    } catch (err) {
      setEvalNotice(`Could not load eval fixtures: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (fixtures.length === 0) {
      setEvalNotice('Eval fixtures are unavailable in this build (they live in the dev checkout).')
      return
    }

    const baseUrl = draft.baseUrl
    const complete = async (
      model: string,
      messages: ApiMessage[],
      wireTools: ToolSchema[]
    ): Promise<{ content: string; toolCalls: ApiToolCall[] }> => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(240_000),
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          temperature: 0,
          ...(wireTools.length > 0 ? { tools: wireTools, tool_choice: 'auto' } : {})
        })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as {
        choices?: {
          message?: {
            content?: string | null
            tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[]
          }
        }[]
      }
      return parseCompletionMessage(
        json.choices?.[0]?.message ?? {},
        wireTools.map((t) => t.function.name)
      )
    }

    try {
      const results = await runToolChoiceEval({
        models,
        fixtures,
        tools,
        systemPromptFor: (model) =>
          withToolCallPreamble(withGrounding('You are a helpful local assistant.'), model),
        complete,
        onFixture: (model, index, total, run) => {
          const mark = run.error ? '!' : run.correct === false || run.spurious === true || run.looped ? '✗' : '✓'
          setEvalRun({
            model,
            modelIndex: models.indexOf(model) + 1,
            modelCount: models.length,
            fixtureIndex: index,
            fixtureCount: total,
            last: `${mark} ${run.file}`
          })
        },
        shouldStop: () => evalCancelRef.current
      })

      for (const { model, runs, rates } of results) {
        await window.api.saveEvalResult({
          model,
          baseUrl,
          ranAt: new Date().toISOString(),
          caveats: ['tool results canned stubs', 'temperature 0', 'run in-app'],
          scores: {
            correctTool: rates.correctTool,
            spuriousCall: rates.spuriousCall,
            argValidity: rates.argValidity,
            loop: rates.loop
          },
          runs
        })
      }
      const summary = results
        .map((r) => `${r.model}: ${r.rates.correctTool.hit}/${r.rates.correctTool.of}`)
        .join(' · ')
      setEvalNotice(
        (evalCancelRef.current ? 'Cancelled — partial results saved. ' : 'Done. ') + summary
      )
      void window.api.evalScores().then(setEvalScores).catch(() => {})
    } catch (err) {
      setEvalNotice(`Eval failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setEvalRun(null)
    }
  }

  const updateModel = (id: string, partial: Partial<AppSettings['models'][number]>): void =>
    setDraft((d) =>
      d
        ? { ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...partial } : m)) }
        : d
    )

  /** Sampling is nested, so it needs its own merge rather than updateModel's spread. */
  const updateSampling = (id: string, partial: Partial<SamplingSettings>): void =>
    setDraft((d) =>
      d
        ? {
            ...d,
            models: d.models.map((m) =>
              m.id === id ? { ...m, sampling: { ...m.sampling, ...partial } } : m
            )
          }
        : d
    )

  const save = async (): Promise<void> => {
    await window.api.setSettings(draft)
    setSettings(draft)
    setOpen(false)
    refresh()
  }

  const reset = async (): Promise<void> => {
    // Two-step: the first click arms, the second wipes. A stray click used to
    // erase every model slot, prompt and provider config with no recourse.
    if (!confirmingReset) {
      setConfirmingReset(true)
      window.setTimeout(() => setConfirmingReset(false), 4000)
      return
    }
    setConfirmingReset(false)
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
    { key: 'memory', label: 'Memory' },
    { key: 'library', label: 'Library' },
    { key: 'mcp', label: 'MCP' },
    { key: 'jobs', label: 'Jobs' }
  ]

  return (
    <div
      ref={surfaceRef}
      className={`${modalClasses(leaving).backdrop} fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4`}
      onClick={attemptClose}
    >
      <div
        {...dialogProps}
        aria-labelledby="settings-modal-title"
        className={`${modalClasses(leaving).panel} flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-panel-light dark:bg-panel-dark shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-black/10 dark:border-white/10 px-5 py-3">
          <h2 id="settings-modal-title" className="text-lg font-semibold">Settings</h2>
          <button
            type="button"
            onClick={attemptClose}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-black/5 dark:hover:bg-white/10"
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
                className={`mb-0.5 block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  tab === t.key
                    ? 'bg-accent/15 text-accent font-medium'
                    : 'hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/*
            Tab content. Keyed on the tab so the body remounts and fades up
            (.tab-face) rather than being swapped under the cursor — and so
            each tab opens at its own top, instead of inheriting however far
            down the previous one was scrolled.
          */}
          <div key={tab} className="tab-face min-h-0 flex-1 overflow-y-auto p-5">
            {tab === 'connection' && <ConnectionTab availableModels={availableModels} connection={connection} draft={draft} refresh={refresh} update={update} />}

            {tab === 'models' && <ModelsTab availableModels={availableModels} draft={draft} evalCancelRef={evalCancelRef} evalNotice={evalNotice} evalRun={evalRun} evalScores={evalScores} runEval={runEval} update={update} updateModel={updateModel} updateSampling={updateSampling} />}

            {tab === 'pipeline' && (
              <CollaborativeMode settings={draft} onChange={(pipeline) => update({ pipeline })} />
            )}

            {tab === 'general' && <GeneralTab checkForUpdates={checkForUpdates} draft={draft} installUpdate={installUpdate} update={update} updateStatus={updateStatus} />}

            {tab === 'tools' && <ToolsTab draft={draft} pickWorkingDir={pickWorkingDir} setWarming={setWarming} setWorkbench={setWorkbench} update={update} warming={warming} workbench={workbench} />}

            {tab === 'search' && <SearchTab braveKeyInfo={braveKeyInfo} braveKeyInput={braveKeyInput} braveKeyNotice={braveKeyNotice} draft={draft} searchTest={searchTest} searchTesting={searchTesting} setBraveKeyInfo={setBraveKeyInfo} setBraveKeyInput={setBraveKeyInput} setBraveKeyNotice={setBraveKeyNotice} setSearchTest={setSearchTest} setSearchTesting={setSearchTesting} setSettings={setSettings} update={update} />}

            {tab === 'privacy' && <PrivacyTab auditInfo={auditInfo} auditNotice={auditNotice} draft={draft} netActivity={netActivity} proxyTest={proxyTest} proxyTesting={proxyTesting} researchStats={researchStats} setAuditInfo={setAuditInfo} setAuditNotice={setAuditNotice} setNetActivity={setNetActivity} setProxyTest={setProxyTest} setProxyTesting={setProxyTesting} setResearchStats={setResearchStats} update={update} />}

            {tab === 'voice' && <VoiceTab draft={draft} setSttStatus={setSttStatus} sttStatus={sttStatus} update={update} voices={voices} />}

            {tab === 'library' && <LibraryTab />}
            {tab === 'mcp' && <McpTab />}
            {tab === 'jobs' && <JobsTab />}

            {tab === 'memory' && <MemoryTab draft={draft} memoryNotice={memoryNotice} memoryStats={memoryStats} setMemoryNotice={setMemoryNotice} setMemoryStats={setMemoryStats} update={update} />}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-black/10 dark:border-white/10 px-5 py-3">
          <button
            type="button"
            onClick={reset}
            className={`text-sm ${
              confirmingReset ? 'font-medium text-ink-danger' : 'text-ink-secondary hover:text-ink-danger'
            }`}
          >
            {confirmingReset ? 'Really reset everything? Click again to confirm' : 'Reset to defaults'}
          </button>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={attemptClose}
              className="rounded-lg border border-black/10 dark:border-white/10 px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
            >
              {dirty ? 'Save' : 'No changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
