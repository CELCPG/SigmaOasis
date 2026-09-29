// Settings → General, rebuilt on the control kit (v4.0, S2): the first tab to
// use it, and the pattern the others follow. Each row is declared once in
// ROWS — label, help, keywords — which is what the tab draws and what the
// settings index searches; the control beside it is the kit's, never a bare
// input. It still writes the modal's draft through `update` until S3 makes
// every control apply as it commits.

import React from 'react'
import type { AppSettings, UpdateStatus } from '../../types'
import { defineRows, registerRows } from '../../lib/settingsKit'
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
  draft: AppSettings
  installUpdate: () => void
  update: (partial: Partial<AppSettings>) => void
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
  const { checkForUpdates, draft, installUpdate, update, updateStatus } = props
  const ready = updateStatus?.state === 'downloaded'
  const busy = updateStatus?.state === 'checking' || updateStatus?.state === 'downloading'
  return (
    <div className="space-y-8">
      <Section title="Appearance" description="How the window looks. Both preview as you change them.">
        <Row meta={ROWS.theme}>
          <Segmented
            value={draft.theme}
            onChange={(theme) => update({ theme })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
          />
        </Row>
        <Row meta={ROWS.fontSize}>
          <Slider value={draft.fontSize} min={12} max={20} format={(v) => `${v}px`} onPreview={(fontSize) => update({ fontSize })} onCommit={(fontSize) => update({ fontSize })} />
        </Row>
      </Section>

      <Section title="Chat" description="What a reply shows around its words.">
        <Row meta={ROWS.hideToolCalls}>
          <Switch checked={draft.hideToolCalls} onChange={(hideToolCalls) => update({ hideToolCalls })} />
        </Row>
        <Row meta={ROWS.showResponseStats}>
          <Switch checked={draft.showResponseStats} onChange={(showResponseStats) => update({ showResponseStats })} />
        </Row>
        <Row meta={ROWS.reasoningDisplay}>
          <Select
            value={draft.reasoningDisplay}
            onChange={(v) => update({ reasoningDisplay: v as AppSettings['reasoningDisplay'] })}
            options={[
              { value: 'collapsed', label: 'Collapsed behind a “Thought” header' },
              { value: 'expanded', label: 'Always expanded' },
              { value: 'hidden', label: 'Hidden' }
            ]}
          />
        </Row>
        <Row meta={ROWS.vibeMode}>
          <Switch checked={draft.vibeMode} onChange={(vibeMode) => update({ vibeMode })} />
        </Row>
      </Section>

      <Section title="Long conversations" description="What happens as a conversation grows, and how a multi-step plan runs.">
        <Row meta={ROWS.contextManagement}>
          <Select
            value={draft.contextManagement}
            onChange={(v) => update({ contextManagement: v as 'compact' | 'trim' })}
            options={[
              { value: 'compact', label: 'Summarize what no longer fits' },
              { value: 'trim', label: 'Drop it silently' }
            ]}
          />
        </Row>
        <Row meta={ROWS.historyLimit}>
          <Stepper value={draft.historyLimit} min={10} max={1000} step={10} onChange={(historyLimit) => update({ historyLimit })} />
        </Row>
        <Row meta={ROWS.confirmPlan}>
          <Switch checked={draft.plan.confirmPlan} onChange={(confirmPlan) => update({ plan: { ...draft.plan, confirmPlan } })} />
        </Row>
        <Row meta={ROWS.maxSteps}>
          <Stepper value={draft.plan.maxSteps} min={1} max={10} onChange={(maxSteps) => update({ plan: { ...draft.plan, maxSteps } })} />
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
