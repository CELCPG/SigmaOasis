import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { Logo } from './Logo'
import { setVibeMode } from '../hooks/vibeMode'
import { createAgentConversation } from '../hooks/agentTasks'
import { useModels } from '../hooks/useModels'
import { todoProgress } from '../lib/agentTurn'
import { formatElapsed } from '../lib/oasisRipple'
import { ago, chooseCards, FAMILY_COLOR, greeting, pickUp, readiness, type FrontDoorCard } from '../lib/frontDoor'
import { SettingsLink } from './settings/SettingsLink'
import type { Conversation } from '../types'
import type { SettingsTarget } from '../../../shared/failure'

/**
 * The front door (v4.0, track F): the screen before the first message, for a
 * chat and for an agent chat alike. Three doors that match the rail; what the
 * reader left off; and cards that each show something this machine can do —
 * chosen from what is enabled, greyed with the setting that turns it on when
 * it is not. When LM Studio is not answering, or no role has a model, the
 * doors give way to the fix.
 *
 * What goes to the composer is one sentence; what starts an agent task is the
 * task itself. Nothing here reaches a model.
 */
export interface FrontDoorProps {
  /** The empty conversation this screen stands in for; null on the cold start, before any is selected. */
  conversation: Conversation | null
  onPick: (prompt: string) => void
}

const FAMILY_LABEL: Record<FrontDoorCard['family'], string> = {
  files: 'files',
  code: 'Python',
  search: 'search',
  memory: 'memory',
  library: 'library',
  shopping: 'shopping',
  agent: 'agent'
}

