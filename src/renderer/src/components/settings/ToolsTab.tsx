// Settings → Tools (v4.0, S4): the tool table's own domains as sections, each
// with a switch for the group and a row per tool — its label, the first
// sentence of the decision rule the model reads, a budget chip — with the
// wire names behind a switch. The working directory, the Workbench and the
// standing grants each as a card or a section of their own.
import { useCallback, useEffect, useState } from 'react'
import { TOOL_DEFS, TOOL_GROUPS, TOOL_LABELS, TOOL_TURN_BUDGETS, toolSummary, type ToolName } from '../../../../shared/tools'
import { splitMcpWireName } from '../../../../shared/mcpNames'
import type { AppSettings, Grant, WorkbenchStatus } from '../../types'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows, type RowMeta } from '../../lib/settingsKit'
import { ActionRow, Button, Card, DangerRow, Field, Notice, Row, Section, StatusDot, Switch } from './kit'

export const ROWS = defineRows('tools', {
  workingDirectory: { label: 'Default working directory', help: 'Relative paths resolve here, and the file tools cannot read or write outside it. Leave empty for unrestricted paths — each write is then confirmed.', keywords: ['folder', 'scope', 'files'] },
  workbench: { label: 'Workbench (sandboxed Python)', help: 'Python runs in WebAssembly inside a sandboxed window: no network — not even your LM Studio server — and no access to your disk beyond the files you attach.', keywords: ['pyodide', 'python', 'sandbox'] },
  showIds: { label: 'Show tool ids', help: 'The name each tool has on the wire, beside its label.', keywords: ['wire', 'names'] },
  grants: { label: 'Standing grants', help: '“Always allow” in a confirmation dialog mints a grant for that exact call — the command in that working directory, the file path, or the MCP tool with those arguments. One byte different asks again. Revoking takes effect on the next call.', keywords: ['always allow', 'revoke', 'permissions'] }
})
registerRows(ROWS)

/** One row per tool, from the tool table: its label without the parenthetical, the first sentence of its rule. */
export const TOOL_ROWS: Record<ToolName, RowMeta> = Object.fromEntries(
  TOOL_DEFS.map((d) => [
    d.name,
    { id: `tools.${d.name}`, label: TOOL_LABELS[d.name as ToolName].replace(/\s*\(.*\)\s*$/, ''), help: toolSummary(d.name as ToolName), keywords: [d.name, ...d.name.split('_')] }
  ])
) as Record<ToolName, RowMeta>
registerRows(TOOL_ROWS)

/** What a grant row calls its tool — `server › tool` for an MCP wire name. */
function grantToolLabel(tool: string): string {
  const mcp = splitMcpWireName(tool)
  return mcp ? `${mcp.server} › ${mcp.tool}` : tool
}

export interface ToolsTabProps {
  settings: AppSettings
  apply: ApplySettings
  defaults: AppSettings | null
}

export function ToolsTab({ settings, apply, defaults }: ToolsTabProps): JSX.Element {
  const [showIds, setShowIds] = useState(false)
  const toggles = settings.tools
  const setTool = (name: ToolName, on: boolean): void => apply(TOOL_ROWS[name], { tools: { ...toggles, [name]: on } }, on ? 'On' : 'Off')
  const setGroup = (label: string, tools: readonly ToolName[], on: boolean): void =>
    apply({ id: `tools.group.${label}`, label: `${label} tools` }, { tools: { ...toggles, ...Object.fromEntries(tools.map((t) => [t, on])) } }, on ? 'all on' : 'all off')

  return (
    <div className="space-y-8">
      <Section title="Where the file tools work" description="The folder the file tools are scoped to.">
        <Row meta={ROWS.workingDirectory} layout="stack">
          <div className="flex gap-2">
            <Field value={settings.workingDirectory} mono placeholder="Leave empty to be asked before each write" onCommit={(workingDirectory) => apply(ROWS.workingDirectory, { workingDirectory })} />
            <Button
              onClick={() =>
                void window.api.pickDirectory().then((dir) => {
                  if (dir) apply(ROWS.workingDirectory, { workingDirectory: dir })
                })
              }
            >
              Browse…
            </Button>
          </div>
        </Row>
        <Row meta={ROWS.workbench} layout="stack">
          <WorkbenchCard />
        </Row>
      </Section>

      <Section
        title="What a model may do"
        description="Every tool the app has, by domain. A tool switched off here reaches no role, whatever its own list says."
        onReset={defaults ? () => apply({ id: 'tools.reset', label: 'Tools' }, { tools: defaults.tools }, 'defaults') : undefined}
      >
        <Row meta={ROWS.showIds}>
          <Switch checked={showIds} onChange={setShowIds} />
        </Row>
        {TOOL_GROUPS.map((g) => {
          const on = g.tools.filter((t) => toggles[t]).length
          return (
            <Card
              key={g.label}
              title={g.label}
              status={`${on} of ${g.tools.length} on · ${g.description}`}
              right={<Switch size="sm" checked={on === g.tools.length} onChange={(v) => setGroup(g.label, g.tools, v)} label={`All ${g.label} tools`} />}
            >
              <div className="space-y-3">
                {g.tools.map((name) => {
                  const budget = TOOL_TURN_BUDGETS[name]
                  const meta = TOOL_ROWS[name]
                  return (
                    <Row
                      key={name}
                      meta={meta}
                      foot={
                        showIds || budget ? (
                          <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-ink-tertiary">
                            {showIds && <code className="rounded bg-black/5 px-1 py-0.5 dark:bg-white/10">{name}</code>}
                            {budget && <span className="rounded-full border border-black/10 px-1.5 py-0.5 dark:border-white/10">{budget} per turn</span>}
                          </span>
                        ) : undefined
                      }
                    >
                      <Switch checked={toggles[name]} onChange={(v) => setTool(name, v)} />
                    </Row>
                  )
                })}
              </div>
            </Card>
          )
        })}
      </Section>

      <GrantsSection />
    </div>
  )
}

