// Settings → Roles (v4.0, S4): one fold per slot — its colour, name, model
// and specialty on the header, the detail inside — in place of 140 controls
// on one scroll. A slot whose model the server no longer lists says so with
// the picker right there. The pipeline order and the tool-choice eval are
// sections of this tab; the Pipeline tab is retired.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ACCENT_KEYS } from '../../lib/colors'
import { modelLabel } from '../../lib/modelInfo'
import type { AccentColor, AppSettings, EvalScoreSummary, ModelConfig, ModelInfo, SamplingSettings, ToolToggles } from '../../types'
import { TOOL_LABELS } from '../../../../shared/tools'
import { LENGTH_PRESETS, TEMPERATURE_PRESETS, activeLengthPreset, activePreset, recommendedSampling } from '../../lib/sampling'
import { EvalScoreLine, ProfileLine } from './helpers'
import { useAppStore } from '../../stores/appStore'
import { latestSlowReading, slowReadingAdvice, slowReadingFact } from '../../lib/modelFit'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, parseTyped, registerRows, type RowMeta } from '../../lib/settingsKit'
import { runToolChoiceEval, parseCompletionMessage } from '../../lib/evalRunner'
import { withGrounding, withToolCallPreamble } from '../../lib/grounding'
import type { ApiMessage, ApiToolCall } from '../../lib/agentLoop'
import type { ToolSchema } from '../../types'
import { ActionRow, Button, Chips, Field, Fold, Notice, RoleDot, Row, Section, Select, Stepper, Switch, Textarea, type ActionResult } from './kit'

export const ROWS = defineRows('models', {
  slots: { label: 'Roles', help: 'Each role is a model, a persona and its own tools; a message goes to one of them, by @handle or by the router.', keywords: ['slots', 'models', 'roles'] },
  enabled: { label: 'Enabled', help: 'An enabled role can answer and be routed to.', keywords: ['on', 'off'] },
  modelId: { label: 'Model', help: 'From LM Studio’s list. The profile line says what the app knows about the family.', keywords: ['model', 'lm studio', 'pick'] },
  roleName: { label: 'Role name', help: 'Route a message to it with @Name. Applies when you press Enter or leave the field.', keywords: ['name', 'handle', 'mention'] },
  contextWindow: { label: 'Context window override', help: 'Tokens. History compaction and the context meter budget against this number. Leave empty to trust what LM Studio reports; set it when the server under-reports the window or you loaded the model with a larger one.', keywords: ['context', 'tokens', 'window'] },
  systemPrompt: { label: 'Persona', help: 'The system prompt: who this role is and how it sounds. Applies when you leave the field.', keywords: ['system prompt', 'persona'] },
  rules: { label: 'Standing rules', help: 'How it operates, apart from how it sounds — appended after the persona on every turn, before a project’s instructions, and disclosed under the reply. Reviewers and critics see the persona only.', keywords: ['rules', 'operating'] },
  capability: { label: 'Capability', help: 'One line other roles and the pre-flight router read: “send me X; don’t send me Y”. Shown in the consult roster.', keywords: ['routing', 'capability'] },
  specialty: { label: 'Specialty', help: 'What the router matches on — code to Coding, finance questions to Finance, factual questions to Research. General opts out of auto-routing.', keywords: ['routing', 'specialty', 'coding', 'research', 'finance', 'data'] },
  color: { label: 'Accent', help: 'The colour this role’s replies carry.', keywords: ['colour', 'color'] },
  keepLoaded: { label: 'Keep loaded', help: 'Pin this model for a month idle rather than an hour, so the app’s own embedding calls and another client’s requests do not evict it between sessions. LM Studio still unloads it when memory runs short.', keywords: ['pin', 'evict', 'resident', 'ttl'] },
  codeMode: { label: 'Code Mode', help: 'native: tools as calls (default). code: one tool, run_code, whose Python program calls the others through a generated tools module, with the same allowlist, budgets and audit. both: both. Measured in docs/evals.md before any default was chosen.', keywords: ['code mode', 'run_code'] },
  tools: { label: 'Tools', help: 'Which of the enabled tools this role holds. A shorter, focused list helps a small model choose — and keeps a powerful tool out of the wrong hands.', keywords: ['allowlist', 'restrict'] },
  presets: { label: 'Temperature preset', help: 'Lower means fewer invented facts; higher means more varied prose. The family’s own recipe is warmer than the Factual preset — the trade is yours to make.', keywords: ['sampling', 'preset', 'factual', 'creative'] },
  temperature: { label: 'Temperature', help: '0 to 2. 0 with a fixed seed makes this role reproducible.', keywords: ['sampling'] },
  topP: { label: 'Top P', help: 'Nucleus sampling, 0.01 to 1; 1 disables it.', keywords: ['sampling'] },
  length: { label: 'Reply length', help: 'A cap on the reply. -1 leaves it to LM Studio.', keywords: ['max tokens', 'length'] },
  maxTokens: { label: 'Max tokens', help: '-1 leaves the reply length to LM Studio.', keywords: ['sampling'] },
  topK: { label: 'Top K', help: '-1 follows the family’s published recipe (Qwen3 runs top-k 20, and loops without it); 0 turns it off.', keywords: ['sampling'] },
  minP: { label: 'Min P', help: '-1 follows the family recipe; 0 turns it off.', keywords: ['sampling'] },
  seed: { label: 'Seed', help: 'A fixed seed with temperature 0 returns the same answer to the same prompt. Empty is random.', keywords: ['sampling', 'reproducible'] },
  pipeline: { label: 'Pipeline order', help: 'In collaborative mode your message flows through the chain in this order — each role sees the previous one’s output and posts its own reply. Turn a role on to add it; move it with the arrows.', keywords: ['collaborative', 'chain', 'order'] },
  eval: { label: 'Tool-choice eval', help: 'Measures whether each loaded model calls the right tool, against canned results — the same harness as npm run eval:tools. Scores appear under each model picker. A big model can take minutes per fixture.', keywords: ['eval', 'measure', 'tool choice'] }
})
registerRows(ROWS)

