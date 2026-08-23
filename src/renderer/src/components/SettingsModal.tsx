import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useModels } from '../hooks/useModels'
import { useUpdates } from '../hooks/useUpdates'
import { CollaborativeMode } from './CollaborativeMode'
import { ACCENT_KEYS, ACCENT } from '../lib/colors'
import { describeModel, describeEvalScore, modelLabel } from '../lib/modelInfo'
import { runToolChoiceEval, parseCompletionMessage } from '../lib/evalRunner'
import { withGrounding, withToolCallPreamble } from '../lib/grounding'
import { LibraryTab } from './settings/LibraryTab'
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

type Tab = 'connection' | 'models' | 'pipeline' | 'general' | 'tools' | 'search' | 'privacy' | 'voice' | 'memory' | 'library'

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

/**
 * Layer 0c: the model's measured tool-choice scores, shown under its picker.
 * Absent entirely for models never evaluated — no "untested" badge, because
 * the absence of a number is not a claim about the model.
 */
/**
 * v1.5.1: what the app knows about this model family — reasoning handling,
 * sampling recipe, tool-calling reliability (measured when the eval has run,
 * otherwise a stated prior). One line; details on hover.
 */
function ProfileLine({ modelId, scores }: { modelId: string; scores: EvalScoreSummary[] }): JSX.Element | null {
  if (!modelId) return null
  const profile = profileFor(modelId, scores.find((s) => s.model === modelId) ?? null)
  const line = describeProfile(profile)
  if (!line) return null
  const tip = [profile.toolCalling.detail, ...profile.notes].filter(Boolean).join('\n')
  return (
    <p className="mt-1 text-xs text-neutral-400" title={tip}>
      Profile: {line}
    </p>
  )
}

