// Helpers the Settings tabs share, moved out of SettingsModal.tsx with them (v2.4).

import React from 'react'
import type { EvalScoreSummary } from '../../types'
import { describeProfile, profileFor } from '../../lib/modelProfiles'
import { describeEvalScore } from '../../lib/modelInfo'

/*
 * The surface of a text field, select or textarea in a settings tab. Tailwind's
 * preflight gives form controls `color: inherit` and leaves their background to
 * the browser, so a control written with layout classes alone (`mt-1 w-full`)
 * drew the theme's ink on the browser's white field: white on white in the dark
 * theme, in Settings → MCP, Jobs and every model's Code Mode through v2.8.0.
 * `outline-none` is safe here — the element-level :focus-visible rule in
 * index.css outranks it and puts the ring back. test/fieldContrastCheck.ts
 * reads every field in the built app, in both themes.
 */
const FIELD_SURFACE = 'rounded-lg border border-black/10 dark:border-white/10 bg-transparent outline-none'
export const FIELD = `${FIELD_SURFACE} px-3 py-2 text-sm`
/** The same surface, sized for a control in a list row beside small buttons. */
export const FIELD_COMPACT = `${FIELD_SURFACE} px-2 py-1 text-xs`

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
