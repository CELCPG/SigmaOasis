// Settings → MCP (v4.0, S4): each server a card — its state, its switch, its
// approval, its tools with a switch each, its log behind a fold — and the
// add-a-server form folded until wanted. Nothing here starts a program the
// user did not turn on: a server is saved off, and the switch is on this page.
// Environment values are typed into masked fields and leave this page when the
// server is added — for the keychain, through the main process.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpApproval, McpServerConfig, McpServerStatus, SecretsStatus } from '../../types'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { Button, Card, DangerRow, Field, Fold, Notice, Row, Section, Select, StatusDot, Switch, type ActionResult, type Tone } from './kit'

export const ROWS = defineRows('mcp', {
  servers: { label: 'Servers', help: 'A Model Context Protocol server is a separate program on this machine whose tools your models can call, beside the built-in ones. It runs with your privileges and outside this app’s egress allowlist, activity log and proxy setting — the app cannot see its network traffic and does not claim to. Every server is saved switched off; its tools reach a model only while it is on.', keywords: ['mcp', 'server', 'tools', 'stdio'] },
  name: { label: 'Name', help: 'What the panel and the model call it.', keywords: ['mcp', 'add'] },
  id: { label: 'Id', help: 'Letters, digits, - and _. Part of every tool’s wire name.', keywords: ['mcp', 'add'] },
  command: { label: 'Command', help: 'The program to launch, as you would type it.', keywords: ['mcp', 'npx', 'command'] },
  args: { label: 'Arguments', help: 'Space-separated; quote a path with spaces.', keywords: ['mcp', 'args'] },
  env: { label: 'Environment', help: 'Values are encrypted in the system keychain; from then on only the names are shown, here and in the confirmation.', keywords: ['mcp', 'env', 'api key', 'keychain'] },
  cwd: { label: 'Working directory', help: 'Optional. Where the server runs.', keywords: ['mcp', 'cwd'] }
})
registerRows(ROWS)

const REFRESH_MS = 2000

const STATE: Record<McpServerStatus['state'], { tone: Tone; label: string }> = {
  running: { tone: 'ok', label: 'running' },
  starting: { tone: 'warn', label: 'starting' },
  stopped: { tone: 'muted', label: 'stopped' },
  failed: { tone: 'danger', label: 'failed' }
}

function splitArgs(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2]!)
  return out
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

interface EnvRow {
  key: number
  name: string
  value: string
}

