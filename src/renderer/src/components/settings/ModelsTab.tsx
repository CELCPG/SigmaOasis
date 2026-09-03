// Extracted from SettingsModal.tsx (v2.4): the "models" tab, as it was. Pure prop-drilling —
// every piece of state and every handler still lives in the modal and arrives here as a prop,
// so nothing about ordering, effects or behaviour changed; the modal just stopped being 2,500 lines.

import React from 'react'
import { ACCENT_KEYS, ACCENT } from '../../lib/colors'
import { modelLabel } from '../../lib/modelInfo'
import type { AppSettings, AccentColor, EvalScoreSummary, ModelConfig, ToolToggles, SamplingSettings } from '../../types'
import { TOOL_LABELS } from '../../../../shared/tools'
import {
  LENGTH_PRESETS,
  TEMPERATURE_PRESETS,
  activeLengthPreset,
  activePreset,
  recommendedSampling
} from '../../lib/sampling'
import type { ModelInfo } from '../../types'
import { EvalScoreLine, ProfileLine } from './helpers'

export interface ModelsTabProps {
  availableModels: ModelInfo[]
  draft: AppSettings
  evalCancelRef: React.MutableRefObject<boolean>
  evalNotice: string | null
  evalRun: { model: string; modelIndex: number; modelCount: number; fixtureIndex: number; fixtureCount: number; last: string; } | null
  evalScores: EvalScoreSummary[]
  runEval: () => Promise<void>
  update: (partial: Partial<AppSettings>) => void
  updateModel: (id: string, partial: Partial<AppSettings["models"][number]>) => void
  updateSampling: (id: string, partial: Partial<SamplingSettings>) => void
}

