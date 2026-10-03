// Settings → LM Studio (v4.0, S4): the server every model runs on, as a
// status hero, the address as a field that commits on Enter or blur, and the
// detected models as rows — what each is, whether it is loaded, which role
// uses it — instead of a monospace bullet list.

import { useEffect, useState } from 'react'
import type { AppSettings, ConnectionStatus, ModelInfo } from '../../types'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { fitSentence, fitVerdict } from '../../lib/modelFit'
import { serverName } from '../../lib/modelInfo'
import { isLoopbackUrl } from './helpers'
import { ActionRow, Button, Card, Field, Notice, RoleDot, Row, Section, Select, StatusDot, Switch, type ActionResult } from './kit'

export const ROWS = defineRows('connection', {
  baseUrl: { label: 'Server address', help: 'LM Studio’s OpenAI-compatible endpoint on this machine. Applies when you press Enter or leave the field.', keywords: ['url', 'base url', 'endpoint', 'port', '1234'] },
  machine: { label: 'This machine', help: 'The GPU as its own tool reports it, and whether it has been reporting errors. A model is judged against it before its first slow reply.', keywords: ['gpu', 'vram', 'card', 'memory', 'nvidia', 'errors'] },
  models: { label: 'Detected models', help: 'What the server lists right now, which role uses each, whether it fits the card, and Load or Unload on your click.', keywords: ['loaded', 'quantization', 'context', 'load', 'unload'] },
  drafts: { label: 'Draft models refused', help: 'A role’s draft model LM Studio would not take this session. Those replies went without it — nothing failed — and it is not sent again until the app restarts. Usually the two models’ vocabularies differ; pick a smaller model of the same family under Roles.', keywords: ['draft', 'speculative', 'refused'] },
  // 4.6 (J1): the agent connection.
  agentConnection: { label: 'Run the agent on its own server', help: 'Agent chats, the sigma command and agent jobs talk to this server instead. Chat, embeddings (the library, memory, tool ranking), titles and the model pin stay on LM Studio. If it does not answer, the agent says so and stops — it never falls back to LM Studio.', keywords: ['agent', 'second', 'llama-server', 'llama.cpp', '8081', '35b', 'connection'] },
  agentBaseUrl: { label: 'Agent server address', help: 'An OpenAI-compatible endpoint on this machine — llama.cpp’s llama-server, for one. Applies when you press Enter or leave the field.', keywords: ['agent', 'url', 'base url', 'endpoint', 'port', 'llama-server'] },
  agentModel: { label: 'Agent model', help: 'What the agent asks that server for. Sigma never loads or unloads a model there; it uses what the server is serving.', keywords: ['agent', 'model', 'llama-server'] }
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
            {serverName(availableModels[0])}
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

      <AgentConnectionCard settings={settings} apply={apply} />

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
                    {/* 4.5: llama-server serves the one model it was started with; there is no load or unload to ask it for. */}
                    {m.server !== 'llamacpp' && (
                      <Button busy={acting === m.id ? '…' : undefined} onClick={() => act(m.id, m.loaded ? 'unload' : 'load')} title={m.loaded ? 'Unload it from LM Studio' : 'Load it in LM Studio, pinned so the app’s embedding calls do not evict it'}>
                        {m.loaded ? 'Unload' : 'Load'}
                      </Button>
                    )}
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

type AgentCatalog = Awaited<ReturnType<typeof window.api.getAgentModelCatalog>>

/** The main process's default (main/agent/connection.ts), for a settings object read before 4.6. */
const AGENT_CONNECTION_OFF: AppSettings['agentConnection'] = { enabled: false, baseUrl: 'http://127.0.0.1:8080/v1', model: '' }

/** The agent connection's status line: what the Test reads, in the main card's words. */
function agentResult(conn: AppSettings['agentConnection'], catalog: AgentCatalog | null | undefined): ActionResult | null {
  if (!conn.enabled) return null
  if (catalog === undefined) return { tone: 'info', text: 'Connecting…' }
  if (catalog === null || 'error' in catalog) return { tone: 'danger', text: `Not answering${catalog && 'error' in catalog ? ` (${catalog.error})` : ''} — the agent will stop with this until it does` }
  const chat = catalog.models.filter((m) => m.type !== 'embeddings')
  if (conn.model && !chat.some((m) => m.id === conn.model)) return { tone: 'danger', text: `Connected, but it does not serve ${conn.model}` }
  return { tone: 'ok', text: `Connected — ${chat.length} model${chat.length === 1 ? '' : 's'} listed` }
}

/**
 * 4.6 (J1): the agent connection — a second server for the agent alone (main/agent/connection.ts).
 * Off, nothing here asks that server anything; on, its list is read through the main process's
 * catalog reader, the same one the card above uses (llama-server included).
 */
function AgentConnectionCard({ settings, apply }: { settings: AppSettings; apply: ApplySettings }): JSX.Element {
  const conn = settings.agentConnection ?? AGENT_CONNECTION_OFF
  const set = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['agentConnection']>, shown?: string): void =>
    apply(meta, { agentConnection: { ...conn, ...patch } }, shown)
  // undefined = reading, null = the read itself failed.
  const [catalog, setCatalog] = useState<AgentCatalog | null | undefined>(undefined)
  const read = (): void => {
    if (!conn.enabled) return
    setCatalog(undefined)
    void window.api.getAgentModelCatalog().then(setCatalog).catch(() => setCatalog(null))
  }
  useEffect(read, [conn.enabled, conn.baseUrl])
  const listed = catalog && !('error' in catalog) ? catalog.models.filter((m) => m.type !== 'embeddings') : []
  const result = agentResult(conn, catalog)
  const options = [
    { value: '', label: listed[0] ? `The server’s model (${listed[0].id})` : 'The server’s model' },
    ...listed.map((m) => ({ value: m.id, label: [m.id, contextLabel(m)].filter(Boolean).join(' · ') })),
    ...(conn.model && !listed.some((m) => m.id === conn.model) ? [{ value: conn.model, label: `${conn.model} (not listed)` }] : [])
  ]
  return (
    <Card
      data-testid="agent-connection"
      title={
        <span className="inline-flex items-center gap-2">
          <StatusDot tone={!conn.enabled ? 'muted' : result?.tone === 'ok' ? 'ok' : result?.tone === 'info' ? 'info' : 'danger'} pulse={conn.enabled && catalog === undefined} />
          Agent connection
        </span>
      }
      status={conn.enabled ? `${conn.model || listed[0]?.id || 'the server’s model'} at ${conn.baseUrl}` : 'off — the agent runs on LM Studio'}
      right={conn.enabled ? <ActionRow action="Test" onAction={read} result={result} /> : undefined}
    >
      <Row meta={ROWS.agentConnection}>
        <Switch checked={conn.enabled} onChange={(enabled) => set(ROWS.agentConnection, { enabled }, enabled ? 'on' : 'off')} />
      </Row>
      <div className="mt-4">
        <Row meta={ROWS.agentBaseUrl} layout="stack">
          <Field value={conn.baseUrl} mono placeholder="http://127.0.0.1:8080/v1" onCommit={(baseUrl) => set(ROWS.agentBaseUrl, { baseUrl })} />
        </Row>
      </div>
      {!isLoopbackUrl(conn.baseUrl) && (
        <Notice tone="warn" className="mt-3">
          Only servers on this machine are supported. This address will not be kept — Sigma Oasis reverts to the default. The agent’s requests carry
          your conversation in plaintext and are deliberately never proxied, so a non-loopback address would send them off-machine unprotected.
        </Notice>
      )}
      {conn.enabled && (
        <div className="mt-4">
          <Row meta={ROWS.agentModel}>
            <Select value={conn.model} onChange={(model) => set(ROWS.agentModel, { model }, model || 'the server’s model')} options={options} />
          </Row>
        </div>
      )}
    </Card>
  )
}