export function FrontDoor({ conversation, onPick }: FrontDoorProps): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const connection = useAppStore((s) => s.connection)
  const conversations = useAppStore((s) => s.conversations)
  const agentRuns = useAppStore((s) => s.agentRuns)
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const setActiveConversationId = useAppStore((s) => s.setActiveConversationId)
  const { refresh } = useModels()

  // What the machine has, read once per opening: the runtime, the memory, the packs.
  const [machine, setMachine] = useState<{ workbench: boolean; memory: boolean; packs: boolean } | null>(null)
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.workbenchStatus().catch(() => null),
      window.api.memoryStats().catch(() => null),
      window.api.libraryList().catch(() => [])
    ]).then(([wb, mem, packs]) => {
      if (cancelled) return
      setMachine({
        workbench: Boolean(wb?.available),
        memory: Boolean(mem && (mem.totalChunks > 0 || mem.sources.length > 0)),
        packs: (packs ?? []).length > 0
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const now = Date.now()
  const project = (conversation && settings?.projects.find((p) => p.id === conversation.projectId)) ?? null
  const isAgent = Boolean(conversation?.agent)
  const ready = settings ? readiness(connection, settings) : null
  const cards = useMemo(
    () => (settings ? chooseCards({ settings, workbench: machine?.workbench ?? false, memoryHasAnything: machine?.memory ?? false, libraryHasPacks: machine?.packs ?? false }) : []),
    [settings, machine]
  )
  const left = useMemo(() => pickUp(conversations, conversation?.id ?? null, now), [conversations, conversation?.id, now])
  const running = Object.entries(agentRuns).map(([conversationId, run]) => {
    const convo = conversations.find((c) => c.id === conversationId)
    const message = convo?.messages.find((m) => m.id === run.messageId)
    return { conversationId, title: convo?.title ?? run.title, startedAt: run.startedAt, progress: todoProgress(message?.agent?.todos) }
  })

  /** A card's click: a sentence into the composer, or an agent chat on a folder the reader picks. */
  const pickCard = (card: FrontDoorCard): void => {
    if (!card.enabled) {
      if (card.link) openSettingsAt(card.link as SettingsTarget)
      return
    }
    if (card.agent) {
      if (isAgent && conversation?.agent?.workspace) {
        onPick(card.prompt)
        return
      }
      void window.api.pickDirectory().then((dir) => {
        if (!dir) return
        const created = createAgentConversation(dir)
        if (created) useAppStore.getState().setComposerPrefill(card.prompt)
      })
      return
    }
    onPick(card.prompt)
  }

  const heading = project ? project.name : isAgent ? (conversation?.agent?.workspace ? 'What should the agent do here?' : 'What should the agent do?') : greeting(new Date(now).getHours())
  const sub = project
    ? project.instructions.trim()
      ? project.instructions.trim().split('\n')[0]!.slice(0, 140)
      : 'A new chat in this project. Its instructions and files are in play from the first message.'
    : isAgent
      ? conversation?.agent?.workspace
        ? 'It reads, edits and runs things in this folder until the task is done — keeping a checklist you can watch, asking before what you asked it to ask about.'
        : 'No folder is chosen, so it works with the web, the library and Python — whatever is enabled under Tools.'
      : 'Your files, your questions, your machine. Everything runs locally through LM Studio — no cloud, no telemetry, nothing to opt out of.'

  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto p-8" data-front-door={isAgent ? 'agent' : 'chat'}>
      <div className="w-full max-w-2xl">
        <div className="oasis-enter flex items-center gap-3">
          <span className="oasis-logo-glow relative inline-flex">
            <Logo size={40} className="relative" />
          </span>
          <div className="min-w-0">
            <h1 className="oasis-heading text-[22px] font-semibold tracking-[-0.5px]">{heading}</h1>
            <p className="mt-0.5 text-sm leading-relaxed text-ink-secondary">{sub}</p>
          </div>
        </div>

        {ready && ready.kind !== 'ready' ? (
          <NotReady kind={ready.kind} baseUrl={ready.kind === 'offline' ? ready.baseUrl : ''} onTest={() => void refresh()} />
        ) : (
          !isAgent && (
            <div className="oasis-enter mt-6 grid gap-2 sm:grid-cols-3" style={{ animationDelay: '80ms' }} data-doors>
              <Door
                icon="💬"
                title="Ask"
                text="A chat with the roles you set up. Attach files, route with @Name."
                hint="just type below"
                onClick={() => document.querySelector<HTMLTextAreaElement>('textarea.composer-input, textarea')?.focus()}
              />
              <Door
                icon="⚡"
                title="Work in a folder"
                text="The agent reads, edits and runs things in a folder you choose until the task is done."
                hint="⚡ in the rail"
                onClick={() =>
                  void window.api.pickDirectory().then((dir) => {
                    if (dir) createAgentConversation(dir)
                  })
                }
              />
              <Door icon="〰" title="Just talk" text="VIBE: nothing but the conversation, on calm water. Everything still runs; none of it is drawn." hint="⌘⇧L" onClick={() => setVibeMode(true)} />
            </div>
          )
        )}

        {(left.recent.length > 0 || left.digest || running.length > 0) && (
          <section className="oasis-enter mt-6" style={{ animationDelay: '140ms' }} data-pick-up>
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-tertiary">Pick up where you left off</h2>
            <div className="mt-2 space-y-1">
              {running.map((r) => (
                <button key={r.conversationId} type="button" onClick={() => setActiveConversationId(r.conversationId)} className="glass-panel glass-panel--hover flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left">
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent shadow-[0_0_6px_rgba(0,212,170,0.8)]" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink-primary">{r.title}</span>
                    <span className="block truncate text-[11px] text-ink-tertiary">
                      working · {formatElapsed(now - r.startedAt)}
                      {r.progress.total > 0 ? ` · ${r.progress.done}/${r.progress.total}` : ''}
                      {r.progress.current ? ` · ${r.progress.current}` : ''}
                    </span>
                  </span>
                </button>
              ))}
              {left.digest && <PickUpRow convo={left.digest} now={now} note="a digest arrived" onOpen={setActiveConversationId} />}
              {left.recent.map((c) => (
                <PickUpRow key={c.id} convo={c} now={now} onOpen={setActiveConversationId} />
              ))}
            </div>
          </section>
        )}

        <section className="oasis-enter mt-6" style={{ animationDelay: '200ms' }} data-cards>
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-tertiary">{isAgent ? 'Tasks to start with' : 'Try what this machine can do'}</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(isAgent ? AGENT_STARTERS(Boolean(conversation?.agent?.workspace)) : cards).map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pickCard(c)}
                data-card={c.id}
                data-enabled={c.enabled}
                style={{ '--card-accent': FAMILY_COLOR[c.family], animationDelay: `${220 + i * 40}ms` } as React.CSSProperties}
                className={`glass-panel oasis-starter oasis-enter flex items-start gap-3 rounded-2xl p-3 text-left ${c.enabled ? '' : 'opacity-70'}`}
                title={c.enabled ? c.prompt : `${c.reason} — click to open the setting`}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] text-sm"
                  style={{ background: 'color-mix(in srgb, var(--card-accent) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--card-accent) 28%, transparent)' }}
                  aria-hidden="true"
                >
                  {c.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink-primary">{c.title}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-tertiary">{c.enabled ? c.prompt : `${(c.reason ?? 'Off')[0]!.toUpperCase()}${(c.reason ?? 'Off').slice(1)} — turn it on.`}</span>
                </span>
                <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]" style={{ borderColor: 'color-mix(in srgb, var(--card-accent) 40%, transparent)', color: 'var(--text-tertiary)' }}>
                  {c.runs === 'agent' ? 'agent' : FAMILY_LABEL[c.family]}
                </span>
              </button>
            ))}
          </div>
        </section>

        <p className="oasis-enter mt-5 text-[11px] text-ink-tertiary" style={{ animationDelay: '400ms' }}>
          {isAgent ? 'Type a task below · steer while it works by typing again · ↶ Undo puts every file back' : 'Route a message to a role with @RoleName · drop files to attach · hold 🎙️ to talk'}
        </p>
      </div>
    </div>
  )
}