export function ModelsTab(props: ModelsTabProps): JSX.Element {
  const { availableModels, draft, evalCancelRef, evalNotice, evalRun, evalScores, runEval, update, updateModel, updateSampling } = props
  return (
    <div className="space-y-5">
                    <div className="rounded-xl border border-black/10 dark:border-white/10 p-4">
                      <div className="flex items-center gap-3">
                        <div className="flex-1">
                          <div className="text-sm font-medium">Tool-choice eval</div>
                          <p className="mt-0.5 text-xs text-ink-tertiary">
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
                        <p className="mt-2 text-xs text-ink-secondary">
                          Model {evalRun.modelIndex}/{evalRun.modelCount} ({evalRun.model}) — fixture{' '}
                          {evalRun.fixtureIndex}/{evalRun.fixtureCount}{' '}
                          <span className="font-mono">{evalRun.last}</span>
                        </p>
                      )}
                      {evalNotice && !evalRun && (
                        <p className="mt-2 text-xs text-ink-secondary">{evalNotice}</p>
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
                            <label className="mb-1 block text-xs font-medium text-ink-secondary">
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
                            <label className="mb-1 block text-xs font-medium text-ink-secondary">
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
                          <label className="mb-1 block text-xs font-medium text-ink-secondary">
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
                          <p className="mt-1 text-xs text-ink-tertiary">
                            History compaction and the context meter budget against this number. Leave
                            empty to trust LM Studio; set it when the server under-reports the window
                            or you loaded the model with a larger one.
                          </p>
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-xs font-medium text-ink-secondary">
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
                            <label className="mb-1 block text-xs font-medium text-ink-secondary">
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
                            <label className="mb-1 block text-xs font-medium text-ink-secondary">
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
                        <p className="mt-1 text-xs text-ink-tertiary">
                          How other models and the pre-flight router decide what to send this role.
                          Capability is the one-line declaration shown in the consult roster; Specialty
                          is what the router matches on (code → Coding, finance questions → Finance,
                          factual questions → Research). Leave Specialty at General to opt out of
                          auto-routing.
                        </p>

                        <div className="mt-3 flex items-center gap-2">
                          <span className="text-xs font-medium text-ink-secondary">Accent:</span>
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
                          <span className="ml-2 text-xs text-ink-tertiary">
                            Route with <code>@{m.roleName.replace(/\s+/g, '')}</code>
                          </span>
                        </div>

                        <label className="mt-3 block text-xs">
                          Code Mode
                          <select
                            className="mt-1 w-full"
                            value={m.codeMode ?? 'native'}
                            onChange={(e) => updateModel(m.id, { codeMode: e.target.value === 'native' ? undefined : (e.target.value as 'code' | 'both') })}
                            aria-label={`${m.roleName} code mode`}
                          >
                            <option value="native">native — tools as calls (default)</option>
                            <option value="code">code — one tool, run_code, whose Python program calls the others</option>
                            <option value="both">both</option>
                          </select>
                          <span className="mt-0.5 block text-ink-tertiary">
                            A program in the sandbox reaches this role&rsquo;s tools through a generated <code>tools</code>{' '}
                            module, with the same allowlist, budgets and audit as direct calls. Measured in{' '}
                            <code>docs/evals.md</code> before any default was chosen.
                          </span>
                        </label>
                        <details className="mt-3">
                          <summary className="cursor-pointer text-xs font-medium text-ink-secondary">
                            Tools
                            <span className="ml-1 font-normal text-ink-tertiary">
                              {m.tools
                                ? `${m.tools.filter((t) => draft.tools[t as keyof ToolToggles]).length} of ${(Object.keys(TOOL_LABELS) as (keyof ToolToggles)[]).filter((k) => draft.tools[k]).length} enabled`
                                : 'all enabled tools'}
                            </span>
                          </summary>
                          <div className="mt-2">
                            {m.tools === undefined ? (
                              <div className="flex items-center gap-3">
                                <p className="flex-1 text-xs text-ink-tertiary">
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
                                  <p className="flex-1 text-xs text-ink-tertiary">
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
                          <summary className="cursor-pointer text-xs font-medium text-ink-secondary">
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
                                        : 'bg-black/5 dark:bg-white/10 text-ink-secondary hover:text-ink-primary'
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
                                    className="rounded-full bg-black/5 dark:bg-white/10 px-2.5 py-1 text-xs text-ink-secondary transition-colors hover:text-ink-primary"
                                  >
                                    {recommendedSampling(m.modelId)!.label} defaults
                                  </button>
                                )}
                              </div>
                            </div>
                            <div>
                              <label className="mb-1 block text-xs text-ink-secondary">Temperature</label>
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
                              <label className="mb-1 block text-xs text-ink-secondary">Top P</label>
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
                              <div className="mb-1 text-xs text-ink-secondary">Reply length</div>
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
                                        : 'bg-black/5 dark:bg-white/10 text-ink-secondary hover:text-ink-primary'
                                    }`}
                                  >
                                    {p.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div>
                              <label className="mb-1 block text-xs text-ink-secondary">Max tokens</label>
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
                              <label className="mb-1 block text-xs text-ink-secondary">Top K</label>
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
                              <label className="mb-1 block text-xs text-ink-secondary">Min P</label>
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
                              <label className="mb-1 block text-xs text-ink-secondary">Seed</label>
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
                          <p className="mt-2 text-xs text-ink-tertiary">
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
                      <p className="mt-1 text-xs text-ink-secondary">
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
                          <label className="text-xs text-ink-secondary">Reviewing role</label>
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
                          <p className="col-span-2 text-xs text-ink-tertiary">
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
                              <span className="mt-0.5 block text-xs text-ink-secondary">
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
                          <span className="mt-0.5 block text-xs text-ink-secondary">
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
                          <span className="mt-0.5 block text-xs text-ink-secondary">
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
                          <span className="mt-0.5 block text-xs text-ink-secondary">
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
                          <span className="mt-0.5 block text-xs text-ink-secondary">
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
                          <span className="mt-0.5 block text-xs text-ink-secondary">
                            From the fourth turn on, the model is handed a mechanical record of what this
                            conversation has established: figures a tool computed, files attached, Python
                            session variables, and constraints you stated (&ldquo;budget is $2,000&rdquo;) —
                            exact strings from tool results and your own words, never from earlier
                            replies, so a small model refers back instead of re-remembering. Disclosed
                            under the reply (&ldquo;📒 Ledger as this turn began&rdquo;) — the record
                            is written before the model answers, so a variable defined by a call in
                            that same reply is counted from the next turn on.
                          </span>
                        </span>
                      </label>

                      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.grounding.factLedger}
                          onChange={(e) => update({ grounding: { ...draft.grounding, factLedger: e.target.checked } })}
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Fact ledger — verification that compounds
                          <span className="mt-0.5 block text-xs text-ink-secondary">
                            A price, a measurement, an address, a contact, a URL or a date the reply
                            states <em>and a retrieved source states too</em> is kept, with the source
                            and the date it was checked, in a library pack the app writes. The next
                            factual ask consults it before the app-run search: a fresh entry answers
                            with its date and the search is skipped; an expired one (prices expire in a
                            day, addresses in months, a founding year never) is re-checked and a changed
                            value is disclosed under the reply. Nothing but the app writes it. Off turns
                            recall and capture off together.
                          </span>
                        </span>
                      </label>

                      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.grounding.outline}
                          onChange={(e) => update({ grounding: { ...draft.grounding, outline: e.target.checked } })}
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Outline long documents first
                          <span className="mt-0.5 block text-xs text-ink-secondary">
                            A request shaped like a document — an explicit length of 800 words or more,
                            or a named form with its sections listed — is written from a JSON outline,
                            one section at a time, each a bounded completion, so a small model writes the
                            document it promised instead of drifting after a few hundred words. No tools
                            ride the sections. Disclosed under the reply (&ldquo;📑 Outlined first&rdquo;).
                            Off by default: the longform suite in <code>docs/evals.md</code> says what it
                            measured.
                          </span>
                        </span>
                      </label>
                    </div>
                  </div>
  )
}