function EvalScoreLine({
  scores,
  modelId
}: {
  scores: EvalScoreSummary[]
  modelId: string
}): JSX.Element | null {
  const score = scores.find((s) => s.model === modelId)
  if (!score) return null
  const text = describeEvalScore(score)
  if (!text) return null
  return (
    <p
      className="mt-1 text-xs text-neutral-400"
      title={`Measured by the local tool-choice eval (npm run eval:tools) against canned tool results; newest run ${new Date(score.ranAt).toLocaleString()}.`}
    >
      Eval: {text} · {new Date(score.ranAt).toLocaleDateString()}
    </p>
  )
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

  if (!open || !draft) return null

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
    { key: 'library', label: 'Library' }
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={attemptClose}
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
            onClick={attemptClose}
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
                      Only servers on this machine are supported. This URL will not be saved —
                      Sigma Oasis reverts to the default. LM Studio traffic carries your
                      conversations in plaintext and is deliberately never proxied, so a
                      non-loopback address would send them off-machine unprotected.
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
                          {describeModel(m) && (
                            <span className="ml-2 font-sans text-neutral-500">
                              {describeModel(m)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {tab === 'models' && (
              <div className="space-y-5">
                <div className="rounded-xl border border-black/10 dark:border-white/10 p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <div className="text-sm font-medium">Tool-choice eval</div>
                      <p className="mt-0.5 text-xs text-neutral-400">
                        Measures whether each loaded model calls the right tool, against canned
                        results (the same harness as <code>npm run eval:tools</code>). Scores appear
                        under each model picker. A big model can take minutes per fixture.
                      </p>
                    </div>
                    {evalRun ? (
                      <button
                        type="button"
                        onClick={() => {
                          evalCancelRef.current = true
                        }}
                        className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void runEval()}
                        className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        Run eval
                      </button>
                    )}
                  </div>
                  {evalRun && (
                    <p className="mt-2 text-xs text-neutral-500">
                      Model {evalRun.modelIndex}/{evalRun.modelCount} ({evalRun.model}) — fixture{' '}
                      {evalRun.fixtureIndex}/{evalRun.fixtureCount}{' '}
                      <span className="font-mono">{evalRun.last}</span>
                    </p>
                  )}
                  {evalNotice && !evalRun && (
                    <p className="mt-2 text-xs text-neutral-500">{evalNotice}</p>
                  )}
                </div>

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
                              {modelLabel(am)}
                            </option>
                          ))}
                          {/* Keep a stale selection visible even if offline */}
                          {m.modelId && !availableModels.some((am) => am.id === m.modelId) && (
                            <option value={m.modelId}>{m.modelId} (not loaded)</option>
                          )}
                        </select>
                        <ProfileLine modelId={m.modelId} scores={evalScores} />
                        <EvalScoreLine scores={evalScores} modelId={m.modelId} />
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
                        Context window override (tokens)
                      </label>
                      <input
                        type="number"
                        min={512}
                        step={1024}
                        value={m.contextWindow ?? ''}
                        placeholder="auto — use what LM Studio reports"
                        onChange={(e) =>
                          updateModel(m.id, {
                            contextWindow: e.target.value === '' ? null : Number(e.target.value)
                          })
                        }
                        className="w-64 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                      />
                      <p className="mt-1 text-xs text-neutral-400">
                        History compaction and the context meter budget against this number. Leave
                        empty to trust LM Studio; set it when the server under-reports the window
                        or you loaded the model with a larger one.
                      </p>
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

                    <div className="mt-3 flex flex-wrap items-end gap-4">
                      <div className="min-w-64 flex-1">
                        <label className="mb-1 block text-xs font-medium text-neutral-500">
                          Capability
                        </label>
                        <input
                          type="text"
                          value={m.capability ?? ''}
                          placeholder="send me: …; don't send me: …"
                          onChange={(e) =>
                            updateModel(m.id, { capability: e.target.value || undefined })
                          }
                          className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-neutral-500">
                          Specialty
                        </label>
                        <select
                          value={m.specialty ?? ''}
                          onChange={(e) =>
                            updateModel(m.id, {
                              specialty: (e.target.value || undefined) as ModelConfig['specialty']
                            })
                          }
                          className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                        >
                          <option value="">General</option>
                          <option value="coding">Coding</option>
                          <option value="research">Research</option>
                          <option value="finance">Finance</option>
                          <option value="data">Data analysis</option>
                        </select>
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-neutral-400">
                      How other models and the pre-flight router decide what to send this role.
                      Capability is the one-line declaration shown in the consult roster; Specialty
                      is what the router matches on (code → Coding, finance questions → Finance,
                      factual questions → Research). Leave Specialty at General to opt out of
                      auto-routing.
                    </p>

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

                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-neutral-500">
                        Tools
                        <span className="ml-1 font-normal text-neutral-400">
                          {m.tools
                            ? `${m.tools.filter((t) => draft.tools[t as keyof ToolToggles]).length} of ${(Object.keys(TOOL_LABELS) as (keyof ToolToggles)[]).filter((k) => draft.tools[k]).length} enabled`
                            : 'all enabled tools'}
                        </span>
                      </summary>
                      <div className="mt-2">
                        {m.tools === undefined ? (
                          <div className="flex items-center gap-3">
                            <p className="flex-1 text-xs text-neutral-400">
                              This role holds every tool enabled under Settings → Tools. Restrict
                              it when a smaller, focused list would help the model choose — or keep
                              a powerful tool out of the wrong hands.
                            </p>
                            <button
                              type="button"
                              onClick={() =>
                                updateModel(m.id, {
                                  tools: (Object.keys(TOOL_LABELS) as (keyof ToolToggles)[]).filter(
                                    (k) => draft.tools[k]
                                  )
                                })
                              }
                              className="shrink-0 rounded-lg border border-black/10 dark:border-white/10 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                            >
                              Restrict…
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="grid grid-cols-2 gap-x-3">
                              {(Object.keys(TOOL_LABELS) as (keyof ToolToggles)[])
                                .filter((k) => draft.tools[k])
                                .map((key) => (
                                  <label
                                    key={key}
                                    className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={(m.tools ?? []).includes(key)}
                                      onChange={(e) =>
                                        updateModel(m.id, {
                                          tools: e.target.checked
                                            ? [...(m.tools ?? []), key]
                                            : (m.tools ?? []).filter((t) => t !== key)
                                        })
                                      }
                                      className="accent-accent"
                                    />
                                    <code className="text-xs">{key}</code>
                                  </label>
                                ))}
                            </div>
                            <div className="mt-1.5 flex items-center gap-3">
                              <p className="flex-1 text-xs text-neutral-400">
                                {(m.tools.filter((t) => draft.tools[t as keyof ToolToggles])).length === 0
                                  ? 'This role holds no tools — it answers from its own knowledge only.'
                                  : 'Only checked tools reach this role. Tools disabled globally never do.'}
                              </p>
                              <button
                                type="button"
                                onClick={() => updateModel(m.id, { tools: undefined })}
                                className="shrink-0 rounded-lg border border-black/10 dark:border-white/10 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                              >
                                Allow all
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </details>

                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-neutral-500">
                        Sampling
                      </summary>
                      <div className="mt-2 grid grid-cols-4 gap-3">
                        <div className="col-span-4">
                          <div className="flex gap-1.5">
                            {TEMPERATURE_PRESETS.map((p) => (
                              <button
                                key={p.label}
                                type="button"
                                title={p.hint}
                                onClick={() => updateSampling(m.id, { temperature: p.value })}
                                className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                                  activePreset(m.sampling.temperature)?.value === p.value
                                    ? 'bg-accent/20 font-medium text-accent-ink'
                                    : 'bg-black/5 dark:bg-white/10 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                                }`}
                              >
                                {p.label} {p.value}
                              </button>
                            ))}
                            {/*
                              The family's own published recipe, applied only
                              on a click: it sets a warmer temperature than
                              this app's anti-confabulation default, and that
                              is the user's trade to make, not ours.
                            */}
                            {recommendedSampling(m.modelId) && (
                              <button
                                type="button"
                                title={`Temperature ${recommendedSampling(m.modelId)!.recipe.temperature}, top-p ${recommendedSampling(m.modelId)!.recipe.topP}, top-k ${recommendedSampling(m.modelId)!.recipe.topK} — as published for this model family. Warmer than the Factual preset.`}
                                onClick={() =>
                                  updateSampling(m.id, recommendedSampling(m.modelId)!.recipe)
                                }
                                className="rounded-full bg-black/5 dark:bg-white/10 px-2.5 py-1 text-xs text-neutral-500 transition-colors hover:text-neutral-700 dark:hover:text-neutral-300"
                              >
                                {recommendedSampling(m.modelId)!.label} defaults
                              </button>
                            )}
                          </div>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-neutral-500">Temperature</label>
                          <input
                            type="number"
                            min={0}
                            max={2}
                            step={0.1}
                            value={m.sampling.temperature}
                            onChange={(e) =>
                              updateSampling(m.id, { temperature: Number(e.target.value) })
                            }
                            className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-neutral-500">Top P</label>
                          <input
                            type="number"
                            min={0.01}
                            max={1}
                            step={0.05}
                            value={m.sampling.topP}
                            onChange={(e) => updateSampling(m.id, { topP: Number(e.target.value) })}
                            className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                          />
                        </div>
                        <div className="col-span-4">
                          <div className="mb-1 text-xs text-neutral-500">Reply length</div>
                          <div className="flex gap-1.5">
                            {LENGTH_PRESETS.map((p) => (
                              <button
                                key={p.label}
                                type="button"
                                title={p.hint}
                                onClick={() => updateSampling(m.id, { maxTokens: p.value })}
                                className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                                  activeLengthPreset(m.sampling.maxTokens)?.value === p.value
                                    ? 'bg-accent/20 font-medium text-accent-ink'
                                    : 'bg-black/5 dark:bg-white/10 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                                }`}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-neutral-500">Max tokens</label>
                          <input
                            type="number"
                            min={-1}
                            step={128}
                            value={m.sampling.maxTokens}
                            onChange={(e) =>
                              updateSampling(m.id, { maxTokens: Number(e.target.value) })
                            }
                            className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-neutral-500">Top K</label>
                          <input
                            type="number"
                            min={-1}
                            max={500}
                            step={1}
                            value={m.sampling.topK}
                            onChange={(e) => updateSampling(m.id, { topK: Number(e.target.value) })}
                            className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-neutral-500">Min P</label>
                          <input
                            type="number"
                            min={-1}
                            max={1}
                            step={0.01}
                            value={m.sampling.minP}
                            onChange={(e) => updateSampling(m.id, { minP: Number(e.target.value) })}
                            className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-neutral-500">Seed</label>
                          <input
                            type="number"
                            placeholder="random"
                            value={m.sampling.seed ?? ''}
                            onChange={(e) =>
                              updateSampling(m.id, {
                                seed: e.target.value === '' ? null : Number(e.target.value)
                              })
                            }
                            className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                          />
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-neutral-400">
                        Lower temperature = fewer invented facts; higher = more varied prose.
                        Temperature 0 with a fixed seed makes this role reproducible: the same
                        prompt returns the same answer. Max tokens <code>-1</code> leaves the reply
                        length to LM Studio. Top K and Min P at <code>-1</code> follow the model
                        family&rsquo;s published recipe (Qwen3 runs top-k 20, and loops without
                        it); <code>0</code> turns them off.
                      </p>
                    </details>
                  </div>
                ))}

                <div className="border-t border-black/10 dark:border-white/10 pt-4">
                  <div className="text-sm font-medium">Second opinion</div>
                  <p className="mt-1 text-xs text-neutral-500">
                    Adds a &quot;🔍 2nd opinion&quot; action under replies: a <em>different</em> role
                    reviews the answer and names the factual claims it could not verify, plus the
                    check that would settle each. Never a confidence score — a model grading its
                    own answer says &quot;yes&quot; nearly always, so the reviewer is always another
                    slot. When enabled, the review also runs automatically on factual-looking
                    answers that consulted no web source (marked ⚠️ unverified).
                  </p>
                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.secondOpinion.enabled}
                      onChange={(e) =>
                        update({ secondOpinion: { ...draft.secondOpinion, enabled: e.target.checked } })
                      }
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>Enable second opinions</span>
                  </label>
                  {draft.secondOpinion.enabled && (
                    <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-2">
                      <label className="text-xs text-neutral-500">Reviewing role</label>
                      <select
                        value={draft.secondOpinion.criticSlotId ?? ''}
                        onChange={(e) =>
                          update({
                            secondOpinion: {
                              ...draft.secondOpinion,
                              criticSlotId: e.target.value || null
                            }
                          })
                        }
                        className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm"
                      >
                        <option value="">Auto — first enabled role that did not answer</option>
                        {draft.models
                          .filter((m) => m.enabled)
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.roleName || m.id}
                            </option>
                          ))}
                      </select>
                      <p className="col-span-2 text-xs text-neutral-400">
                        Needs at least two enabled roles; with one, the action explains that no
                        independent review is possible instead of asking the answerer to grade
                        itself.
                      </p>
                      <label className="col-span-2 mt-1 flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.claimCheck.enabled}
                          onChange={(e) =>
                            update({ claimCheck: { ...draft.claimCheck, enabled: e.target.checked } })
                          }
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Check claims automatically
                          <span className="mt-0.5 block text-xs text-neutral-500">
                            On ⚠️ unverified answers, the reviewing role extracts the factual
                            claims and the app checks each against web sources — confirmed,
                            contradicted, or unverifiable, with the source shown. Runs one search
                            per claim (max{' '}
                            <input
                              type="number"
                              min={1}
                              max={10}
                              value={draft.claimCheck.maxClaims}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                update({
                                  claimCheck: {
                                    ...draft.claimCheck,
                                    maxClaims: Math.max(1, Math.min(10, Number(e.target.value) || 5))
                                  }
                                })
                              }
                              className="mx-0.5 w-12 rounded border border-black/10 dark:border-white/10 bg-transparent px-1 py-0.5 text-center text-xs"
                            />
                            ) — respects &quot;confirm before search&quot;.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}

                  {/*
                    Outside the secondOpinion gate on purpose: this pass needs
                    no critic slot. It works from what the checker already
                    found, and the answerer fixes its own answer.
                  */}
                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.grounding.autoCorrect}
                      onChange={(e) => update({ grounding: { ...draft.grounding, autoCorrect: e.target.checked } })}
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Correct unsupported specifics
                      <span className="mt-0.5 block text-xs text-neutral-500">
                        When the grounding check finds an address, price, link or phone number the
                        turn&rsquo;s own tools never returned, the findings go back to the model for
                        one revision — verify it with a tool, or drop it and say so. Costs one extra
                        round, and only on answers already known to contain unsupported specifics.
                        The reply is marked as revised.
                      </span>
                    </span>
                  </label>

                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.grounding.playbooks}
                      onChange={(e) =>
                        update({ grounding: { ...draft.grounding, playbooks: e.target.checked } })
                      }
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Playbooks — give the model a method for the kind of question
                      <span className="mt-0.5 block text-xs text-neutral-500">
                        For first-aid, health, finance, legal, home-repair, data, code, comparison
                        and planning questions, a short numbered method rides along with the turn
                        (&ldquo;say to call emergency services first&rdquo;, &ldquo;compute with the
                        calculator, never in your head&rdquo;, &ldquo;describe the data before
                        analysing it&rdquo;). A few dozen tokens; the reply says which playbook was
                        used. This is how a small model acts like it has expertise it does not have.
                      </span>
                    </span>
                  </label>

                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.grounding.selfReview}
                      onChange={(e) =>
                        update({ grounding: { ...draft.grounding, selfReview: e.target.checked } })
                      }
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Think harder may use self-review when no second role is enabled
                      <span className="mt-0.5 block text-xs text-neutral-500">
                        🧠 Think harder is draft → review → revise, once. With two roles the review
                        comes from a different model. With one, this lets the same model read its
                        own draft as a strict reviewer — weaker, always labelled &ldquo;reviewed its
                        own draft&rdquo;, and still useful for arithmetic slips and skipped steps.
                        Off means think harder requires a second role, like second opinions.
                      </span>
                    </span>
                  </label>

                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.grounding.workbenchChecks}
                      onChange={(e) =>
                        update({ grounding: { ...draft.grounding, workbenchChecks: e.target.checked } })
                      }
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Workbench checks — recompute figures, run the code
                      <span className="mt-0.5 block text-xs text-neutral-500">
                        When a reply states figures that nothing computed, the model is asked for a
                        short Python program that recomputes them and the app runs it in the sandbox;
                        the reply is then checked against that output like any calculator result.
                        When a reply contains self-contained Python, the app runs it — a syntax error,
                        an undefined name or a failed assertion is sent back for one revision, kept
                        only if the revised code runs. Both are disclosed under the reply
                        (&ldquo;🧮 Recomputed…&rdquo;, &ldquo;🧪 Ran the Python…&rdquo;).
                      </span>
                    </span>
                  </label>

                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.grounding.ledger}
                      onChange={(e) => update({ grounding: { ...draft.grounding, ledger: e.target.checked } })}
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Conversation ledger — the app remembers what was established
                      <span className="mt-0.5 block text-xs text-neutral-500">
                        From the fourth turn on, the model is handed a mechanical record of what this
                        conversation has established: figures a tool computed, files attached, Python
                        session variables, and constraints you stated (&ldquo;budget is $2,000&rdquo;) —
                        exact strings from tool results and your own words, never from earlier
                        replies, so a small model refers back instead of re-remembering. Disclosed
                        under the reply (&ldquo;📒 Ledger&rdquo;).
                      </span>
                    </span>
                  </label>
                </div>
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
                  <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.showResponseStats}
                      onChange={(e) => update({ showResponseStats: e.target.checked })}
                      className="h-4 w-4 accent-accent"
                    />
                    Show response stats
                  </label>
                  <p className="mt-1 text-xs text-neutral-500">
                    Tokens/sec and time to first token under each reply. Token counts come from LM
                    Studio; when a server does not report them, only timing is shown.
                  </p>
                  <div className="mt-3">
                    <label className="mb-1 block text-sm">Reasoning display</label>
                    <select
                      value={draft.reasoningDisplay}
                      onChange={(e) =>
                        update({
                          reasoningDisplay: e.target.value as AppSettings['reasoningDisplay']
                        })
                      }
                      className="w-64 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                    >
                      <option value="collapsed">Collapsed behind a &quot;Thought&quot; header</option>
                      <option value="expanded">Always expanded</option>
                      <option value="hidden">Hidden</option>
                    </select>
                    <p className="mt-1 text-xs text-neutral-500">
                      How a model&apos;s chain-of-thought appears above its reply. Applies to new
                      views of a message; the reasoning itself is always kept.
                    </p>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    When a conversation outgrows the context window
                  </label>
                  <select
                    value={draft.contextManagement}
                    onChange={(e) =>
                      update({ contextManagement: e.target.value as 'compact' | 'trim' })
                    }
                    className="w-64 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                  >
                    <option value="compact">Summarize what no longer fits</option>
                    <option value="trim">Drop it silently</option>
                  </select>
                  <p className="mt-1 text-xs text-neutral-500">
                    Summarizing costs one extra local model call when the limit is first reached,
                    and keeps the model aware of how the conversation began. Dropping is what
                    versions before 0.8.2 did.
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Plan mode (📋 in the composer)</label>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.plan.confirmPlan}
                      onChange={(e) => update({ plan: { ...draft.plan, confirmPlan: e.target.checked } })}
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Show the plan for approval before executing
                      <span className="block text-xs text-neutral-500">
                        One dialog with every step before anything runs — the moment to catch a plan
                        that misread the task. Off means generated plans run immediately.
                      </span>
                    </span>
                  </label>
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-xs text-neutral-500">Max steps per plan</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={draft.plan.maxSteps}
                      onChange={(e) => update({ plan: { ...draft.plan, maxSteps: Number(e.target.value) } })}
                      className="w-20 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                    />
                    <span className="text-xs text-neutral-400">
                      Each step is a bounded sub-turn with the enabled tools.
                    </span>
                  </div>
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
                <div className="rounded-xl border border-black/10 dark:border-white/10 p-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        workbench === null
                          ? 'bg-neutral-400'
                          : !workbench.available
                            ? 'bg-red-500'
                            : workbench.warm
                              ? 'bg-green-500'
                              : 'bg-amber-500'
                      }`}
                    />
                    <span className="text-sm font-medium">Workbench (sandboxed Python)</span>
                    <span className="text-xs text-neutral-400">
                      {workbench === null
                        ? 'checking…'
                        : !workbench.available
                          ? 'not installed'
                          : `Pyodide ${workbench.version ?? '?'} · ${workbench.warm ? 'running' : 'idle'}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setWorkbench(null)
                        void window.api.workbenchStatus().then(setWorkbench).catch(() => setWorkbench(null))
                      }}
                      className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      Refresh
                    </button>
                    {workbench?.available && !workbench.warm && (
                      <button
                        type="button"
                        disabled={warming}
                        onClick={() => {
                          setWarming(true)
                          void window.api
                            .warmWorkbench()
                            // Loading the runtime takes a second or two; re-read once it can have finished.
                            .then(() => new Promise((r) => setTimeout(r, 2500)))
                            .then(() => window.api.workbenchStatus())
                            .then(setWorkbench)
                            .catch(() => undefined)
                            .finally(() => setWarming(false))
                        }}
                        className="rounded-lg border border-black/10 dark:border-white/10 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                        title="Load the runtime now so the first run_python of the session does not pay the cold start"
                      >
                        {warming ? 'Starting…' : 'Start now'}
                      </button>
                    )}
                  </div>
                  <p className="mt-1.5 text-xs text-neutral-500">
                    {workbench?.available
                      ? `Python runs in WebAssembly inside a sandboxed window: no network — not even your LM Studio server — and no access to your disk beyond the files you attach. Available offline: the standard library${
                          workbench.packages.length > 0 ? ` plus ${workbench.packages.join(', ')}` : ''
                        }. The sandbox is torn down after ten minutes idle.`
                      : 'run_python and analyze_file report themselves unavailable until the runtime is installed. Everything else in the app is unaffected.'}
                  </p>
                  {workbench && !workbench.available && workbench.reason && (
                    <p className="mt-2 rounded-lg bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
                      {workbench.reason}
                      <br />
                      In a checkout, run <code>bash scripts/fetch-pyodide.sh</code>; packaged builds
                      include it.
                    </p>
                  )}
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
                  <div>
                    <label className="mb-1 block text-xs text-neutral-500">
                      Deep research budget
                    </label>
                    <select
                      value={draft.research.depth}
                      onChange={(e) =>
                        update({
                          research: {
                            ...draft.research,
                            depth: e.target.value as AppSettings['research']['depth']
                          }
                        })
                      }
                      className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm"
                    >
                      <option value="quick">Quick — up to 3 searches, 4 pages, 4 domains</option>
                      <option value="standard">Standard — up to 6 searches, 10 pages, 8 domains</option>
                      <option value="thorough">Thorough — up to 10 searches, 16 pages, 12 domains</option>
                    </select>
                    <p className="mt-1 text-xs text-neutral-500">
                      Hard ceiling on what one <code>deep_research</code> call may spend. The
                      distinct-domain cap is the privacy-relevant one — it limits how many separate
                      sites learn anything at all.
                    </p>
                  </div>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.research.confirmPlan}
                      onChange={(e) =>
                        update({
                          research: { ...draft.research, confirmPlan: e.target.checked }
                        })
                      }
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Approve research plans
                      <span className="block text-xs text-neutral-500">
                        Before a deep research run sends anything, show every sub-question and every
                        outgoing query for approval — one dialog for the whole plan.
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
                  <div className="text-sm font-medium">Proxy (Tor / VPN)</div>
                  <p className="mt-1 text-xs text-neutral-500">
                    Route search, page reads and rendering through a proxy you run. This is the only
                    control here that hides <em>who is asking</em> rather than what is asked — your
                    provider still sees the query, but no longer your IP address. Your LM Studio
                    server is never proxied.
                  </p>

                  <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                    <select
                      value={draft.proxy.mode}
                      onChange={(e) =>
                        update({
                          proxy: {
                            ...draft.proxy,
                            mode: e.target.value as AppSettings['proxy']['mode']
                          }
                        })
                      }
                      className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm"
                    >
                      <option value="none">No proxy (direct connection)</option>
                      <option value="socks5">SOCKS5 — recommended (Tor, most VPNs)</option>
                      <option value="http">HTTP proxy</option>
                    </select>
                    <button
                      type="button"
                      disabled={proxyTesting}
                      onClick={async () => {
                        setProxyTesting(true)
                        setProxyTest(null)
                        // Test the saved settings, so what is verified is what is in force.
                        await window.api.setSettings(draft)
                        setProxyTest(await window.api.testProxy())
                        setProxyTesting(false)
                      }}
                      className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50"
                    >
                      {proxyTesting ? 'Testing…' : 'Test proxy'}
                    </button>
                  </div>

                  {draft.proxy.mode !== 'none' && (
                    <div className="mt-2 grid grid-cols-[2fr_1fr] gap-2">
                      <input
                        value={draft.proxy.host}
                        onChange={(e) => update({ proxy: { ...draft.proxy, host: e.target.value } })}
                        placeholder="127.0.0.1"
                        spellCheck={false}
                        className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm font-mono"
                      />
                      <input
                        type="number"
                        value={draft.proxy.port}
                        onChange={(e) =>
                          update({ proxy: { ...draft.proxy, port: Number(e.target.value) } })
                        }
                        min={1}
                        max={65535}
                        className="rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm font-mono"
                      />
                    </div>
                  )}

                  {draft.proxy.mode === 'socks5' && (
                    <p className="mt-2 text-xs text-neutral-500">
                      With SOCKS5, hostnames are resolved <strong>at the proxy</strong>, so your local
                      resolver never learns which sites you read. Tor&apos;s daemon listens on port
                      9050; the Tor Browser bundle uses 9150.
                    </p>
                  )}
                  {proxyTest && (
                    <p
                      className={`mt-2 text-xs ${
                        proxyTest.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'
                      }`}
                    >
                      {proxyTest.detail}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-neutral-500">
                    &quot;Test proxy&quot; is the one time the app contacts a third party on its own
                    behalf: it asks <code>api.ipify.org</code> which IP address sites see, because a
                    misconfigured proxy otherwise fails silently by simply not being used.
                  </p>
                </div>

                <div className="border-t border-black/10 dark:border-white/10 pt-4">
                  <div className="text-sm font-medium">Shopping</div>
                  <p className="mt-1 mb-3 text-xs text-neutral-500">
                    Shopping tools contact retailers, who log the visit. Sigma Oasis never logs in,
                    never fills a cart and never checks out — you finish the purchase in your own
                    browser. The watchlist stays on this machine.
                  </p>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.shopping.requireProxy}
                      onChange={(e) =>
                        update({ shopping: { ...draft.shopping, requireProxy: e.target.checked } })
                      }
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Require a proxy for shopping fetches
                      <span className="block text-xs text-neutral-500">
                        Refuses rather than going out direct. Big retailers block Tor exits, so this
                        trades success rate for not handing them your IP — deliberately, and in that
                        order.
                      </span>
                    </span>
                  </label>
                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.shopping.excludeTierX}
                      onChange={(e) =>
                        update({ shopping: { ...draft.shopping, excludeTierX: e.target.checked } })
                      }
                      className="mt-0.5 h-4 w-4 accent-accent"
                    />
                    <span>
                      Exclude affiliate listicles and content farms
                      <span className="block text-xs text-neutral-500">
                        &quot;Top 10 best…&quot; pages are written to rank, not to inform. The domain
                        list is in <code>src/main/ipc/sourceTiers.ts</code> — a ranking you can read.
                      </span>
                    </span>
                  </label>
                  <div className="mt-3">
                    <label className="mb-1 block text-xs text-neutral-500">
                      Sellers checked per comparison: {draft.shopping.maxSellers}
                    </label>
                    <input
                      type="range"
                      min={1}
                      max={5}
                      value={draft.shopping.maxSellers}
                      onChange={(e) =>
                        update({
                          shopping: { ...draft.shopping, maxSellers: Number(e.target.value) }
                        })
                      }
                      className="w-full accent-accent"
                    />
                    <p className="text-xs text-neutral-500">
                      Each seller is one page fetch. The budget is checked before each fetch and the
                      stop is stated in the result.
                    </p>
                  </div>
                </div>

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
                  (researchStats.pages === 0 &&
                    researchStats.searchQueries === 0 &&
                    (researchStats.pinnedDocs ?? 0) === 0) ? (
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
                      cached search{researchStats.searchQueries === 1 ? '' : 'es'}
                      {(researchStats.pinnedDocs ?? 0) > 0 && (
                        <>
                          {' '}·{' '}
                          <strong className="text-neutral-700 dark:text-neutral-300">
                            {researchStats.pinnedDocs}
                          </strong>{' '}
                          attached document{researchStats.pinnedDocs === 1 ? '' : 's'} (
                          {Math.round((researchStats.pinnedChars ?? 0) / 1024)} KB)
                        </>
                      )}
                      . In RAM only.
                    </p>
                  )}
                </div>

                <div className="border-t border-black/10 dark:border-white/10 pt-4">
                  <div className="text-sm font-medium">Session audit log</div>
                  <p className="mt-1 text-xs text-neutral-500">
                    An append-only transcript of what was actually said: your inputs, the
                    model&apos;s answers, and each tool call — no system prompts or other hidden
                    layers. Every line is encrypted with your OS keychain and hash-chained, so an
                    edited or deleted line is detectable on export. Ephemeral chats are never
                    logged. Off by default.
                  </p>

                  {auditInfo && !auditInfo.available && (
                    <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                      Unavailable: your OS keychain is not accessible, and this log is never
                      written unencrypted.
                    </p>
                  )}

                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.audit.enabled}
                      disabled={auditInfo !== null && !auditInfo.available}
                      onChange={(e) => update({ audit: { ...draft.audit, enabled: e.target.checked } })}
                      className="mt-0.5 h-4 w-4 accent-accent disabled:opacity-40"
                    />
                    <span>
                      Record a session audit log
                      <span className="block text-xs text-neutral-500">
                        Takes effect after Save. Entries from before enabling are not recovered —
                        the log starts when you turn it on.
                      </span>
                    </span>
                  </label>

                  {draft.audit.enabled && (
                    <label className="mt-2 flex cursor-pointer items-start gap-2.5 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.audit.autoPurgeOnQuit}
                        onChange={(e) =>
                          update({ audit: { ...draft.audit, autoPurgeOnQuit: e.target.checked } })
                        }
                        className="mt-0.5 h-4 w-4 accent-accent"
                      />
                      <span>
                        Purge the log automatically when the app quits
                        <span className="block text-xs text-neutral-500">
                          Verification for the current session only; nothing accumulates.
                        </span>
                      </span>
                    </label>
                  )}

                  {auditInfo && (
                    <div className="mt-3 rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-neutral-500">
                      {auditInfo.sessions.length === 0 ? (
                        <span>No audit logs on disk.</span>
                      ) : (
                        <span>
                          <strong className="text-neutral-700 dark:text-neutral-300">
                            {auditInfo.sessions.length}
                          </strong>{' '}
                          session log{auditInfo.sessions.length === 1 ? '' : 's'} on disk · latest:{' '}
                          {auditInfo.sessions[0]!.entries} entries,{' '}
                          {Math.max(1, Math.round(auditInfo.sessions[0]!.sizeBytes / 1024))} KB
                          {auditInfo.sessions[0]!.sessionId === auditInfo.currentSessionId
                            ? ' (this session)'
                            : ''}
                          . The key is machine-bound, so logs do not survive an OS reinstall.
                        </span>
                      )}
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={!auditInfo.available || auditInfo.sessions.length === 0}
                          onClick={() =>
                            void window.api.auditExport().then((r) => {
                              if (r.ok) {
                                setAuditNotice(
                                  `Exported ${r.entries} entries to ${r.path}` +
                                    (r.chainValid
                                      ? ' — hash chain verified.'
                                      : ' — ⚠ hash chain BROKEN: the log was modified.')
                                )
                              } else if (!r.canceled) {
                                setAuditNotice(`Export failed: ${r.error ?? 'unknown error'}`)
                              }
                            })
                          }
                          className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                          title="Decrypt the latest session log to a file you choose. The export is plaintext — anyone with the file can read it."
                        >
                          Export latest (decrypted)
                        </button>
                        <button
                          type="button"
                          disabled={!auditInfo.available || auditInfo.sessions.length === 0}
                          onClick={() =>
                            void window.api.tracesExport().then((r) => {
                              if (r.ok) {
                                setAuditNotice(
                                  `Traces: ${r.counts.positive} positive, ${r.counts.rejected} rejected, ` +
                                    `${r.counts.unlabeled} unlabeled (excluded) — schema ${r.schemaVersion ?? 'n/a'}. ` +
                                    `Wrote ${r.paths.positive} and siblings.` +
                                    (r.chainValid
                                      ? ''
                                      : ' ⚠ Hash chain BROKEN: the log was modified.')
                                )
                              } else if (!r.canceled) {
                                setAuditNotice(`Trace export failed: ${r.error ?? 'unknown error'}`)
                              }
                            })
                          }
                          className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                          title="Export the latest session as OpenAI-format fine-tuning traces: positive and rejected JSONL, a manifest, and the tool schemas. Redacted; writes to a location you choose."
                        >
                          Export traces (SFT)
                        </button>
                        <button
                          type="button"
                          disabled={auditInfo.sessions.length === 0}
                          onClick={() => {
                            if (!window.confirm('Delete every audit log on disk? This cannot be undone.'))
                              return
                            void window.api.auditPurge().then((r) => {
                              setAuditNotice(`Purged ${r.removed} session log${r.removed === 1 ? '' : 's'}.`)
                              void window.api.auditStatus().then(setAuditInfo)
                            })
                          }}
                          className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-red-500 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                        >
                          Purge all
                        </button>
                      </div>
                      {auditNotice && <p className="mt-2 break-all text-neutral-400">{auditNotice}</p>}
                    </div>
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
                    Every request the app makes to the outside, newest first. Only origins are
                    recorded — never full URLs, so your queries stay private even here.
                  </p>
                  <p className="mt-1 text-xs text-neutral-500">
                    Not listed: the chat stream itself. Replies stream straight from the chat window
                    to your LM Studio server on this machine ({draft.baseUrl}); that traffic can
                    only ever go to a loopback address, is never proxied, and does not pass through
                    this log. Everything that leaves the machine does.
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

            {tab === 'library' && <LibraryTab />}

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
            className={`text-sm ${
              confirmingReset ? 'font-medium text-red-500' : 'text-neutral-500 hover:text-red-500'
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
