// Settings → LM Studio (v4.0, S4): the server every model runs on, as a
// status hero, the address as a field that commits on Enter or blur, and the
// detected models as rows — what each is, whether it is loaded, which role
// uses it — instead of a monospace bullet list.

import type { AppSettings, ConnectionStatus, ModelInfo } from '../../types'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { isLoopbackUrl } from './helpers'
import { ActionRow, Card, Field, Notice, RoleDot, Row, Section, StatusDot, type ActionResult } from './kit'

export const ROWS = defineRows('connection', {
  baseUrl: { label: 'Server address', help: 'LM Studio’s OpenAI-compatible endpoint on this machine. Applies when you press Enter or leave the field.', keywords: ['url', 'base url', 'endpoint', 'port', '1234'] },
  models: { label: 'Detected models', help: 'What the server lists right now, and which role uses each.', keywords: ['loaded', 'quantization', 'context'] }
})
registerRows(ROWS)

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

      <Section title="Models" description={ROWS.models.help}>
        <Row meta={ROWS.models} bare>
          {availableModels.length === 0 ? (
            <Notice tone="muted">Nothing listed. Start LM Studio’s server, load a model, and press Test.</Notice>
          ) : (
            <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
              {availableModels.map((m) => {
                const roles = usedBy(m.id)
                return (
                  <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                    <StatusDot tone={m.loaded ? 'ok' : 'muted'} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs text-ink-primary">{m.id}</div>
                      <div className="text-xs text-ink-tertiary">
                        {[m.type === 'embeddings' ? 'embeddings' : m.vision ? 'vision' : m.arch, m.quantization, contextLabel(m), m.loaded ? 'loaded' : 'not loaded']
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
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
      </Section>
    </div>
  )
}
