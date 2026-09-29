// Settings → General, rebuilt on the control kit (v4.0, S2): the first tab to
// use it, and the pattern the others follow. Each row is declared once in
// ROWS — label, help, keywords — which is what the tab draws and what the
// settings index searches; the control beside it is the kit's, never a bare
// input. Every control applies as it commits (S3): `apply` writes the
// change, names the row in the toast, and offers Undo.

import React from 'react'
import type { AppSettings, UpdateStatus } from '../../types'
import { defineRows, registerRows } from '../../lib/settingsKit'
import type { ApplySettings } from '../../hooks/settingsApply'
import { ActionRow, Row, Section, Segmented, Select, Slider, Stepper, Switch, type ActionResult } from './kit'

export const ROWS = defineRows('general', {
  theme: { label: 'Theme', help: 'Light or dark. Previewed as you choose.', keywords: ['dark mode', 'light mode', 'appearance'] },
  fontSize: { label: 'Font size', help: 'The base size of everything in the window.', keywords: ['text size', 'zoom'] },
  historyLimit: { label: 'Conversations to keep', help: 'Beyond this, the oldest saved conversation is dropped when a new one is saved. Unsaved chats never count.', keywords: ['history', 'limit'] },
  hideToolCalls: { label: 'Hide tool-call details', help: 'Tool activity collapses to a quiet thinking animation and the chat stays clean.', keywords: ['tools', 'clean'] },
  vibeMode: { label: '〰 VIBE mode', help: 'The window becomes the conversation and nothing else, on slow night water, and replies are asked to be short. Tools, memory and every check still run — they are just not drawn. ⌘⇧L or Esc to come back.', keywords: ['vibe', 'calm', 'lagoon'] },
  showResponseStats: { label: 'Show response stats', help: 'Tokens per second and time to first token under each reply. When a server does not report token counts, only timing is shown.', keywords: ['tokens', 'speed', 'ttft'] },
  reasoningDisplay: { label: 'Reasoning display', help: 'How a model’s chain of thought appears above its reply. The reasoning itself is always kept.', keywords: ['thinking', 'chain of thought', 'thought'] },
  contextManagement: { label: 'When a conversation outgrows the context window', help: 'Summarizing costs one extra local model call when the limit is first reached and keeps the model aware of how the conversation began. Dropping is what versions before 0.8.2 did.', keywords: ['compact', 'trim', 'summarize', 'context'] },
  confirmPlan: { label: 'Show a plan for approval before it runs', help: 'One dialog with every step before anything runs — the moment to catch a plan that misread the task. Off means generated plans run at once.', keywords: ['plan mode', 'approve'] },
  maxSteps: { label: 'Steps per plan', help: 'Each step is a bounded sub-turn with the enabled tools.', keywords: ['plan'] },
  updates: { label: 'Updates', help: 'The version this window runs, and whether a newer one is ready.', keywords: ['version', 'about', 'update'] }
})
registerRows(ROWS)

export interface GeneralTabProps {
  checkForUpdates: () => Promise<void>
  settings: AppSettings
  installUpdate: () => void
  apply: ApplySettings
  /** The defaults, for a section's Reset; null until they have loaded. */
  defaults: AppSettings | null
  updateStatus: UpdateStatus | null
}

/** What the update row says, in one line and one tone. */
function updateResult(status: UpdateStatus | null): ActionResult | null {
  if (!status) return null
  switch (status.state) {
    case 'dev':
      return { tone: 'muted', text: 'Development build — updates apply to packaged releases.' }
    case 'checking':
      return { tone: 'info', text: 'Checking for updates…' }
    case 'available':
      return { tone: 'info', text: `Update ${status.version} found — downloading…` }
    case 'downloading':
      return { tone: 'info', text: `Downloading update… ${status.percent ?? 0}%` }
    case 'downloaded':
      return { tone: 'ok', text: `Update ${status.version} is ready to install.` }
    case 'error':
      return { tone: 'danger', text: `Update check failed: ${status.error ?? 'unknown error'}` }
    default:
      return { tone: 'ok', text: 'You’re up to date.' }
  }
}