export interface ModelsTabProps {
  settings: AppSettings
  apply: ApplySettings
  availableModels: ModelInfo[]
}

export function ModelsTab({ settings, apply, availableModels }: ModelsTabProps): JSX.Element {
  const [evalScores, setEvalScores] = useState<EvalScoreSummary[]>([])
  useEffect(() => {
    void window.api.evalScores().then(setEvalScores).catch(() => {})
  }, [])

  const updateModel = (id: string, meta: RowMeta, partial: Partial<ModelConfig>, shown?: string): void =>
    apply(meta, { models: settings.models.map((m) => (m.id === id ? { ...m, ...partial } : m)) }, shown)
  const updateSampling = (id: string, meta: RowMeta, partial: Partial<SamplingSettings>, shown?: string): void =>
    apply(meta, { models: settings.models.map((m) => (m.id === id ? { ...m, sampling: { ...m.sampling, ...partial } } : m)) }, shown)
  const enabledToolKeys = (Object.keys(TOOL_LABELS) as (keyof ToolToggles)[]).filter((k) => settings.tools[k])

  return (
    <div className="space-y-8">
      <Section title="Roles" description="Open a role to change it. Its switch is on its line.">
        <Row meta={ROWS.slots} bare>
          <div className="space-y-2">
            {settings.models.map((m, idx) => {
              const listed = availableModels.some((am) => am.id === m.modelId)
              const stale = Boolean(m.modelId) && !listed && availableModels.length > 0
              return (
                <Fold
                  key={m.id}
                  title={
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <RoleDot color={m.color} />
                      <span className="truncate">{m.roleName || `Role ${idx + 1}`}</span>
                      <span className="truncate font-mono text-xs text-ink-tertiary">{m.modelId || 'no model'}</span>
                      {stale && <span className="text-xs text-ink-warn">not on the server</span>}
                    </span>
                  }
                  summary={
                    <span className="inline-flex items-center gap-3">
                      <span>{m.specialty ?? 'general'}</span>
                      <Switch size="sm" checked={m.enabled} onChange={(enabled) => updateModel(m.id, ROWS.enabled, { enabled }, `${m.roleName}: ${enabled ? 'on' : 'off'}`)} label={`${m.roleName} enabled`} />
                    </span>
                  }
                >
                  <Row
                    meta={ROWS.modelId}
                    layout="stack"
                    foot={
                      <>
                        {stale && (
                          <Notice tone="warn" className="mb-1">
                            LM Studio no longer lists <code>{m.modelId}</code>. Pick one of the models it has, or load this one again.
                          </Notice>
                        )}
                        <ProfileLine modelId={m.modelId} scores={evalScores} />
                        <EvalScoreLine scores={evalScores} modelId={m.modelId} />
                        <SlowReadingNote modelId={m.modelId} loadedContextLength={availableModels.find((am) => am.id === m.modelId)?.loadedContextLength} />
                      </>
                    }
                  >
                    <Select
                      value={m.modelId}
                      onChange={(modelId) => updateModel(m.id, ROWS.modelId, { modelId })}
                      options={[
                        { value: '', label: '— select a model —' },
                        ...availableModels.map((am) => ({ value: am.id, label: modelLabel(am) })),
                        ...(m.modelId && !listed ? [{ value: m.modelId, label: `${m.modelId} (not listed)` }] : [])
                      ]}
                    />
                  </Row>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Row meta={ROWS.roleName} layout="stack">
                      <Field value={m.roleName} onCommit={(roleName) => updateModel(m.id, ROWS.roleName, { roleName })} />
                    </Row>
                    <Row meta={ROWS.contextWindow} layout="stack">
                      <Field
                        value={m.contextWindow === null ? '' : String(m.contextWindow)}
                        placeholder="auto — what LM Studio reports"
                        onCommit={(text) => {
                          const n = parseTyped(text)
                          updateModel(m.id, ROWS.contextWindow, { contextWindow: Number.isFinite(n) && n >= 512 ? Math.round(n) : null }, Number.isFinite(n) && n >= 512 ? `${Math.round(n)} tokens` : 'auto')
                        }}
                      />
                    </Row>
                  </div>
                  <Row meta={ROWS.systemPrompt} layout="stack">
                    <Textarea value={m.systemPrompt} mono onCommit={(systemPrompt) => updateModel(m.id, ROWS.systemPrompt, { systemPrompt }, 'edited')} />
                  </Row>
                  <Row meta={ROWS.rules} layout="stack">
                    <Textarea value={m.rules ?? ''} mono placeholder="e.g. Always give figures with their source and date. Never guess a price; search. Reply in the user's language." onCommit={(rules) => updateModel(m.id, ROWS.rules, { rules: rules.trim() ? rules : undefined }, rules.trim() ? 'edited' : 'cleared')} />
                  </Row>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Row meta={ROWS.capability} layout="stack">
                      <Field value={m.capability ?? ''} placeholder="send me: …; don't send me: …" onCommit={(capability) => updateModel(m.id, ROWS.capability, { capability: capability || undefined }, capability || 'cleared')} />
                    </Row>
                    <Row meta={ROWS.specialty} layout="stack">
                      <Select
                        value={m.specialty ?? ''}
                        onChange={(v) => updateModel(m.id, ROWS.specialty, { specialty: (v || undefined) as ModelConfig['specialty'] }, v || 'General')}
                        options={[
                          { value: '', label: 'General' },
                          { value: 'coding', label: 'Coding' },
                          { value: 'research', label: 'Research' },
                          { value: 'finance', label: 'Finance' },
                          { value: 'data', label: 'Data analysis' }
                        ]}
                      />
                    </Row>
                  </div>
                  <Row meta={ROWS.color} foot={<span className="text-xs text-ink-tertiary">Route with <code>@{m.roleName.replace(/\s+/g, '')}</code></span>}>
                    <Chips
                      value={m.color}
                      onChange={(color) => updateModel(m.id, ROWS.color, { color: color as AccentColor }, color)}
                      chips={ACCENT_KEYS.map((c) => ({ value: c, label: c, swatch: SWATCH[c] }))}
                    />
                  </Row>
                  <Row meta={ROWS.keepLoaded}>
                    <Switch checked={Boolean(m.keepLoaded)} onChange={(keepLoaded) => updateModel(m.id, ROWS.keepLoaded, { keepLoaded: keepLoaded || undefined })} />
                  </Row>
                  <Row meta={ROWS.codeMode}>
                    <Select
                      label={`${m.roleName} code mode`}
                      value={m.codeMode ?? 'native'}
                      onChange={(v) => updateModel(m.id, ROWS.codeMode, { codeMode: v === 'native' ? undefined : (v as 'code' | 'both') }, v)}
                      options={[
                        { value: 'native', label: 'native — tools as calls' },
                        { value: 'code', label: 'code — run_code only' },
                        { value: 'both', label: 'both' }
                      ]}
                    />
                  </Row>

                  <Fold title="Tools" summary={m.tools ? `${m.tools.filter((t) => settings.tools[t as keyof ToolToggles]).length} of ${enabledToolKeys.length} enabled` : 'all enabled tools'}>
                    <Row
                      meta={ROWS.tools}
                      layout="stack"
                      foot={
                        <span className="text-xs text-ink-tertiary">
                          {m.tools === undefined
                            ? 'This role holds every tool enabled under Tools.'
                            : m.tools.filter((t) => settings.tools[t as keyof ToolToggles]).length === 0
                              ? 'This role holds no tools — it answers from its own knowledge only.'
                              : 'Only the tools switched on here reach this role. Tools disabled globally never do.'}
                        </span>
                      }
                    >
                      {m.tools === undefined ? (
                        <Button onClick={() => updateModel(m.id, ROWS.tools, { tools: enabledToolKeys }, 'restricted')}>Restrict…</Button>
                      ) : (
                        <div className="space-y-2">
                          <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                            {enabledToolKeys.map((key) => (
                              <label key={key} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-xs text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                                <code>{key}</code>
                                <Switch
                                  size="sm"
                                  label={`${m.roleName} may use ${key}`}
                                  checked={(m.tools ?? []).includes(key)}
                                  onChange={(on) => updateModel(m.id, ROWS.tools, { tools: on ? [...(m.tools ?? []), key] : (m.tools ?? []).filter((t) => t !== key) }, `${key} ${on ? 'on' : 'off'}`)}
                                />
                              </label>
                            ))}
                          </div>
                          <Button onClick={() => updateModel(m.id, ROWS.tools, { tools: undefined }, 'all enabled tools')}>Allow all</Button>
                        </div>
                      )}
                    </Row>
                  </Fold>

                  <Fold title="Sampling" summary={`${activePreset(m.sampling.temperature)?.label ?? `temperature ${m.sampling.temperature}`} · ${activeLengthPreset(m.sampling.maxTokens)?.label ?? `${m.sampling.maxTokens} tokens`}`}>
                    <Row meta={ROWS.presets} layout="stack">
                      <Chips
                        value={(activePreset(m.sampling.temperature)?.label as string | undefined) ?? null}
                        onChange={(label) => {
                          const preset = TEMPERATURE_PRESETS.find((p) => p.label === label)
                          const family = recommendedSampling(m.modelId)
                          if (preset) updateSampling(m.id, ROWS.presets, { temperature: preset.value }, `${preset.label} ${preset.value}`)
                          else if (family && label === `${family.label} defaults`) updateSampling(m.id, ROWS.presets, family.recipe, `${family.label} defaults`)
                        }}
                        chips={[
                          ...TEMPERATURE_PRESETS.map((p) => ({ value: p.label, label: `${p.label} ${p.value}`, hint: p.hint })),
                          ...(recommendedSampling(m.modelId)
                            ? [
                                {
                                  value: `${recommendedSampling(m.modelId)!.label} defaults`,
                                  label: `${recommendedSampling(m.modelId)!.label} defaults`,
                                  hint: `Temperature ${recommendedSampling(m.modelId)!.recipe.temperature}, top-p ${recommendedSampling(m.modelId)!.recipe.topP}, top-k ${recommendedSampling(m.modelId)!.recipe.topK} — as published for this model family. Warmer than the Factual preset.`
                                }
                              ]
                            : [])
                        ]}
                      />
                    </Row>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Row meta={ROWS.temperature}>
                        <Stepper value={m.sampling.temperature} min={0} max={2} step={0.1} onChange={(temperature) => updateSampling(m.id, ROWS.temperature, { temperature })} />
                      </Row>
                      <Row meta={ROWS.topP}>
                        <Stepper value={m.sampling.topP} min={0.01} max={1} step={0.05} onChange={(topP) => updateSampling(m.id, ROWS.topP, { topP })} />
                      </Row>
                    </div>
                    <Row meta={ROWS.length} layout="stack">
                      <Chips
                        value={(activeLengthPreset(m.sampling.maxTokens)?.label as string | undefined) ?? null}
                        onChange={(label) => {
                          const preset = LENGTH_PRESETS.find((p) => p.label === label)
                          if (preset) updateSampling(m.id, ROWS.length, { maxTokens: preset.value }, preset.label)
                        }}
                        chips={LENGTH_PRESETS.map((p) => ({ value: p.label, label: p.label, hint: p.hint }))}
                      />
                    </Row>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Row meta={ROWS.maxTokens}>
                        <Stepper value={m.sampling.maxTokens} min={-1} max={131072} step={128} onChange={(maxTokens) => updateSampling(m.id, ROWS.maxTokens, { maxTokens })} />
                      </Row>
                      <Row meta={ROWS.topK}>
                        <Stepper value={m.sampling.topK} min={-1} max={500} step={1} onChange={(topK) => updateSampling(m.id, ROWS.topK, { topK })} />
                      </Row>
                      <Row meta={ROWS.minP}>
                        <Stepper value={m.sampling.minP} min={-1} max={1} step={0.01} onChange={(minP) => updateSampling(m.id, ROWS.minP, { minP })} />
                      </Row>
                      <Row meta={ROWS.seed} layout="stack">
                        <Field
                          value={m.sampling.seed === null ? '' : String(m.sampling.seed)}
                          placeholder="random"
                          onCommit={(text) => {
                            const n = parseTyped(text)
                            updateSampling(m.id, ROWS.seed, { seed: Number.isFinite(n) ? Math.round(n) : null }, Number.isFinite(n) ? String(Math.round(n)) : 'random')
                          }}
                        />
                      </Row>
                    </div>
                  </Fold>
                </Fold>
              )
            })}
          </div>
        </Row>
      </Section>

      <PipelineSection settings={settings} apply={apply} />

      <EvalSection settings={settings} availableModels={availableModels} onScores={setEvalScores} />
    </div>
  )
}