/** An agent chat's first cards: the tasks a folder, or no folder, is good for. */
function AGENT_STARTERS(hasFolder: boolean): FrontDoorCard[] {
  const base = { family: 'agent' as const, runs: 'agent', enabled: true, agent: true }
  return hasFolder
    ? [
        { ...base, id: 'map', icon: '🗺️', title: 'Explain this project', prompt: 'Explain how this project is organized and where to start reading.' },
        { ...base, id: 'tests', icon: '🧪', title: 'Run the tests, fix what fails', prompt: 'Run the tests, and fix whatever fails.' },
        { ...base, id: 'review', icon: '🔍', title: 'Review for bugs', prompt: 'Review the code for bugs and risky spots, and list them with file and line.' },
        { ...base, id: 'readme', icon: '📝', title: 'Write the README', prompt: 'Write or update the README so a newcomer can run the project.' },
        { ...base, id: 'tidy', icon: '🗂️', title: 'Tidy this folder', prompt: 'Tidy this folder: group the files by type into folders, name the folders plainly, and show me the plan before moving anything.' }
      ]
    : [
        { ...base, id: 'research', icon: '🔎', title: 'Research across sources', prompt: 'Research a question across several sources and give me a cited summary.' },
        { ...base, id: 'compute', icon: '🧮', title: 'Work a calculation through', prompt: 'Work through a calculation step by step with Python and show the result.' }
      ]
}

function Door({ icon, title, text, hint, onClick }: { icon: string; title: string; text: string; hint: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} data-door={title} className="glass-panel glass-panel--hover flex flex-col items-start gap-1.5 rounded-2xl p-3 text-left">
      <span className="text-lg" aria-hidden="true">
        {icon}
      </span>
      <span className="text-[13px] font-medium text-ink-primary">{title}</span>
      <span className="text-[11px] leading-snug text-ink-tertiary">{text}</span>
      <span className="mt-auto text-[10px] text-ink-tertiary">{hint}</span>
    </button>
  )
}

function PickUpRow({ convo, now, note, onOpen }: { convo: Conversation; now: number; note?: string; onOpen: (id: string) => void }): JSX.Element {
  return (
    <button type="button" onClick={() => onOpen(convo.id)} className="glass-panel glass-panel--hover flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink-primary">{convo.title}</span>
        <span className="block truncate text-[11px] text-ink-tertiary">
          {note ? `${note} · ` : ''}
          {ago(convo.updatedAt, now)}
          {convo.agent ? ' · agent' : ''}
        </span>
      </span>
      <span className="text-xs text-ink-tertiary" aria-hidden="true">
        →
      </span>
    </button>
  )
}

/** When LM Studio is not answering, or no role has a model, the doors give way to the fix. */
function NotReady({ kind, baseUrl, onTest }: { kind: 'offline' | 'no-role'; baseUrl: string; onTest: () => void }): JSX.Element {
  return (
    <div className="oasis-enter mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4" style={{ animationDelay: '80ms' }} data-not-ready={kind}>
      <div className="text-sm font-medium text-ink-primary">{kind === 'offline' ? 'LM Studio is not answering' : 'No role has a model yet'}</div>
      <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
        {kind === 'offline'
          ? `Nothing here can answer until it does. Start LM Studio, load a model and start its server, then test the address (${baseUrl}).`
          : 'A role is a model with a persona. Pick a model for one under Roles and the doors open.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {kind === 'offline' && (
          <button type="button" onClick={onTest} className="rounded-lg border border-black/10 px-3 py-1.5 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10">
            Test again
          </button>
        )}
        <SettingsLink to={kind === 'offline' ? 'connection.baseUrl' : 'models.slots'} className="rounded-lg border border-black/10 px-3 py-1.5 no-underline hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10">
          {kind === 'offline' ? 'Open LM Studio settings' : 'Open Roles'}
        </SettingsLink>
      </div>
    </div>
  )
}