export function GeneralTab(props: GeneralTabProps): JSX.Element {
  const { checkForUpdates, settings, installUpdate, apply, defaults, updateStatus } = props
  const ready = updateStatus?.state === 'downloaded'
  const busy = updateStatus?.state === 'checking' || updateStatus?.state === 'downloading'
  /** A section's Reset: those keys of the defaults, applied as one change. */
  const reset = (label: string, keys: (keyof AppSettings)[]): (() => void) | undefined =>
    defaults ? () => apply({ id: 'general.reset', label }, Object.fromEntries(keys.map((k) => [k, defaults[k]])) as Partial<AppSettings>, 'defaults') : undefined
  return (
    <div className="space-y-8">
      <Section title="Appearance" description="How the window looks. Both preview as you change them." onReset={reset('Appearance', ['theme', 'fontSize'])}>
        <Row meta={ROWS.theme}>
          <Segmented
            value={settings.theme}
            onChange={(theme) => apply(ROWS.theme, { theme })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
          />
        </Row>
        <Row meta={ROWS.fontSize}>
          <Slider
            value={settings.fontSize}
            min={12}
            max={20}
            format={(v) => `${v}px`}
            onPreview={(px) => {
              document.documentElement.style.fontSize = `${px}px`
            }}
            onCommit={(fontSize) => apply(ROWS.fontSize, { fontSize }, `${fontSize}px`)}
          />
        </Row>
      </Section>

      <Section title="Chat" description="What a reply shows around its words." onReset={reset('Chat', ['hideToolCalls', 'showResponseStats', 'reasoningDisplay', 'vibeMode'])}>
        <Row meta={ROWS.hideToolCalls}>
          <Switch checked={settings.hideToolCalls} onChange={(hideToolCalls) => apply(ROWS.hideToolCalls, { hideToolCalls })} />
        </Row>
        <Row meta={ROWS.showResponseStats}>
          <Switch checked={settings.showResponseStats} onChange={(showResponseStats) => apply(ROWS.showResponseStats, { showResponseStats })} />
        </Row>
        <Row meta={ROWS.reasoningDisplay}>
          <Select
            value={settings.reasoningDisplay}
            onChange={(v) => apply(ROWS.reasoningDisplay, { reasoningDisplay: v as AppSettings['reasoningDisplay'] })}
            options={[
              { value: 'collapsed', label: 'Collapsed behind a “Thought” header' },
              { value: 'expanded', label: 'Always expanded' },
              { value: 'hidden', label: 'Hidden' }
            ]}
          />
        </Row>
        <Row meta={ROWS.vibeMode}>
          <Switch checked={settings.vibeMode} onChange={(vibeMode) => apply(ROWS.vibeMode, { vibeMode })} />
        </Row>
      </Section>

      <Section
        title="Long conversations"
        description="What happens as a conversation grows, and how a multi-step plan runs."
        onReset={reset('Long conversations', ['contextManagement', 'historyLimit', 'plan'])}
      >
        <Row meta={ROWS.contextManagement}>
          <Select
            value={settings.contextManagement}
            onChange={(v) => apply(ROWS.contextManagement, { contextManagement: v as 'compact' | 'trim' })}
            options={[
              { value: 'compact', label: 'Summarize what no longer fits' },
              { value: 'trim', label: 'Drop it silently' }
            ]}
          />
        </Row>
        <Row meta={ROWS.historyLimit}>
          <Stepper value={settings.historyLimit} min={10} max={1000} step={10} onChange={(historyLimit) => apply(ROWS.historyLimit, { historyLimit })} />
        </Row>
        <Row meta={ROWS.confirmPlan}>
          <Switch checked={settings.plan.confirmPlan} onChange={(confirmPlan) => apply(ROWS.confirmPlan, { plan: { ...settings.plan, confirmPlan } })} />
        </Row>
        <Row meta={ROWS.maxSteps}>
          <Stepper value={settings.plan.maxSteps} min={1} max={10} onChange={(maxSteps) => apply(ROWS.maxSteps, { plan: { ...settings.plan, maxSteps } })} />
        </Row>
      </Section>

      <Section title="About" description={`Sigma Oasis v${updateStatus?.currentVersion ?? '…'}`}>
        <Row meta={ROWS.updates} layout="stack">
          {updateStatus?.state === 'dev' ? (
            <ActionRow action="Check now" onAction={() => undefined} disabled result={updateResult(updateStatus)} />
          ) : (
            <ActionRow
              action={ready ? 'Restart to update' : 'Check now'}
              kind={ready ? 'primary' : 'secondary'}
              onAction={() => (ready ? installUpdate() : void checkForUpdates())}
              busy={busy ? (updateStatus?.state === 'checking' ? 'Checking…' : 'Downloading…') : null}
              result={updateResult(updateStatus)}
            />
          )}
        </Row>
      </Section>
    </div>
  )
}
