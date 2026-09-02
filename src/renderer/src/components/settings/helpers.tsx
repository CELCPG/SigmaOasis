// Helpers the Settings tabs share, moved out of SettingsModal.tsx with them (v2.4).

import React from 'react'
import type { EvalScoreSummary } from '../../types'
import { describeProfile, profileFor } from '../../lib/modelProfiles'
import { describeEvalScore } from '../../lib/modelInfo'

export /**
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
export /**
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
    <p className="mt-1 text-xs text-ink-tertiary" title={tip}>
      Profile: {line}
    </p>
  )
}
export function EvalScoreLine({
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
      className="mt-1 text-xs text-ink-tertiary"
      title={`Measured by the local tool-choice eval (npm run eval:tools) against canned tool results; newest run ${new Date(score.ranAt).toLocaleString()}.`}
    >
      Eval: {text} · {new Date(score.ranAt).toLocaleDateString()}
    </p>
  )
}
