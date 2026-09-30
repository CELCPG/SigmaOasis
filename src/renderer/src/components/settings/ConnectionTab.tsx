// Settings → LM Studio (v4.0, S4): the server every model runs on, as a
// status hero, the address as a field that commits on Enter or blur, and the
// detected models as rows — what each is, whether it is loaded, which role
// uses it — instead of a monospace bullet list.

import { useEffect, useState } from 'react'
import type { AppSettings, ConnectionStatus, ModelInfo } from '../../types'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { fitSentence, fitVerdict } from '../../lib/modelFit'
import { isLoopbackUrl } from './helpers'
import { ActionRow, Button, Card, Field, Notice, RoleDot, Row, Section, StatusDot, type ActionResult } from './kit'

export const ROWS = defineRows('connection', {
  baseUrl: { label: 'Server address', help: 'LM Studio’s OpenAI-compatible endpoint on this machine. Applies when you press Enter or leave the field.', keywords: ['url', 'base url', 'endpoint', 'port', '1234'] },
  machine: { label: 'This machine', help: 'The GPU as its own tool reports it, and whether it has been reporting errors. A model is judged against it before its first slow reply.', keywords: ['gpu', 'vram', 'card', 'memory', 'nvidia', 'errors'] },
  models: { label: 'Detected models', help: 'What the server lists right now, which role uses each, whether it fits the card, and Load or Unload on your click.', keywords: ['loaded', 'quantization', 'context', 'load', 'unload'] },
  drafts: { label: 'Draft models refused', help: 'A role’s draft model LM Studio would not take this session. Those replies went without it — nothing failed — and it is not sent again until the app restarts. Usually the two models’ vocabularies differ; pick a smaller model of the same family under Roles.', keywords: ['draft', 'speculative', 'refused'] }
})
registerRows(ROWS)

type Gpu = Awaited<ReturnType<typeof window.api.gpuInfo>>

export interface ConnectionTabProps {
  settings: AppSettings
  apply: ApplySettings
  availableModels: ModelInfo[]
  connection: ConnectionStatus
  refresh: () => Promise<void>
}

function connectionResult(connection: ConnectionStatus, count: number): ActionResult {
  if (connection === 'online') return { tone: 'ok', text: `Connected — ${count} model${count === 1 ? '' : 's'} listed` }
  if (connection === 'connecting') return { tone: 'info', text: 'Connecting…' }
  return { tone: 'danger', text: 'Offline — is LM Studio running with the server started?' }
}

function contextLabel(m: ModelInfo): string {
  const ctx = m.loadedContextLength ?? m.maxContextLength
  return ctx ? `${Math.round(ctx / 1024)}K ctx` : ''
}