/** The role palette's swatches, for the Chips picker. Hues from lib/colors.ts, as colours. */
const SWATCH: Record<AccentColor, string> = { blue: '#3b82f6', purple: '#a855f7', green: '#22c55e' }

/** The collaborative chain: which roles take part, and in what order. Was the Pipeline tab. */
function PipelineSection({ settings, apply }: { settings: AppSettings; apply: ApplySettings }): JSX.Element {
  const enabled = settings.models.filter((m) => m.enabled)
  // The chain can hold ids for slots that no longer exist (a reset, an edited
  // config). Drop them so the rendered list and the stored array stay aligned.
  const live = settings.pipeline.filter((id) => settings.models.some((m) => m.id === id))
  const ordered = live.map((id) => settings.models.find((m) => m.id === id) as ModelConfig)
  const set = (pipeline: string[], shown: string): void => apply(ROWS.pipeline, { pipeline }, shown)
  const move = (index: number, delta: -1 | 1): void => {
    const next = [...live]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    set(next, `${ordered[index]!.roleName} ${delta < 0 ? 'earlier' : 'later'}`)
  }
  return (
    <Section title="Pipeline" description={ROWS.pipeline.help}>
      <Row meta={ROWS.pipeline} bare>
        {enabled.length === 0 ? (
          <Notice tone="muted">No role is enabled. Enable one above first.</Notice>
        ) : (
          <div className="space-y-1.5">
            {enabled.map((m) => {
              const at = live.indexOf(m.id)
              return (
                <div key={m.id} data-list-row className="flex items-center gap-3 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/10">
                  <span className="w-5 text-center text-xs tabular-nums text-ink-tertiary">{at >= 0 ? at + 1 : '–'}</span>
                  <RoleDot color={m.color} />
                  <span className="min-w-0 flex-1 truncate">{m.roleName}</span>
                  <span className="truncate font-mono text-xs text-ink-tertiary">{m.modelId || 'no model'}</span>
                  {at >= 0 && (
                    <span className="flex gap-1">
                      <Button kind="ghost" onClick={() => move(at, -1)} disabled={at === 0} aria-label={`Move ${m.roleName} earlier`}>
                        ◀
                      </Button>
                      <Button kind="ghost" onClick={() => move(at, 1)} disabled={at === ordered.length - 1} aria-label={`Move ${m.roleName} later`}>
                        ▶
                      </Button>
                    </span>
                  )}
                  <Switch size="sm" label={`${m.roleName} in the pipeline`} checked={at >= 0} onChange={(on) => set(on ? [...live, m.id] : live.filter((id) => id !== m.id), `${m.roleName} ${on ? 'added' : 'removed'}`)} />
                </div>
              )
            })}
          </div>
        )}
      </Row>
    </Section>
  )
}

