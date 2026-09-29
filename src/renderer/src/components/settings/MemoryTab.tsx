// Settings → Memory (v4.0, S4): a status card, the two settings, and the
// knowledge base as rows that take two clicks to forget.
import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, MemoryStats } from '../../types'
import { MEMORY_ORIGIN_LABELS } from '../../../../shared/memoryOrigin'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { ActionRow, Button, Card, DangerRow, Field, Notice, Row, Section, Slider, StatusDot, Switch, type ActionResult } from './kit'

export const ROWS = defineRows('memory', {
  autoContext: { label: 'Recall automatically', help: 'Relevant memories ride every turn without being asked for. A model can always search them with memory_search.', keywords: ['recall', 'context', 'auto'] },
  topK: { label: 'Memories to recall per turn', help: 'The most relevant chunks handed to the model each turn.', keywords: ['top k', 'chunks'] },
  embeddingModel: { label: 'Embedding model', help: 'Leave empty to use the first loaded model whose name contains “embed”. Applies when you press Enter or leave the field.', keywords: ['nomic', 'embeddings'] },
  knowledge: { label: 'Knowledge base', help: 'Documents you added and memories models saved, each removable here. Notes created by models are indexed automatically.', keywords: ['documents', 'sources', 'forget'] }
})
registerRows(ROWS)

export interface MemoryTabProps {
  settings: AppSettings
  apply: ApplySettings
  defaults: AppSettings | null
}

export function MemoryTab({ settings, apply, defaults }: MemoryTabProps): JSX.Element {
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [notice, setNotice] = useState<ActionResult | null>(null)
  const refresh = useCallback(() => {
    void window.api.memoryStats().then(setStats)
  }, [])
  useEffect(refresh, [refresh])
  const memory = settings.memory
  const set = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['memory']>): void => apply(meta, { memory: { ...memory, ...patch } })
  const status: ActionResult = stats === null ? { tone: 'info', text: 'Checking…' } : stats.available ? { tone: 'ok', text: `Ready — ${stats.totalChunks.toLocaleString()} of ${stats.maxChunks.toLocaleString()} chunks indexed` } : { tone: 'danger', text: 'No embedding model detected' }

  return (
    <div className="space-y-8">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={status.tone} />
            Memory
          </span>
        }
        status={stats?.embeddingModel ? `embedding with ${stats.embeddingModel}` : undefined}
        right={<ActionRow action="Refresh" onAction={refresh} result={status} />}
      >
        {stats && !stats.available && stats.reason && <Notice tone="warn">{stats.reason}</Notice>}
        {stats?.mixedModels && (
          <Notice tone="warn" className="mt-2">
            Some sources were indexed with a different embedding model and can’t be searched by the current one. Remove and re-add them below, or switch back to the model that indexed them.
          </Notice>
        )}
      </Card>

      <Section title="Recall" description="How memories reach a conversation." onReset={defaults ? () => apply({ id: 'memory.reset', label: 'Memory' }, { memory: defaults.memory }, 'defaults') : undefined}>
        <Row meta={ROWS.autoContext}>
          <Switch checked={memory.autoContext} onChange={(autoContext) => set(ROWS.autoContext, { autoContext })} />
        </Row>
        <Row meta={ROWS.topK}>
          <Slider value={memory.topK} min={1} max={8} onCommit={(topK) => set(ROWS.topK, { topK })} />
        </Row>
        <Row meta={ROWS.embeddingModel} layout="stack">
          <Field value={memory.embeddingModel} mono placeholder={stats?.embeddingModel ?? 'auto-detect'} onCommit={(embeddingModel) => set(ROWS.embeddingModel, { embeddingModel })} />
        </Row>
      </Section>

      <Section
        title="Knowledge base"
        description={ROWS.knowledge.help}
        right={
          <Button
            onClick={() =>
              void window.api.pickFile().then(async (p) => {
                if (!p) return
                setNotice({ tone: 'info', text: 'Indexing…' })
                const res = await window.api.memoryAddDocumentFromPath(p)
                setNotice(res.ok ? { tone: 'ok', text: `Indexed “${res.name}” (${res.chunks} chunk${res.chunks === 1 ? '' : 's'}${res.truncated ? ', truncated' : ''}).` } : { tone: 'danger', text: res.error ?? 'Indexing failed.' })
                refresh()
              })
            }
          >
            + Add document
          </Button>
        }
      >
        <Row meta={ROWS.knowledge} bare>
          <div className="space-y-2">
            {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
            {(stats?.untrustedChunks ?? 0) > 0 && (
              <DangerRow
                label={`${stats!.untrustedChunks} chunk${stats!.untrustedChunks === 1 ? '' : 's'} saved by a model after it read web or server content`}
                detail="Never added to a conversation automatically; a model can still find them with memory_search."
                action="Forget them"
                confirm="Forget web-origin memory?"
                onConfirm={() =>
                  window.api.memoryDeleteOrigin('untrusted').then((r) => {
                    setNotice(r.ok ? { tone: 'ok', text: `Forgot ${r.removed ?? 0} chunk(s) of web-origin memory.` } : { tone: 'danger', text: r.error ?? 'Could not forget them.' })
                    refresh()
                  })
                }
              />
            )}
            {(stats?.sources.length ?? 0) === 0 ? (
              <Notice tone="muted">Nothing indexed yet. Notes created by models are indexed automatically; models can also save memories with the memory_save tool.</Notice>
            ) : (
              stats!.sources.map((s) => (
                <DangerRow
                  key={s.source}
                  label={s.source}
                  detail={`${s.chunks} chunk${s.chunks === 1 ? '' : 's'}${s.origin !== 'user' ? ` · ${MEMORY_ORIGIN_LABELS[s.origin]}` : ''}`}
                  action="Forget"
                  confirm="Forget this?"
                  onConfirm={() => window.api.memoryDeleteSource(s.source).then(refresh)}
                />
              ))
            )}
          </div>
        </Row>
      </Section>
    </div>
  )
}