export function ConnectionTab({ settings, apply, availableModels, connection, refresh }: ConnectionTabProps): JSX.Element {
  const loaded = availableModels.filter((m) => m.loaded).length
  const usedBy = (id: string): string[] => settings.models.filter((m) => m.enabled && m.modelId === id).map((m) => m.roleName)
  const [gpu, setGpu] = useState<Gpu | undefined>(undefined)
  const [acting, setActing] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ id: string; result: ActionResult } | null>(null)
  const [drafts, setDrafts] = useState<Awaited<ReturnType<typeof window.api.draftNotices>>>([])
  useEffect(() => {
    void window.api.gpuInfo().then(setGpu).catch(() => setGpu(null))
    void window.api.draftNotices().then(setDrafts).catch(() => setDrafts([]))
  }, [])
  // v4.2 (S8): a model some role drafts with is judged with its draft on the card too.
  const draftOf = (id: string): ModelInfo | { id: string } | undefined => {
    const name = settings.models.find((r) => r.enabled && r.modelId === id && r.draftModel)?.draftModel
    return name ? (availableModels.find((am) => am.id === name) ?? { id: name }) : undefined
  }
  const act = (id: string, verb: 'load' | 'unload'): void => {
    setActing(id)
    void (verb === 'load' ? window.api.modelsLoad(id) : window.api.modelsUnload(id))
      .then((r) => setOutcome({ id, result: { tone: r.ok ? 'ok' : 'danger', text: r.detail } }))
      .catch((e: unknown) => setOutcome({ id, result: { tone: 'danger', text: String(e) } }))
      .finally(() => {
        setActing(null)
        void refresh()
      })
  }
  return (
    <div className="space-y-8">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={connection === 'online' ? 'ok' : connection === 'connecting' ? 'info' : 'danger'} pulse={connection === 'connecting'} />
            LM Studio
          </span>
        }
        status={connection === 'online' ? `${loaded} of ${availableModels.length} loaded` : undefined}
        right={<ActionRow action="Test" onAction={() => void refresh()} result={connectionResult(connection, availableModels.length)} />}
      >
        <Row meta={ROWS.baseUrl} layout="stack">
          <Field value={settings.baseUrl} mono placeholder="http://127.0.0.1:1234/v1" onCommit={(baseUrl) => { apply(ROWS.baseUrl, { baseUrl }); void refresh() }} />
        </Row>
        {!isLoopbackUrl(settings.baseUrl) && (
          <Notice tone="warn" className="mt-3">
            Only servers on this machine are supported. This address will not be kept — Sigma Oasis reverts to the default. LM Studio traffic
            carries your conversations in plaintext and is deliberately never proxied, so a non-loopback address would send them off-machine unprotected.
          </Notice>
        )}
      </Card>

      <Section title="This machine" description="What the model is judged against.">
        <Row meta={ROWS.machine}>
          <span className="text-sm text-ink-secondary">
            {gpu === undefined ? 'Reading…' : gpu === null ? 'No GPU tool answered (nvidia-smi is what the app reads); fit is not judged.' : `${gpu.name} · ${(gpu.memoryBytes / 1024 ** 3).toFixed(0)} GB`}
          </span>
        </Row>
        {gpu?.pcieReplays !== null && gpu?.pcieReplays !== undefined && gpu.pcieReplays > 0 && (
          <Notice tone="warn">
            The GPU reports {gpu.pcieReplays.toLocaleString()} PCIe replays since the driver last reset. A count that keeps rising while a model runs is the card or its slot, not the model — a slow reply
            during it says nothing about fit.
          </Notice>
        )}
      </Section>

      <Section title="Models" description={ROWS.models.help}>
        <Row meta={ROWS.models} bare>
          {availableModels.length === 0 ? (
            <Notice tone="muted">Nothing listed. Start LM Studio’s server, load a model, and press Test.</Notice>
          ) : (
            <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
              {availableModels.map((m) => {
                const roles = usedBy(m.id)
                const verdict = gpu && m.type !== 'embeddings' ? fitVerdict(m, gpu.memoryBytes, draftOf(m.id)) : null
                return (
                  <li key={m.id} data-list-row className="flex items-center gap-3 px-3 py-2">
                    <StatusDot tone={m.loaded ? 'ok' : 'muted'} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs text-ink-primary">{m.id}</div>
                      <div className="text-xs text-ink-tertiary">
                        {[m.type === 'embeddings' ? 'embeddings' : m.vision ? 'vision' : m.arch, m.quantization, contextLabel(m), m.loaded ? 'loaded' : 'not loaded']
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                      {verdict && <div className={`text-xs ${verdict.kind === 'fits' ? 'text-ink-tertiary' : verdict.kind === 'tight' ? 'text-ink-warn' : 'text-ink-danger'}`}>{fitSentence(verdict, m.id)}</div>}
                      {outcome?.id === m.id && <div className={`text-xs ${outcome.result.tone === 'ok' ? 'text-ink-ok' : 'text-ink-danger'}`}>{outcome.result.text}</div>}
                    </div>
                    <Button busy={acting === m.id ? '…' : undefined} onClick={() => act(m.id, m.loaded ? 'unload' : 'load')} title={m.loaded ? 'Unload it from LM Studio' : 'Load it in LM Studio, pinned so the app’s embedding calls do not evict it'}>
                      {m.loaded ? 'Unload' : 'Load'}
                    </Button>
                    {roles.length > 0 && (
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
                        {settings.models
                          .filter((r) => r.enabled && r.modelId === m.id)
                          .map((r) => (
                            <span key={r.id} className="inline-flex items-center gap-1">
                              <RoleDot color={r.color} size="sm" />
                              {r.roleName}
                            </span>
                          ))}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Row>
        {drafts.length > 0 && (
          <Row meta={ROWS.drafts} layout="stack">
            <Notice tone="muted">
              {drafts.map((d) => (
                <div key={`${d.model}::${d.draft}`} className="text-xs">
                  <code>{d.draft}</code> for <code>{d.model}</code>: {d.detail || 'refused'}
                </div>
              ))}
            </Notice>
          </Row>
        )}
      </Section>
    </div>
  )
}