function WorkbenchCard(): JSX.Element {
  const [status, setStatus] = useState<WorkbenchStatus | null>(null)
  const [warming, setWarming] = useState(false)
  const load = useCallback(() => {
    setStatus(null)
    void window.api.workbenchStatus().then(setStatus).catch(() => setStatus(null))
  }, [])
  useEffect(load, [load])
  const tone = status === null ? 'muted' : !status.available ? 'danger' : status.warm ? 'ok' : 'warn'
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <StatusDot tone={tone} pulse={warming} />
          Pyodide
        </span>
      }
      status={status === null ? 'checking…' : !status.available ? 'not installed' : `${status.version ?? '?'} · ${status.warm ? 'running' : 'idle'}`}
      right={
        <ActionRow action="Refresh" onAction={load}>
          {status?.available && !status.warm && (
            <Button
              busy={warming ? 'Starting…' : undefined}
              title="Load the runtime now so the first run_python of the session does not pay the cold start"
              onClick={() => {
                setWarming(true)
                void window.api
                  .warmWorkbench()
                  .then(() => new Promise((r) => setTimeout(r, 2500)))
                  .then(() => window.api.workbenchStatus())
                  .then(setStatus)
                  .catch(() => undefined)
                  .finally(() => setWarming(false))
              }}
            >
              Start now
            </Button>
          )}
        </ActionRow>
      }
    >
      <p className="text-xs text-ink-secondary">
        {status?.available
          ? `Available offline: the standard library${status.packages.length > 0 ? ` plus ${status.packages.join(', ')}` : ''}. The sandbox is torn down after ten minutes idle.`
          : 'run_python and analyze_file report themselves unavailable until the runtime is installed. Everything else in the app is unaffected.'}
      </p>
      {status && !status.available && status.reason && (
        <Notice tone="warn" className="mt-2">
          {status.reason} In a checkout, run <code>bash scripts/fetch-pyodide.sh</code>; packaged builds include it.
        </Notice>
      )}
    </Card>
  )
}

/** The standing grants, listed with their use counts and revoked one at a time — two clicks each. */
function GrantsSection(): JSX.Element {
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const refresh = useCallback(async () => {
    setGrants(await window.api.grantsList().catch(() => []))
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return (
    <Section
      title="Standing grants"
      description={ROWS.grants.help}
      right={grants && grants.length > 0 ? <DangerRow variant="inline" label="" action="Revoke all" confirm={`Revoke all ${grants.length}?`} onConfirm={() => window.api.grantsRevokeAll().then(refresh)} /> : undefined}
    >
      <Row meta={ROWS.grants} bare>
        {grants === null ? (
          <p className="text-xs text-ink-tertiary">Loading…</p>
        ) : grants.length === 0 ? (
          <Notice tone="muted">No standing grants. Every command and every write outside the working directory still asks.</Notice>
        ) : (
          <div className="space-y-1.5">
            {grants.map((g) => (
              <DangerRow
                key={g.id}
                label={<span className="font-mono text-xs">{g.summary}</span>}
                detail={`${grantToolLabel(g.tool)}${g.cwd ? ` · in ${g.cwd}` : ''} · used ${g.uses} time${g.uses === 1 ? '' : 's'}`}
                action="Revoke"
                confirm="Revoke?"
                onConfirm={() => window.api.grantsRevoke(g.id).then(refresh)}
              />
            ))}
          </div>
        )}
      </Row>
    </Section>
  )
}