/**
 * The tool-choice eval against every loaded model (Layer 0c), from Settings.
 * The shared runner (lib/evalRunner.ts) is the same code the CLI shells; here
 * the transport is a loopback fetch and progress renders on the row. A
 * cancelled run still saves what it measured. Moved here from the modal in
 * v4.0, where it was one of two dozen pieces of tab state.
 */
function EvalSection({ settings, availableModels, onScores }: { settings: AppSettings; availableModels: ModelInfo[]; onScores: (s: EvalScoreSummary[]) => void }): JSX.Element {
  const [run, setRun] = useState<{ model: string; modelIndex: number; modelCount: number; fixtureIndex: number; fixtureCount: number; last: string } | null>(null)
  const [notice, setNotice] = useState<ActionResult | null>(null)
  const cancel = useRef(false)

  const runEval = useCallback(async (): Promise<void> => {
    if (run) return
    const models = availableModels.filter((m) => m.loaded).map((m) => m.id)
    if (models.length === 0) {
      setNotice({ tone: 'warn', text: 'No loaded models to evaluate — load one in LM Studio first.' })
      return
    }
    setNotice(null)
    cancel.current = false
    let fixtures, tools
    try {
      ;({ fixtures, tools } = await window.api.evalFixtures())
    } catch (err) {
      setNotice({ tone: 'danger', text: `Could not load eval fixtures: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    if (fixtures.length === 0) {
      setNotice({ tone: 'warn', text: 'Eval fixtures are unavailable in this build (they live in the dev checkout).' })
      return
    }
    const baseUrl = settings.baseUrl
    const complete = async (model: string, messages: ApiMessage[], wireTools: ToolSchema[]): Promise<{ content: string; toolCalls: ApiToolCall[] }> => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(240_000),
        body: JSON.stringify({ model, messages, stream: false, temperature: 0, ...(wireTools.length > 0 ? { tools: wireTools, tool_choice: 'auto' } : {}) })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[] }
      return parseCompletionMessage(json.choices?.[0]?.message ?? {}, wireTools.map((t) => t.function.name))
    }
    try {
      const results = await runToolChoiceEval({
        models,
        fixtures,
        tools,
        systemPromptFor: (model) => withToolCallPreamble(withGrounding('You are a helpful local assistant.'), model),
        complete,
        onFixture: (model, index, total, r) => {
          const mark = r.error ? '!' : r.correct === false || r.spurious === true || r.looped ? '✗' : '✓'
          setRun({ model, modelIndex: models.indexOf(model) + 1, modelCount: models.length, fixtureIndex: index, fixtureCount: total, last: `${mark} ${r.file}` })
        },
        shouldStop: () => cancel.current
      })
      for (const { model, runs, rates } of results) {
        await window.api.saveEvalResult({
          model,
          baseUrl,
          ranAt: new Date().toISOString(),
          caveats: ['tool results canned stubs', 'temperature 0', 'run in-app'],
          scores: { correctTool: rates.correctTool, spuriousCall: rates.spuriousCall, argValidity: rates.argValidity, loop: rates.loop },
          runs
        })
      }
      const summary = results.map((r) => `${r.model}: ${r.rates.correctTool.hit}/${r.rates.correctTool.of}`).join(' · ')
      setNotice({ tone: cancel.current ? 'warn' : 'ok', text: (cancel.current ? 'Cancelled — partial results saved. ' : 'Done. ') + summary })
      void window.api.evalScores().then(onScores).catch(() => {})
    } catch (err) {
      setNotice({ tone: 'danger', text: `Eval failed: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setRun(null)
    }
  }, [availableModels, onScores, run, settings.baseUrl])

  return (
    <Section title="Measure" description="The tool-choice suite, run from here against every loaded model.">
      <Row meta={ROWS.eval} layout="stack" foot={run ? <span className="text-xs text-ink-secondary">Model {run.modelIndex}/{run.modelCount} ({run.model}) — fixture {run.fixtureIndex}/{run.fixtureCount} <span className="font-mono">{run.last}</span></span> : undefined}>
        {run ? (
          <ActionRow action="Cancel" onAction={() => { cancel.current = true }} result={{ tone: 'info', text: 'Running…' }} />
        ) : (
          <ActionRow action="Run eval" onAction={() => void runEval()} result={notice} />
        )}
      </Row>
    </Section>
  )
}

/**
 * v3.1 (S6): the slow-reading verdict where VIBE's reader can find it. VIBE
 * draws no stats, so a reply there that waited a minute for its first word
 * says nothing about why; this says it beside the slot, from the model's most
 * recent reply (lib/modelFit.ts `latestSlowReading`).
 */
function SlowReadingNote({ modelId, loadedContextLength }: { modelId: string; loadedContextLength?: number }): JSX.Element | null {
  const conversations = useAppStore((s) => s.conversations)
  const reading = React.useMemo(() => latestSlowReading(conversations, modelId), [conversations, modelId])
  if (!reading) return null
  return (
    <p className="mt-1.5 text-xs text-ink-secondary" data-slow-reading="true">
      🐢 Its last reply {slowReadingFact(reading)}. {slowReadingAdvice(loadedContextLength)}
    </p>
  )
}