export function McpTab(): JSX.Element {
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [configs, setConfigs] = useState<McpServerConfig[]>([])
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null)
  const [notice, setNotice] = useState<ActionResult | null>(null)
  const [form, setForm] = useState({ id: '', name: '', command: '', args: '', cwd: '' })
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const nextRowKey = useRef(0)
  const [adding, setAdding] = useState(false)
  const [formOpen, setFormOpen] = useState(false)

  const refresh = useCallback(async () => {
    const [status, settings, secretState] = await Promise.all([
      window.api.mcpStatus().catch(() => [] as McpServerStatus[]),
      window.api.getSettings().catch(() => null),
      window.api.secretsStatus().catch(() => null)
    ])
    setServers(status)
    setConfigs(settings?.mcp?.servers ?? [])
    setSecrets(secretState)
  }, [])
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  const configOf = (id: string): McpServerConfig | undefined => configs.find((c) => c.id === id)
  const save = async (next: McpServerConfig): Promise<void> => {
    const r = await window.api.mcpUpdate(next)
    if (!r.ok) setNotice({ tone: 'danger', text: r.error ?? 'Could not save the server.' })
    await refresh()
  }

  const add = async (): Promise<void> => {
    const command = form.command.trim()
    const id = (form.id.trim() || form.name.trim() || command.split(/[\\/\s]/).pop() || '').replace(/[^A-Za-z0-9_-]+/g, '_')
    if (!command || !id) return setNotice({ tone: 'warn', text: 'A server needs a command and an id.' })
    const env: Record<string, string> = {}
    for (const row of envRows) {
      const name = row.name.trim()
      if (!name && !row.value) continue
      if (!ENV_NAME.test(name)) return setNotice({ tone: 'warn', text: `“${name}” is not a variable name: letters, digits and _, not starting with a digit.` })
      if (name in env) return setNotice({ tone: 'warn', text: `The variable ${name} is listed twice.` })
      env[name] = row.value
    }
    setAdding(true)
    const r = await window.api.mcpAdd({ id, name: form.name.trim() || id, command, args: splitArgs(form.args), env, ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}), enabled: false, disabledTools: [], approval: 'ask' })
    setAdding(false)
    if (r.ok) {
      setForm({ id: '', name: '', command: '', args: '', cwd: '' })
      setEnvRows([])
      setFormOpen(false)
      setNotice({ tone: 'ok', text: `Added “${r.server?.name ?? id}”, switched off. Turn it on when you are ready.` + (r.warning ? ` ${r.warning}` : '') })
    } else if (!r.canceled) setNotice({ tone: 'danger', text: r.error ?? 'Could not add the server.' })
    await refresh()
  }

  return (
    <div className="space-y-8">
      <Section title="Servers" description={ROWS.servers.help} right={<Button kind="primary" onClick={() => setFormOpen((o) => !o)}>{formOpen ? 'Close' : 'Add a server…'}</Button>}>
        <Row meta={ROWS.servers} bare>
          <div className="space-y-3">
            {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
            <Fold title="Add a server" summary="a confirmation shows the exact command before anything is saved; the server is added switched off" open={formOpen} onToggle={setFormOpen}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Row meta={ROWS.name} layout="stack">
                  <Field value={form.name} onChange={(name) => setForm({ ...form, name })} onCommit={(name) => setForm({ ...form, name })} placeholder="Filesystem" />
                </Row>
                <Row meta={ROWS.id} layout="stack">
                  <Field value={form.id} mono onChange={(id) => setForm({ ...form, id })} onCommit={(id) => setForm({ ...form, id })} placeholder="fs" />
                </Row>
              </div>
              <Row meta={ROWS.command} layout="stack">
                <Field value={form.command} mono onChange={(command) => setForm({ ...form, command })} onCommit={(command) => setForm({ ...form, command })} placeholder="npx" />
              </Row>
              <Row meta={ROWS.args} layout="stack">
                <Field value={form.args} mono onChange={(args) => setForm({ ...form, args })} onCommit={(args) => setForm({ ...form, args })} placeholder='-y @modelcontextprotocol/server-filesystem "/Users/me/Documents"' />
              </Row>
              <Row meta={ROWS.env} layout="stack">
                <div className="space-y-1.5">
                  {envRows.map((row, i) => {
                    const label = row.name.trim() || `variable ${i + 1}`
                    return (
                      <div key={row.key} className="flex gap-2">
                        <div className="w-2/5">
                          <Field value={row.name} mono compact label={`Name of variable ${i + 1}`} placeholder="API_TOKEN" onChange={(name) => setEnvRows((rows) => rows.map((r) => (r.key === row.key ? { ...r, name } : r)))} onCommit={() => undefined} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <Field value={row.value} type="password" mono compact label={`Value of ${label}`} onChange={(value) => setEnvRows((rows) => rows.map((r) => (r.key === row.key ? { ...r, value } : r)))} onCommit={() => undefined} />
                        </div>
                        <Button kind="ghost" aria-label={`Remove ${label}`} onClick={() => setEnvRows((rows) => rows.filter((r) => r.key !== row.key))}>
                          Remove
                        </Button>
                      </div>
                    )
                  })}
                  <Button kind="ghost" onClick={() => setEnvRows((rows) => [...rows, { key: nextRowKey.current++, name: '', value: '' }])}>
                    + Add variable
                  </Button>
                </div>
              </Row>
              <Row meta={ROWS.cwd} layout="stack">
                <Field value={form.cwd} mono onChange={(cwd) => setForm({ ...form, cwd })} onCommit={(cwd) => setForm({ ...form, cwd })} />
              </Row>
              <Button kind="primary" busy={adding ? 'Confirming…' : undefined} onClick={() => void add()}>
                Add server…
              </Button>
            </Fold>

            {servers.length === 0 ? (
              <Notice tone="muted">No servers added.</Notice>
            ) : (
              servers.map((s) => {
                const cfg = configOf(s.id)
                const state = STATE[s.state]
                return (
                  <Card
                    key={s.id}
                    title={
                      <span className="inline-flex items-center gap-2">
                        <StatusDot tone={state.tone} pulse={s.state === 'starting'} />
                        {s.name} <span className="font-mono text-xs font-normal text-ink-tertiary">{s.id}</span>
                      </span>
                    }
                    status={`${state.label}${s.era ? ` · ${s.era} protocol ${s.protocolVersion ?? ''}` : ''}${s.serverInfo?.name ? ` · ${s.serverInfo.name}${s.serverInfo.version ? ` ${s.serverInfo.version}` : ''}` : ''}${s.restarts > 0 ? ` · restarted ${s.restarts}×` : ''}`}
                    right={
                      <>
                        <Select
                          compact
                          label={`${s.name} approval`}
                          value={cfg?.approval ?? 'ask'}
                          onChange={(v) => cfg && void save({ ...cfg, approval: v as McpApproval })}
                          title="ask: confirm each call (Always allow mints a grant) · grants only: run grants only · never ask"
                          options={[
                            { value: 'ask', label: 'ask each call' },
                            { value: 'allowlist', label: 'grants only' },
                            { value: 'full', label: 'never ask' }
                          ]}
                        />
                        <Button kind="ghost" onClick={() => void window.api.mcpReload(s.id).then(refresh)}>
                          Reload
                        </Button>
                        <DangerRow variant="inline" label="" action="Remove" confirm={`Remove ${s.name}?`} onConfirm={() => window.api.mcpRemove(s.id).then(refresh)} />
                        <Switch label={`${s.name} enabled`} checked={cfg?.enabled ?? false} onChange={(enabled) => cfg && void save({ ...cfg, enabled })} />
                      </>
                    }
                  >
                    {cfg && (
                      <div className="font-mono text-xs text-ink-tertiary">
                        {[cfg.command, ...cfg.args].join(' ')}
                        {cfg.envNames.length ? ` · env: ${cfg.envNames.join(', ')} (in the keychain)` : ''}
                      </div>
                    )}
                    {secrets?.mcpEnv.unreadable.includes(s.id) && (
                      <Notice tone="danger" className="mt-2">
                        Its environment values could not be decrypted on this machine — they were sealed by another machine’s or account’s keychain — so it is kept off. Remove it and add it again with its values.
                      </Notice>
                    )}
                    {s.lastError && (
                      <Notice tone="danger" className="mt-2">
                        {s.lastError}
                      </Notice>
                    )}
                    {s.tools.length > 0 && (
                      <ul className="mt-3 space-y-1.5">
                        {s.tools.map((t) => (
                          <li key={t.wireName} className="flex items-start gap-3 text-xs">
                            <span className="min-w-0 flex-1">
                              <span className="font-mono text-ink-primary">{t.rawName}</span>
                              <span className="text-ink-tertiary"> · on the wire as </span>
                              <span className="font-mono text-ink-tertiary">{t.wireName}</span>
                              {t.description && <span className="block text-ink-secondary">{t.description}</span>}
                            </span>
                            <Switch
                              size="sm"
                              label={`${t.rawName} enabled`}
                              checked={t.enabled}
                              onChange={(on) => {
                                if (!cfg) return
                                const off = new Set(cfg.disabledTools)
                                if (on) off.delete(t.rawName)
                                else off.add(t.rawName)
                                void save({ ...cfg, disabledTools: [...off] })
                              }}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-3">
                      <Fold title="Log" summary={s.stderr.length ? `${s.stderr.length} line${s.stderr.length === 1 ? '' : 's'} on stderr` : 'nothing on stderr'}>
                        <pre className="max-h-48 overflow-auto rounded-lg bg-black/10 p-2 font-mono text-[11px] leading-snug text-ink-secondary dark:bg-white/5">{s.stderr.length ? s.stderr.join('\n') : '(nothing on stderr)'}</pre>
                      </Fold>
                    </div>
                  </Card>
                )
              })
            )}
          </div>
        </Row>
      </Section>
    </div>
  )
}
