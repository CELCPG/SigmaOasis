// Settings → MCP (v2.5): the servers the user has added, each with its state,
// its tools, its last error and its stderr. Nothing here starts a program the
// user did not turn on: a server is saved off, and the switch is on this page.
import React, { useCallback, useEffect, useState } from 'react'
import type { McpServerConfig, McpServerStatus } from '../../types'

const REFRESH_MS = 2000

const STATE_DOT: Record<McpServerStatus['state'], { className: string; label: string }> = {
  running: { className: 'bg-emerald-500', label: 'running' },
  starting: { className: 'bg-amber-500', label: 'starting' },
  stopped: { className: 'bg-ink-muted', label: 'stopped' },
  failed: { className: 'bg-red-500', label: 'failed' }
}

function splitArgs(text: string): string[] {
  // A plain split on whitespace, with double-quoted runs kept whole. Enough
  // for `npx -y @modelcontextprotocol/server-filesystem "/Users/me/My Docs"`.
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2])
  return out
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = line.slice(i + 1)
  }
  return env
}

export function McpTab(): JSX.Element {
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [configs, setConfigs] = useState<McpServerConfig[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState<string | null>(null)
  const [form, setForm] = useState({ id: '', name: '', command: '', args: '', env: '', cwd: '' })
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async () => {
    const [status, settings] = await Promise.all([
      window.api.mcpStatus().catch(() => [] as McpServerStatus[]),
      window.api.getSettings().catch(() => null)
    ])
    setServers(status)
    setConfigs(settings?.mcp?.servers ?? [])
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  const configOf = (id: string): McpServerConfig | undefined => configs.find((c) => c.id === id)

  const save = async (next: McpServerConfig): Promise<void> => {
    const r = await window.api.mcpUpdate(next)
    if (!r.ok) setNotice(r.error ?? 'Could not save the server.')
    await refresh()
  }

  const add = async (): Promise<void> => {
    const command = form.command.trim()
    const id = (form.id.trim() || form.name.trim() || command.split(/[\\/\s]/).pop() || '').replace(/[^A-Za-z0-9_-]+/g, '_')
    if (!command || !id) {
      setNotice('A server needs a command and an id.')
      return
    }
    setAdding(true)
    const r = await window.api.mcpAdd({
      id,
      name: form.name.trim() || id,
      command,
      args: splitArgs(form.args),
      env: parseEnv(form.env),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      enabled: false,
      disabledTools: []
    })
    setAdding(false)
    if (r.ok) {
      setForm({ id: '', name: '', command: '', args: '', env: '', cwd: '' })
      setNotice(`Added "${r.server?.name ?? id}", switched off. Turn it on below when you are ready.`)
    } else if (!r.canceled) {
      setNotice(r.error ?? 'Could not add the server.')
    }
    await refresh()
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm font-medium">MCP servers</div>
        <p className="mt-1 text-xs text-ink-secondary">
          A Model Context Protocol server is a separate program on this machine whose tools your models can
          call, beside the built-in ones. It runs with your privileges and outside this app’s egress
          allowlist, activity log and proxy setting — the app cannot see its network traffic and does not
          claim to. Every server is saved switched off; its tools reach a model only while it is on.
        </p>
      </div>

      {notice && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-ink-primary" role="status">
          {notice}
        </p>
      )}

      {servers.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No servers added.</p>
      ) : (
        <ul className="space-y-3">
          {servers.map((s) => {
            const cfg = configOf(s.id)
            const dot = STATE_DOT[s.state]
            return (
              <li key={s.id} className="glass-panel rounded-xl p-3">
                <div className="flex items-center gap-3">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot.className}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {s.name} <span className="font-mono text-xs text-ink-tertiary">{s.id}</span>
                    </div>
                    <div className="text-xs text-ink-secondary">
                      {dot.label}
                      {s.era ? ` · ${s.era} protocol ${s.protocolVersion ?? ''}` : ''}
                      {s.serverInfo?.name ? ` · ${s.serverInfo.name}${s.serverInfo.version ? ` ${s.serverInfo.version}` : ''}` : ''}
                      {s.restarts > 0 ? ` · restarted ${s.restarts}×` : ''}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={cfg?.enabled ?? false}
                      onChange={(e) => cfg && void save({ ...cfg, enabled: e.target.checked })}
                      aria-label={`${s.name} enabled`}
                    />
                    On
                  </label>
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs text-ink-secondary transition-colors hover:bg-black/10 dark:hover:bg-white/5"
                    onClick={() => void window.api.mcpReload(s.id).then(refresh)}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs text-ink-secondary transition-colors hover:bg-black/10 dark:hover:bg-white/5"
                    onClick={() => setShowLogs(showLogs === s.id ? null : s.id)}
                  >
                    {showLogs === s.id ? 'Hide log' : 'Log'}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-xs text-ink-danger transition-colors hover:bg-black/10 dark:hover:bg-white/5"
                    onClick={() => void window.api.mcpRemove(s.id).then(refresh)}
                  >
                    Remove
                  </button>
                </div>
                {cfg && (
                  <div className="mt-2 font-mono text-xs text-ink-tertiary">
                    {[cfg.command, ...cfg.args].join(' ')}
                    {Object.keys(cfg.env).length ? ` · env: ${Object.keys(cfg.env).join(', ')}` : ''}
                  </div>
                )}
                {s.lastError && (
                  <p className="mt-2 text-xs text-ink-danger" role="status">
                    {s.lastError}
                  </p>
                )}
                {s.tools.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {s.tools.map((t) => (
                      <li key={t.wireName} className="flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={t.enabled}
                          onChange={(e) => {
                            if (!cfg) return
                            const off = new Set(cfg.disabledTools)
                            if (e.target.checked) off.delete(t.rawName)
                            else off.add(t.rawName)
                            void save({ ...cfg, disabledTools: [...off] })
                          }}
                          aria-label={`${t.rawName} enabled`}
                        />
                        <span className="min-w-0">
                          <span className="font-mono">{t.rawName}</span>
                          <span className="text-ink-tertiary"> · on the wire as </span>
                          <span className="font-mono text-ink-tertiary">{t.wireName}</span>
                          {t.description && <span className="block text-ink-secondary">{t.description}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {showLogs === s.id && (
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/10 p-2 font-mono text-[11px] leading-snug text-ink-secondary dark:bg-white/5">
                    {s.stderr.length ? s.stderr.join('\n') : '(nothing on stderr)'}
                  </pre>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="glass-panel rounded-xl p-3">
        <div className="mb-2 text-sm font-medium">Add a server</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Name
            <input className="mt-1 w-full" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Filesystem" />
          </label>
          <label className="text-xs">
            Id <span className="text-ink-tertiary">(letters, digits, - _)</span>
            <input className="mt-1 w-full font-mono" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="fs" />
          </label>
          <label className="text-xs sm:col-span-2">
            Command
            <input className="mt-1 w-full font-mono" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" />
          </label>
          <label className="text-xs sm:col-span-2">
            Arguments <span className="text-ink-tertiary">(space-separated; quote a path with spaces)</span>
            <input className="mt-1 w-full font-mono" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder='-y @modelcontextprotocol/server-filesystem "/Users/me/Documents"' />
          </label>
          <label className="text-xs sm:col-span-2">
            Environment <span className="text-ink-tertiary">(one NAME=value per line; names are shown in the confirmation, values never)</span>
            <textarea className="mt-1 w-full font-mono" rows={2} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
          </label>
          <label className="text-xs sm:col-span-2">
            Working directory <span className="text-ink-tertiary">(optional)</span>
            <input className="mt-1 w-full font-mono" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} />
          </label>
        </div>
        <button
          type="button"
          className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={adding}
          onClick={() => void add()}
        >
          {adding ? 'Confirming…' : 'Add server…'}
        </button>
        <p className="mt-2 text-xs text-ink-tertiary">
          A confirmation shows the exact command before anything is saved. The server is added switched off.
        </p>
      </div>
    </div>
  )
}
